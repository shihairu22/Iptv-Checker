const fs = require('fs').promises;
const path = require('path');

class PersistenceService {
    constructor() {
        this.dataDir = path.join(__dirname, '../../data');
    }

    async ensureDataDir() {
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
        } catch (e) {
            // Ignore if exists
        }
    }

    async readJson(filename, defaultObj = {}) {
        await this.ensureDataDir();
        const filePath = path.join(this.dataDir, filename);
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        } catch (e) {
            return defaultObj;
        }
    }

    async writeJson(filename, obj) {
        await this.ensureDataDir();
        const filePath = path.join(this.dataDir, filename);
        try {
            const content = JSON.stringify(obj, null, 2);
            await fs.writeFile(filePath, content, 'utf-8');
            return true;
        } catch (e) {
            console.error(`[PersistenceService] Failed to write ${filename}:`, e);
            return false;
        }
    }

    async saveWithBackup(filename, payload) {
        await this.ensureDataDir();
        const filePath = path.join(this.dataDir, filename);
        try {
            const content = JSON.stringify(payload, null, 2);
            await fs.writeFile(filePath, content, 'utf-8');

            // Generate timestamped backup
            const ts = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
            const backupName = filename.replace('.json', '') + `-${stamp}.json`;
            const backupPath = path.join(this.dataDir, backupName);
            
            await fs.writeFile(backupPath, content, 'utf-8');
            return true;
        } catch (e) {
            console.error(`[PersistenceService] Failed to save/backup ${filename}:`, e);
            return false;
        }
    }

    async listBackups(pattern) {
        await this.ensureDataDir();
        try {
            const files = await fs.readdir(this.dataDir);
            const matches = files.filter(f => pattern.test(f));
            const entries = await Promise.all(matches.map(async f => {
                const full = path.join(this.dataDir, f);
                const stat = await fs.stat(full);
                return { file: f, time: stat.mtimeMs };
            }));
            return entries.sort((a, b) => b.time - a.time);
        } catch (e) {
            return [];
        }
    }
}

module.exports = new PersistenceService();
