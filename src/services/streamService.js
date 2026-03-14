const persistence = require('./persistenceService');

class StreamService {
    constructor() {
        this.multicastList = [];
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
        // 从 SQLite 加载流数据
        this.multicastList = persistence.getAllStreams();
        // 从 kv_store 加载 settings
        const savedSettings = await persistence.readJson('settings', null);
        if (savedSettings) {
            Object.assign(this.settings, savedSettings);
        }
    }

    async save() {
        // 流数据走 SQLite streams 表
        const ok = persistence.saveAllStreams(this.multicastList);
        // settings 走 kv_store
        const ok2 = await persistence.writeJson('settings', this.settings);
        return ok && ok2;
    }

    async backupData() {
        const payload = { streams: this.multicastList, settings: this.settings };
        return await persistence.saveWithBackup('streams.json', payload);
    }

    async loadFromFile(filename) {
        // 从 SQLite backups 表读取 payload
        const data = persistence.getBackupPayload(filename);
        if (data && data.streams) {
            this.multicastList = Array.isArray(data.streams) ? data.streams : [];
            if (data.settings) {
                Object.assign(this.settings, data.settings);
            }
            await this.save();
            return true;
        }
        return false;
    }

    getStreams() {
        return this.multicastList;
    }

    setStreams(list) {
        this.multicastList = list;
    }

    updateStream(idx, update) {
        if (idx >= 0 && idx < this.multicastList.length) {
            this.multicastList[idx] = { ...this.multicastList[idx], ...update };
            // 同步更新 SQLite 单条记录
            persistence.upsertStream(this.multicastList[idx]);
            return true;
        }
        return false;
    }

    addStream(stream) {
        this.multicastList.push(stream);
        persistence.upsertStream(stream);
    }

    // 批量添加流数据
    async addStreamBatch(newStreams) {
        if (!Array.isArray(newStreams) || newStreams.length === 0) return;

        const urlMap = new Map();
        this.multicastList.forEach((s, i) => {
            const key = `${s.udpxyUrl}|${s.multicastUrl}`;
            urlMap.set(key, i);
        });

        newStreams.forEach(ns => {
            const key = `${ns.udpxyUrl}|${ns.multicastUrl}`;
            if (urlMap.has(key)) {
                const idx = urlMap.get(key);
                this.multicastList[idx] = { ...this.multicastList[idx], ...ns };
                persistence.upsertStream(this.multicastList[idx]);
            } else {
                this.multicastList.push(ns);
                urlMap.set(key, this.multicastList.length - 1);
                persistence.upsertStream(ns);
            }
        });

        // settings 也同步保存
        await persistence.writeJson('settings', this.settings);
    }

    getSettings() {
        return this.settings;
    }

    updateSettings(newSettings) {
        Object.assign(this.settings, newSettings);
    }

    async deleteStream(idx) {
        if (idx >= 0 && idx < this.multicastList.length) {
            const s = this.multicastList[idx];
            this.multicastList.splice(idx, 1);
            persistence.deleteStream(s.udpxyUrl || '', s.multicastUrl || '');
            await persistence.writeJson('settings', this.settings);
            return true;
        }
        return false;
    }

    async clearStreams() {
        this.multicastList = [];
        persistence.clearStreams();
        await persistence.writeJson('settings', this.settings);
    }

    getStats() {
        const total = this.multicastList.length;
        let online = 0;
        let offline = 0;
        const resolutions = {};
        const groups = {};

        this.multicastList.forEach(s => {
            if (s.isAvailable) online++; else offline++;

            const res = s.resolution || 'Unknown';
            resolutions[res] = (resolutions[res] || 0) + 1;

            const grp = s.groupTitle || 'Default';
            groups[grp] = (groups[grp] || 0) + 1;
        });

        return { total, online, offline, resolutions, groups };
    }
}

module.exports = new StreamService();
