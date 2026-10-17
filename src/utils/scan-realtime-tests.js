/**
 * 真实码流端到端：不用 stub，起一个真的 MPEG-TS 码流（ffmpeg 生成）+ 真 HTTP 服务
 * （扮演 udpxy），让真 ffprobe 去拉流解析，落到真 SQLite，再回读校验。
 *
 * 覆盖三件事：
 *   1. 真实可用流 → 解析出分辨率/编码 → 入库 is_available=1
 *   2. 同一 URL 并发探测 → 只起一次 ffprobe（合并生效）
 *   3. 不可达 udpxy → 判定失败，不进库
 *
 * 依赖：系统有 ffmpeg / ffprobe。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

// ---- 必须在 require ../services/stream 之前挂计数器（它解构了 execFile）----
const cp = require('child_process');
let ffprobeSpawns = 0;
const baseExecFile = cp.execFile;
cp.execFile = function (file) {
    if (file === 'ffprobe') ffprobeSpawns += 1;
    return baseExecFile.apply(cp, arguments);
};

const FIXTURE = path.join(process.env.TMPDIR || os.tmpdir(), 'scan-realtime-fixture.ts');

function makeFixture() {
    if (fs.existsSync(FIXTURE) && fs.statSync(FIXTURE).size > 100 * 1024) return FIXTURE;
    const r = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-f', 'mpegts', FIXTURE
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('生成码流失败: ' + (r.stderr || r.error));
    return FIXTURE;
}

function startUdpProxyStub(tsBuffer) {
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.method + ' ' + req.url);
        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Content-Length': tsBuffer.length,
            'Connection': 'close'
        });
        if (req.method === 'HEAD') return res.end();
        res.end(tsBuffer);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }));
    });
}

function waitDone(runner, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 30000);
    return (async () => {
        let status;
        while (Date.now() < deadline) {
            status = await runner.getStatus();
            if (!status.running && status.progress.pending === 0 && status.progress.inFlight === 0) return status;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('等待超时，最后状态: ' + JSON.stringify(status && status.progress));
    })();
}

(async () => {
    const tsPath = makeFixture();
    const tsBuffer = fs.readFileSync(tsPath);
    console.log(`码流就绪: ${tsPath} (${(tsBuffer.length / 1024).toFixed(0)} KB)`);

    const { server, port, hits } = await startUdpProxyStub(tsBuffer);
    console.log(`伪 udpxy 监听: http://127.0.0.1:${port}`);

    const storage = require('../storage');
    await storage.init();
    const streamService = require('../services/stream');
    const { ScanRunner } = require('../services/scan-runner');

    // 干净起点
    await storage.run('DELETE FROM scan_queue');
    await storage.run('DELETE FROM scan_meta');
    await storage.run("DELETE FROM streams WHERE name LIKE 'RT%'");

    const runner = new ScanRunner(); // 全默认：真队列 + 真 ffprobe + 真 storage

    // ---------- 1. 真实可用流 ----------
    console.log('\n[1] 真实码流探测');
    const spawnsBefore = ffprobeSpawns;
    await runner.start({
        type: 'batch',
        batchText: 'RT-真实流,rtp://239.255.9.1:5000',
        udpxyUrl: `http://127.0.0.1:${port}`,
        concurrency: 1,
        retry: 0
    });
    let st = await waitDone(runner);
    console.log('    进度:', JSON.stringify(st.progress));
    assert.strictEqual(st.progress.success, 1, '真实流应判定成功');
    assert.strictEqual(st.progress.failed, 0, '真实流不应失败');
    assert.strictEqual(ffprobeSpawns - spawnsBefore, 1, '应只起 1 次 ffprobe');
    assert.ok(hits.some((h) => h.includes('/rtp/239.255.9.1:5000')), 'udpxy 应收到 /rtp/ 请求');

    const row = await storage.get(
        "SELECT name, udpxy_url, multicast_url, is_available, resolution, codec, frame_rate FROM streams WHERE multicast_url = 'rtp://239.255.9.1:5000'"
    );
    console.log('    入库:', JSON.stringify(row));
    assert.ok(row, '真实流应入库');
    assert.strictEqual(row.is_available, 1, 'is_available 应为 1');
    assert.strictEqual(row.resolution, '1280x720', '分辨率应由真 ffprobe 解析得出');
    assert.strictEqual(row.codec, 'h264', '编码应为 h264');
    assert.strictEqual(row.udpxy_url, `http://127.0.0.1:${port}`);

    // ---------- 2. 并发探测合并 ----------
    console.log('\n[2] 同一 URL 并发探测合并');
    const coldUrl = `http://127.0.0.1:${port}/rtp/239.255.9.2:5000?nocache=1`;
    const before2 = ffprobeSpawns;
    const [a, b] = await Promise.all([
        streamService.ffprobeCheckAsync(coldUrl),
        streamService.ffprobeCheckAsync(coldUrl)
    ]);
    const used = ffprobeSpawns - before2;
    console.log(`    两个并发探测 → 起进程 ${used} 次；结果一致: ${a.isAvailable === b.isAvailable && a.resolution === b.resolution}`);
    assert.strictEqual(used, 1, '并发探测应合并为 1 次 ffprobe');
    assert.strictEqual(a.isAvailable, true);
    assert.strictEqual(a.resolution, '1280x720');
    assert.strictEqual(b.resolution, a.resolution);

    // ---------- 3. 不可达 udpxy ----------
    console.log('\n[3] 不可达 udpxy 判定失败');
    await runner.start({
        type: 'batch',
        batchText: 'RT-死链,rtp://239.255.9.3:5000',
        udpxyUrl: 'http://127.0.0.1:1',
        concurrency: 2,
        retry: 1
    });
    st = await waitDone(runner);
    console.log('    进度:', JSON.stringify(st.progress));
    assert.strictEqual(st.progress.failed, 1, '不可达应记失败');
    assert.strictEqual(st.progress.success, 0, '不可达不应算成功');
    const dead = await storage.get("SELECT id FROM streams WHERE multicast_url = 'rtp://239.255.9.3:5000'");
    assert.ok(!dead, '失败的流不应入库');

    const failedRow = await storage.get("SELECT attempts, error FROM scan_queue WHERE url = 'rtp://239.255.9.3:5000'");
    console.log('    队列失败记录:', JSON.stringify(failedRow));
    assert.strictEqual(failedRow.attempts, 2, 'retry=1 应共尝试 2 次');
    assert.ok(failedRow.error, '应记录失败原因');

    // ---------- 收尾 ----------
    await storage.run("DELETE FROM streams WHERE name LIKE 'RT%'");
    await storage.run('DELETE FROM scan_queue');
    await storage.run('DELETE FROM scan_meta');
    server.close();
    console.log('\n✅ 真实码流端到端全部通过');
    process.exit(0);
})().catch((err) => {
    console.error('\n❌ 真实码流测试失败:', err && err.stack ? err.stack : err);
    process.exit(1);
});
