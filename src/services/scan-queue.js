/**
 * 扫描队列（持久化）
 *
 * 设计来源：legacy 分支（iptv-checker 1.4.2）的 taskCheck.js —— 地址池全量落 SQLite，
 * 内存只保留滑动窗口，服务重启可续跑。
 *
 * 这里只做「队列」这一件事，探测与落库由调用方注入，便于单测与替换。
 */

const TABLE = 'scan_queue';
const META_TABLE = 'scan_meta';

function createScanQueue(driver) {
    const { run, get, all } = driver;
    let schemaReady = null;

    async function ensureSchema() {
        if (schemaReady) return schemaReady;
        schemaReady = (async () => {
            await run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                udpxy_url TEXT,
                name TEXT,
                state TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT,
                updated_at TEXT
            )`);
            await run(`CREATE INDEX IF NOT EXISTS idx_scan_queue_state ON ${TABLE}(state, id)`);
            await run(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                updated_at TEXT
            )`);
        })().catch((e) => {
            schemaReady = null;
            throw e;
        });
        return schemaReady;
    }

    async function clear() {
        await ensureSchema();
        await run(`DELETE FROM ${TABLE}`);
    }

    async function insertMany(items) {
        await ensureSchema();
        const list = Array.isArray(items) ? items : [];
        if (list.length === 0) return 0;
        const now = new Date().toISOString();
        for (const item of list) {
            await run(
                `INSERT INTO ${TABLE} (url, udpxy_url, name, state, attempts, created_at, updated_at)
                 VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
                [String(item.url || '').trim(), String(item.udpxyUrl || '').trim(), String(item.name || ''), now, now]
            );
        }
        return list.length;
    }

    /**
     * 原子领取一批待办：先 SELECT 再 UPDATE，且只领 pending 的行。
     * 单进程下不会重复领取（驱动循环是唯一领取方）。
     */
    async function reserveBatch(n) {
        await ensureSchema();
        const limit = Math.max(1, parseInt(n, 10) || 1);
        const rows = await all(
            `SELECT id, url, udpxy_url, name, attempts FROM ${TABLE}
             WHERE state = 'pending' ORDER BY id LIMIT ?`,
            [limit]
        );
        if (!rows || rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        const now = new Date().toISOString();
        const placeholders = ids.map(() => '?').join(',');
        await run(
            `UPDATE ${TABLE} SET state = 'in_flight', attempts = attempts + 1, updated_at = ?
             WHERE id IN (${placeholders})`,
            [now, ...ids]
        );
        return rows.map((r) => ({
            id: r.id,
            url: r.url,
            udpxyUrl: r.udpxy_url || '',
            name: r.name || '',
            attempts: (r.attempts || 0) + 1
        }));
    }

    async function markDone(ids) {
        await ensureSchema();
        const list = (Array.isArray(ids) ? ids : [ids]).filter((v) => v != null);
        if (list.length === 0) return;
        const now = new Date().toISOString();
        await run(
            `UPDATE ${TABLE} SET state = 'done', error = NULL, updated_at = ?
             WHERE id IN (${list.map(() => '?').join(',')})`,
            [now, ...list.map(Number)]
        );
    }

    async function markFailed(ids, error) {
        await ensureSchema();
        const list = (Array.isArray(ids) ? ids : [ids]).filter((v) => v != null);
        if (list.length === 0) return;
        const now = new Date().toISOString();
        await run(
            `UPDATE ${TABLE} SET state = 'failed', error = ?, updated_at = ?
             WHERE id IN (${list.map(() => '?').join(',')})`,
            [String(error || '').slice(0, 500), now, ...list.map(Number)]
        );
    }

    /** 停止/中断时把在飞的行放回 pending，供续跑 */
    async function release(ids) {
        await ensureSchema();
        const list = (Array.isArray(ids) ? ids : [ids]).filter((v) => v != null);
        if (list.length === 0) return;
        const now = new Date().toISOString();
        await run(
            `UPDATE ${TABLE} SET state = 'pending', updated_at = ?
             WHERE id IN (${list.map(() => '?').join(',')})`,
            [now, ...list.map(Number)]
        );
    }

    /** 服务重启后清理残留的 in_flight */
    async function resetInFlight() {
        await ensureSchema();
        await run(`UPDATE ${TABLE} SET state = 'pending' WHERE state = 'in_flight'`);
    }

    async function counts() {
        await ensureSchema();
        const rows = await all(`SELECT state, COUNT(*) AS c FROM ${TABLE} GROUP BY state`);
        const out = { total: 0, pending: 0, inFlight: 0, done: 0, failed: 0 };
        for (const row of rows || []) {
            const c = Number(row.c) || 0;
            out.total += c;
            if (row.state === 'pending') out.pending = c;
            else if (row.state === 'in_flight') out.inFlight = c;
            else if (row.state === 'done') out.done = c;
            else if (row.state === 'failed') out.failed = c;
        }
        return out;
    }

    async function saveMeta(payload) {
        await ensureSchema();
        await run(
            `INSERT INTO ${META_TABLE} (id, payload, updated_at) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
            [JSON.stringify(payload || {}), new Date().toISOString()]
        );
    }

    async function loadMeta() {
        await ensureSchema();
        const row = await get(`SELECT payload FROM ${META_TABLE} WHERE id = 1`);
        if (!row || !row.payload) return null;
        try {
            return JSON.parse(row.payload);
        } catch (e) {
            return null;
        }
    }

    async function clearMeta() {
        await ensureSchema();
        await run(`DELETE FROM ${META_TABLE} WHERE id = 1`);
    }

    return {
        ensureSchema,
        clear,
        insertMany,
        reserveBatch,
        markDone,
        markFailed,
        release,
        resetInFlight,
        counts,
        saveMeta,
        loadMeta,
        clearMeta
    };
}

/** 绑定到应用自带 storage（懒加载，避免循环依赖） */
let bound = null;
function getDefaultQueue() {
    if (bound) return bound;
    const storage = require('../storage');
    bound = createScanQueue({
        run: (sql, params) => storage.run(sql, params),
        get: (sql, params) => storage.get(sql, params),
        all: (sql, params) => {
            if (typeof storage.all === 'function') return storage.all(sql, params);
            return storage.dbAll(storage.db, sql, params);
        }
    });
    return bound;
}

module.exports = { createScanQueue, getDefaultQueue, TABLE };
