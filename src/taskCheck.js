const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { ffprobeCheck } = require('./ffprobe');
const { checkNetwork } = require('./networkCheck');
const persistence = require('./services/persistenceService');
const streamService = require('./services/streamService');
const packageJson = require('../package.json');


const STATE_FILE = 'current_task.json';
const LOG_SIZE = 50;

let PQueue;
(async () => {
    try {
        // 设置超时，防止在某些环境下 PQueue 导入无限挂起
        const importPromise = import('p-queue');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('PQueue import timeout')), 10000));
        const m = await Promise.race([importPromise, timeoutPromise]);
        PQueue = m.default;
    } catch (e) {
        console.error('Failed to import p-queue:', e);
        // 提供一个极简的模拟，防止 init 循环死锁
        PQueue = class MockQueue {
            constructor(opts) {
                this.concurrency = (opts && opts.concurrency) || 1;
                this.autoStart = (opts && opts.autoStart) !== false;
            }
            add(fn) { return Promise.resolve().then(fn); }
            pause() { }
            clear() { }
            start() { }
        };
    }
})();

class TaskManager extends EventEmitter {
    constructor() {
        super();
        this.task = {
            running: false,
            paused: false,
            type: '',
            params: {},
            items: [],
            finished: 0,
            total: 0,
            successCount: 0,
            failCount: 0,
            startTime: 0,
            logs: [],
            concurrency: 5
        };
        this.queue = null; // PQueue instance
        this.resultBuffer = [];
        this.activeProcesses = new Set(); // 追踪运行中的子进程
        this.io = null;

        // 初始化加载状态
        this.init().catch(err => console.error('Task init failed:', err));
    }

    setIo(io) {
        this.io = io;
    }

    async init() {
        // Wait for PQueue to be loaded
        while (!PQueue) {
            await new Promise(r => setTimeout(r, 100));
        }

        await this.loadState();
        setInterval(() => this.flushResults(), 3000);
    }

    log(msg) {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.task.logs.unshift(line);
        if (this.task.logs.length > LOG_SIZE) this.task.logs.pop();
        console.log('[TaskManager]', msg);
        if (this.io) this.io.emit('task:log', line);
    }

    async saveState() {
        // 保存时剔除 items 大数组以减小 IO
        const stateToSave = {
            ...this.task,
            items: []
        };
        await persistence.writeJson(STATE_FILE, stateToSave);
    }

    async loadState() {
        const state = await persistence.readJson(STATE_FILE, null);
        if (state && (state.running || state.paused)) {
            this.task = { ...state, items: [] };
            this.regenerateItems();

            // 关键修复：如果恢复后发现没有 items 但标记为正在运行，说明是由于之前的 Bug 导致的僵死任务，立即清理
            if (this.task.total === 0 && (this.task.running || this.task.paused)) {
                this.log('检测到无效的持久化扫描状态 (0 条目)，已自动重置。');
                this.task.running = false;
                this.task.paused = false;
                this.saveState();
                return;
            }

            // 恢复进度
            if (this.task.running) {
                this.task.running = true;
                this.log('服务重启，正在恢复之前的扫描任务 (Direct Mode)...');

                // 恢复队列
                if (this.queue) {
                    this.queue.pause();
                    this.queue.clear();
                }
                this.queue = new PQueue({ concurrency: this.task.concurrency, autoStart: true });

                // 跳过已完成的
                for (let i = this.task.finished; i < this.task.items.length; i++) {
                    this.queue.add(() => this.runItem(this.task.items[i]));
                }

                if (typeof this.queue.start === 'function') {
                    this.queue.start();
                }
            } else {
                this.log('服务重启，任务处于暂停状态');
            }
        }
    }

    regenerateItems() {
        const { type, params } = this.task;
        this.task.items = [];

        if (type === 'batch') {
            const { batchText, udpxyUrl } = params;
            const lines = (batchText || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

            // 处理 [1-10] 范围
            const expandBracketRange = (url) => {
                const match = url.match(/\[(\d+)-(\d+)\]/);
                if (!match) return [url];
                const [full, start, end] = match;
                const s = parseInt(start);
                const e = parseInt(end);
                const prefix = url.slice(0, match.index);
                const suffix = url.slice(match.index + full.length);
                const res = [];
                const width = start.length; // 保持前导零宽度
                for (let i = Math.min(s, e); i <= Math.max(s, e); i++) {
                    res.push(`${prefix}${String(i).padStart(width, '0')}${suffix}`);
                }
                return res;
            };

            lines.forEach(line => {
                // 格式可能是: "CCTV1,rtp://..." 或 "http://..."
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
                urlRaw = urlRaw.replace(/^[`'"]+|[`'"]+$/g, '');

                if (urlRaw) {
                    const expanded = expandBracketRange(urlRaw);
                    expanded.forEach(u => this.task.items.push({ name, url: u, udpxyUrl }));
                }
            });
        } else if (type === 'range') {
            const { udpxyUrl, startUrl, endUrl, ports: portStr } = params;

            // 辅助函数：解析 IP 和端口 (增强灵活性)
            const parseRtp = (url) => {
                let u = (url || '').trim();
                // 移除常见的前缀和符号
                u = u.replace(/^(rtp|udp):\/\/@?/, '').replace(/^@/, '');

                // 匹配 IP:PORT 或是 单独的 IP
                const match = u.match(/^([^:]+)(?::(\d+))?$/);
                if (!match) return null;

                let host = match[1];
                let port = match[2] ? parseInt(match[2], 10) : 0;

                // 验证是否为有效 IP 格式
                if (!host.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) return null;

                return { host, port };
            };

            const ipToInt = (ip) => {
                const parts = ip.split('.').map(Number);
                return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
            };

            const intToIp = (intv) => {
                const a = (intv >>> 24) & 255;
                const b = (intv >>> 16) & 255;
                const c = (intv >>> 8) & 255;
                const d = intv & 255;
                return `${a}.${b}.${c}.${d}`;
            };

            const parsePorts = (str) => {
                const ports = [];
                const parts = (str || '').split(',').map(s => s.trim()).filter(Boolean);
                for (const p of parts) {
                    if (p.includes('-')) {
                        const [start, end] = p.split('-').map(Number);
                        if (!isNaN(start) && !isNaN(end)) {
                            for (let i = Math.min(start, end); i <= Math.max(start, end); i++) ports.push(i);
                        }
                    } else {
                        const n = Number(p);
                        if (!isNaN(n)) ports.push(n);
                    }
                }
                return [...new Set(ports)];
            };

            const s = parseRtp(startUrl);
            const e = parseRtp(endUrl);
            this.log(`Range init: startUrl=${startUrl} endUrl=${endUrl} s=${JSON.stringify(s)} e=${JSON.stringify(e)}`);

            if (s && e) {
                let startIp = ipToInt(s.host);
                let endIp = ipToInt(e.host);
                if (startIp > endIp) [startIp, endIp] = [endIp, startIp];

                // 端口列表：优先使用 params.ports，否则使用 StartUrl/EndUrl 中的端口
                let ports = parsePorts(portStr);
                if (ports.length === 0) {
                    ports.push(s.port);
                    if (e.port !== s.port) ports.push(e.port);
                }

                // 生成任务项
                for (let ip = startIp; ip <= endIp; ip++) {
                    const currentIp = intToIp(ip);
                    for (const port of ports) {
                        this.task.items.push({
                            name: '',
                            url: `rtp://${currentIp}:${port}`,
                            udpxyUrl
                        });
                    }
                }
            } else {
                this.log(`Range parse failed. s=${!!s} e=${!!e}`);
            }
        }

        this.task.total = this.task.items.length;
        const MAX_ITEMS = 500000;
        if (this.task.items.length > MAX_ITEMS) {
            this.task.items = this.task.items.slice(0, MAX_ITEMS);
            this.task.total = MAX_ITEMS;
            this.log(`警告：条目数超过上限，已截断至 ${MAX_ITEMS} 条`);
        }
        if (this.task.total === 0 && (type === 'batch' || type === 'range')) {
            this.log(`警告：解析后扫描条目为 0。请检查输入是否包含有效的 IP 或 URL。参数预览: ${JSON.stringify(params)}`);
            // 如果在运行中发现总数为 0，强制停止
            if (this.task.running || this.task.paused) {
                this.task.running = false;
                this.task.paused = false;
                this.saveState();
            }
        }
    }

    start(params) {
        if (this.task.running) return false;

        this.task.type = params.type || 'batch';
        this.task.params = params;
        // 限制并发上限
        this.task.concurrency = Math.min(parseInt(params.concurrency) || 20, 50);
        this.task.startTime = Date.now();
        this.task.finished = 0;
        this.task.successCount = 0;
        this.task.failCount = 0;
        this.task.logs = [];

        this.regenerateItems();

        if (this.task.total === 0) {
            this.log('任务启动取消：未识别到有效的扫描项');
            this.task.running = false;
            this.saveState();
            return false;
        }

        // 初始化队列
        if (this.queue) {
            this.queue.pause();
            this.queue.clear();
        }

        this.queue = new PQueue({ concurrency: this.task.concurrency });

        this.task.running = true;
        this.task.paused = false;

        this.log(`任务启动，共 ${this.task.total} 条，并发 ${this.task.concurrency} (Direct Mode)`);
        this.saveState();

        // 添加任务到队列
        this.task.items.forEach(item => {
            this.queue.add(() => this.runItem(item));
        });

        return true;
    }

    resume() {
        if (!this.task.paused || this.task.running) return false;

        this.task.running = true;
        this.task.paused = false;
        this.log('任务恢复执行 (Direct Mode)...');

        // 重新初始化队列（安全起见）
        if (this.queue) {
            this.queue.pause();
            this.queue.clear();
        }
        this.queue = new PQueue({ concurrency: this.task.concurrency, autoStart: true });

        // 只添加未完成的任务
        for (let i = this.task.finished; i < this.task.items.length; i++) {
            this.queue.add(() => this.runItem(this.task.items[i]));
        }

        // 显式唤醒新队列，防止因版本差异造成的假死
        if (typeof this.queue.start === 'function') {
            this.queue.start();
        }

        this.saveState();
        return true;
    }

    stop() {
        if (!this.task.running) return;
        this.task.running = false;
        this.task.paused = true;

        if (this.queue) {
            this.queue.pause();
            this.queue.clear();
        }

        // 立即杀灭正在运行的子进程，释放系统资源
        for (const cp of this.activeProcesses) {
            try { cp.kill(); } catch (e) { }
        }
        this.activeProcesses.clear();

        this.log('任务已手动暂停，正在运行的任务已强制停止并清理');
        this.saveState();
    }

    // 直接执行逻辑（替代 Worker）
    runItem(item) {
        return new Promise((resolve) => {
            if (!this.task.running) {
                resolve();
                return;
            }

            const { url, udpxyUrl } = item;
            let fullUrl = url;
            // 如果是 rtp 且有 udpxy，则转换
            if (fullUrl.startsWith('rtp://') && udpxyUrl) {
                fullUrl = `${udpxyUrl}/rtp/${fullUrl.replace('rtp://', '')}`;
            }

            // 失败重试逻辑
            const maxAttempts = 1 + (parseInt(this.task.params.retry) || 0);
            let attempts = 0;

            const executeParamCheck = async () => {
                try {
                    attempts++;

                    // 如果任务中途暂停，停止重试
                    if (!this.task.running) {
                        resolve();
                        return;
                    }

                    // 1. Pre-flight Network Check (Fast Fail)
                    const isNetAlive = await checkNetwork(fullUrl);

                    // Double check running state after await
                    if (!this.task.running) {
                        resolve();
                        return;
                    }

                    if (!isNetAlive) {
                        // 网络不可达，直接失败，不走 ffprobe，也不重试 (网络都不通，重试大概率没用且浪费时间)
                        // 除非 retry 是针对不稳定网络的? 
                        // 这里策略：如果是 "dead link" (端口关/无组播流)，直接判定无效
                        // 为了保守起见，如果还有重试次数，也可以 continue。但为了性能，我们假设 1s 收不到包就是死的。
                        if (attempts < maxAttempts) {
                            // 稍微 delay 一下再重试，万一是网络抖动
                            setTimeout(executeParamCheck, 1000);
                        } else {
                            this.task.failCount++;
                            this.finalizeItem();
                            resolve();
                        }
                        return;
                    }

                    // 2. Heavy FFprobe Check
                    const cp = ffprobeCheck(fullUrl, (data) => {
                        this.activeProcesses.delete(cp);
                        if (data.isAvailable) {
                            this.handleResult(item, data);
                            this.finalizeItem();
                            resolve();
                        } else {
                            if (attempts < maxAttempts && this.task.running) {
                                // Retry delay
                                setTimeout(executeParamCheck, 1000);
                            } else {
                                this.task.failCount++;
                                this.finalizeItem();
                                resolve();
                            }
                        }
                    });
                    if (cp) this.activeProcesses.add(cp);
                } catch (e) {
                    console.error(`[Task] Error checking ${fullUrl}:`, e);
                    this.task.failCount++;
                    this.finalizeItem();
                    resolve();
                }
            };

            executeParamCheck();
        });
    }

    finalizeItem() {
        if (this.task.paused) return; // 暂停时不计数，留给 resume

        this.task.finished++;
        // 阶段性保存状态 (每 20 条)
        if (this.task.finished % 20 === 0) {
            this.saveState();
        }

        // 防止并发队列中多个 item 同时完成导致 finishTask 被重复调用
        if (this.task.finished >= this.task.total && this.task.running) {
            this.task.running = false; // 原子标记，阻止后续重入
            this.finishTask();
        }
    }

    handleResult(item, data) {
        // 如果暂停了，不再处理结果
        if (this.task.paused) return;

        if (data.isAvailable) {
            this.task.successCount++;
            const resultItem = {
                ...data,
                udpxyUrl: item.udpxyUrl || this.task.params.udpxyUrl,
                multicastUrl: item.url,
                name: item.name || data.serviceName || '频道'
            };
            this.resultBuffer.push(resultItem);
        } else {
            // failCount already incremented in runItem
        }
    }

    getStatus() {
        return {
            running: this.task.running,
            paused: this.task.paused,
            finished: this.task.finished,
            total: this.task.total,
            success: this.task.successCount,
            fail: this.task.failCount,
            logs: this.task.logs,
            version: packageJson.version
        };
    }

    async flushResults() {
        if (this.resultBuffer.length > 0) {
            const batch = [...this.resultBuffer];
            this.resultBuffer = [];
            await streamService.addStreamBatch(batch);

            // 优化: 广播增量数据更新，避免前端全量拉取
            if (this.io && (this.task.running || this.task.paused)) {
                this.io.emit('task:update_data', batch);
            }
        }
        // 广播进度 (每3秒或有结果时)
        if (this.io && (this.task.running || this.task.paused)) {
            this.io.emit('task:progress', this.getStatus());
        }
    }

    async finishTask() {
        this.task.running = false;
        this.task.paused = false;
        this.log(`任务全部完成。有效: ${this.task.successCount}, 无效: ${this.task.failCount}`);
        await this.flushResults(); // 写入剩余结果
        // 清除状态文件或标记为完成
        this.task.type = ''; // 清除类型防止重启再次运行
        this.saveState();
    }
}

module.exports = new TaskManager();
