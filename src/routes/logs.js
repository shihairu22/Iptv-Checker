const express = require('express');
const path = require('path');
const logger = require('../services/logService');

const router = express.Router();

router.get('/files', (req, res) => {
    res.json({ success: true, files: logger.listFiles() });
});

router.get('/download', (req, res) => {
    const filePath = logger.getFilePath(req.query.file);
    if (!filePath) {
        return res.status(404).json({ success: false, message: 'Log file not found' });
    }
    res.download(filePath, path.basename(filePath));
});

router.get('/stream', (req, res) => {
    logger.stream(res, {
        level: String(req.query.level || 'info'),
        module: String(req.query.module || 'all'),
        keyword: String(req.query.keyword || '').trim()
    }, req.query.tail);
});

module.exports = router;
