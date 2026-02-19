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

    getSettings() {
        return this.settings;
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
    }
}

module.exports = new StreamService();
