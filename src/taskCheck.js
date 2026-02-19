const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { ffprobeCheck } = require('./ffprobe');
const packageJson = require('../package.json');

const STATE_FILE = path.join(__dirname, '../data/current_task.json');
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

        // Ensure data dir
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        // Load state on boot
        this.loadState();
    }

    log(msg) {
        this.task.logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (this.task.logs.length > LOG_SIZE) this.task.logs.pop();
    }

    saveState() {
        try {
            const state = { ...this.task, items: [] }; // Don't save huge list
            fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        } catch (e) { }
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const raw = fs.readFileSync(STATE_FILE, 'utf-8');
                const state = JSON.parse(raw);
                if (state.running || state.paused) {
                    // Restore task
                    this.task = { ...state, items: [] };
                    this.regenerateItems();
                    this.queueIndex = this.task.finished;
                    this.activeWorkers = 0;
                    if (this.task.running) {
                        this.task.paused = true; // Start as paused on reboot
                        this.task.running = false;
                        this.log('服务重启，任务已暂停');
                    }
                }
            }
        } catch (e) {
            this.log('恢复任务状态失败');
        }
    }

    regenerateItems() {
        const { type, params } = this.task;
        this.task.items = [];
        if (type === 'range') {
            const { startUrl, endUrl, ports } = params;
            // ... logic to generate range ...
            // Need ip conversion utils
            const s = this.parseRtp(startUrl);
            const e = this.parseRtp(endUrl);
            const pList = this.parsePorts(ports);
            if (s && e) {
                let a = s.ipInt, b = e.ipInt;
                if (a > b) [a, b] = [b, a];
                const count = b - a + 1;
                // Default port logic
                let targetPorts = pList;
                if (targetPorts.length === 0) {
                    targetPorts = [s.port];
                    if (e.port !== s.port) targetPorts.push(e.port);
                }
                for (let i = 0; i < count; i++) {
                    const ip = this.intToIp(a + i);
                    for (const port of targetPorts) {
                        this.task.items.push({ name: '', url: `rtp://${ip}:${port}` });
                    }
                }
            }
        } else if (type === 'batch') {
            const { batchText } = params;
            const lines = (batchText || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            lines.forEach(line => {
                const parts = line.split(',');
                const name = parts.length > 1 ? parts[0].trim() : '';
                const url = parts.length > 1 ? parts[1].trim() : parts[0].trim();
                const expanded = this.expandBracketRange(url);
                expanded.forEach(u => this.task.items.push({ name, url: u }));
            });
        }
        this.task.total = this.task.items.length;
    }

    // Utils
    intToIp(int) {
        return [(int >>> 24) & 0xFF, (int >>> 16) & 0xFF, (int >>> 8) & 0xFF, int & 0xFF].join('.');
    }
    ipToInt(ip) {
        const parts = ip.split('.').map(Number);
        return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    }
    parseRtp(u) {
        const s = (u || '').trim();
        if (!s.startsWith('rtp://')) return null;
        const body = s.slice(6);
        const parts = body.split(':');
        if (parts.length !== 2) return null;
        return { ipInt: this.ipToInt(parts[0]), port: parseInt(parts[1]), host: parts[0] };
    }
    parsePorts(str) {
        const ports = [];
        const parts = (str || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const p of parts) {
            if (p.includes('-')) {
                const [a, b] = p.split('-').map(Number);
                if (!isNaN(a) && !isNaN(b)) {
                    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) ports.push(i);
                }
            } else {
                const n = Number(p);
                if (!isNaN(n)) ports.push(n);
            }
        }
        return [...new Set(ports)];
    }
    expandBracketRange(url) {
        const match = url.match(/\[(\d+)-(\d+)\]/);
        if (!match) return [url];
        const [full, start, end] = match;
        const s = parseInt(start);
        const e = parseInt(end);
        const prefix = url.slice(0, match.index);
        const suffix = url.slice(match.index + full.length);
        const res = [];
        const fmt = (n) => String(n).padStart(start.length, '0'); // Keep padding? standard behavior usually expects padding if start has leading zeros
        // But let's assume simple number
        for (let i = Math.min(s, e); i <= Math.max(s, e); i++) {
            res.push(`${prefix}${i}${suffix}`);
        }
        return res;
    }

    start(params) {
        if (this.task.running) return false;

        // Init task
        this.task.type = params.type;
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

        this.log(`任务启动: ${this.task.type} 扫描，总数 ${this.task.total}`);
        this.saveState();
        this.processQueue();
        return true;
    }

    stop() {
        if (!this.task.running) return;
        this.task.running = false;
        this.task.paused = true;
        this.log('任务已暂停');
        this.saveState();
    }

    resume() {
        if (!this.task.items.length && this.task.params) {
            this.regenerateItems();
        }
        if (this.task.finished >= this.task.total) return false;

        this.task.running = true;
        this.task.paused = false;
        this.log('任务继续');
        this.processQueue();
        return true;
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
            version: packageJson.version // Add version
        };
    }

    processQueue() {
        if (!this.task.running || this.task.paused) return;

        // High concurrency loop
        while (this.activeWorkers < this.task.concurrency && this.queueIndex < this.task.items.length) {
            const item = this.task.items[this.queueIndex];
            const currentIndex = this.queueIndex; // capture scope
            this.queueIndex++;
            this.activeWorkers++;

            let fullUrl = item.url;
            let udpxy = this.task.params.udpxyUrl || '';
            // Construct full URL
            if (fullUrl.startsWith('rtp://')) {
                fullUrl = `${udpxy}/rtp/${fullUrl.replace('rtp://', '')}`;
            }

            ffprobeCheck(fullUrl, (data) => {
                this.activeWorkers--;
                this.task.finished++;

                if (data.isAvailable) {
                    this.task.successCount++;
                    // Emit result
                    this.emit('result', {
                        ...data,
                        originalUrl: item.url,
                        name: item.name,
                        udpxy: udpxy
                    });
                } else {
                    this.task.failCount++;
                }

                // Log every 50 or on success
                if (data.isAvailable || this.task.finished % 20 === 0) {
                    const status = data.isAvailable ? '✅在线' : '❌离线';
                    this.log(`${status}: ${item.url} (${data.resolution || '-'})`);
                }

                // Check completion
                if (this.activeWorkers === 0 && this.queueIndex >= this.task.items.length) {
                    this.task.running = false;
                    this.task.paused = false;
                    this.log(`任务完成。在线: ${this.task.successCount}`);
                    this.emit('complete');
                    this.saveState();
                } else {
                    // Save state occasionally
                    if (this.task.finished % 10 === 0) this.saveState();

                    // Trigger next
                    setImmediate(() => this.processQueue());
                }
            });
        }
    }
}

module.exports = new TaskManager();
