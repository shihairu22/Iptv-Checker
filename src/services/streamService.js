const persistence = require('./persistenceService');

const BACKUP_CONFIG_KEYS = [
    'logo_templates.json',
    'fcc_servers.json',
    'udpxy_servers.json',
    'group_titles.json',
    'group_rules.json',
    'epg_sources.json',
    'proxy_servers.json',
    'app_settings.json'
];

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
        await this._hydrateSplitConfigs();
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
        const configs = {};
        for (const key of BACKUP_CONFIG_KEYS) {
            const value = await persistence.readJson(key, null);
            if (value !== null) configs[key] = value;
        }
        const payload = { streams, settings: this.settings, configs };
        return await persistence.saveWithBackup('streams.json', payload);
    }

    async loadFromFile(filename) {
        const data = persistence.getBackupPayload(filename);
        if (data && data.streams) {
            persistence.saveAllStreams(Array.isArray(data.streams) ? data.streams : []);
            if (data.settings) {
                Object.assign(this.settings, data.settings);
                await persistence.writeJson('settings', this.settings);
            }
            if (data.configs && typeof data.configs === 'object') {
                for (const [key, value] of Object.entries(data.configs)) {
                    await persistence.writeJson(key, value);
                }
            }
            await this.init();
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
        const select = persistence.db.prepare(
            'SELECT data FROM streams WHERE udpxy_url=? AND multicast_url=?'
        );
        const upsert = persistence.db.prepare(
            'INSERT OR REPLACE INTO streams(udpxy_url,multicast_url,name,data) VALUES(?,?,?,?)'
        );
        persistence.db.transaction((list) => {
            for (const incoming of list) {
                const udpxyUrl = incoming.udpxyUrl || '';
                const multicastUrl = incoming.multicastUrl || '';
                const existingRow = select.get(udpxyUrl, multicastUrl);
                let merged = incoming;
                if (existingRow) {
                    const existing = JSON.parse(existingRow.data);
                    merged = {
                        ...existing,
                        ...incoming,
                        udpxyUrl: udpxyUrl || existing.udpxyUrl || '',
                        multicastUrl: multicastUrl || existing.multicastUrl || '',
                        name: incoming.name || existing.name || ''
                    };
                }
                upsert.run(merged.udpxyUrl || '', merged.multicastUrl || '', merged.name || '', JSON.stringify(merged));
            }
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
        const normalized = String(fcc || '').trim().replace(/^(fcc=)+/i, '');
        if (!normalized) return 0;
        const httpParam = 'fcc=' + normalized;
        // 仅更新 udpxy_url 非空或 multicast_url 以 rtp:// udp:// 开头的行
        const result = persistence.db.prepare(
            `UPDATE streams SET data=json_set(data,'$.httpParam',?)
             WHERE udpxy_url != '' OR multicast_url LIKE 'rtp://%' OR multicast_url LIKE 'udp://%'
               OR multicast_url LIKE 'rtsp://%' OR multicast_url LIKE 'rtsps://%'`
        ).run(httpParam);
        return result.changes;
    }

    async _hydrateSplitConfigs() {
        const logoCfg = await persistence.readJson('logo_templates.json', null);
        if (logoCfg && Array.isArray(logoCfg.templates)) {
            const templates = logoCfg.templates
                .map(item => {
                    if (typeof item === 'string') return { id: '', url: item };
                    return {
                        id: item && item.id ? String(item.id) : '',
                        url: item && item.url ? String(item.url) : ''
                    };
                })
                .filter(item => item.url);
            if (templates.length > 0) {
                const currentId = typeof logoCfg.currentId === 'string' ? logoCfg.currentId : '';
                const current = templates.find(item => item.id === currentId) || templates[0];
                this.settings.logoTemplate = current.url;
            }
        }

        const fccCfg = await persistence.readJson('fcc_servers.json', null);
        if (fccCfg && Array.isArray(fccCfg.servers)) {
            this.settings.fccServers = fccCfg.servers;
        }

        const groupCfg = await persistence.readJson('group_titles.json', null);
        if (groupCfg && Array.isArray(groupCfg.titles)) {
            this.settings.groupTitles = groupCfg.titles
                .map(item => typeof item === 'string' ? item : (item && item.name ? item.name : ''))
                .filter(Boolean);
        }

        const proxyCfg = await persistence.readJson('proxy_servers.json', null);
        if (proxyCfg && Array.isArray(proxyCfg.list)) {
            this.settings.proxyList = proxyCfg.list;
        }

        const appCfg = await persistence.readJson('app_settings.json', null);
        if (appCfg && typeof appCfg === 'object') {
            if (typeof appCfg.useInternal === 'boolean') this.settings.useInternal = appCfg.useInternal;
            if (typeof appCfg.useExternal === 'boolean') this.settings.useExternal = appCfg.useExternal;
            if (typeof appCfg.internalUrl === 'string') this.settings.internalUrl = appCfg.internalUrl;
            if (typeof appCfg.externalUrl === 'string') this.settings.externalUrl = appCfg.externalUrl;
            if (typeof appCfg.securityToken === 'string') this.settings.securityToken = appCfg.securityToken;
            if (typeof appCfg.enableToken === 'boolean') this.settings.enableToken = appCfg.enableToken;
        }
    }
}

module.exports = new StreamService();
