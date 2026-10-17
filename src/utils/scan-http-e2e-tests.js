/**
 * HTTP 端到端验证：真起服务 → 同进程签发会话 → 走 REST 全流程。
 * 运行：node test_temp/scan-http-e2e.js
 */
const assert = require('assert');

process.env.PORT = '3998';

async function main() {
    const appPath = require.resolve('../index');
    require(appPath); // 启动监听
    await new Promise((r) => setTimeout(r, 1200));

    const auth = require('../core/auth');
    const token = auth.createSession('admin');
    console.log('已签发会话:', token.slice(0, 12) + '…');

    const base = 'http://127.0.0.1:3998';
    const headers = { 'Content-Type': 'application/json', Cookie: `auth_token=${token}` };
    const call = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        let json = null;
        try { json = await res.json(); } catch (e) { /* 非 JSON */ }
        return { status: res.status, json };
    };

    // 1. status（空任务）
    let r = await call('GET', '/api/scan-tasks/status');
    console.log('GET  status →', r.status, JSON.stringify(r.json && r.json.progress));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.success, true);

    // 2. start（3 条，指向不存在的 udpxy —— 预期全部失败，但流程必须跑通）
    r = await call('POST', '/api/scan-tasks/start', {
        type: 'batch',
        batchText: 'A,rtp://239.254.0.1:5000\nB,rtp://239.254.0.2:5000\nC,rtp://239.254.0.3:5000',
        udpxyUrl: 'http://127.0.0.1:9',
        concurrency: 3,
        retry: 0
    });
    console.log('POST start →', r.status, JSON.stringify(r.json));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.started, true);
    assert.strictEqual(r.json.total, 3);

    // 3. 轮询到结束
    let status = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        r = await call('GET', '/api/scan-tasks/status');
        status = r.json;
        if (!status.running && status.progress.pending === 0 && status.progress.inFlight === 0) break;
        await new Promise((res) => setTimeout(res, 300));
    }
    console.log('轮询结束 →', JSON.stringify(status.progress));
    assert.strictEqual(status.progress.finished, 3, 'finished 应为 3');
    assert.strictEqual(status.progress.pending, 0);

    // 4. stop / resume 在空任务上应安全返回
    r = await call('POST', '/api/scan-tasks/stop');
    console.log('POST stop  →', r.status, JSON.stringify({ running: r.json && r.json.running }));
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/api/scan-tasks/resume');
    console.log('POST resume→', r.status, JSON.stringify({ running: r.json && r.json.running }));
    assert.strictEqual(r.status, 200);

    // 5. 失败明细
    r = await call('GET', '/api/scan-tasks/failures?limit=10');
    console.log('GET  failures →', r.status, JSON.stringify(r.json && r.json.failures && r.json.failures.map((f) => f.attempts)));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.failures.length, 3, '应有 3 条失败明细');
    assert.ok(r.json.failures.every((f) => f.error), '失败明细应带原因');

    // 6. 重扫失败项（这里 udpxy 仍不可达，预期再次全部失败 —— 验证的是流程不是结果）
    r = await call('POST', '/api/scan-tasks/retry-failed');
    console.log('POST retry-failed →', r.status, JSON.stringify({ retried: r.json && r.json.retried }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.retried, 3, '应把 3 条失败项打回待处理');
    const deadline2 = Date.now() + 60000;
    while (Date.now() < deadline2) {
        r = await call('GET', '/api/scan-tasks/status');
        status = r.json;
        if (!status.running && status.progress.pending === 0 && status.progress.inFlight === 0) break;
        await new Promise((res) => setTimeout(res, 300));
    }
    console.log('重扫结束 →', JSON.stringify(status.progress));
    assert.strictEqual(status.progress.finished, 3, '重扫后 finished 仍应为 3');

    // 7. 页面可访问
    const page = await fetch(base + '/scan', { headers: { Cookie: `auth_token=${token}` } });
    const html = await page.text();
    console.log('GET  /scan →', page.status, '长度', html.length);
    assert.strictEqual(page.status, 200);
    assert.ok(html.includes('扫描队列'), '页面应渲染标题');
    assert.ok(html.includes('/js/scan/scan-page.js'), '页面应引用前端脚本');

    // 8. 参数校验
    r = await call('POST', '/api/scan-tasks/start', { type: 'batch', batchText: '' });
    console.log('POST start(空) →', r.status, r.json && r.json.message);
    assert.strictEqual(r.status, 400);

    console.log('\n✅ HTTP 端到端通过');
    process.exit(0);
}

main().catch((err) => {
    console.error('\n❌ 端到端失败:', err && err.stack ? err.stack : err);
    process.exit(1);
});
