/**
 * 扫描任务执行器（后台任务 + 滑动窗口 + 节流 + 断点续传）
 *
 * 设计来源：legacy 分支（iptv-checker 1.4.2）的 TaskManager。
 * 与上游（channel-sentinel 2.0.1）的差异点：
 *   - 上游是「一次请求跑一批、跑完即丢」（services/stream.js 里 limit=5 的内存池）
 *   - 这里把地址池落到 SQLite，内存只保留 concurrency × WINDOW_MULTIPLIER 的滑动窗口，
 *     支持服务重启后续跑、支持扫描/暂停分阶段节流、支持可配置并发与失败重试
 *
 * 探测与落库都可注入（便于单测）：默认用 streamService.ffprobeCheckAsync + storage.syncStreamsUpsert。
 */

const { EventEmitter } = require('events');

const WINDOW_MULTIPLIER = 3;
const LOG_SIZE = 200;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMulticastUrl(raw) {
    const text = String(raw || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
    if (!text) return '';
    if (/^(rtp|udp|rtsp|rtsps|http|https):\/\//i.test(text)) return text;
    if (/^(rtp|udp|rtsp|rtsps):@?/i.test(text)) {
        const m = text.match(/^(rtp|udp|rtsp|rtsps):@?(.+)$/i);
        return m ? `${m[1].toLowerCase()}://${m[2]}` : text;
    }
    return `rtp://${text.replace(/^\/+/, '')}`;
}

/** user@239.1.1.[1-5]:5000 → 展开成 5 条 */
function expandBracketRange(url) {
    const m = String(url || '').match(/\[(\d+)-(\d+)\]/);
    if (!m) return [url];
    const [full, start, end] = m;
    const s = parseInt(start, 10);
    const e = parseInt(end, 10);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return [url];
    const prefix = url.slice(0, m.index);
    const suffix = url.slice(m.index + full.length);
    const width = start.length;
    const out = [];
    for (let i = Math.min(s, e); i <= Math.max(s, e); i += 1) {
        out.push(prefix + String(i).padStart(width, '0') + suffix);
    }
    return out;
}

/** 批量文本：每行 name,url 或 url；# 开头跳过 */
function parseBatchText(text, udpxyUrl) {
    const items = [];
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const line of lines) {
        const parts = line.split(',');
        let name = '';
        let urlRaw = '';
        if (parts.length > 1) {
            name = parts[0].trim();
            urlRaw = parts.slice(1).join(',').trim();
        } else {
            urlRaw = parts[0].trim();
        }
        name = name.replace(/^[`'"]+|[`'"]+$/g, '');
        const url = normalizeMulticastUrl(urlRaw);
        if (!url) continue;
        for (const expanded of expandBracketRange(url)) {
            items.push({ url: expanded, udpxyUrl: udpxyUrl || '', name });
        }
    }
    return items;
}

function ipToInt(ip) {
    return ip.split('.').map(Number).reduce((acc, n) => ((acc << 8) | n) >>> 0, 0);
}

function intToIp(v) {
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

function parseEndpoint(rawUrl) {
    const raw = String(rawUrl || '').trim();
    const schemeMatch = raw.match(/^(rtp|udp):/i);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'rtp';
    const body = raw.replace(/^(rtp|udp):?\/+@?/i, '').replace(/^@/, '');
    const m = body.match(/^([^:]+)(?::(\d+))?$/);
    if (!m) return null;
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(m[1])) return null;
    return { host: m[1], port: m[2] ? parseInt(m[2], 10) : 0, scheme };
}

function parsePorts(str) {
    const ports = [];
    String(str || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((p) => {
        if (p.includes('-')) {
            const [a, b] = p.split('-').map(Number);
            if (!Number.isNaN(a) && !Number.isNaN(b)) {
                for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) ports.push(i);
            }
        } else {
            const n = Number(p);
            if (!Number.isNaN(n)) ports.push(n);
        }
    });
    return [...new Set(ports)];
}

/** 网段/端口段：startUrl ~ endUrl（含），端口可指定多段 */
function parseRange({ udpxyUrl, startUrl, endUrl, ports } = {}) {
    const s = parseEndpoint(startUrl);
    const e = parseEndpoint(endUrl);
    if (!s || !e) return [];
    const scheme = s.scheme || e.scheme || 'rtp';
    const portList = parsePorts(ports);
    const effectivePorts = portList.length ? portList : [s.port || e.port || 0];
    const startInt = ipToInt(s.host);
    const endInt = ipToInt(e.host);
    const items = [];
    for (let ip = Math.min(startInt, endInt); ip <= Math.max(startInt, endInt); ip += 1) {
        for (const port of effectivePorts) {
            const host = intToIp(ip);
            const url = port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
            items.push({ url, udpxyUrl: udpxyUrl || '', name: '' });
        }
    }
    return items;
}

function buildPlaybackUrl(multicastUrl, udpxyUrl) {
    const base = String(udpxyUrl || '').trim().replace(/\/+$/, '');
    if (!base) return multicastUrl;
    const m = String(multicastUrl || '').match(/^([a-z]+):\/\/(.+)$/i);
    const scheme = m ? m[1].toLowerCase() : 'rtp';
    const rest = m ? m[2] : String(multicastUrl || '');
    return `${base}/${scheme}/${rest}`;
}

class ScanRunner extends EventEmitter {
    constructor(options = {}) {
        super();
        this.queue = options.queue || null;
        this.probe = options.probe || null;
        this.sink = options.sink || null;
        this.logger = options.logger || null;
        this.windowMultiplier = options.windowMultiplier || WINDOW_MULTIPLIER;
        this.meta = {
            running: false,
            paused: false,
            type: '',
            udpxyUrl: '',
            name: '',
            defaultHttpParam: '',
            concurrency: 20,
            retry: 0,
            throttle: null,
            total: 0,
            finished: 0,
            success: 0,
            failed: 0,
            startedAt: 0,
            logs: []
        };
        this._buffer = [];
        this._inflight = 0;
        this._driving = false;
        this._throttleTimer = null;
        this._throttlePhase = '';
        this._throttleUntil = 0;
        this._ready = null;
    }

    _deps() {
        if (this.queue && this.probe && this.sink) return { queue: this.queue, probe: this.probe, sink: this.sink };
        /* eslint-disable global-require */
        const { getDefaultQueue } = require('./scan-queue');
        const streamService = require('./stream');
        const storage = require('../storage');
        const logger = require('../core/logger');
        /* eslint-enable global-require */

        const queue = this.queue || getDefaultQueue();
        const probe = this.probe || ((fullUrl) => streamService.ffprobeCheckAsync(fullUrl));
        const sink = this.sink || (async ({ row, probeResult, meta }) => {
            const fields = streamService.buildDetectFields(row.udpxyUrl || meta.udpxyUrl || '', row.url, probeResult);
            const record = streamService.buildNewStreamRecord(
                fields,
                row.name || meta.name || '',
                probeResult && probeResult.serviceName,
                meta.defaultHttpParam || ''
            );
            storage.syncStreamsUpsert(record);
        });
        this.queue = queue;
        this.probe = probe;
        this.sink = sink;
        this.logger = this.logger || logger;
        return { queue, probe, sink };
    }

    async init() {
        if (this._ready) return this._ready;
        this._ready = (async () => {
            const { queue } = this._deps();
            await queue.ensureSchema();
            await queue.resetInFlight();
            const saved = await queue.loadMeta();
            if (saved && (saved.running || saved.paused)) {
                const counts = await queue.counts();
                if (counts.pending === 0 && counts.inFlight === 0) {
                    this.log('检测到残留任务状态但队列已空，自动重置');
                    await queue.clearMeta();
                } else {
                    this.meta = { ...this.meta, ...saved, logs: [] };
                    this.meta.total = counts.total;
                    this.meta.finished = counts.done + counts.failed;
                    this.log(`服务重启，恢复任务：总数 ${this.meta.total}，已完成 ${this.meta.finished}，待处理 ${counts.pending}`);
                    if (this.meta.running) this._startThrottleIfNeeded();
                    this._resumeDrive();
                }
            }
        })().catch((err) => {
            this._ready = null;
            throw err;
        });
        return this._ready;
    }

    log(message) {
        const line = `[${new Date().toLocaleTimeString()}] ${message}`;
        this.meta.logs.unshift(line);
        if (this.meta.logs.length > LOG_SIZE) this.meta.logs.pop();
        this.emit('log', line);
        if (this.logger && typeof this.logger.info === 'function') {
            this.logger.info(`[scan] ${message}`, 'ScanRunner');
        }
    }

    _persist() {
        const { queue } = this._deps();
        const payload = { ...this.meta, logs: this.meta.logs.slice(0, 20) };
        queue.saveMeta(payload).catch(() => {});
    }

    async start(params = {}) {
        await this.init();
        const { queue } = this._deps();
        if (this.meta.running) {
            return { started: false, reason: '任务进行中', status: await this.getStatus() };
        }

        const type = params.type === 'range' ? 'range' : 'batch';
        const items = type === 'range' ? parseRange(params) : parseBatchText(params.batchText, params.udpxyUrl);
        if (items.length === 0) {
            return { started: false, reason: '未识别到有效扫描项' };
        }

        await queue.clear();
        await queue.clearMeta();
        await queue.insertMany(items);

        const concurrency = Math.max(1, Math.min(parseInt(params.concurrency, 10) || 20, 200));
        this.meta = {
            running: true,
            paused: false,
            type,
            udpxyUrl: String(params.udpxyUrl || ''),
            name: String(params.name || ''),
            defaultHttpParam: String(params.defaultHttpParam || ''),
            concurrency,
            retry: Math.max(0, Math.min(parseInt(params.retry, 10) || 0, 5)),
            throttle: params.throttle && params.throttle.enabled ? {
                enabled: true,
                runMinutes: Math.max(1, parseInt(params.throttle.runMinutes, 10) || 30),
                pauseMinutes: Math.max(1, parseInt(params.throttle.pauseMinutes, 10) || 10)
            } : null,
            total: items.length,
            finished: 0,
            success: 0,
            failed: 0,
            startedAt: Date.now(),
            logs: []
        };
        this._buffer = [];
        this._inflight = 0;
        this.log(`任务启动：${type === 'range' ? '网段扫描' : '批量列表'}，共 ${items.length} 项，并发 ${concurrency}`);
        this._persist();
        this._startThrottleIfNeeded();
        this._resumeDrive();
        return { started: true, total: items.length, concurrency };
    }

    _startThrottleIfNeeded() {
        const throttle = this.meta.throttle;
        if (!throttle || !throttle.enabled) return;
        this._scheduleThrottle('run', throttle.runMinutes * 60000);
    }

    _clearThrottleTimer() {
        if (this._throttleTimer) {
            clearTimeout(this._throttleTimer);
            this._throttleTimer = null;
        }
    }

    _scheduleThrottle(phase, durationMs) {
        this._clearThrottleTimer();
        this._throttlePhase = phase;
        this._throttleUntil = Date.now() + durationMs;
        this.log(`[节流] ${phase === 'run' ? '扫描' : '暂停'}阶段，持续 ${Math.round(durationMs / 1000)} 秒`);
        this._throttleTimer = setTimeout(() => {
            const throttle = this.meta.throttle;
            if (!throttle || !throttle.enabled) return;
            if (phase === 'run') {
                this.log('[节流] 扫描时间到，进入暂停阶段');
                this._pauseInternal();
                this._scheduleThrottle('pause', throttle.pauseMinutes * 60000);
            } else {
                this.log('[节流] 暂停时间到，恢复扫描');
                this._resumeDrive();
                this._scheduleThrottle('run', throttle.runMinutes * 60000);
            }
        }, durationMs);
        if (this._throttleTimer.unref) this._throttleTimer.unref();
    }

    _pauseInternal() {
        this.meta.running = false;
        this.meta.paused = true;
        this._persist();
    }

    _resumeDrive() {
        this.meta.running = true;
        this.meta.paused = false;
        this._persist();
        this._drive().catch((err) => this.log(`驱动异常: ${err && err.message ? err.message : err}`));
    }

    async stop() {
        await this.init();
        const { queue } = this._deps();
        this.meta.running = false;
        this.meta.paused = false;
        this._clearThrottleTimer();
        const leftovers = this._buffer.splice(0, this._buffer.length);
        if (leftovers.length) await queue.release(leftovers.map((r) => r.id));
        this.log('任务已停止（在飞项完成后回填为待处理）');
        this._persist();
        return this.getStatus();
    }

    async resume() {
        await this.init();
        if (this.meta.running) return this.getStatus();
        const { queue } = this._deps();
        const counts = await queue.counts();
        if (counts.pending === 0 && counts.inFlight === 0) {
            this.log('无可续跑项');
            return this.getStatus();
        }
        this.log(`续跑：待处理 ${counts.pending}`);
        this._startThrottleIfNeeded();
        this._resumeDrive();
        return this.getStatus();
    }

    async _drive() {
        if (this._driving) return;
        this._driving = true;
        const { queue } = this._deps();
        const windowSize = Math.max(1, this.meta.concurrency * this.windowMultiplier);
        try {
            while (this.meta.running) {
                if (this._buffer.length >= windowSize) {
                    await sleep(150);
                    continue;
                }
                const rows = await queue.reserveBatch(windowSize - this._buffer.length);
                if (rows.length === 0) {
                    if (this._buffer.length === 0 && this._inflight === 0) {
                        await this._finish();
                        break;
                    }
                    await sleep(200);
                    continue;
                }
                this._buffer.push(...rows);
                this._pump();
            }
        } finally {
            this._driving = false;
        }
    }

    _pump() {
        while (this.meta.running && this._inflight < this.meta.concurrency && this._buffer.length > 0) {
            const row = this._buffer.shift();
            this._inflight += 1;
            this._runItem(row)
                .catch((err) => this.log(`单项异常: ${err && err.message ? err.message : err}`))
                .finally(() => {
                    this._inflight -= 1;
                    this._pump();
                });
        }
    }

    async _runItem(row) {
        const { queue } = this._deps();
        if (!this.meta.running) {
            await queue.release([row.id]);
            return;
        }
        const fullUrl = buildPlaybackUrl(row.url, row.udpxyUrl || this.meta.udpxyUrl);
        const maxAttempts = 1 + (this.meta.retry || 0);
        let lastError = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (!this.meta.running) {
                await queue.release([row.id]);
                return;
            }
            try {
                const probeResult = await this.probe(fullUrl, row);
                if (!this.meta.running) {
                    await queue.release([row.id]);
                    return;
                }
                if (probeResult && probeResult.isAvailable) {
                    await this.sink({ row, probeResult, meta: this.meta, fullUrl });
                    await queue.markDone([row.id]);
                    this.meta.success += 1;
                    this.meta.finished += 1;
                    this._afterItem();
                    return;
                }
                lastError = '流不可访问';
            } catch (err) {
                lastError = err && err.message ? err.message : String(err);
            }
            if (attempt < maxAttempts) await sleep(1000);
        }
        if (!this.meta.running) {
            await queue.release([row.id]);
            return;
        }
        await queue.markFailed([row.id], lastError);
        this.meta.failed += 1;
        this.meta.finished += 1;
        this._afterItem();
    }

    _afterItem() {
        if (this.meta.finished % 25 === 0) this._persist();
        this.emit('progress', {
            finished: this.meta.finished,
            total: this.meta.total,
            success: this.meta.success,
            failed: this.meta.failed
        });
    }

    async _finish() {
        this.meta.running = false;
        this.meta.paused = false;
        this._clearThrottleTimer();
        this.log(`任务完成：成功 ${this.meta.success}，失败 ${this.meta.failed}，共 ${this.meta.total}`);
        try {
            const { queue } = this._deps();
            await queue.clearMeta();
        } catch (e) { /* meta 清理失败不影响结果 */ }
        this._persist();
        this.emit('done', await this.getStatus());
    }

    async getStatus() {
        const { queue } = this._deps();
        await queue.ensureSchema();
        const counts = await queue.counts();
        const elapsedSeconds = this.meta.startedAt ? Math.floor((Date.now() - this.meta.startedAt) / 1000) : 0;
        return {
            running: !!this.meta.running,
            paused: !!this.meta.paused,
            type: this.meta.type,
            concurrency: this.meta.concurrency,
            retry: this.meta.retry,
            progress: {
                total: counts.total,
                finished: counts.done + counts.failed,
                success: this.meta.success,
                failed: this.meta.failed,
                pending: counts.pending,
                inFlight: counts.inFlight
            },
            throttle: this.meta.throttle ? {
                ...this.meta.throttle,
                phase: this._throttlePhase,
                remainingSeconds: this._throttleUntil ? Math.max(0, Math.floor((this._throttleUntil - Date.now()) / 1000)) : 0
            } : null,
            elapsedSeconds,
            logs: this.meta.logs.slice(0, 20)
        };
    }
}

let singleton = null;
function getRunner() {
    if (!singleton) singleton = new ScanRunner();
    return singleton;
}

module.exports = {
    ScanRunner,
    getRunner,
    parseBatchText,
    parseRange,
    normalizeMulticastUrl,
    expandBracketRange,
    buildPlaybackUrl,
    WINDOW_MULTIPLIER
};
