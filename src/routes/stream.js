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

// 启动任务
router.post('/task/start', (req, res) => {
    res.json({ success: taskManager.start(req.body) });
});

// 停止任务
router.post('/task/stop', (req, res) => {
    taskManager.stop();
    res.json({ success: true });
});

// 单条检测
router.post('/check-stream', (req, res) => {
    let { udpxyUrl, multicastUrl, name } = req.body;
    udpxyUrl = String(udpxyUrl || '').trim();
    multicastUrl = String(multicastUrl || '').trim();
    const fullUrl = `${udpxyUrl}/rtp/${multicastUrl.replace('rtp://', '')}`;

    ffprobeCheck(fullUrl, (data) => {
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
    });
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
