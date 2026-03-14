const persistence = require('./persistenceService');

class StreamService {
    constructor() {
        this.settings = {
            globalFcc: '',
            fccServers: [],
            logoTemplate: '',
            groupTitles: ['默认'],
            externalUrl: '',
            internalUrl: '',
            useInternal: false,
            useExternal: false,
            securityToken: '',
            enableToken: false,
            proxyList: []
        };
    }

    async init() {
        const savedSettings = await persistence.readJson('settings', null);
        if (savedSettings) {
            Object.assign(this.settings, savedSettings);
        }
    }

    async saveSettings() {
        return await persistence.writeJson('settings', this.settings);
    }

    // 兼容旧 save() 调用
    async save() {
        return await this.saveSettings();
    }

    async backupData() {
        const streams = persistence.getAllStreams();
        const payload = { streams, settings: this.settings };
        return await persistence.saveWithBackup('streams.json', payload);
    }

    async loadFromFile(filename) {
        const data = persistence.getBackupPayload(filename);
        if (data && data.streams) {
            persistence.saveAllStreams(Array.isArray(data.streams) ? data.streams : []);
            if (data.settings) Object.assign(this.settings, data.settings);
            await this.saveSettings();
            return true;
        }
        return false;
    }

    // ---- 分页查询（不加载全量到内存）----

    getStreams(offset = 0, limit = 99999999) {
        return persistence.getStreamsPaged(offset, limit);
    }

    getStreamsCount() {
        return persistence.getStreamsCount();
    }

    // 仅供少量批量操作使用（如 set-fcc）
    getAllStreams() {
        return persistence.getAllStreams();
    }

    setStreams(list) {
        persistence.saveAllStreams(list);
    }

    updateStream(idx, update) {
        // idx 是前端传来的位置索引，转换为 SQLite 操作
        const rows = persistence.db.prepare('SELECT id,data FROM streams ORDER BY id LIMIT 1 OFFSET ?').all(idx);
        if (!rows || rows.length === 0) return false;
        const row = rows[0];
        const merged = { ...JSON.parse(row.data), ...update };
        persistence.db.prepare('UPDATE streams SET name=?,data=? WHERE id=?')
            .run(merged.name||'', JSON.stringify(merged), row.id);
        return true;
    }

    updateStreamByUrl(udpxyUrl, multicastUrl, update) {
        const row = persistence.db.prepare('SELECT id,data FROM streams WHERE udpxy_url=? AND multicast_url=?').get(udpxyUrl||'', multicastUrl||'');
        if (!row) return false;
        const merged = { ...JSON.parse(row.data), ...update };
        persistence.db.prepare('UPDATE streams SET name=?,data=? WHERE id=?')
            .run(merged.name||'', JSON.stringify(merged), row.id);
        return true;
    }

    addStream(stream) {
        persistence.upsertStream(stream);
    }

    async addStreamBatch(newStreams) {
        if (!Array.isArray(newStreams) || newStreams.length === 0) return;
        const upsert = persistence.db.prepare(
            'INSERT OR REPLACE INTO streams(udpxy_url,multicast_url,name,data) VALUES(?,?,?,?)'
        );
        persistence.db.transaction((list) => {
            for (const s of list) upsert.run(s.udpxyUrl||'', s.multicastUrl||'', s.name||'', JSON.stringify(s));
        })(newStreams);
    }

    getSettings() {
        return this.settings;
    }

    updateSettings(newSettings) {
        Object.assign(this.settings, newSettings);
    }

    async deleteStream(idx) {
        const rows = persistence.db.prepare('SELECT id FROM streams ORDER BY id LIMIT 1 OFFSET ?').all(idx);
        if (!rows || rows.length === 0) return false;
        persistence.db.prepare('DELETE FROM streams WHERE id=?').run(rows[0].id);
        return true;
    }

    async clearStreams() {
        persistence.clearStreams();
    }

    getStats() {
        return persistence.getStreamsStats();
    }

    // 批量为组播流设置 httpParam=fcc=xxx（纯 SQL，不加载全量数据）
    setFccForMulticast(fcc) {
        const httpParam = 'fcc=' + fcc;
        // 仅更新 udpxy_url 非空或 multicast_url 以 rtp:// udp:// 开头的行
        const result = persistence.db.prepare(
            `UPDATE streams SET data=json_set(data,'$.httpParam',?)
             WHERE udpxy_url != '' OR multicast_url LIKE 'rtp://%' OR multicast_url LIKE 'udp://%'`
        ).run(httpParam);
        return result.changes;
    }
}

module.exports = new StreamService();
