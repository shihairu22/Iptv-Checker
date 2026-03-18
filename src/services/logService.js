const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DATA_DIR = path.join(__dirname, '../../data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_TAIL = 2000;
const MAX_RECENT = MAX_TAIL;

const LEVEL_SCORE = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
    FATAL: 50
};

function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function normalizeLevel(level) {
    const upper = String(level || 'INFO').trim().toUpperCase();
    return LEVEL_SCORE[upper] ? upper : 'INFO';
}

function normalizeModule(moduleName) {
    const text = String(moduleName || 'App').trim();
    return text || 'App';
}

function stringifyData(data) {
    if (data === undefined) return '';
    try {
        return JSON.stringify(data);
    } catch (e) {
        return String(data);
    }
}

function parseLine(line) {
    if (!line) return null;
    try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') {
            parsed.level = normalizeLevel(parsed.level);
            parsed.module = normalizeModule(parsed.module);
            parsed.time = parsed.time || new Date().toISOString();
            parsed.message = String(parsed.message || '');
            return parsed;
        }
    } catch (e) {
        // Fall back to wrapping plain-text log lines.
    }
    return {
        time: new Date().toISOString(),
        level: 'INFO',
        module: 'App',
        message: String(line)
    };
}

function readAllEntries() {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) return [];
    try {
        return fs.readFileSync(LOG_FILE, 'utf8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(parseLine)
            .filter(Boolean);
    } catch (e) {
        return [];
    }
}

class LogService extends EventEmitter {
    constructor() {
        super();
        ensureLogDir();
        this.recent = readAllEntries().slice(-MAX_RECENT);
        this.writer = this.createWriter();

        const closeWriter = () => this.close();
        process.once('beforeExit', closeWriter);
        process.once('exit', closeWriter);
    }

    createWriter() {
        const writer = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
        writer.on('error', () => {
            // Keep in-memory logging alive even if the file sink temporarily fails.
        });
        return writer;
    }

    writeToFile(payload) {
        if (this.writer && !this.writer.destroyed) {
            try {
                this.writer.write(payload + '\n');
                return;
            } catch (e) {
                // Fall through to a best-effort async append.
            }
        }
        fs.promises.appendFile(LOG_FILE, payload + '\n', 'utf8').catch(() => {});
    }

    close() {
        if (this.writer && !this.writer.destroyed) {
            this.writer.end();
        }
        this.writer = null;
    }

    write(level, message, moduleName = 'App', data, reqId) {
        const entry = {
            time: new Date().toISOString(),
            level: normalizeLevel(level),
            module: normalizeModule(moduleName),
            reqId: reqId ? String(reqId) : '',
            message: String(message || ''),
            data: data === undefined ? undefined : data
        };

        this.recent.push(entry);
        if (this.recent.length > MAX_RECENT) this.recent.shift();

        const payload = JSON.stringify(entry);
        this.writeToFile(payload);

        const line = `[${entry.time}] [${entry.level}] [${entry.module}] ${entry.message}${entry.data === undefined ? '' : ' ' + stringifyData(entry.data)}`;
        if (entry.level === 'ERROR' || entry.level === 'FATAL') console.error(line);
        else if (entry.level === 'WARN') console.warn(line);
        else console.log(line);

        this.emit('entry', entry);
        return entry;
    }

    debug(message, moduleName = 'App', data, reqId) {
        return this.write('DEBUG', message, moduleName, data, reqId);
    }

    info(message, moduleName = 'App', data, reqId) {
        return this.write('INFO', message, moduleName, data, reqId);
    }

    warn(message, moduleName = 'App', data, reqId) {
        return this.write('WARN', message, moduleName, data, reqId);
    }

    error(message, moduleName = 'App', data, reqId) {
        return this.write('ERROR', message, moduleName, data, reqId);
    }

    matches(entry, filters = {}) {
        const threshold = normalizeLevel(filters.level || 'INFO');
        if ((LEVEL_SCORE[entry.level] || 0) < (LEVEL_SCORE[threshold] || 0)) return false;

        if (filters.module && filters.module !== 'all' && String(entry.module || '').toLowerCase() !== String(filters.module).toLowerCase()) {
            return false;
        }

        if (filters.keyword) {
            const haystack = `${entry.message || ''} ${stringifyData(entry.data)} ${entry.reqId || ''}`.toLowerCase();
            if (!haystack.includes(String(filters.keyword).toLowerCase())) return false;
        }

        return true;
    }

    listFiles() {
        ensureLogDir();
        if (!fs.existsSync(LOG_FILE)) return [];
        const stat = fs.statSync(LOG_FILE);
        return [{ file: path.basename(LOG_FILE), size: stat.size }];
    }

    getFilePath(name) {
        const safe = path.basename(String(name || ''));
        if (safe !== path.basename(LOG_FILE)) return null;
        return fs.existsSync(LOG_FILE) ? LOG_FILE : null;
    }

    getTail(filters = {}, tail = 200) {
        const size = Math.max(1, Math.min(parseInt(tail, 10) || 200, MAX_TAIL));
        const entries = this.recent.filter(entry => this.matches(entry, filters));
        return entries.slice(-size);
    }

    stream(res, filters = {}, tail = 200) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const initial = this.getTail(filters, tail);
        initial.forEach(entry => {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        });

        const onEntry = (entry) => {
            if (!this.matches(entry, filters)) return;
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        };

        const keepAlive = setInterval(() => {
            res.write(': keep-alive\n\n');
        }, 15000);

        this.on('entry', onEntry);
        res.on('close', () => {
            clearInterval(keepAlive);
            this.off('entry', onEntry);
        });
    }
}

module.exports = new LogService();
