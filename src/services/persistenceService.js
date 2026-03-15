const fsSync = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'iptv.db');

function ensureDataDirSync() {
    if (!fsSync.existsSync(DATA_DIR)) {
        fsSync.mkdirSync(DATA_DIR, { recursive: true });
    }
}

class PersistenceService {
    constructor() {
        this.dataDir = DATA_DIR;
        this.db = null;
        this._init();
    }

    _init() {
        ensureDataDirSync();
        this.db = new Database(DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this._createTables();
        this._migrate();
    }

    _createTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS kv_store (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS streams (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                udpxy_url     TEXT NOT NULL DEFAULT '',
                multicast_url TEXT NOT NULL DEFAULT '',
                name          TEXT NOT NULL DEFAULT '',
                data          TEXT NOT NULL DEFAULT '{}'
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_streams_url
                ON streams(udpxy_url, multicast_url);
            CREATE TABLE IF NOT EXISTS backups (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                payload    TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_queue (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                url       TEXT NOT NULL,
                udpxy_url TEXT NOT NULL DEFAULT '',
                name      TEXT NOT NULL DEFAULT '',
                status    INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_tq_status ON task_queue(status);
            CREATE TABLE IF NOT EXISTS task_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
    }

    // 首次启动从旧 JSON 文件迁移，迁移完毕后不再依赖 JSON 文件
    _migrate() {
        const done = this.db.prepare("SELECT value FROM kv_store WHERE key='migration_done'").get();
        if (done) return;

        // 迁移流数据
        const streamsFile = path.join(DATA_DIR, 'streams.json');
        if (fsSync.existsSync(streamsFile)) {
            try {
                const raw = fsSync.readFileSync(streamsFile, 'utf-8');
                const data = JSON.parse(raw);
                if (Array.isArray(data.streams) && data.streams.length > 0) {
                    const insert = this.db.prepare(
                        'INSERT OR IGNORE INTO streams(udpxy_url,multicast_url,name,data) VALUES(?,?,?,?)'
                    );
                    this.db.transaction((list) => {
                        for (const s of list) {
                            insert.run(s.udpxyUrl||'', s.multicastUrl||'', s.name||'', JSON.stringify(s));
                        }
                    })(data.streams);
                    console.log(`[DB] 迁移频道 ${data.streams.length} 条`);
                }
                if (data.settings) {
                    this.db.prepare("INSERT OR IGNORE INTO kv_store(key,value) VALUES('settings',?)").run(JSON.stringify(data.settings));
                }
            } catch (e) {
                console.error('[DB] streams.json 迁移失败:', e.message);
            }
        }

        // 迁移配置文件
        const cfgFiles = [
            'logo_templates.json','fcc_servers.json','udpxy_servers.json',
            'group_titles.json','group_rules.json','epg_sources.json',
            'proxy_servers.json','app_settings.json','users.json',
            'sessions.json','current_task.json'
        ];
        for (const f of cfgFiles) {
            const fp = path.join(DATA_DIR, f);
            if (fsSync.existsSync(fp)) {
                try {
                    const raw = fsSync.readFileSync(fp, 'utf-8');
                    this.db.prepare('INSERT OR IGNORE INTO kv_store(key,value) VALUES(?,?)').run(f, raw);
                } catch (e) {
                    console.error(`[DB] ${f} 迁移失败:`, e.message);
                }
            }
        }

        this.db.prepare("INSERT OR REPLACE INTO kv_store(key,value) VALUES('migration_done','1')").run();
        console.log('[DB] 数据迁移完成');
    }

    // ---- kv_store 接口 ----

    validateKey(key) {
        if (!key || typeof key !== 'string') return false;
        if (key.includes('..') || key.includes('/') || key.includes('\\') || key.includes(':')) return false;
        return true;
    }

    // 保持异步签名（调用方不需要改动）
    async readJson(key, defaultObj = {}) {
        if (!this.validateKey(key)) return defaultObj;
        try {
            const row = this.db.prepare('SELECT value FROM kv_store WHERE key=?').get(key);
            if (!row) return defaultObj;
            return JSON.parse(row.value);
        } catch (e) {
            return defaultObj;
        }
    }

    async writeJson(key, obj) {
        if (!this.validateKey(key)) return false;
        try {
            this.db.prepare('INSERT OR REPLACE INTO kv_store(key,value) VALUES(?,?)').run(key, JSON.stringify(obj));
            return true;
        } catch (e) {
            console.error(`[DB] writeJson(${key}) 失败:`, e.message);
            return false;
        }
    }

    // ---- 流数据专用接口 ----

    getAllStreams() {
        return this.db.prepare('SELECT data FROM streams ORDER BY id').all().map(r => JSON.parse(r.data));
    }

    saveAllStreams(streams) {
        const insert = this.db.prepare('INSERT OR REPLACE INTO streams(udpxy_url,multicast_url,name,data) VALUES(?,?,?,?)');
        const del    = this.db.prepare('DELETE FROM streams');
        try {
            this.db.transaction((list) => {
                del.run();
                for (const s of list) insert.run(s.udpxyUrl||'', s.multicastUrl||'', s.name||'', JSON.stringify(s));
            })(streams);
            return true;
        } catch (e) {
            console.error('[DB] saveAllStreams 失败:', e.message);
            return false;
        }
    }

    upsertStream(stream) {
        try {
            this.db.prepare('INSERT OR REPLACE INTO streams(udpxy_url,multicast_url,name,data) VALUES(?,?,?,?)')
                .run(stream.udpxyUrl||'', stream.multicastUrl||'', stream.name||'', JSON.stringify(stream));
            return true;
        } catch (e) {
            console.error('[DB] upsertStream 失败:', e.message);
            return false;
        }
    }

    deleteStream(udpxyUrl, multicastUrl) {
        try {
            this.db.prepare('DELETE FROM streams WHERE udpxy_url=? AND multicast_url=?').run(udpxyUrl||'', multicastUrl||'');
            return true;
        } catch (e) { return false; }
    }

    clearStreams() {
        try { this.db.prepare('DELETE FROM streams').run(); return true; }
        catch (e) { return false; }
    }

    // ---- 备份接口（全走 SQLite，不再写 JSON 文件）----

    async saveWithBackup(name, payload) {
        const ts = new Date();
        const pad = n => String(n).padStart(2,'0');
        const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
        const backupName = (name.replace('.json','')) + `-${stamp}.json`;
        try {
            this.db.prepare('INSERT OR REPLACE INTO backups(name,created_at,payload) VALUES(?,?,?)')
                .run(backupName, Date.now(), JSON.stringify(payload));
            return true;
        } catch (e) {
            console.error('[DB] saveWithBackup 失败:', e.message);
            return false;
        }
    }

    async listBackups(pattern) {
        try {
            return this.db.prepare('SELECT name, created_at FROM backups ORDER BY created_at DESC').all()
                .filter(r => pattern.test(r.name))
                .map(r => ({ file: r.name, time: r.created_at }));
        } catch (e) { return []; }
    }

    // 从备份恢复：读取 payload 并返回，供 streamService.loadFromBackup 使用
    getBackupPayload(name) {
        try {
            const row = this.db.prepare('SELECT payload FROM backups WHERE name=?').get(name);
            if (!row) return null;
            return JSON.parse(row.payload);
        } catch (e) { return null; }
    }

    async deleteBackup(name) {
        if (!this.validateKey(name)) return false;
        try {
            this.db.prepare('DELETE FROM backups WHERE name=?').run(name);
            return true;
        } catch (e) { return false; }
    }

    // 兼容旧调用（persist.js validateFilename 检查）
    validateFilename(filename) {
        return this.validateKey(filename);
    }

    // ---- task_queue 接口 ----

    taskQueueClear() {
        this.db.prepare('DELETE FROM task_queue').run();
        this.db.prepare('DELETE FROM task_meta').run();
    }

    // 批量插入地址（事务，每批 50000 条）
    taskQueueInsertBatch(items) {
        const insert = this.db.prepare('INSERT INTO task_queue(url,udpxy_url,name) VALUES(?,?,?)');
        const CHUNK = 50000;
        for (let i = 0; i < items.length; i += CHUNK) {
            const chunk = items.slice(i, i + CHUNK);
            this.db.transaction((list) => {
                for (const item of list) insert.run(item.url, item.udpxyUrl||'', item.name||'');
            })(chunk);
        }
    }

    // 取下一批待处理条目（status=0）
    taskQueueReserveBatch(limit) {
        return this.db.transaction((size) => {
            const rows = this.db.prepare(
                'SELECT id,url,udpxy_url,name FROM task_queue WHERE status=0 ORDER BY id LIMIT ?'
            ).all(size);
            if (rows.length === 0) return rows;
            const ids = rows.map(row => row.id);
            const placeholders = ids.map(() => '?').join(',');
            this.db.prepare(`UPDATE task_queue SET status=2 WHERE id IN (${placeholders})`).run(...ids);
            return rows;
        })(limit);
    }

    // 标记一批条目为已完成
    taskQueueMarkDone(ids) {
        if (!ids || ids.length === 0) return;
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`UPDATE task_queue SET status=1 WHERE id IN (${placeholders})`).run(...ids);
    }

    taskQueueMarkPending(ids) {
        if (!ids || ids.length === 0) return;
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`UPDATE task_queue SET status=0 WHERE id IN (${placeholders})`).run(...ids);
    }

    taskQueueResetInFlight() {
        this.db.prepare('UPDATE task_queue SET status=0 WHERE status=2').run();
    }

    taskQueueCount() {
        const row = this.db.prepare('SELECT COUNT(*) as n FROM task_queue').get();
        return row ? row.n : 0;
    }

    taskQueuePendingCount() {
        const row = this.db.prepare('SELECT COUNT(*) as n FROM task_queue WHERE status=0').get();
        return row ? row.n : 0;
    }

    taskQueueDoneCount() {
        const row = this.db.prepare('SELECT COUNT(*) as n FROM task_queue WHERE status=1').get();
        return row ? row.n : 0;
    }

    // ---- task_meta 接口 ----

    taskMetaSet(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO task_meta(key,value) VALUES(?,?)').run(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    taskMetaGet(key, defaultVal = null) {
        const row = this.db.prepare('SELECT value FROM task_meta WHERE key=?').get(key);
        if (!row) return defaultVal;
        try { return JSON.parse(row.value); } catch { return row.value; }
    }

    taskMetaDelete(key) {
        this.db.prepare('DELETE FROM task_meta WHERE key=?').run(key);
    }

    // ---- streams 分页查询（去内存化支持）----

    getStreamsPaged(offset, limit) {
        return this.db.prepare('SELECT data FROM streams ORDER BY id LIMIT ? OFFSET ?').all(limit, offset).map(r => JSON.parse(r.data));
    }

    getStreamsCount() {
        const row = this.db.prepare('SELECT COUNT(*) as n FROM streams').get();
        return row ? row.n : 0;
    }

    getStreamsStats() {
        const total = this.getStreamsCount();
        const online = this.db.prepare("SELECT COUNT(*) as n FROM streams WHERE json_extract(data,'$.isAvailable')=1").get().n;
        const offline = total - online;
        // 分辨率分布
        const resRows = this.db.prepare("SELECT json_extract(data,'$.resolution') as res, COUNT(*) as n FROM streams GROUP BY res").all();
        const resolutions = {};
        resRows.forEach(r => { resolutions[r.res || 'Unknown'] = r.n; });
        // 分组分布
        const grpRows = this.db.prepare("SELECT json_extract(data,'$.groupTitle') as grp, COUNT(*) as n FROM streams GROUP BY grp").all();
        const groups = {};
        grpRows.forEach(r => { groups[r.grp || 'Default'] = r.n; });
        return { total, online, offline, resolutions, groups };
    }
}

module.exports = new PersistenceService();
