const persistence = require('./persistenceService');

class StreamService {
    constructor() {
        this.multicastList = [];
        this.settings = {
            globalFcc: '',
            fccServers: [],
            logoTemplate: 'http://12.12.12.177:9443/lcmyhome/TVlive/raw/branch/main/LOGO/{name}.png',
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
        const data = await persistence.readJson('streams.json', { streams: [], settings: this.settings });
        this.multicastList = Array.isArray(data.streams) ? data.streams : [];
        if (data.settings) {
            this.settings = { ...this.settings, ...data.settings };
        }
    }

    async save() {
        const payload = { streams: this.multicastList, settings: this.settings };
        // 优化: 日常保存不再生成备份文件，减少 IO
        return await persistence.writeJson('streams.json', payload);
    }

    async backupData() {
        const payload = { streams: this.multicastList, settings: this.settings };
        return await persistence.saveWithBackup('streams.json', payload);
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
            return true;
        }
        return false;
    }

    addStream(stream) {
        this.multicastList.push(stream);
    }

    // [NEW] 批量添加流数据
    async addStreamBatch(newStreams) {
        if (!Array.isArray(newStreams) || newStreams.length === 0) return;

        // 简单的去重逻辑：如果 URL 完全一致则覆盖，否则追加
        // 为了性能，先建立当前 URL 映射
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
            } else {
                this.multicastList.push(ns);
            }
        });

        // 立即保存
        await this.save();
    }

    getSettings() {
        return this.settings;
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
    }

    deleteStream(idx) {
        if (!!this.multicastList[idx]) {
            this.multicastList.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    async clearStreams() {
        this.multicastList = [];
        await this.save();
    }

    getStats() {
        const total = this.multicastList.length;
        let online = 0;
        let offline = 0;
        const resolutions = {};
        const groups = {};

        this.multicastList.forEach(s => {
            if (s.isAvailable) online++; else offline++;

            // Resolution stats
            const res = s.resolution || 'Unknown';
            resolutions[res] = (resolutions[res] || 0) + 1;

            // Group stats
            const grp = s.groupTitle || 'Default';
            groups[grp] = (groups[grp] || 0) + 1;
        });

        return {
            total,
            online,
            offline,
            resolutions,
            groups
        };
    }
}

module.exports = new StreamService();
