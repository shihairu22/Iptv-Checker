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

    validateFilename(filename) {
        if (!filename || typeof filename !== 'string') return false;
        // 禁止包含路径分隔符、驱动器符或 .. 
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\') || filename.includes(':')) return false;
        return true;
    }

    async readJson(filename, defaultObj = {}) {
        if (!this.validateFilename(filename)) return defaultObj;
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
        if (!this.validateFilename(filename)) return false;
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

    async saveWithBackup(filename, payload) {
        if (!this.validateFilename(filename)) return false;
        const _write = async () => {
            await this.ensureDataDir();
            const filePath = path.join(this.dataDir, filename);
            const tempPath = filePath + `.${Date.now()}.tmp`;

            // Generate timestamped backup
            const ts = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
            const backupName = filename.replace('.json', '') + `-${stamp}.json`;
            const backupPath = path.join(this.dataDir, backupName);

            try {
                const content = JSON.stringify(payload, null, 2);

                // 写入当前主文件
                await fs.writeFile(tempPath, content, 'utf-8');
                await fs.rename(tempPath, filePath);

                // 写入备份存档
                await fs.writeFile(backupPath, content, 'utf-8');
                return true;
            } catch (e) {
                console.error(`[PersistenceService] Failed to save/backup ${filename}:`, e);
                try { await fs.unlink(tempPath); } catch (_) { }
                return false;
            }
        };
        this.writeLock = this.writeLock.then(_write).catch(() => false);
        return this.writeLock;
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

    async deleteBackup(filename) {
        if (!this.validateFilename(filename)) return false;
        try {
            const p = path.join(this.dataDir, filename);
            await fs.unlink(p);
            return true;
        } catch (e) {
            return false;
        }
    }
}

module.exports = new PersistenceService();
