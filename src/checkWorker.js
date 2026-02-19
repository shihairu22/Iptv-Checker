const { parentPort, workerData } = require('worker_threads');
const { ffprobeCheck } = require('./ffprobe');

// workerData 传递初始配置，或者通过 message 接收任务
// 这里设计为：Worker 启动后监听 'message' 事件接收任务，或者直接处理一次任务然后退出（如果用线程池模式）
// 简单起见，我们采用“一次性 Worker”或者“长连接 Worker”配合 p-queue。
// 为了配合 p-queue，通常是在主线程这一侧控制并发，每次 new Worker() 执行一个任务，或者维护一个固定大小的 Worker Pool。
// 鉴于 p-queue 控制的是 Promise 的并发数，最简单的实现是：p-queue 的任务执行函数中 new Worker()，执行完 terminate。
// 虽然频繁创建 Worker 有开销，但比 process.spawn 小。
// 更高级的是维护 strict Worker Pool。为了代码不过于复杂，我们先用 "Task Function wraps new Worker" 方式，
// 如果性能仍不达标，再升级为固定各种 Worker 线程复用。

if (workerData && workerData.url) {
    // 方式 A: 每次 new Worker 传入 workerData
    const { url, udpxyUrl } = workerData;
    let fullUrl = url;
    if (fullUrl.startsWith('rtp://') && udpxyUrl) {
        fullUrl = `${udpxyUrl}/rtp/${fullUrl.replace('rtp://', '')}`;
    }

    ffprobeCheck(fullUrl, (data) => {
        parentPort.postMessage({ success: true, data });
    });
} else {
    // 方式 B: 复用 Worker
    parentPort.on('message', (task) => {
        const { url, udpxyUrl } = task;
        let fullUrl = url;
        if (fullUrl.startsWith('rtp://') && udpxyUrl) {
            fullUrl = `${udpxyUrl}/rtp/${fullUrl.replace('rtp://', '')}`;
        }

        try {
            ffprobeCheck(fullUrl, (data) => {
                parentPort.postMessage({ id: task.id, success: true, data });
            });
        } catch (e) {
            parentPort.postMessage({ id: task.id, success: false, error: e.message });
        }
    });
}
