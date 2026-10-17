/**
 * 扫描任务路由（后台任务模式）
 *
 * 与现有的 POST /check-streams-batch 并存：
 *   - 原有接口：一次请求跑一批，跑完返回（适合小列表、即点即看）
 *   - 这里的接口：丢进持久化队列后台跑，进度可查、可停、可续（适合大列表/网段）
 *
 * 端点：
 *   POST /api/scan-tasks/start    { type:'batch'|'range', batchText|startUrl+endUrl+ports,
 *                                   udpxyUrl, concurrency, retry, throttle:{enabled,runMinutes,pauseMinutes} }
 *   GET  /api/scan-tasks/status
 *   POST /api/scan-tasks/stop
 *   POST /api/scan-tasks/resume
 */

const express = require('express');
const { getRunner } = require('../services/scan-runner');
const { wrapAsync } = require('../middleware/governance');

const router = express.Router();
const route = (method, path, handler) => router[method](path, wrapAsync(handler));

function apiSuccess(res, payload = {}, statusCode = 200) {
    if (typeof res.apiSuccess === 'function') return res.apiSuccess(payload, statusCode);
    return res.status(statusCode).json({ success: true, ...(payload || {}) });
}

function apiFail(res, message, statusCode = 400, extra = {}) {
    if (typeof res.apiFail === 'function') return res.apiFail(message, statusCode, extra);
    return res.status(statusCode).json({ success: false, message, ...(extra || {}) });
}

route('post', '/scan-tasks/start', async (req, res) => {
    const body = req.body || {};
    const type = body.type === 'range' ? 'range' : 'batch';
    if (type === 'batch' && !String(body.batchText || '').trim()) {
        return apiFail(res, '缺少 batchText', 400);
    }
    if (type === 'range' && (!String(body.startUrl || '').trim() || !String(body.endUrl || '').trim())) {
        return apiFail(res, '缺少 startUrl / endUrl', 400);
    }
    const result = await getRunner().start({
        type,
        batchText: body.batchText,
        startUrl: body.startUrl,
        endUrl: body.endUrl,
        ports: body.ports,
        udpxyUrl: body.udpxyUrl || '',
        name: body.name || '',
        defaultHttpParam: body.defaultHttpParam || '',
        concurrency: body.concurrency,
        retry: body.retry,
        throttle: body.throttle
    });
    if (!result.started) return apiFail(res, result.reason || '任务未启动', 409, { status: result.status });
    req.log.info(`扫描任务已启动：${result.total} 项，并发 ${result.concurrency}`);
    return apiSuccess(res, result);
});

route('get', '/scan-tasks/status', async (req, res) => {
    const status = await getRunner().getStatus();
    return apiSuccess(res, status);
});

route('post', '/scan-tasks/stop', async (req, res) => {
    const status = await getRunner().stop();
    req.log.info('扫描任务已停止');
    return apiSuccess(res, status);
});

route('post', '/scan-tasks/resume', async (req, res) => {
    const status = await getRunner().resume();
    return apiSuccess(res, status);
});

module.exports = router;
