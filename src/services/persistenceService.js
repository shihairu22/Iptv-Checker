const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'iptv.db');

// 确保 data 目录存在（同步，启动时执行一次）
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
        // WAL 模式：写入性能更好，读写不互斥
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
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                udpxy_url    TEXT NOT NULL DEFAULT '',
                multicast_url TEXT NOT NULL DEFAULT '',
                name         TEXT NOT NULL DEFAULT '',
                data         TEXT NOT NULL DEFAULT '{}'
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_streams_url
                ON streams(udpxy_url, multicast_url);
            CREATE TABLE IF NOT EXISTS backups (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                name      TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                payload   TEXT NOT NULL
            );
        `);
    }

    // 从旧 JSON 文件迁移数据（仅首次运行）
    _migrate() {
        const migrated = this.db.prepare("SELECT value FROM kv_store WHERE key = 'migration_done'").get();
        if (migrated) return;

        const streamsFile = path.join(DATA_DIR, 'streams.json');
        if (fsSync.existsSync(streamsFile)) {
            try {
                const raw = fsSync.readFileSync(streamsFile, 'utf-8');
                const data = JSON.parse(raw);
                if (data.streams && Array.isArray(data.streams) && data.streams.length > 0) {
                    const insert = this.db.prepare(
                        'INSERT OR REPLACE INTO streams(udpxy_url, multicast_url, name, data) VALUES(?,?,?,?)'
                    );
                    const insertMany = this.db.transaction((streams) => {
                        for (const s of streams) {
                            insert.run(
                                s.udpxyUrl || '',
                                s.multicastUrl || '',
                                s.name || '',
                                JSON.stringify(s)
                            );
                        }
                    });
                    insertMany(data.streams);
                    console.log(`[PersistenceService] 从 streams.json 迁移 ${data.streams.length} 条频道到 SQLite`);
                }
                if (data.settings) {
                    this.db.prepare("INSERT OR REPLACE INTO kv_store(key,value) VALUES('settings',?)").run(JSON.stringify(data.settings));
                }
            } catch (e) {
                console.error('[PersistenceService] streams.json 迁移失败:', e.message);
            }
        }

        // 迁移其他 JSON 配置文件
        const cfgFiles = [
            'logo_templates.json', 'fcc_servers.json', 'udpxy_servers.json',
            'group_titles.json', 'group_rules.json', 'epg_sources.json',
            'proxy_servers.json', 'app_settings.json', 'users.json',
            'sessions.json', 'current_task.json'
        ];
        for (const f of cfgFiles) {
            const fp = path.join(DATA_DIR, f);
            if (fsSync.existsSync(fp)) {
                try {
                    const raw = fsSync.readFileSync(fp, 'utf-8');
                    this.db.prepare("INSERT OR REPLACE INTO kv_store(key,value) VALUES(?,?)").run(f, raw);
                } catch (e) {
                    console.error(`[PersistenceService] ${f} 迁移失败:`, e.message);
                }
            }
        }

        this.db.prepare("INSERT OR REPLACE INTO kv_store(key,value) VALUES('migration_done','1')").run();
        console.log('[PersistenceService] 数据迁移完成');
    }

    // ---- 兼容旧接口：readJson / writeJson ----

    validateFilename(filename) {
        if (!filename || typeof filename !== 'string') return false;
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.includes(':')) return false;
        return true;
    }

    async ensureDataDir() {
        ensureDataDirSync();
    }

    async readJson(filename, defaultObj = {}) {
        if (!this.validateFilename(filename)) return defaultObj;
        try {
            const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(filename);
            if (!row) return defaultObj;
            return JSON.parse(row.value);
        } catch (e) {
            return defaultObj;
        }
    }

    async writeJson(filename, obj) {
        if (!this.validateFilename(filename)) return false;
        try {
            this.db.prepare('INSERT OR REPLACE INTO kv_store(key,value) VALUES(?,?)').run(filename, JSON.stringify(obj));
            return true;
        } catch (e) {
            console.error(`[PersistenceService] writeJson ${filename} 失败:`, e.message);
            return false;
        }
    }

    // ---- 流数据专用接口 ----

    getAllStreams() {
        const rows = this.db.prepare('SELECT data FROM streams ORDER BY id').all();
        return rows.map(r => JSON.parse(r.data));
    }

    saveAllStreams(streams) {
        const insert = this.db.prepare(
            'INSERT OR REPLACE INTO streams(udpxy_url, multicast_url, name, data) VALUES(?,?,?,?)'
        );
        const deleteAll = this.db.prepare('DELETE FROM streams');
        const tx = this.db.transaction((list) => {
            deleteAll.run();
            for (const s of list) {
                insert.run(s.udpxyUrl || '', s.multicastUrl || '', s.name || '', JSON.stringify(s));
            }
        });
        try {
            tx(streams);
            return true;
        } catch (e) {
            console.error('[PersistenceService] saveAllStreams 失败:', e.message);
            return false;
        }
    }

    upsertStream(stream) {
        try {
            this.db.prepare(
                'INSERT OR REPLACE INTO streams(udpxy_url, multicast_url, name, data) VALUES(?,?,?,?)'
            ).run(stream.udpxyUrl || '', stream.multicastUrl || '', stream.name || '', JSON.stringify(stream));
            return true;
        } catch (e) {
            console.error('[PersistenceService] upsertStream 失败:', e.message);
            return false;
        }
    }

    deleteStream(udpxyUrl, multicastUrl) {
        try {
            this.db.prepare('DELETE FROM streams WHERE udpxy_url=? AND multicast_url=?').run(udpxyUrl || '', multicastUrl || '');
            return true;
        } catch (e) {
            return false;
        }
    }

    clearStreams() {
        try {
            this.db.prepare('DELETE FROM streams').run();
            return true;
        } catch (e) {
            return false;
        }
    }

    // ---- 备份接口 ----

    async saveWithBackup(filename, payload) {
        // 写主数据
        const ok = await this.writeJson(filename, payload);
        if (!ok) return false;
        // 写备份记录（保留 JSON 文件备份以兼容恢复流程）
        try {
            const ts = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
            const backupName = filename.replace('.json', '') + `-${stamp}.json`;
            // 同时写入 JSON 文件（供 loadFromFile 恢复用）
            const backupPath = path.join(DATA_DIR, backupName);
            await fs.writeFile(backupPath, JSON.stringify(payload, null, 2), 'utf-8');
            // 也记录到 backups 表
            this.db.prepare('INSERT INTO backups(name,created_at,payload) VALUES(?,?,?)').run(
                backupName, Date.now(), JSON.stringify(payload)
            );
            return true;
        } catch (e) {
            console.error('[PersistenceService] 备份写入失败:', e.message);
            return false;
        }
    }

    async listBackups(pattern) {
        try {
            // 优先读 backups 表
            const rows = this.db.prepare('SELECT name, created_at FROM backups ORDER BY created_at DESC').all();
            const fromDb = rows
                .filter(r => pattern.test(r.name))
                .map(r => ({ file: r.name, time: r.created_at }));
            if (fromDb.length > 0) return fromDb;
            // 降级：扫描 JSON 文件（兼容旧数据）
            const files = await fs.readdir(DATA_DIR);
            const matches = files.filter(f => pattern.test(f));
            const entries = await Promise.all(matches.map(async f => {
                const full = path.join(DATA_DIR, f);
                const stat = await fs.stat(full);
                return { file: f, time: stat.mtimeMs };
            }));
            return entries.sort((a, b) => b.time - a.time);
        } catch (e) {
            return [];
        }
    }

    async deleteBackup(filename) {
        if (!this.validateFilename(filename)) return false;
        try {
            this.db.prepare('DELETE FROM backups WHERE name=?').run(filename);
            // 同时尝试删除 JSON 文件
            try { await fs.unlink(path.join(DATA_DIR, filename)); } catch (_) {}
            return true;
        } catch (e) {
            return false;
        }
    }
}

module.exports = new PersistenceService();
