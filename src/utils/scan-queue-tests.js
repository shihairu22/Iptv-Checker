/**
 * 扫描队列 / 后台任务执行器 —— 单元测试
 *
 * 运行方式:
 *   node src/utils/scan-queue-tests.js
 *
 * 不依赖应用的 sqlite3 驱动（用 Node 内置 node:sqlite），也不依赖真实流：
 * 探测与落库都用 stub 注入，只验证队列语义与调度行为。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { createScanQueue } = require('../services/scan-queue');
const {
    ScanRunner,
    parseBatchText,
    parseRange,
    normalizeMulticastUrl,
    expandBracketRange,
    buildPlaybackUrl
} = require('../services/scan-runner');

const PASS = [];
const FAIL = [];

function check(name, fn) {
    try {
        fn();
        PASS.push(name);
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        FAIL.push(`${name}: ${err.message}`);
        console.log(`  \x1b[31m✗\x1b[0m ${name} — ${err.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        PASS.push(name);
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        FAIL.push(`${name}: ${err.message}`);
        console.log(`  \x1b[31m✗\x1b[0m ${name} — ${err.message}`);
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 8000, stepMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(stepMs);
    }
    return false;
}

function makeDb() {
    const file = path.join(os.tmpdir(), `scan-queue-test-${process.pid}-${Date.now()}.db`);
    const db = new DatabaseSync(file);
    const driver = {
        run: (sql, params = []) => db.prepare(sql).run(...params),
        get: (sql, params = []) => db.prepare(sql).get(...params),
        all: (sql, params = []) => db.prepare(sql).all(...params)
    };
    return { file, db, driver };
}

async function main() {
    console.log('\n=== 1. 解析 ===');
    check('normalizeMulticastUrl 补 scheme', () => {
        assert.strictEqual(normalizeMulticastUrl('239.1.1.1:5000'), 'rtp://239.1.1.1:5000');
        assert.strictEqual(normalizeMulticastUrl('rtp://239.1.1.1:5000'), 'rtp://239.1.1.1:5000');
        assert.strictEqual(normalizeMulticastUrl('udp:@239.1.1.1:5000'), 'udp://239.1.1.1:5000');
    });
    check('expandBracketRange 展开 [1-3]', () => {
        assert.deepStrictEqual(
            expandBracketRange('rtp://239.1.1.[1-3]:5000'),
            ['rtp://239.1.1.1:5000', 'rtp://239.1.1.2:5000', 'rtp://239.1.1.3:5000']
        );
    });
    check('parseBatchText 支持注释/命名/空行/括号', () => {
        const text = [
            '# 注释行',
            'CCTV1,rtp://239.1.1.1:5000',
            'rtp://239.1.1.2:5000',
            '',
            'CCTV3,239.1.1.[3-4]:5000'
        ].join('\n');
        const items = parseBatchText(text, 'http://udpxy:4022');
        assert.strictEqual(items.length, 4);
        assert.strictEqual(items[0].name, 'CCTV1');
        assert.strictEqual(items[0].url, 'rtp://239.1.1.1:5000');
        assert.strictEqual(items[0].udpxyUrl, 'http://udpxy:4022');
        assert.strictEqual(items[3].url, 'rtp://239.1.1.4:5000');
        assert.strictEqual(items[3].name, 'CCTV3');
    });
    check('parseRange 网段 × 端口', () => {
        const items = parseRange({
            startUrl: 'rtp://239.1.1.1',
            endUrl: 'rtp://239.1.1.3',
            ports: '5000,5002-5003',
            udpxyUrl: ''
        });
        assert.strictEqual(items.length, 9);
        assert.strictEqual(items[0].url, 'rtp://239.1.1.1:5000');
        assert.strictEqual(items[8].url, 'rtp://239.1.1.3:5003');
    });
    check('buildPlaybackUrl 拼 udpxy 路径', () => {
        assert.strictEqual(buildPlaybackUrl('rtp://239.1.1.1:5000', 'http://10.0.0.2:4022/'), 'http://10.0.0.2:4022/rtp/239.1.1.1:5000');
        assert.strictEqual(buildPlaybackUrl('rtp://239.1.1.1:5000', ''), 'rtp://239.1.1.1:5000');
    });

    console.log('\n=== 2. 队列语义 ===');
    const { file, db, driver } = makeDb();
    const queue = createScanQueue(driver);

    await checkAsync('insertMany + counts', async () => {
        await queue.clear();
        const n = await queue.insertMany([
            { url: 'rtp://239.0.0.1:5000', udpxyUrl: 'u', name: 'a' },
            { url: 'rtp://239.0.0.2:5000', udpxyUrl: 'u', name: 'b' },
            { url: 'rtp://239.0.0.3:5000', udpxyUrl: 'u', name: 'c' }
        ]);
        assert.strictEqual(n, 3);
        const c = await queue.counts();
        assert.deepStrictEqual(c, { total: 3, pending: 3, inFlight: 0, done: 0, failed: 0 });
    });

    await checkAsync('reserveBatch 领取后变 in_flight 且不重复领取', async () => {
        const first = await queue.reserveBatch(2);
        assert.strictEqual(first.length, 2);
        const second = await queue.reserveBatch(5);
        assert.strictEqual(second.length, 1);
        assert.notStrictEqual(first[0].id, second[0].id);
        const c = await queue.counts();
        assert.strictEqual(c.inFlight, 3);
        assert.strictEqual(c.pending, 0);
    });

    await checkAsync('release 回填 pending / markDone / markFailed', async () => {
        await queue.clear();
        await queue.insertMany([
            { url: 'rtp://239.5.0.1:5000' },
            { url: 'rtp://239.5.0.2:5000' },
            { url: 'rtp://239.5.0.3:5000' }
        ]);
        const rows = await queue.reserveBatch(3);
        assert.strictEqual(rows.length, 3);
        const ids = rows.map((r) => r.id);
        await queue.release([ids[0]]);
        await queue.markDone([ids[1]]);
        await queue.markFailed([ids[2]], '超时');
        const c = await queue.counts();
        assert.strictEqual(c.pending, 1);
        assert.strictEqual(c.done, 1);
        assert.strictEqual(c.failed, 1);
        assert.strictEqual(c.inFlight, 0);
    });

    await checkAsync('resetInFlight 清理残留', async () => {
        await queue.clear();
        await queue.insertMany([
            { url: 'rtp://239.4.0.1:5000' },
            { url: 'rtp://239.4.0.2:5000' },
            { url: 'rtp://239.4.0.3:5000' }
        ]);
        await queue.reserveBatch(2);
        let c = await queue.counts();
        assert.strictEqual(c.inFlight, 2);
        assert.strictEqual(c.pending, 1);
        await queue.resetInFlight();
        c = await queue.counts();
        assert.strictEqual(c.inFlight, 0);
        assert.strictEqual(c.pending, 3);
    });

    await checkAsync('saveMeta / loadMeta / clearMeta', async () => {
        await queue.saveMeta({ running: true, total: 3 });
        const meta = await queue.loadMeta();
        assert.strictEqual(meta.running, true);
        await queue.clearMeta();
        assert.strictEqual(await queue.loadMeta(), null);
    });

    console.log('\n=== 3. 执行器（stub 探测/落库）===');

    await checkAsync('全量跑完：30 项 / 并发 5，结果全部落库', async () => {
        await queue.clear();
        await queue.clearMeta();
        const seen = [];
        let maxParallel = 0;
        let parallel = 0;
        const runner = new ScanRunner({
            queue,
            probe: async () => {
                parallel += 1;
                maxParallel = Math.max(maxParallel, parallel);
                await sleep(15);
                parallel -= 1;
                return { isAvailable: true, frameRate: '25', resolution: '1920x1080', codec: 'h264' };
            },
            sink: async ({ row, probeResult }) => {
                seen.push({ url: row.url, ok: probeResult.isAvailable });
            },
            logger: null
        });
        const text = Array.from({ length: 30 }, (_, i) => `C${i},rtp://239.9.0.${i + 1}:5000`).join('\n');
        const res = await runner.start({ type: 'batch', batchText: text, udpxyUrl: 'http://u:4022', concurrency: 5 });
        assert.strictEqual(res.started, true);
        assert.strictEqual(res.total, 30);
        const done = await waitFor(async () => {
            const st = await runner.getStatus();
            return !st.running && st.progress.total > 0 && st.progress.pending === 0;
        });
        assert.ok(done, '任务未在超时内完成');
        const st = await runner.getStatus();
        assert.strictEqual(st.progress.finished, 30);
        assert.strictEqual(st.progress.success, 30);
        assert.strictEqual(seen.length, 30);
        assert.ok(maxParallel <= 5, `并发超限: ${maxParallel}`);
        assert.strictEqual((await queue.counts()).done, 30);
    });

    await checkAsync('失败项进 failed，不退化成 done', async () => {
        await queue.clear();
        await queue.clearMeta();
        const runner = new ScanRunner({
            queue,
            probe: async () => ({ isAvailable: false }),
            sink: async () => { throw new Error('不应被调用'); },
            logger: null
        });
        await runner.start({ type: 'batch', batchText: 'x,rtp://239.8.0.1:5000\ny,rtp://239.8.0.2:5000', concurrency: 2, retry: 0 });
        await waitFor(async () => !(await runner.getStatus()).running);
        const st = await runner.getStatus();
        assert.strictEqual(st.progress.failed, 2);
        assert.strictEqual(st.progress.success, 0);
        assert.strictEqual((await queue.counts()).failed, 2);
    });

    await checkAsync('停止后剩余项保持 pending，续跑能跑完', async () => {
        await queue.clear();
        await queue.clearMeta();
        const runner = new ScanRunner({
            queue,
            probe: async () => { await sleep(20); return { isAvailable: true }; },
            sink: async () => {},
            logger: null
        });
        const text = Array.from({ length: 40 }, (_, i) => `r${i},rtp://239.7.0.${i + 1}:5000`).join('\n');
        await runner.start({ type: 'batch', batchText: text, concurrency: 4 });
        await sleep(120);
        const stopped = await runner.stop();
        assert.strictEqual(stopped.running, false);
        await sleep(120);
        const mid = await queue.counts();
        assert.ok(mid.pending > 0, `停止后应保留待处理项，实际 pending=${mid.pending}`);

        await runner.resume();
        const finished = await waitFor(async () => {
            const st = await runner.getStatus();
            return !st.running && st.progress.pending === 0 && st.progress.inFlight === 0;
        });
        assert.ok(finished, '续跑未完成');
        const st = await runner.getStatus();
        const c = await queue.counts();
        assert.strictEqual(c.total, 40);
        assert.strictEqual(c.done, 40);
        assert.strictEqual(st.progress.success, 40);
    });

    await checkAsync('重启续跑：新实例 init() 会把 in_flight 回填并接着跑', async () => {
        await queue.clear();
        await queue.clearMeta();
        await queue.insertMany(Array.from({ length: 10 }, (_, i) => ({ url: `rtp://239.6.0.${i + 1}:5000` })));
        await queue.saveMeta({ running: true, paused: false, type: 'batch', concurrency: 3, retry: 0, total: 10, finished: 0, success: 0, failed: 0, udpxyUrl: '', startedAt: Date.now() });
        // 模拟上次进程留下的在飞状态
        await queue.reserveBatch(2);

        const runner = new ScanRunner({
            queue,
            probe: async () => ({ isAvailable: true }),
            sink: async () => {},
            logger: null
        });
        await runner.init();
        const done = await waitFor(async () => {
            const st = await runner.getStatus();
            return !st.running && st.progress.pending === 0 && st.progress.inFlight === 0;
        });
        assert.ok(done, '重启续跑未完成');
        assert.strictEqual((await queue.counts()).done, 10);
    });

    console.log('\n=== 结果 ===');
    console.log(`  通过 ${PASS.length} 项，失败 ${FAIL.length} 项`);
    if (FAIL.length) {
        FAIL.forEach((f) => console.log(`   · ${f}`));
    }

    try { db.close(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    process.exit(FAIL.length ? 1 : 0);
}

main().catch((err) => {
    console.error('测试崩溃:', err);
    process.exit(2);
});
