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

module.exports = router;
