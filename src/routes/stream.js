const express = require('express');
const router = express.Router();
const streamService = require('../services/streamService');
const { ffprobeCheck } = require('../ffprobe');

function cleanText(value, maxLen = 256) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLen);
}

function cleanUrl(value, maxLen = 2048) {
    return cleanText(value, maxLen);
}

function normalizeUpdateValue(key, value) {
    if (value === undefined || value === null) return undefined;
    switch (key) {
        case 'name':
            return cleanText(String(value), 128);
        case 'groupTitle':
            return cleanText(String(value), 64);
        case 'logo':
        case 'catchupBase':
            return cleanUrl(String(value));
        case 'tvgId':
        case 'tvgName':
            return cleanText(String(value), 128);
        case 'httpParam':
            return cleanText(String(value), 256);
        default:
            return undefined;
    }
}

// 获取流（支持分页）
router.get('/streams', (req, res) => {
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit) || 10000));
    const streams = streamService.getStreams(offset, limit);
    const total = streamService.getStreamsCount();
    res.json({ success: true, streams, total, offset, limit });
});

// 统计信息
router.get('/stats', (req, res) => {
    res.json({ success: true, stats: streamService.getStats() });
});

// 单条检测
router.post('/check-stream', async (req, res) => {
    let { udpxyUrl, multicastUrl, name } = req.body;
    udpxyUrl = cleanUrl(String(udpxyUrl || ''));
    multicastUrl = cleanUrl(String(multicastUrl || ''));
    name = cleanText(String(name || ''), 128);
    let fullUrl = multicastUrl;
    // 兼容 rtp://、rtp://@、rtp/、rtsp:// 等多种格式
    const rtpMatch = fullUrl.match(/^rtp:?\/+@?(.+)/i);
    if (rtpMatch && udpxyUrl) {
        fullUrl = `${udpxyUrl}/rtp/${rtpMatch[1]}`;
    }

    // 协议安全校验：仅允许合法的流媒体协议，防止 file:// 等危险协议导致 SSRF
    const allowedProtocols = ['rtp://', 'udp://', 'http://', 'https://', 'rtsp://', 'rtsps://'];
    if (!allowedProtocols.some(p => fullUrl.toLowerCase().startsWith(p))) {
        return res.status(400).json({ success: false, message: '不支持的流协议' });
    }

    try {
        // 使用 Promise 包装 ffprobeCheck 以支持 async/await
        const data = await new Promise((resolve, reject) => {
            let cp = null;
            const timeoutHandle = setTimeout(() => {
                // 超时时确保子进程被 kill
                if (cp && typeof cp.kill === 'function') {
                    try { cp.kill(); } catch (_) { }
                }
                reject(new Error('检测超时 (20s)'));
            }, 21000);

            cp = ffprobeCheck(fullUrl, (data) => {
                clearTimeout(timeoutHandle);
                resolve(data);
            });
        });

        const found = streamService.updateStreamByUrl(udpxyUrl, multicastUrl, data);
        if (!found) {
            streamService.addStream({
                ...data,
                udpxyUrl,
                multicastUrl,
                name: name || cleanText(String(data.serviceName || ''), 128)
            });
        }
        const saved = await streamService.save();
        if (!saved) {
            return res.status(500).json({ success: false, message: '检测结果保存失败' });
        }
        res.json({ success: true, ...data });
    } catch (error) {
        console.error(`[Stream Check] Error for ${fullUrl}:`, error.message);
        res.status(500).json({ success: false, message: error.message || '检测失败' });
    }
});

// 删除单条
router.delete('/stream/:index', async (req, res) => {
    const idx = parseInt(req.params.index, 10);
    if (Number.isNaN(idx) || idx < 0) {
        return res.json({ success: false, message: '删除失败，索引无效' });
    }
    const ok = await streamService.deleteStream(idx);
    if (ok) {
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '删除失败，索引超出范围或保存异常' });
    }
});

// 清空所有
router.delete('/streams', async (req, res) => {
    await streamService.clearStreams();
    res.json({ success: true });
});
// 更新单条流信息（按 udpxyUrl + multicastUrl 查找）
router.post('/stream/update', async (req, res) => {
    const { udpxyUrl, multicastUrl, update } = req.body;
    if (!update || typeof update !== 'object') {
        return res.json({ success: false, message: '缺少 update 参数' });
    }
    const safeUdpxyUrl = cleanUrl(String(udpxyUrl || ''));
    const safeMulticastUrl = cleanUrl(String(multicastUrl || ''));
    // 只允许更新安全字段
    const allowed = ['name', 'groupTitle', 'logo', 'tvgId', 'tvgName', 'httpParam', 'catchupBase'];
    const safeUpdate = {};
    for (const key of allowed) {
        const value = normalizeUpdateValue(key, update[key]);
        if (value !== undefined) safeUpdate[key] = value;
    }
    const found = streamService.updateStreamByUrl(safeUdpxyUrl, safeMulticastUrl, safeUpdate);
    if (found) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: '未找到对应的流' });
    }
});

// 批量设置 FCC 参数
router.post('/set-fcc', (req, res) => {
    const { fcc } = req.body;
    const safeFcc = cleanText(typeof fcc === 'string' ? fcc : '', 256);
    if (!safeFcc) {
        return res.json({ success: false, message: '缺少 fcc 参数' });
    }
    const count = streamService.setFccForMulticast(safeFcc);
    res.json({ success: true, count });
});

module.exports = router;
