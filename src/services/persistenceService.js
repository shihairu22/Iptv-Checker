const fs = require('fs').promises;
const path = require('path');

class PersistenceService {
    constructor() {
        this.dataDir = path.join(__dirname, '../../data');
        this.writeLock = Promise.resolve();
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
        const _write = async () => {
            await this.ensureDataDir();
            const filePath = path.join(this.dataDir, filename);
            const tempPath = filePath + `.${Date.now()}.tmp`;
            try {
                const content = JSON.stringify(obj, null, 2);
                await fs.writeFile(tempPath, content, 'utf-8');
                await fs.rename(tempPath, filePath);
                return true;
            } catch (e) {
                console.error(`[PersistenceService] Failed to write ${filename}:`, e);
                try { await fs.unlink(tempPath); } catch (_) { }
                return false;
            }
        };
        this.writeLock = this.writeLock.then(_write).catch(() => false);
        return this.writeLock;
    }

}

module.exports = new PersistenceService();
