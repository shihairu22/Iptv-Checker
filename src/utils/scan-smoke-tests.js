/**
 * 真实集成冒烟：真 SQLite（storage）+ 真队列 + 真落库，只把 ffprobe 换成 stub。
 * 目的：验证新模块能接上上游现有的 storage/stream 服务，而不只是自己的单测里转。
 */
const assert = require('assert');

(async () => {
    const storage = require('../storage');
    await storage.init();
    console.log('storage 就绪');

    const streamService = require('../services/stream');
    const { ScanRunner } = require('../services/scan-runner');

    const before = await storage.get('SELECT COUNT(*) AS c FROM streams');
    console.log('现有 streams 行数:', before.c);

    let probed = 0;
    const runner = new ScanRunner({
        // 不注入 queue/sink —— 走默认：真 SQLite 队列 + 真 storage.syncStreamsUpsert
        probe: async (fullUrl) => {
            probed += 1;
            assert.ok(/^http:\/\/127\.0\.0\.1:4022\/rtp\//.test(fullUrl), `URL 拼接不对: ${fullUrl}`);
            await new Promise((r) => setTimeout(r, 10));
            return { isAvailable: true, frameRate: '25.00', bitRate: 4000000, resolution: '1920x1080', codec: 'h264', serviceName: '' };
        }
    });

    const text = Array.from({ length: 12 }, (_, i) => `TEST${i},rtp://239.255.0.${i + 1}:5000`).join('\n');
    const started = await runner.start({
        type: 'batch',
        batchText: text,
        udpxyUrl: 'http://127.0.0.1:4022',
        concurrency: 4,
        retry: 0
    });
    console.log('启动:', JSON.stringify(started));
    assert.strictEqual(started.started, true);

    const deadline = Date.now() + 20000;
    let status;
    while (Date.now() < deadline) {
        status = await runner.getStatus();
        if (!status.running && status.progress.pending === 0 && status.progress.inFlight === 0) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    console.log('结束状态:', JSON.stringify({ running: status.running, progress: status.progress }));
    assert.strictEqual(status.progress.finished, 12, 'finished 应为 12');
    assert.strictEqual(status.progress.success, 12, 'success 应为 12');
    assert.strictEqual(probed, 12, '每个地址应只被探测一次');

    const after = await storage.get('SELECT COUNT(*) AS c FROM streams');
    console.log('落库后 streams 行数:', after.c, `(+${after.c - before.c})`);
    assert.strictEqual(after.c - before.c, 12, '应有 12 条新流入库');

    const sample = await storage.get(
        "SELECT name, udpxy_url, multicast_url, is_available, resolution, codec FROM streams WHERE multicast_url = 'rtp://239.255.0.1:5000'"
    );
    console.log('样例行:', JSON.stringify(sample));
    assert.ok(sample, '样例行应存在');
    assert.strictEqual(sample.is_available, 1);
    assert.strictEqual(sample.resolution, '1920x1080');
    assert.strictEqual(sample.udpxy_url, 'http://127.0.0.1:4022');

    // 清理本次写入的测试行 + 队列
    await storage.run("DELETE FROM streams WHERE name LIKE 'TEST%' AND multicast_url LIKE 'rtp://239.255.0.%'");
    await storage.run('DELETE FROM scan_queue');
    await storage.run('DELETE FROM scan_meta');
    console.log('\n✅ 集成冒烟全部通过');
    process.exit(0);
})().catch((err) => {
    console.error('\n❌ 冒烟失败:', err && err.stack ? err.stack : err);
    process.exit(1);
});
