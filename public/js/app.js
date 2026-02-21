/**
 * app.js - 核心业务逻辑
 * 依赖: utils.js, Socket.IO, Chart.js, Bootstrap
 */

// --- 全局变量 ---
let allStreams = [];
let detectCancel = false;
let detectRunning = false;
let isTaskPaused = false;
let lastSearch = '';
let selectedSet = new Set();
let pageSize = 20;
let currentPage = 1;
let filterStatus = 'online'; // all/online/offline
let isDockerEnv = false; // 全局 Docker 环境标识

// 图表实例
let statusChartInstance = null;
let resolutionChartInstance = null;

// Socket.IO 实例
const socket = io();

// --- 拦截全局 Fetch 以自动注入 CSRF Header ---
(function () {
    const originalFetch = window.fetch;
    window.fetch = function (url, options = {}) {
        if (typeof url === 'string' && url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(options.method || 'GET')) {
            options.headers = options.headers || {};
            // KISS 方案: 注入 CSRF 自定义 Header
            if (options.headers instanceof Headers) {
                options.headers.set('X-Requested-With', 'XMLHttpRequest');
            } else {
                options.headers['X-Requested-With'] = 'XMLHttpRequest';
            }
        }
        return originalFetch(url, options);
    };
})();

// --- 登录状态检查 ---
(async function () {
    try {
        const r = await fetch('/api/auth/check');
        const j = await r.json();
        if (!j.success) {
            window.location.href = '/login.html';
        } else {
            window.currentUser = j.username;
            function updateDisplay() {
                const userDisplay = document.getElementById('userDisplay');
                if (userDisplay) userDisplay.textContent = j.username;
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', updateDisplay);
            } else {
                updateDisplay();
            }
        }
    } catch (e) {
        window.location.href = '/login.html';
    }
})();

// --- 初始化与事件监听 ---
document.addEventListener('DOMContentLoaded', function () {
    // 1. 初始化系统信息与版本
    loadSystemInfo();

    // 2. 加载数据
    getStreams();
    updateInputCount();

    // 3. 恢复用户设置
    loadUserSettings();

    // 4. 初始化图表
    initDashboard();

    // 5. 绑定UI事件
    bindUIEvents();

    // 6. 初始化范围检测预览
    updateRangeSummary();
});

// --- Socket.IO 事件 ---
socket.on('task:status', updateTaskUI);
socket.on('task:progress', updateTaskUI);

// 优化: 接收增量数据更新
socket.on('task:update_data', (batch) => {
    if (!batch || !Array.isArray(batch)) return;

    // 更新本地内存数据
    // 建立索引映射加速查找
    const urlMap = new Map();
    allStreams.forEach((s, i) => {
        const key = `${s.udpxyUrl}|${s.multicastUrl}`;
        urlMap.set(key, i);
    });

    batch.forEach(item => {
        const key = `${item.udpxyUrl}|${item.multicastUrl}`;
        if (urlMap.has(key)) {
            const idx = urlMap.get(key);
            allStreams[idx] = { ...allStreams[idx], ...item };
        } else {
            allStreams.push(item);
            urlMap.set(key, allStreams.length - 1);
        }
    });

    // 刷新显示 (防抖)
    updateStatsAndDisplay();
});

function updateTaskUI(task) {
    if (!task) return;

    if (task.running || task.paused) {
        isTaskPaused = task.paused;
        showProgress(task.finished, task.total,
            task.paused ? `任务暂停 (已完成: ${task.finished}/${task.total}) - 点击“继续检测”恢复` : `正在后台检测: ${task.finished}/${task.total} | 成功: ${task.success} 失败: ${task.fail}`);

        // 更新按钮状态
        const startBtn = document.getElementById('startDetectBtn');
        if (startBtn) {
            if (task.paused) {
                startBtn.innerHTML = '<i class="bi bi-play-circle-fill me-1"></i> 继续检测';
                startBtn.classList.remove('btn-success');
                startBtn.classList.add('btn-warning');
            } else {
                startBtn.innerHTML = '<i class="bi bi-activity me-1"></i> 检测中...';
                startBtn.classList.remove('btn-warning');
                startBtn.classList.add('btn-success');
            }
        }


        if (!task.running && !task.paused && task.finished === task.total) {
            showProgress(task.total, task.total, `检测完成 | 总数: ${task.total} 在线: ${task.success} 离线: ${task.fail}`);
            getStreams();

            // 恢复按钮
            const startBtn = document.getElementById('startDetectBtn');
            if (startBtn) {
                startBtn.innerHTML = '<i class="bi bi-play-circle-fill me-1"></i> 开始检测';
                startBtn.classList.remove('btn-warning');
                startBtn.classList.add('btn-success');
            }
            isTaskPaused = false;
        }
    } else {
        // 任务未运行
        isTaskPaused = false;
        const startBtn = document.getElementById('startDetectBtn');
        if (startBtn) {
            startBtn.innerHTML = '<i class="bi bi-play-circle-fill me-1"></i> 开始检测';
            startBtn.classList.remove('btn-warning');
            startBtn.classList.add('btn-success');
        }

        // 只有在 UI 显示着进度条时才隐藏，避免刚加载页面就闪烁
        const progressBarWrap = document.getElementById('progressBarWrap');
        if (progressBarWrap && progressBarWrap.style.display !== 'none' && !task.logs?.length) {
            // socket 连接初次会发送 status，可能是空闲状态，不做强制隐藏
        }
    }
}

// --- 核心业务函数 ---

// 获取所有流
async function getStreams() {
    try {
        const response = await fetch('/api/streams');
        const data = await response.json();
        allStreams = data.streams || [];
        updateStatsAndDisplay();
        initDashboard(); // Update charts
    } catch (error) {
        console.error('Error:', error);
    }
}

// 检测单条流 (API调用)
async function checkStream(udpxyUrl, multicastUrl, name = '') {
    showProgress(0, 1, `正在检测: ${name || '-'}`);
    const startTime = Date.now();
    try {
        const response = await fetch('/api/check-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udpxyUrl, multicastUrl, name }),
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '检测失败');

        showProgress(1, 1, `检测完成: ${escapeHTML(name || data.name || '-')} | 分辨率:${escapeHTML(data.resolution || '-')} | 编码:${escapeHTML(data.codec || '-')} | 帧率:${escapeHTML(data.frameRate || '-')} | ${data.isAvailable ? '✅在线' : '❌离线'}`);
        showLastResult(data, name, multicastUrl);
        setTimeout(() => {
            const total = 1;
            const online = data.isAvailable ? 1 : 0;
            const offline = data.isAvailable ? 0 : 1;
            const usedSec = ((Date.now() - startTime) / 1000).toFixed(2);
            showProgress(1, 1, `检测完成 | 总数: ${total} 在线: ${online} 离线: ${offline} 耗时: ${usedSec}s | ${data.isAvailable ? '✅在线' : '❌离线'}`);
            getStreams();
        }, 1800);
        return data;
    } catch (error) {
        showProgress(1, 1, `检测失败: ${escapeHTML(name || '-')}`);
        setTimeout(hideProgress, 1800);
        console.error('Error:', error);
        return { success: false, message: '请求失败' };
    }
}

// 批量检测入口
async function batchCheckStreams(udpxyUrl, batchText) {
    if (isTaskPaused) {
        try {
            const res = await fetch('/api/task/resume', { method: 'POST' });
            const d = await res.json();
            if (d.success) {
                showProgress(0, 100, '任务已恢复...');
            } else {
                showCenterConfirm('恢复失败: ' + d.message, null, true);
            }
        } catch (e) { console.error(e); }
        return;
    }

    if (!batchText || !batchText.trim()) {
        showCenterConfirm('请输入或加载检测地址', null, true);
        return;
    }

    const concurrency = document.getElementById('concurrencySelect') ? document.getElementById('concurrencySelect').value : 10;
    const retry = document.getElementById('retrySelect') ? document.getElementById('retrySelect').value : 0;

    try {
        const response = await fetch('/api/task/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'batch',
                udpxyUrl,
                batchText,
                concurrency,
                retry
            }),
        });
        const data = await response.json();
        if (data.success) {
            showProgress(0, 100, '后台任务已启动...');
        } else {
            showCenterConfirm('任务启动失败，可能已有任务在运行', null, true);
        }
    } catch (error) {
        console.error('Error:', error);
        showCenterConfirm('请求失败', null, true);
    }
}

// 范围检测入口
async function rangeCheckStreams(udpxyUrl, startUrl, endUrl) {
    if (isTaskPaused) {
        try {
            const res = await fetch('/api/task/resume', { method: 'POST' });
            const d = await res.json();
            if (d.success) {
                showProgress(0, 100, '任务已恢复...');
            } else {
                showCenterConfirm('恢复失败: ' + d.message, null, true);
            }
        } catch (e) { console.error(e); }
        return;
    }

    if (!udpxyUrl) { showCenterConfirm('请先选择UDPXY服务器', null, true); return; }
    if (!startUrl || !endUrl) { showCenterConfirm('请输入正确的范围（rtp://ip:port）', null, true); return; }

    const portVal = document.getElementById('portInput')?.value.trim();
    const concurrency = document.getElementById('concurrencySelect') ? document.getElementById('concurrencySelect').value : 10;

    try {
        const response = await fetch('/api/task/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'range',
                udpxyUrl,
                startUrl,
                endUrl,
                ports: portVal,
                concurrency
            }),
        });
        const data = await response.json();
        if (data.success) {
            showProgress(0, 100, '后台范围检测任务已启动...');
        } else {
            showCenterConfirm('任务启动失败，可能已有任务在运行', null, true);
        }
    } catch (error) {
        console.error('Error:', error);
        showCenterConfirm('请求失败', null, true);
    }
}

// 删除流
async function deleteStream(index) {
    showCenterConfirm('确定要删除该流吗？', async function (ok) {
        if (!ok) return;
        try {
            const response = await fetch(`/api/stream/${index}`, { method: 'DELETE' });
            const data = await response.json();
            if (data.success) getStreams();
        } catch (error) { console.error('Error:', error); }
    });
}

// --- 数据展示与图表 ---

async function initDashboard() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        if (data.success && data.stats) {
            renderCharts(data.stats);
        }
    } catch (e) {
        console.error("Failed to load stats", e);
    }
}

function renderCharts(stats) {
    // 1. 状态饼图
    const ctxStatus = document.getElementById('statusChart');
    if (ctxStatus) {
        const ctx = ctxStatus.getContext('2d');
        if (statusChartInstance) statusChartInstance.destroy();

        statusChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['在线', '离线'],
                datasets: [{
                    data: [stats.online, stats.offline],
                    backgroundColor: ['#28a745', '#dc3545'],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    }

    // 2. 分辨率柱状图 (取前10个)
    const ctxRes = document.getElementById('resolutionChart');
    if (ctxRes) {
        const ctx = ctxRes.getContext('2d');
        if (resolutionChartInstance) resolutionChartInstance.destroy();

        const resEntries = Object.entries(stats.resolutions || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);

        resolutionChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: resEntries.map(e => e[0]),
                datasets: [{
                    label: '数量',
                    data: resEntries.map(e => e[1]),
                    backgroundColor: '#6f42c1',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true, grid: { display: false } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
}

function updateStatsAndDisplay() {
    const search = lastSearch.trim().toLowerCase();
    let filtered = allStreams;
    if (search) {
        filtered = allStreams.filter(s => (s.name || '').toLowerCase().includes(search) || (s.multicastUrl || '').toLowerCase().includes(search));
    }
    if (filterStatus === 'online') filtered = filtered.filter(s => s.isAvailable);
    if (filterStatus === 'offline') filtered = filtered.filter(s => !s.isAvailable);

    const online = filtered.filter(s => s.isAvailable);
    const offline = filtered.filter(s => !s.isAvailable);

    const st = document.getElementById('stat-total');
    if (st) st.innerText = filtered.length;
    const so = document.getElementById('stat-online');
    if (so) so.innerText = online.length;
    const soff = document.getElementById('stat-offline');
    if (soff) soff.innerText = offline.length;

    // 分页处理
    const total = filtered.length;
    const sizeVal = pageSize === 'all' ? total : Number(pageSize);
    const pages = sizeVal >= total ? 1 : Math.max(1, Math.ceil(total / sizeVal));
    if (currentPage > pages) currentPage = pages;
    if (currentPage < 1) currentPage = 1;

    const start = (sizeVal >= total) ? 0 : (currentPage - 1) * sizeVal;
    const end = (sizeVal >= total) ? total : Math.min(start + sizeVal, total);
    const pageArr = filtered.slice(start, end);

    // 渲染列表
    renderStreamsList(pageArr);

    // 更新分页控件
    updatePaginationControls(sizeVal, total, pages);
}


function renderStreamsList(arr) {
    const e = typeof escapeHTML === 'function' ? escapeHTML : (s => s);
    const render = arr => arr.map((stream, idx) => `
<div class="stream-item d-flex align-items-center ${stream.isAvailable ? 'available' : 'unavailable'} p-3 mb-2 rounded border bg-white shadow-sm position-relative overflow-hidden">
    <div class="d-flex align-items-center flex-grow-1 gap-3 flex-wrap">
        <div class="form-check mb-0">
             <input type="checkbox" class="form-check-input sel-index" data-index="${allStreams.indexOf(stream)}">
        </div>
        
        ${stream.logo ? `<img src="${e(stream.logo)}" alt="" class="rounded bg-light border" style="width:48px;height:48px;object-fit:contain;" onerror="if(!this.dataset.err){this.dataset.err=1;this.src='/api/proxy/stream?url='+encodeURIComponent(this.src);}">` : '<div class="rounded bg-light border d-flex align-items-center justify-content-center text-muted" style="width:48px;height:48px;"><i class="bi bi-tv"></i></div>'}
        
        <div class="d-flex flex-column" style="min-width: 180px; max-width: 300px;">
            <span class="fw-bold text-dark text-truncate" title="${e(stream.name || '')}">${e(stream.name || '未命名频道')}</span>
            <span class="small text-muted text-truncate font-monospace" title="${e(stream.multicastUrl)}">${e(stream.multicastUrl)}</span>
        </div>

        <div class="d-flex flex-wrap gap-2 align-items-center ms-lg-3">
             <span class="badge ${stream.isAvailable ? 'bg-success' : 'bg-danger'} rounded-pill d-flex align-items-center">
                ${stream.isAvailable ? '<i class="bi bi-check-circle-fill me-1"></i>在线' : '<i class="bi bi-x-circle-fill me-1"></i>离线'}
             </span>
             ${stream.isAvailable ? `
                 <span class="badge bg-light text-dark border">Resolution: ${e(stream.resolution || '-')}</span>
                 <span class="badge bg-light text-dark border">FPS: ${e(stream.frameRate || '-')}</span>
                 <span class="badge bg-light text-dark border">Codec: ${e(stream.codec || '-')}</span>
                 ${stream.hdr && stream.hdr !== '-' && stream.hdr !== 'SDR' ? `<span class="badge ${stream.hdr === 'HDR10' ? 'bg-danger' : stream.hdr === 'HLG' ? 'bg-warning text-dark' : 'bg-info'}">` + e(stream.hdr) + `</span>` : (stream.hdr === 'SDR' ? '<span class="badge bg-secondary">SDR</span>' : '')}
                 ${stream.audio && stream.audio !== '-' ? `<span class="badge bg-light text-dark border">Audio: ${e((stream.audio || '').toUpperCase())}${stream.audioChannels ? (stream.audioChannels >= 8 ? ' 7.1' : stream.audioChannels >= 6 ? ' 5.1' : ' ' + e(stream.audioChannels) + 'ch') : ''}</span>` : ''}
             ` : ''}
             ${stream.groupTitle ? `<span class="badge bg-info text-dark bg-opacity-10 border border-info">Group: ${e(stream.groupTitle)}</span>` : ''}
        </div>
    </div>

    <div class="d-flex gap-2 ms-auto align-self-center">
        <button class="btn btn-sm btn-outline-success" onclick="openPotPlayer('${e(stream.udpxyUrl || '')}/rtp/${e((stream.multicastUrl || '').replace('rtp://', ''))}${stream.httpParam ? ('?' + e(stream.httpParam)) : ''}')" title="播放">
            <i class="bi bi-play-fill"></i> <span class="d-none d-md-inline">播放</span>
        </button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteStream(${allStreams.indexOf(stream)})" title="删除">
            <i class="bi bi-trash"></i> <span class="d-none d-md-inline">删除</span>
        </button>
    </div>
</div>
`).join('');

    const sl = document.getElementById('streams-list');
    if (sl) sl.innerHTML = render(arr);
    bindListEvents(); // 重新绑定列表内的事件（如checkbox）
}

function updatePaginationControls(sizeVal, total, pages) {
    const info = document.getElementById('pageInfo');
    const sel = document.getElementById('pageSizeSelect');
    const prev = document.getElementById('prevPageBtn');
    const next = document.getElementById('nextPageBtn');

    if (info) info.textContent = (sizeVal >= total) ? `第 1/1 页（共 ${total} 条）` : `第 ${currentPage}/${pages} 页（共 ${total} 条）`;

    if (sel) {
        sel.value = (pageSize === 'all') ? 'all' : String(pageSize);
        sel.onchange = function () {
            pageSize = this.value === 'all' ? 'all' : Number(this.value);
            currentPage = 1;
            updateStatsAndDisplay();
        };
    }
    if (prev) prev.onclick = function () { if (currentPage > 1) { currentPage--; updateStatsAndDisplay(); } };
    if (next) next.onclick = function () { if (sizeVal >= total) return; if (currentPage < pages) { currentPage++; updateStatsAndDisplay(); } };
}

function bindListEvents() {
    const selectAllBox = document.getElementById('selectAllIndexPage');
    if (selectAllBox) {
        const boxes = Array.from(document.querySelectorAll('.sel-index'));
        const allChecked = boxes.length > 0 && boxes.every(b => selectedSet.has(Number(b.dataset.index)));
        selectAllBox.checked = allChecked;
        selectAllBox.onchange = function () {
            const xs = Array.from(document.querySelectorAll('.sel-index'));
            xs.forEach(x => {
                const i = Number(x.dataset.index);
                if (this.checked) { selectedSet.add(i); x.checked = true; } else { selectedSet.delete(i); x.checked = false; }
            });
        };
    }

    const boxes = Array.from(document.querySelectorAll('.sel-index'));
    boxes.forEach(b => {
        b.checked = selectedSet.has(Number(b.dataset.index));
        b.onchange = function () {
            const i = Number(this.dataset.index);
            if (this.checked) selectedSet.add(i); else selectedSet.delete(i);
        };
    });
}

function openPotPlayer(url) {
    const schemes = [
        'potplayer://' + url,
        'potplayer://play?url=' + encodeURIComponent(url)
    ];
    let opened = false;
    try {
        window.location.href = schemes[0];
        opened = true;
    } catch (e) { }
    setTimeout(() => {
        if (!opened) {
            try {
                window.location.href = schemes[1];
            } catch (e) { }
        }
    }, 200);
}

// --- 配置与设置相关 ---

// UDPXY 服务器管理
const UDPS_KEY = 'udpxyServers';
const UDP_CURR_KEY = 'udpxyCurrentId';
function getUdpxyServers() {
    try {
        const raw = localStorage.getItem(UDPS_KEY);
        let list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        if (list.length === 0) {
            list = [{ id: String(Date.now()), name: '默认服务器', url: 'http://192.168.88.1:8333' }];
            localStorage.setItem(UDPS_KEY, JSON.stringify(list));
            localStorage.setItem(UDP_CURR_KEY, list[0].id);
        }
        return list;
    } catch (e) {
        const list = [{ id: String(Date.now()), name: '默认服务器', url: 'http://192.168.88.1:8333' }];
        localStorage.setItem(UDPS_KEY, JSON.stringify(list));
        localStorage.setItem(UDP_CURR_KEY, list[0].id);
        return list;
    }
}
function saveUdpxyServers(list) { localStorage.setItem(UDPS_KEY, JSON.stringify(list)); }
function getCurrentUdpxyId() { return localStorage.getItem(UDP_CURR_KEY); }
function setCurrentUdpxyId(id) { localStorage.setItem(UDP_CURR_KEY, id); }
function getCurrentUdpxyUrl() {
    const list = getUdpxyServers();
    const curr = getCurrentUdpxyId();
    const found = list.find(s => s.id === curr) || list[0];
    return found ? found.url : '';
}
async function syncUdpxyServersBackend() {
    const list = getUdpxyServers();
    const curr = getCurrentUdpxyId();
    await fetch('/api/config/udpxy-servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers: list, currentId: curr }) });
}
async function loadUdpxyServersBackend() {
    try {
        const r = await fetch('/api/config/udpxy-servers');
        const j = await r.json();
        if (j.success && Array.isArray(j.servers) && j.servers.length > 0) {
            localStorage.setItem(UDPS_KEY, JSON.stringify(j.servers));
            if (j.currentId) localStorage.setItem(UDP_CURR_KEY, j.currentId);
        }
    } catch (e) { }
}
function addUdpxy(name, url) {
    name = (name || '').trim();
    url = (url || '').trim();
    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
        showCenterConfirm('请填写正确的服务器地址（http://或https://）', null, true);
        return;
    }
    if (!name) name = '未命名服务器';
    const list = getUdpxyServers();
    const id = String(Date.now());
    list.push({ id, name, url });
    saveUdpxyServers(list);
    setCurrentUdpxyId(id);
    renderUdpxySelect();
    syncUdpxyServersBackend();
}
function deleteCurrentUdpxy() {
    const list = getUdpxyServers();
    if (list.length <= 1) {
        showCenterConfirm('至少保留一个服务器', null, true);
        return;
    }
    const curr = getCurrentUdpxyId();
    const idx = list.findIndex(s => s.id === curr);
    if (idx >= 0) list.splice(idx, 1);
    saveUdpxyServers(list);
    setCurrentUdpxyId(list[0].id);
    renderUdpxySelect();
    syncUdpxyServersBackend();
}
function renderUdpxySelect() {
    const select = document.getElementById('udpxySelect');
    const input = document.getElementById('udpxyUrl');
    if (!select) return;
    const list = getUdpxyServers();
    const curr = getCurrentUdpxyId() || (list[0] && list[0].id);
    select.innerHTML = list.map(s => {
        const nameEsc = escapeHTML(s.name || '');
        const urlEsc = escapeHTML(s.url || '');
        return `<option value="${escapeHTML(s.id)}">${nameEsc} (${urlEsc})</option>`;
    }).join('');
    if (curr) select.value = curr;
    const url = getCurrentUdpxyUrl();
    if (input) input.value = url || '';
}


// 断点续扫相关
function clearScanTask() { try { localStorage.removeItem('scanTask'); } catch (e) { } }

// 数据导出
function exportData(format) {
    if (!allStreams || allStreams.length === 0) {
        showCenterConfirm('当前没有可导出的数据', null, true);
        return;
    }

    let exportList = allStreams;
    if (filterStatus === 'online') exportList = allStreams.filter(s => s.isAvailable);
    if (filterStatus === 'offline') exportList = allStreams.filter(s => !s.isAvailable);

    let content = '';
    const dateStr = new Date().toISOString().replace(/T/, '_').replace(/:/g, '').split('.')[0];
    const filename = `streams_${filterStatus}_${dateStr}.${format}`;

    if (format === 'm3u') {
        content = '#EXTM3U\n';
        exportList.forEach(s => {
            content += `#EXTINF:-1 tvg-name="${s.name}" tvg-logo="${s.logo || ''}" group-title="${s.groupTitle || '默认'}",${s.name}\n`;
            let url = s.multicastUrl;
            content += `${url}\n`;
        });
    } else if (format === 'txt') {
        // 先按 groupTitle 排序以便合并输出
        exportList.sort((a, b) => (a.groupTitle || '默认').localeCompare(b.groupTitle || '默认'));
        let currentGroup = '';
        exportList.forEach(s => {
            const group = s.groupTitle || '默认';
            if (group !== currentGroup) {
                content += `${group},#genre#\n`;
                currentGroup = group;
            }
            let url = s.multicastUrl;
            content += `${s.name},${url}\n`;
        });
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}

// 辅助功能
function updateInputCount() {
    let rangeStart = document.getElementById('rangeStart') ? (document.getElementById('rangeStart').value || '').trim() : '';
    let rangeEnd = document.getElementById('rangeEnd') ? (document.getElementById('rangeEnd').value || '').trim() : '';
    let batchInput = document.getElementById('batchInput') ? (document.getElementById('batchInput').value || '').trim() : '';
    let count = 0;

    // 这里依赖 utils.js 的 parseRtpUrl, ipv4ToInt
    if (rangeStart && rangeEnd) {
        const s = parseRtpUrl(rangeStart);
        const e = parseRtpUrl(rangeEnd);
        if (s && e) {
            let a = ipv4ToInt(s.ip), b = ipv4ToInt(e.ip);
            if (a > b) [a, b] = [b, a];
            count = Math.min(b - a + 1, 1000); // 估算
        }
    } else if (batchInput) {
        count = batchInput.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).length;
    }
    const statTotal = document.getElementById('stat-total');
    if (statTotal) statTotal.innerText = count;
    const statOnline = document.getElementById('stat-online');
    if (statOnline) statOnline.innerText = 0;
    const statOffline = document.getElementById('stat-offline');
    if (statOffline) statOffline.innerText = 0;
}

function updateRangeSummary() {
    const startEl = document.getElementById('rangeStart');
    const endEl = document.getElementById('rangeEnd');
    const sumEl = document.getElementById('rangeSummary');
    const cidrEl = document.getElementById('cidrInput');
    const portEl = document.getElementById('portInput');

    if (!startEl || !endEl || !sumEl) return;

    const portStr = portEl ? portEl.value.trim() : '';
    const ports = parsePorts(portStr);
    const portCount = ports.length || 1;
    const portLabel = ports.length > 1 ? ` × ${ports.length}端口` : '';

    const s = parseRtpUrl(startEl.value);
    const e = parseRtpUrl(endEl.value);

    if (!s || !e) {
        const cidrStr = cidrEl ? cidrEl.value.trim() : '';
        const parts = cidrStr.split('/');
        if (parts.length === 2 && parseInt(parts[1]) <= 32) {
            const rng = parseCIDR(cidrStr);
            if (rng) {
                sumEl.value = `${cidrStr}${portLabel}`;
                return;
            }
        }
        sumEl.value = '';
        return;
    }

    const si = ipv4ToInt(s.ip);
    const ei = ipv4ToInt(e.ip);

    const ipCount = Math.abs(ei - si) + 1;
    const totalCheck = ipCount * portCount;
    sumEl.value = `${s.ip} - ${e.ip}${portLabel}  检测总数：${totalCheck}`;
}


// --- UI 事件绑定集中处理 ---
function bindUIEvents() {
    // 搜索
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            lastSearch = this.value;
            updateStatsAndDisplay();
        });
    }

    // 筛选按钮
    const btnAll = document.getElementById('filterAll');
    const btnOnline = document.getElementById('filterOnline');
    const btnOffline = document.getElementById('filterOffline');
    if (btnAll) btnAll.onclick = function () { filterStatus = 'all'; updateFilterActive('all'); updateStatsAndDisplay(); };
    if (btnOnline) btnOnline.onclick = function () { filterStatus = 'online'; updateFilterActive('online'); updateStatsAndDisplay(); };
    if (btnOffline) btnOffline.onclick = function () { filterStatus = 'offline'; updateFilterActive('offline'); updateStatsAndDisplay(); };

    function updateFilterActive(status) {
        [btnAll, btnOnline, btnOffline].forEach(btn => btn?.classList.remove('active'));
        if (status === 'all') btnAll?.classList.add('active');
        if (status === 'online') btnOnline?.classList.add('active');
        if (status === 'offline') btnOffline?.classList.add('active');
    }

    // 清空按钮
    const clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) {
        clearAllBtn.onclick = async function () {
            showCenterConfirm('确定要清空所有检测结果吗？', async function (ok) {
                if (!ok) return;
                try {
                    await fetch('/api/streams', { method: 'DELETE' });
                    getStreams();
                    showProgress(0, 0, '已清空所有结果');
                } catch (e) {
                    console.error(e);
                    showCenterConfirm('清空失败', null, true);
                }
            });
        };
    }

    // 批量删除
    const batchDeleteBtn = document.getElementById('batchDeleteBtn');
    if (batchDeleteBtn) {
        batchDeleteBtn.onclick = async function () {
            const arr = Array.from(selectedSet);
            if (arr.length === 0) return;
            showCenterConfirm(`确定删除选中的 ${arr.length} 个频道吗？`, async function (ok) {
                if (!ok) return;
                for (const i of arr) {
                    try { await fetch(`/api/stream/${i}`, { method: 'DELETE' }); } catch (e) { }
                }
                selectedSet = new Set();
                getStreams();
            });
        };
    }

    // 检测配置相关绑定
    const loadBtn = document.getElementById('loadFileBtn');
    if (loadBtn) loadBtn.onclick = loadFromNetwork;

    // 开始检测
    const startDetectBtn = document.getElementById('startDetectBtn');
    if (startDetectBtn) {
        startDetectBtn.addEventListener('click', async () => {
            if (detectRunning) return;
            detectRunning = true;
            const startBtn = document.getElementById('startDetectBtn');
            const stopBtn = document.getElementById('stopDetectBtn');
            if (startBtn) startBtn.disabled = true;

            const udpxyUrl = document.getElementById('udpxyUrl').value;
            const batchText = document.getElementById('batchInput').value;
            const startUrl = document.getElementById('rangeStart').value.trim();
            const endUrl = document.getElementById('rangeEnd').value.trim();

            if (!udpxyUrl) {
                showCenterConfirm('请先填写UDPXY服务器地址', null, true);
                detectRunning = false;
                if (startBtn) startBtn.disabled = false;
                return;
            }

            try {
                clearScanTask();
                if (batchText.trim()) {
                    await batchCheckStreams(udpxyUrl, batchText);
                } else if (startUrl && endUrl) {
                    await rangeCheckStreams(udpxyUrl, startUrl, endUrl);
                } else {
                    showCenterConfirm('请粘贴组播地址或填写范围再点击检测', null, true);
                }
            } finally {
                detectRunning = false;
                if (startBtn) startBtn.disabled = false;
            }
        });
    }

    // 停止检测
    const stopDetectBtn = document.getElementById('stopDetectBtn');
    if (stopDetectBtn) {
        stopDetectBtn.addEventListener('click', async function () {
            try {
                await fetch('/api/task/stop', { method: 'POST' });
                showProgress(0, 0, '正在停止任务...');
            } catch (e) { }
        });
    }

    // UDPXY 设置绑定
    loadUdpxyServersBackend().then(() => { renderUdpxySelect(); });
    const select = document.getElementById('udpxySelect');
    const addBtn = document.getElementById('addUdpxyBtn');
    const delBtn = document.getElementById('delUdpxyBtn');
    const applyBtn = document.getElementById('applyUdpxyBtn');

    if (select) select.onchange = function () { setCurrentUdpxyId(this.value); renderUdpxySelect(); };
    if (addBtn) addBtn.onclick = function () {
        const nameInput = document.getElementById('udpxyNameInput');
        const urlInput = document.getElementById('udpxyAddInput');
        if (!nameInput || !urlInput) return;
        const name = nameInput.value;
        const url = urlInput.value;
        addUdpxy(name, url);
        nameInput.value = '';
        urlInput.value = '';
    };
    if (delBtn) delBtn.onclick = function () {
        showCenterConfirm('确定删除当前选中服务器？', function (ok) { if (ok) deleteCurrentUdpxy(); });
    };
    if (applyBtn) applyBtn.onclick = async function () {
        await syncUdpxyServersBackend();
        showCenterConfirm('已应用并保存当前服务器设置', null, true);
    };

    // CIDR 工具绑定
    const applyCidrBtn = document.getElementById('applyCidrBtn');
    const clearCidrBtn = document.getElementById('clearCidrBtn');
    const inputIds = ['rangeStart', 'rangeEnd', 'cidrInput', 'portInput'];

    inputIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateRangeSummary);
    });

    if (applyCidrBtn) applyCidrBtn.addEventListener('click', function () {
        const cidrEl = document.getElementById('cidrInput');
        if (!cidrEl) return;
        const cidr = cidrEl.value.trim();
        const rng = parseCIDR(cidr);
        if (rng) {
            const startE = document.getElementById('rangeStart');
            if (startE) startE.value = rng.start;
            const endE = document.getElementById('rangeEnd');
            if (endE) endE.value = rng.end;
            updateRangeSummary();
            showCenterConfirm('CIDR已转换为IP范围', null, true);
        } else {
            showCenterConfirm('CIDR格式不正确，例如: 192.168.1.0/24', null, true);
        }
    });

    if (clearCidrBtn) clearCidrBtn.addEventListener('click', function () {
        document.getElementById('cidrInput').value = '';
        document.getElementById('rangeStart').value = '';
        document.getElementById('rangeEnd').value = '';
        updateRangeSummary();
    });

    const bodyObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                if (document.body.classList.contains('modal-open')) {
                    document.body.style.paddingRight = '0px';
                }
            }
        });
    });
    bodyObserver.observe(document.body, { attributes: true });

    // 修复模态框关闭后背景不可滚动问题
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('hidden.bs.modal', function () {
            if (document.querySelectorAll('.modal.show').length === 0) {
                document.body.classList.remove('modal-open');
                document.body.style.paddingRight = '';
                const backdrop = document.querySelector('.modal-backdrop');
                if (backdrop) backdrop.remove();
            }
        });
    });

    // 版本快照绑定
    const saveId = document.getElementById('saveBtnIndex') || document.getElementById('saveBtn');
    if (saveId) saveId.onclick = persistSave;
    const loadId = document.getElementById('loadBtnIndex') || document.getElementById('loadBtn');
    if (loadId) loadId.onclick = loadSelectedVersion;
    const delId = document.getElementById('deletePersistBtnIndex') || document.getElementById('deletePersistBtn');
    if (delId) delId.onclick = deleteSelectedVersion;
    const refreshId = document.getElementById('refreshVersionsBtnIndex') || document.getElementById('refreshVersionsBtn');
    if (refreshId) refreshId.onclick = refreshVersions;

    // 初始化版本列表
    refreshVersions();

    // 绑定更新与退出
    window.doLogout = async function () {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    }
}

async function loadUserSettings() {
    // 从后端恢复设置到本地缓存（分组、Logo模板、FCC服务器）
    fetch('/api/settings').then(r => r.json()).then(j => {
        if (j.success && j.settings) {
            if (Array.isArray(j.settings.groupTitles)) localStorage.setItem('groupTitles', JSON.stringify(j.settings.groupTitles));
            if (typeof j.settings.logoTemplate === 'string') localStorage.setItem('logoTemplate', j.settings.logoTemplate);
        }
    }).catch(() => { });
}

async function loadSystemInfo() {
    try {
        const r = await fetch('/api/system/info');
        const j = await r.json();
        if (j.success) {
            document.getElementById('footerVersion').textContent = 'v' + j.version;
            const curVerEl = document.getElementById('modalCurrentVersion');
            if (curVerEl) curVerEl.textContent = 'v' + j.version;
            if (j.isDocker) {
                isDockerEnv = true;
                const badge = document.getElementById('dockerBadge');
                if (badge) badge.style.display = 'inline-block';
            }
        }
    } catch (e) { }
}

async function loadFromNetwork() {
    const ta = document.getElementById('batchInput');
    const raw = (ta.value || '').trim();
    const urls = raw.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#') && (s.startsWith('http://') || s.startsWith('https://')));
    if (urls.length === 0) {
        showCenterConfirm('请在输入框中填入m3u或txt的网络地址（http/https）后再点击“加载”', null, true);
        return;
    }
    try {
        const resp = await fetch('/api/fetch-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
        });
        const data = await resp.json();
        const texts = (data.results || []).filter(r => r.ok).map(r => r.text);
        let items = [];
        for (const t of texts) {
            const parsed = parsePlaylistText(t);
            if (parsed && parsed.length) items = items.concat(parsed);
        }
        if (items.length) items = unifyChannelNames(items);
        if (items.length === 0) {
            showCenterConfirm('未解析到有效地址', null, true);
            return;
        }
        const lines = items.map(it => `${it.name || ''},${it.url}`);
        ta.value = lines.join('\n');
        updateInputCount();
        const okCount = texts.length;
        const failCount = urls.length - okCount;
        showCenterConfirm('网络源：成功' + okCount + ' 失败' + failCount + '；解析到地址：' + items.length + ' 条', null, true);
    } catch (e) {
        showCenterConfirm('加载网络文件失败（代理错误或网络问题）', null, true);
    }
}

// === 版本快照 (Persistence) ===
async function refreshVersions() {
    try {
        const res = await fetch('/api/persist/list');
        const data = await res.json();
        const sel1 = document.getElementById('versionsSelectIndex');
        const sel2 = document.getElementById('versionsSelect');
        const v = sel1 ? sel1.value : (sel2 ? sel2.value : null);

        let html = '';
        if (data.success && data.backups) {
            data.backups.forEach(b => {
                const date = new Date(b.time).toLocaleString();
                html += `<option value="${b.file}">${b.file} (${date})</option>`;
            });
        }
        if (sel1) { sel1.innerHTML = html; if (v) sel1.value = v; }
        if (sel2) { sel2.innerHTML = html; if (v) sel2.value = v; }
    } catch (e) {
        console.error('Failed to refresh versions:', e);
    }
}

function persistSave() {
    showCenterConfirm('确定将当前的所有配置和数据备份存档吗？', async function (ok) {
        if (!ok) return;
        try {
            const res = await fetch('/api/persist/save', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showCenterConfirm('备份成功', null, true);
                refreshVersions();
            } else {
                showCenterConfirm('备份失败: ' + data.message, null, true);
            }
        } catch (e) {
            console.error(e);
            showCenterConfirm('网络错误', null, true);
        }
    });
}

async function persistLoad() {
    try {
        const res = await fetch('/api/persist/load', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            getStreams(); // refresh list
            showCenterConfirm('已重新加载最新流数据', null, true);
        }
    } catch (e) {
        console.error(e);
    }
}

function loadSelectedVersion() {
    const sel1 = document.getElementById('versionsSelectIndex');
    const sel2 = document.getElementById('versionsSelect');
    const v = sel1 && sel1.value ? sel1.value : (sel2 ? sel2.value : null);
    if (!v) { showCenterConfirm('请先选择一个离线版本', null, true); return; }

    showCenterConfirm(`警告：加载历史版本 [${v}] 将会覆盖当前的所有流数据，并且此操作不可撤销。\n\n您确定要覆盖吗？`, async function (ok) {
        if (!ok) return;
        try {
            const res = await fetch('/api/persist/load-version', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: v })
            });
            const data = await res.json();
            if (data.success) {
                showCenterConfirm('版本已恢复', null, true);
                getStreams();
            } else {
                showCenterConfirm('恢复失败: ' + data.message, null, true);
            }
        } catch (e) {
            console.error(e);
        }
    });
}

function deleteSelectedVersion() {
    const sel1 = document.getElementById('versionsSelectIndex');
    const sel2 = document.getElementById('versionsSelect');
    const v = sel1 && sel1.value ? sel1.value : (sel2 ? sel2.value : null);
    if (!v) { showCenterConfirm('请先选择一个离线版本', null, true); return; }

    showCenterConfirm(`确定删除该历史版本 [${v}] 吗？`, async function (ok) {
        if (!ok) return;
        try {
            const res = await fetch('/api/persist/delete-version', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: v })
            });
            const data = await res.json();
            if (data.success) {
                showCenterConfirm('已删除版本', null, true);
                refreshVersions();
            } else {
                showCenterConfirm('删除失败: ' + data.message, null, true);
            }
        } catch (e) {
            console.error(e);
        }
    });
}

async function doChangePwd() {
    const username = document.getElementById('newUsername').value.trim();
    const oldPassword = document.getElementById('oldPassword').value;
    const password = document.getElementById('newPassword').value;

    if (!oldPassword) {
        showCenterConfirm('请输入旧密码', null, true);
        return;
    }

    try {
        const r = await fetch('/api/auth/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, oldPassword, password })
        });
        const j = await r.json();
        if (j.success) {
            showCenterConfirm('修改成功，请重新登录', (ok) => {
                fetch('/api/logout', { method: 'POST' }).finally(() => {
                    window.location.reload();
                });
            }, true);
        } else {
            showCenterConfirm(j.message || '修改失败', null, true);
        }
    } catch (e) {
        showCenterConfirm('请求失败', null, true);
    }
}

// --- 版本检测与更新逻辑 (全局通用) ---
async function showVersionModal() {
    const modalEl = document.getElementById('versionModal');
    if (!modalEl) return;
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
    await checkGithubUpdate();
}

async function checkGithubUpdate() {
    const notesDiv = document.getElementById('releaseNotes');
    const latestSpan = document.getElementById('modalLatestVersion');
    const btnUpdate = document.getElementById('btnUpdate');
    if (!notesDiv || !latestSpan) return;

    try {
        const r = await fetch('https://api.github.com/repos/shihairu22/Iptv-Checker/releases/latest');
        if (r.status === 200) {
            const data = await r.json();
            latestSpan.textContent = data.tag_name;
            // 简单的 Markdown 转 HTML (增加 XSS 转义)
            const safeBody = escapeHTML(data.body || '');
            notesDiv.innerHTML = safeBody.replace(/\r\n/g, '<br>').replace(/\n/g, '<br>');

            const verText = document.getElementById('modalCurrentVersion')?.textContent || '';
            const currentVer = verText.replace('v', '').trim();
            const remoteVer = data.tag_name.replace('v', '').trim();

            if (remoteVer !== currentVer && btnUpdate) {
                btnUpdate.textContent = isDockerEnv ? 'Docker 更新指引' : '立即更新';
                btnUpdate.disabled = false;
                btnUpdate.classList.remove('btn-secondary');
                btnUpdate.classList.add('btn-success');
            }
        }
    } catch (e) {
        notesDiv.innerHTML = '<div class="text-center text-muted py-3">获取更新信息失败</div>';
    }
}

async function doUpdate() {
    if (isDockerEnv) {
        alert('Docker 环境无法直接通过网页更新。\n\n请在服务器执行以下命令更新：\ndocker-compose pull && docker-compose up -d');
        return;
    }

    if (!confirm('确定要尝试自动更新吗？\n请确保已保存数据。')) return;

    const btn = document.getElementById('btnUpdate');
    if (!btn) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '更新中...';

    try {
        const r = await fetch('/api/system/update', { method: 'POST' });
        const j = await r.json();
        alert(j.message);
        if (j.success) {
            location.reload();
        }
    } catch (e) {
        alert('请求失败');
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}
