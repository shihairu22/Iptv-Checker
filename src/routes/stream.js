const express = require('express');
const router = express.Router();
const streamService = require('../services/streamService');
const taskManager = require('../taskCheck');
const { ffprobeCheck } = require('../ffprobe');

// 获取所有流
router.get('/streams', (req, res) => {
    res.json({ success: true, streams: streamService.getStreams() });
});

// 任务状态
router.get('/task/status', (req, res) => res.json(taskManager.getStatus()));

// 统计信息
router.get('/stats', (req, res) => {
    res.json({ success: true, stats: streamService.getStats() });
});

// 启动任务
router.post('/task/start', (req, res) => {
    res.json({ success: taskManager.start(req.body) });
});

// 停止任务
router.post('/task/stop', (req, res) => {
    taskManager.stop();
    res.json({ success: true });
});

// 恢复任务
router.post('/task/resume', (req, res) => {
    res.json({ success: taskManager.resume() });
});

// 单条检测
router.post('/check-stream', async (req, res) => {
    let { udpxyUrl, multicastUrl, name } = req.body;
    udpxyUrl = String(udpxyUrl || '').trim();
    multicastUrl = String(multicastUrl || '').trim();
    let fullUrl = multicastUrl;
    if (fullUrl.startsWith('rtp://') && udpxyUrl) {
        fullUrl = `${udpxyUrl}/rtp/${fullUrl.replace('rtp://', '')}`;
    }

    try {
        // 使用 Promise 包装 ffprobeCheck 以支持 async/await
        const data = await new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                reject(new Error('检测超时 (20s)'));
            }, 21000);

            ffprobeCheck(fullUrl, (data) => {
                clearTimeout(timeoutHandle);
                resolve(data);
            });
        });

        const list = streamService.getStreams();
        const existingIndex = list.findIndex(item =>
            String(item.udpxyUrl || '').trim() === udpxyUrl &&
            String(item.multicastUrl || '').trim() === multicastUrl
        );

        if (existingIndex !== -1) {
            streamService.updateStream(existingIndex, data);
        } else {
            streamService.addStream({
                ...data,
                udpxyUrl,
                multicastUrl,
                name: name || data.serviceName || ''
            });
        }
        res.json({ success: true, ...data });
    } catch (error) {
        console.error(`[Stream Check] Error for ${fullUrl}:`, error.message);
        res.status(500).json({ success: false, message: error.message || '检测失败' });
    }
});

// 删除单条
router.delete('/stream/:index', (req, res) => {
    const idx = parseInt(req.params.index, 10);
    if (streamService.deleteStream(idx)) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: '删除失败，索引无效' });
    }
});

// 清空所有
router.delete('/streams', async (req, res) => {
    await streamService.clearStreams();
    res.json({ success: true });
});

module.exports = router;
