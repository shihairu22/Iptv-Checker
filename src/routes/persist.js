const express = require('express');
const router = express.Router();
const persistence = require('../services/persistenceService');
const streamService = require('../services/streamService');
const { requireAuth } = require('../middleware/auth');

// 获取备份列表
router.get('/list', requireAuth, async (req, res) => {
    try {
        const entries = await persistence.listBackups(/^streams-\d{8}-\d{6}\.json$/);
        const mapped = entries.map(e => ({
            file: e.file,
            time: e.time
        }));
        res.json({ success: true, count: mapped.length, backups: mapped });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: String(e) });
    }
});

// 手动保存快照
router.post('/save', requireAuth, async (req, res) => {
    try {
        const ok = await streamService.backupData();
        if (ok) {
            res.json({ success: true, message: '配置已妥善备份' });
        } else {
            res.status(500).json({ success: false, message: '备份配置失败' });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: String(e) });
    }
});

// 加载流数据（触发前端重新拉取）
router.post('/load', requireAuth, async (req, res) => {
    try {
        await streamService.init(); // 重新加载内存
        const list = streamService.getStreams();
        res.json({ success: true, count: list.length, streams: list });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: String(e) });
    }
});

// 恢复历史版本
router.post('/load-version', requireAuth, async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ success: false, message: '文件名称为空' });
        // 路径穿越防护
        if (!persistence.validateFilename(filename)) {
            return res.status(400).json({ success: false, message: '文件名不合法' });
        }

        const ok = await streamService.loadFromFile(filename);
        if (ok) {
            await streamService.init(); // 确保加载到内存
            res.json({ success: true, message: '已加载版本：' + filename });
        } else {
            res.status(500).json({ success: false, message: '加载版本失败或版本无效' });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: String(e) });
    }
});

// 删除历史版本
router.delete('/delete-version', requireAuth, async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ success: false, message: '文件名称为空' });
        // 路径穿越防护
        if (!persistence.validateFilename(filename)) {
            return res.status(400).json({ success: false, message: '文件名不合法' });
        }

        const ok = await persistence.deleteBackup(filename);
        if (ok) {
            res.json({ success: true, message: '版本记录已移除' });
        } else {
            res.status(500).json({ success: false, message: '删除版本失败' });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: String(e) });
    }
});

module.exports = router;
