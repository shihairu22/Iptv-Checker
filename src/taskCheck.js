const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { ffprobeCheck } = require('./ffprobe');
const persistence = require('./services/persistenceService');
const streamService = require('./services/streamService');
const packageJson = require('../package.json');

const STATE_FILE = 'current_task.json';
const LOG_SIZE = 50;

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
        this.activeWorkers = 0;
        this.queueIndex = 0;
        this.resultBuffer = []; // 暂存检查结果，批量写入

        // 初始化加载状态
        this.init().catch(err => console.error('Task init failed:', err));
    }

    async init() {
        await this.loadState();
        setInterval(() => this.flushResults(), 3000); // 定时将结果写入 disk
    }

    log(msg) {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.task.logs.unshift(line);
        if (this.task.logs.length > LOG_SIZE) this.task.logs.pop();
        console.log('[TaskManager]', msg);
    }

    async saveState() {
        // 保存时剔除 items 大数组以减小 IO，items 启动时重新生成或单独存储
        // 为简单起见，如果 items 不大可以存。但在 IPTV 场景 items 可能很大。
        // 策略：只存 params，重启时 regenerate items，然后 fast-forward 到 finished 索引
        const stateToSave = {
            ...this.task,
            items: [] // 暂不存 items，靠 regenerate
        };
        await persistence.writeJson(STATE_FILE, stateToSave);
    }

    async loadState() {
        const state = await persistence.readJson(STATE_FILE, null);
        if (state && (state.running || state.paused)) {
            this.task = { ...state, items: [] };
            this.regenerateItems();

            // 恢复进度
            this.queueIndex = this.task.finished;
            this.activeWorkers = 0;

            if (this.task.running) {
                this.task.running = true; // 保持运行状态
                this.log('服务重启，正在恢复之前的扫描任务...');
                this.processQueue();
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

            // 辅助函数：解析 IP 和端口
            const parseRtp = (url) => {
                const u = (url || '').trim();
                const match = u.match(/rtp:\/\/([^:]+):(\d+)/);
                if (!match) return null;
                return { host: match[1], port: parseInt(match[2], 10) };
            };

            const ipToInt = (ip) => {
                const parts = ip.split('.').map(Number);
                return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
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
            }
        }

        this.task.total = this.task.items.length;
    }

    start(params) {
        if (this.task.running) return false;

        this.task.type = params.type || 'batch';
        this.task.params = params;
        this.task.concurrency = parseInt(params.concurrency) || 5;
        this.task.startTime = Date.now();
        this.task.finished = 0;
        this.task.successCount = 0;
        this.task.failCount = 0;
        this.task.logs = [];

        this.regenerateItems();

        this.queueIndex = 0;
        this.activeWorkers = 0;
        this.task.running = true;
        this.task.paused = false;

        this.log(`任务启动，共 ${this.task.total} 条，并发 ${this.task.concurrency}`);
        this.saveState();
        this.processQueue();
        return true;
    }

    stop() {
        if (!this.task.running) return;
        this.task.running = false;
        this.task.paused = true;
        this.log('任务已手动暂停');
        this.saveState();
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
        }
    }

    processQueue() {
        if (!this.task.running || this.task.paused) return;

        // 填充 worker 直到达到并发限制
        while (this.activeWorkers < this.task.concurrency && this.queueIndex < this.task.items.length) {
            const item = this.task.items[this.queueIndex];
            this.queueIndex++;
            this.activeWorkers++;

            this.checkOne(item).then(() => {
                this.activeWorkers--;
                this.task.finished++;

                // 检查完成
                if (this.activeWorkers === 0 && this.queueIndex >= this.task.items.length) {
                    this.finishTask();
                } else if (this.task.running) {
                    // 继续处理
                    // 使用 setImmediate 防止栈溢出，给 IO 喘息机会
                    setImmediate(() => this.processQueue());
                }
            });
        }
    }

    async checkOne(item) {
        if (!this.task.running) return;

        let fullUrl = item.url;
        let udpxy = item.udpxyUrl || this.task.params.udpxyUrl || '';

        // 构造完整请求地址
        if (fullUrl.startsWith('rtp://') && udpxy) {
            fullUrl = `${udpxy}/rtp/${fullUrl.replace('rtp://', '')}`;
        }

        return new Promise(resolve => {
            ffprobeCheck(fullUrl, (data) => {
                const isSuccess = data.isAvailable;

                if (isSuccess) {
                    this.task.successCount++;
                    const resultItem = {
                        ...data,
                        udpxyUrl: udpxy,
                        multicastUrl: item.url, // 原始地址
                        name: item.name || data.serviceName || '频道'
                    };
                    // 加入缓存，批量写入
                    this.resultBuffer.push(resultItem);
                } else {
                    this.task.failCount++;
                }

                // 记录日志 (每 10 条或成功时)
                if (isSuccess || this.task.finished % 10 === 0) {
                    // this.log(`${isSuccess?'✅':'❌'} ${item.name||item.url}`);
                }

                // 阶段性保存状态 (每 20 条)
                if (this.task.finished % 20 === 0) {
                    this.saveState();
                }

                resolve();
            });
        });
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
