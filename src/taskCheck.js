/**
 * taskCheck.js - 流式任务管理器
 * 地址池全量存 SQLite task_queue，内存只保留滑动窗口
 * 支持节流调度：扫描 runMinutes 分钟 -> 暂停 pauseMinutes 分钟 -> 继续
 */
const EventEmitter = require('events');
const { ffprobeCheck } = require('./ffprobe');
const { checkNetwork } = require('./networkCheck');
const persistence = require('./services/persistenceService');
const streamService = require('./services/streamService');
const { normalizeMulticastUrl, buildProxyPlaybackUrl } = require('./utils/streamUrl');

const LOG_SIZE = 50;
const WINDOW_MULTIPLIER = 4;

class FallbackQueue {
    constructor(opts) {
        this.concurrency = (opts && opts.concurrency) || 1;
        this.size = 0;
        this.pending = 0;
    }
    add(fn) {
        this.size++;
        return Promise.resolve()
            .then(() => {
                this.size = Math.max(0, this.size - 1);
                this.pending++;
                return fn();
            })
            .finally(() => {
                this.pending = Math.max(0, this.pending - 1);
            });
    }
    pause() {}
    clear() { this.size = 0; }
    start() {}
}

let PQueue = FallbackQueue;
const pQueueReady = (async () => {
    try {
        const importPromise = import('p-queue');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('PQueue import timeout')), 10000));
        const m = await Promise.race([importPromise, timeoutPromise]);
        if (m && m.default) PQueue = m.default;
    } catch (e) {
        console.error('Failed to import p-queue:', e);
    }
})();

class TaskManager extends EventEmitter {
    constructor() {
        super();
        this.meta = {
            running: false,
            paused: false,
            type: '',
            params: {},
            total: 0,
            finished: 0,
            successCount: 0,
            failCount: 0,
            startTime: 0,
            logs: []
        };
        this.queue = null;
        this.resultBuffer = [];
        this.activeProcesses = new Set();
        this.io = null;
        this._driving = false;
        this._throttleTimer = null;
        this._throttlePhase = '';
        this._throttleStartAt = 0;
        this._throttleDurationMs = 0;
        this._queueStartRequested = false;

        this.ready = this.init().catch(err => console.error('Task init failed:', err));
    }

    setIo(io) { this.io = io; }

    async init() {
        await pQueueReady.catch(() => {});
        await this._loadMeta();
        setInterval(() => this.flushResults(), 3000);
    }

    log(msg) {
        const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        this.meta.logs.unshift(line);
        if (this.meta.logs.length > LOG_SIZE) this.meta.logs.pop();
        console.log('[TaskManager]', msg);
        if (this.io) this.io.emit('task:log', line);
    }

    _saveMeta() {
        const toSave = { ...this.meta, logs: this.meta.logs.slice(0, 20) };
        persistence.taskMetaSet('meta', toSave);
    }

    async _loadMeta() {
        const saved = persistence.taskMetaGet('meta');
        if (!saved) return;
        if (saved.running || saved.paused) {
            persistence.taskQueueResetInFlight();
            const pending = persistence.taskQueuePendingCount();
            if (pending === 0) {
                this.log('检测到残留任务状态但队列已空，自动重置');
                persistence.taskMetaDelete('meta');
                return;
            }
            this.meta = { ...this.meta, ...saved };
            this.meta.total = persistence.taskQueueCount();
            this.meta.finished = persistence.taskQueueDoneCount();
            this.log('服务重启，恢复任务：总数 ' + this.meta.total + '，已完成 ' + this.meta.finished + '，待处理 ' + pending);
            if (this.meta.running) {
                this._startQueue();
                const throttle = this.meta.params.throttle;
                if (throttle && throttle.enabled) {
                    this._scheduleThrottle('run', throttle.runMinutes * 60000);
                }
            }
        }
    }

    _parseAndInsert(params) {
        const type = this.meta.type;
        const items = [];

        const expandBracketRange = (url) => {
            const match = url.match(/\[(\d+)-(\d+)\]/);
            if (!match) return [url];
            const [full, start, end] = match;
            const s = parseInt(start), e = parseInt(end);
            const prefix = url.slice(0, match.index);
            const suffix = url.slice(match.index + full.length);
            const width = start.length;
            const res = [];
            for (let i = Math.min(s, e); i <= Math.max(s, e); i++)
                res.push(prefix + String(i).padStart(width, '0') + suffix);
            return res;
        };

        if (type === 'batch') {
            const { batchText, udpxyUrl } = params;
            const lines = (batchText || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            lines.forEach(line => {
                const parts = line.split(',');
                let name = '', urlRaw = '';
                if (parts.length > 1) { name = parts[0].trim(); urlRaw = parts.slice(1).join(',').trim(); }
                else { urlRaw = parts[0].trim(); }
                name = name.replace(/^[`'"]+|[`'"]+$/g, '');
                urlRaw = urlRaw.replace(/^[`'"]+|[`'"]+$/g, '');
                if (urlRaw) expandBracketRange(urlRaw).forEach(u => items.push({ url: normalizeMulticastUrl(u), udpxyUrl: udpxyUrl || '', name }));
            });
        } else if (type === 'range') {
            const { udpxyUrl, startUrl, endUrl, ports: portStr } = params;
            const parseEndpoint = (url) => {
                const raw = String(url || '').trim();
                const schemeMatch = raw.match(/^(rtp|udp):/i);
                const scheme = schemeMatch ? String(schemeMatch[1]).toLowerCase() : 'rtp';
                let u = raw.replace(/^(rtp|udp):?\/+@?/i, '').replace(/^@/, '');
                const match = u.match(/^([^:]+)(?::(\d+))?$/);
                if (!match) return null;
                if (!match[1].match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) return null;
                return { host: match[1], port: match[2] ? parseInt(match[2], 10) : 0, scheme };
            };
            const ipToInt = ip => ip.split('.').map(Number).reduce((acc, n) => ((acc << 8) | n) >>> 0, 0);
            const intToIp = v => [(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255].join('.');
            const parsePorts = str => {
                const ports = [];
                (str||'').split(',').map(s=>s.trim()).filter(Boolean).forEach(p => {
                    if (p.includes('-')) { const [a,b]=p.split('-').map(Number); if(!isNaN(a)&&!isNaN(b)) for(let i=Math.min(a,b);i<=Math.max(a,b);i++) ports.push(i); }
                    else { const n=Number(p); if(!isNaN(n)) ports.push(n); }
                });
                return [...new Set(ports)];
            };
            const s = parseEndpoint(startUrl), e = parseEndpoint(endUrl);
            if (s && e) {
                const scheme = s.scheme || e.scheme || 'rtp';
                const ports = parsePorts(portStr).length ? parsePorts(portStr) : [s.port || e.port || 0];
                const startInt = ipToInt(s.host), endInt = ipToInt(e.host);
                for (let ip = Math.min(startInt,endInt); ip <= Math.max(startInt,endInt); ip++) {
                    for (const port of ports) {
                        const ipStr = intToIp(ip);
                        const url = port ? `${scheme}://${ipStr}:${port}` : `${scheme}://${ipStr}`;
                        items.push({ url, udpxyUrl: udpxyUrl||'', name: '' });
                    }
                }
            }
        }

        persistence.taskQueueInsertBatch(items);
        return items.length;
    }

    _startQueue() {
        if (this.queue) { this.queue.pause(); this.queue.clear(); }
        this.queue = new PQueue({ concurrency: this.meta.params.concurrency || 20, autoStart: true });
        this._queueStartRequested = false;
        this._driving = false;
        this._driveLoop();
    }

    _startQueueWhenReady() {
        if (this._queueStartRequested) return;
        this._queueStartRequested = true;
        Promise.resolve(this.ready)
            .then(() => {
                this._queueStartRequested = false;
                if (this.meta.running) this._startQueue();
            })
            .catch((err) => {
                this._queueStartRequested = false;
                console.error('Task queue bootstrap failed:', err);
            });
    }

    async _driveLoop() {
        if (this._driving) return;
        this._driving = true;
        const windowSize = (this.meta.params.concurrency || 20) * WINDOW_MULTIPLIER;

        while (this.meta.running) {
            const qSize = (this.queue.size || 0) + (this.queue.pending || 0);
            if (qSize > windowSize / 2) {
                await new Promise(r => setTimeout(r, 200));
                continue;
            }
            const batch = persistence.taskQueueReserveBatch(windowSize);
            if (batch.length === 0) {
                await new Promise(r => setTimeout(r, 500));
                const qSize2 = (this.queue.size || 0) + (this.queue.pending || 0);
                if (qSize2 === 0 && this.meta.running) {
                    this.meta.running = false;
                    this._finishTask();
                }
                break;
            }
            for (const row of batch) {
                if (!this.meta.running) break;
                this.queue.add(() => this._runItem({ id: row.id, url: row.url, udpxyUrl: row.udpxy_url, name: row.name }));
            }
        }
        this._driving = false;
    }

    _runItem(item) {
        return new Promise((resolve) => {
            if (!this.meta.running) { this._releaseItem(item.id); resolve(); return; }
            const fullUrl = buildProxyPlaybackUrl(item.url, item.udpxyUrl);
            const maxAttempts = 1 + (parseInt(this.meta.params.retry) || 0);
            let attempts = 0;

            const execute = async () => {
                try {
                    attempts++;
                    if (!this.meta.running) { this._releaseItem(item.id); resolve(); return; }
                    const isAlive = await checkNetwork(fullUrl);
                    if (!this.meta.running) { this._releaseItem(item.id); resolve(); return; }
                    if (!isAlive) {
                        if (attempts < maxAttempts) setTimeout(execute, 1000);
                        else { this.meta.failCount++; this._finalizeItem(item.id); resolve(); }
                        return;
                    }
                    const cp = ffprobeCheck(fullUrl, (data) => {
                        this.activeProcesses.delete(cp);
                        if (!this.meta.running) {
                            this._releaseItem(item.id);
                            resolve();
                            return;
                        }
                        if (data.isAvailable) {
                            this._handleResult(item, data);
                            this._finalizeItem(item.id);
                            resolve();
                        } else {
                            if (attempts < maxAttempts && this.meta.running) setTimeout(execute, 1000);
                            else { this.meta.failCount++; this._finalizeItem(item.id); resolve(); }
                        }
                    });
                    if (cp) this.activeProcesses.add(cp);
                } catch (e) {
                    console.error('[Task] Error:', e);
                    if (!this.meta.running) {
                        this._releaseItem(item.id);
                        resolve();
                        return;
                    }
                    this.meta.failCount++;
                    this._finalizeItem(item.id);
                    resolve();
                }
            };
            execute();
        });
    }

    _finalizeItem(queueId) {
        persistence.taskQueueMarkDone([queueId]);
        if (this.meta.paused) return;
        this.meta.finished++;
        if (this.meta.finished % 100 === 0) this._saveMeta();
    }

    _releaseItem(queueId) {
        persistence.taskQueueMarkPending([queueId]);
    }

    _handleResult(item, data) {
        if (this.meta.paused) return;
        this.meta.successCount++;
        this.resultBuffer.push({
            ...data,
            udpxyUrl: item.udpxyUrl || this.meta.params.udpxyUrl,
            multicastUrl: item.url,
            name: item.name || data.serviceName || '频道'
        });
    }

    _clearThrottleTimer() {
        if (this._throttleTimer) { clearTimeout(this._throttleTimer); this._throttleTimer = null; }
    }

    _scheduleThrottle(phase, durationMs) {
        this._clearThrottleTimer();
        this._throttlePhase = phase;
        this._throttleStartAt = Date.now();
        this._throttleDurationMs = durationMs;
        this.log('[节流] ' + (phase === 'run' ? '扫描' : '暂停') + ' 阶段，持续 ' + Math.round(durationMs/1000) + ' 秒');
        this._throttleTimer = setTimeout(() => {
            const throttle = this.meta.params.throttle;
            if (!throttle || !throttle.enabled) return;
            if (phase === 'run') {
                this.log('[节流] 扫描时间到，进入暂停阶段');
                this._stopInternal(true);
                this._scheduleThrottle('pause', throttle.pauseMinutes * 60000);
            } else {
                this.log('[节流] 暂停时间到，恢复扫描');
                this.resume();
                this._scheduleThrottle('run', throttle.runMinutes * 60000);
            }
        }, durationMs);
    }

    start(params) {
        if (this.meta.running) return false;
        this.meta.type = params.type || 'batch';
        this.meta.params = { ...params, concurrency: Math.min(parseInt(params.concurrency) || 20, 200) };
        this.meta.startTime = Date.now();
        this.meta.finished = 0;
        this.meta.successCount = 0;
        this.meta.failCount = 0;
        this.meta.logs = [];

        persistence.taskQueueClear();
        const total = this._parseAndInsert(params);
        if (total === 0) {
            this.log('任务启动取消：未识别到有效的扫描项');
            return false;
        }
        this.meta.total = total;
        this.meta.running = true;
        this.meta.paused = false;
        this._saveMeta();
        this.log('任务启动，共 ' + total + ' 条，并发 ' + this.meta.params.concurrency);
        this._startQueueWhenReady();

        const throttle = params.throttle;
        if (throttle && throttle.enabled && throttle.runMinutes > 0) {
            this._scheduleThrottle('run', throttle.runMinutes * 60000);
        }
        return true;
    }

    // 内部停止：仅暂停队列，不清除节流计时器（节流专用）
    _stopInternal(keepThrottle) {
        if (!this.meta.running) return;
        this.meta.running = false;
        this.meta.paused = true;
        if (this.queue) { this.queue.pause(); }
        this.activeProcesses.forEach(cp => { try { cp.kill(); } catch(e) {} });
        this.activeProcesses.clear();
        persistence.taskQueueResetInFlight();
        if (!keepThrottle) this._clearThrottleTimer();
        this._saveMeta();
        this.log('任务已暂停');
    }

    stop() {
        if (!this.meta.running && !this.meta.paused) return false;
        this._clearThrottleTimer();
        this.meta.running = false;
        this.meta.paused = false;
        if (this.queue) { this.queue.pause(); this.queue.clear(); }
        this.activeProcesses.forEach(cp => { try { cp.kill(); } catch(e) {} });
        this.activeProcesses.clear();
        this._finishTask();
        return true;
    }

    resume() {
        if (this.meta.running) return false;
        if (!this.meta.paused) return false;
        this.meta.running = true;
        this.meta.paused = false;
        this._saveMeta();
        this.log('任务恢复');
        this._startQueueWhenReady();
        return true;
    }

    _finishTask() {
        this._clearThrottleTimer();
        this.flushResults();
        const elapsed = Math.round((Date.now() - this.meta.startTime) / 1000);
        this.log('任务完成：成功 ' + this.meta.successCount + '，失败 ' + this.meta.failCount + '，耗时 ' + elapsed + 's');
        this._saveMeta();
        persistence.taskQueueClear();
        persistence.taskMetaDelete('meta');
        if (this.io) this.io.emit('task:done', this.getStatus());
    }

    flushResults() {
        if (this.resultBuffer.length === 0) return;
        const batch = this.resultBuffer.splice(0);
        streamService.addStreamBatch(batch).catch(e => console.error('[Task] flushResults error:', e));
        if (this.io) this.io.emit('task:progress', this.getStatus());
    }

    getStatus() {
        const now = Date.now();
        const elapsed = this.meta.startTime ? Math.round((now - this.meta.startTime) / 1000) : 0;
        const throttle = {};
        if (this._throttlePhase) {
            const remaining = Math.max(0, Math.round((this._throttleStartAt + this._throttleDurationMs - now) / 1000));
            throttle.phase = this._throttlePhase;
            throttle.remainingSeconds = remaining;
        }
        return {
            running: this.meta.running,
            paused: this.meta.paused,
            type: this.meta.type,
            total: this.meta.total,
            finished: this.meta.finished,
            successCount: this.meta.successCount,
            failCount: this.meta.failCount,
            elapsed,
            logs: this.meta.logs,
            throttle: this._throttlePhase ? throttle : null
        };
    }
}

module.exports = new TaskManager();
