/**
 * app.js - 鏍稿績涓氬姟閫昏緫
 * 渚濊禆: utils.js, Socket.IO, Chart.js, Bootstrap
 */

// --- 鍏ㄥ眬鍙橀噺 ---
let allStreams = [];
let detectCancel = false;
let detectRunning = false;
let isTaskPaused = false;
let lastSearch = '';
let selectedSet = new Set();
let pageSize = 20;
let currentPage = 1;
let filterStatus = 'online'; // all/online/offline

// 鍥捐〃瀹炰緥
let statusChartInstance = null;
let resolutionChartInstance = null;

// Socket.IO 瀹炰緥
const socket = io();

// --- 鐧诲綍鐘舵€佹鏌?---
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

// --- 鍒濆鍖栦笌浜嬩欢鐩戝惉 ---
document.addEventListener('DOMContentLoaded', function () {
    // 1. 鍒濆鍖栫郴缁熶俊鎭笌鐗堟湰
    loadSystemInfo();

    // 2. 鍔犺浇鏁版嵁
    getStreams();
    updateInputCount();

    // 3. 鎭㈠鐢ㄦ埛璁剧疆
    loadUserSettings();

    // 4. 鍒濆鍖栧浘琛?    initDashboard();

    // 5. 缁戝畾UI浜嬩欢
    bindUIEvents();

    // 6. 鍒濆鍖栬寖鍥存娴嬮瑙?    updateRangeSummary();
});

// --- Socket.IO 浜嬩欢 ---
socket.on('task:status', updateTaskUI);
socket.on('task:progress', updateTaskUI);
// console.log('Server Log:', msg);

// 浼樺寲: 鎺ユ敹澧為噺鏁版嵁鏇存柊
socket.on('task:update_data', (batch) => {
    if (!batch || !Array.isArray(batch)) return;

    // 鏇存柊鏈湴鍐呭瓨鏁版嵁
    // 寤虹珛绱㈠紩鏄犲皠鍔犻€熸煡鎵?    const urlMap = new Map();
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
        }
    });

    // 鍒锋柊鏄剧ず (闃叉姈)
    updateStatsAndDisplay();
});

function updateTaskUI(task) {
    if (!task) return;

    if (task.running || task.paused) {
        isTaskPaused = task.paused;
        // const percent = task.total > 0 ? Math.round((task.finished / task.total) * 100) : 0;
        showProgress(task.finished, task.total,
            task.paused ? `浠诲姟鏆傚仠 (宸插畬鎴? ${task.finished}/${task.total}) - 鐐瑰嚮鈥滅户缁娴嬧€濇仮澶峘 : `姝ｅ湪鍚庡彴妫€娴? ${task.finished}/${task.total} | 鎴愬姛: ${task.success} 澶辫触: ${task.fail}`);

        // 鏇存柊鎸夐挳鐘舵€?        const startBtn = document.getElementById('startDetectBtn');
        if (startBtn) {
            if (task.paused) {
                startBtn.innerHTML = '<i class="bi bi-play-circle-fill me-1"></i> 缁х画妫€娴?;
                startBtn.classList.remove('btn-success');
                startBtn.classList.add('btn-warning');
            } else {
                startBtn.innerHTML = '<i class="bi bi-activity me-1"></i> 妫€娴嬩腑...';
                startBtn.classList.remove('btn-warning');
                startBtn.classList.add('btn-success');
            }
        }

        // 浼樺寲: 绉婚櫎鍏ㄩ噺鎷夊彇锛屾敼鐢?task:update_data 澧為噺鏇存柊
        // if (task.finished % 10 === 0 || task.finished === task.total) {
        //     getStreams();
        // }

        if (!task.running && !task.paused && task.finished === task.total) {
            showProgress(task.total, task.total, `妫€娴嬪畬鎴?| 鎬绘暟: ${task.total} 鍦ㄧ嚎: ${task.success} 绂荤嚎: ${task.fail}`);
            getStreams();

            // 鎭㈠鎸夐挳
            const startBtn = document.getElementById('startDetectBtn');
            if (startBtn) {
                startBtn.innerHTML = '<i class="bi bi-play-circle-fill me-1"></i> 寮€濮嬫娴?;
                startBtn.classList.remove('btn-warning');
                startBtn.classList.add('btn-success');
            }
            isTaskPaused = false;
        }
    } else {
        // 浠诲姟鏈繍琛?        isTaskPaused = false;
        const startBtn = document.getElementById('startDetectBtn');
        if (startBtn) {
            startBtn.innerHTML = '<i class="bi bi-play-circle-fill me-1"></i> 寮€濮嬫娴?;
            startBtn.classList.remove('btn-warning');
            startBtn.classList.add('btn-success');
        }

        // 鍙湁鍦?UI 鏄剧ず鐫€杩涘害鏉℃椂鎵嶉殣钘忥紝閬垮厤鍒氬姞杞介〉闈㈠氨闂儊
        const progressBarWrap = document.getElementById('progressBarWrap');
        if (progressBarWrap && progressBarWrap.style.display !== 'none' && !task.logs?.length) {
            // socket 杩炴帴鍒濇浼氬彂閫?status锛屽彲鑳芥槸绌洪棽鐘舵€侊紝涓嶅仛寮哄埗闅愯棌
        }
    }
}

// --- 鏍稿績涓氬姟鍑芥暟 ---

// 鑾峰彇鎵€鏈夋祦
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

// 妫€娴嬪崟鏉℃祦 (API璋冪敤)
async function checkStream(udpxyUrl, multicastUrl, name = '') {
    showProgress(0, 1, `姝ｅ湪妫€娴? ${name || '-'}`);
    const startTime = Date.now();
    try {
        const response = await fetch('/api/check-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udpxyUrl, multicastUrl, name }),
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '妫€娴嬪け璐?);

        showProgress(1, 1, `妫€娴嬪畬鎴? ${name || '-'} | 鍒嗚鲸鐜?${data.resolution || '-'} | 缂栫爜:${data.codec || '-'} | 甯х巼:${data.frameRate || '-'} | ${data.isAvailable ? '鉁呭湪绾? : '鉂岀绾?}`);
        showLastResult(data, name, multicastUrl);
        setTimeout(() => {
            const total = 1;
            const online = data.isAvailable ? 1 : 0;
            const offline = data.isAvailable ? 0 : 1;
            const usedSec = ((Date.now() - startTime) / 1000).toFixed(2);
            showProgress(1, 1, `妫€娴嬪畬鎴?| 鎬绘暟: ${total} 鍦ㄧ嚎: ${online} 绂荤嚎: ${offline} 鑰楁椂: ${usedSec}s | ${data.isAvailable ? '鉁呭湪绾? : '鉂岀绾?}`);
            getStreams();
        }, 1800);
        return data;
    } catch (error) {
        showProgress(1, 1, `妫€娴嬪け璐? ${name || '-'}`);
        setTimeout(hideProgress, 1800);
        console.error('Error:', error);
        return { success: false, message: '璇锋眰澶辫触' };
    }
}

// 鎵归噺妫€娴嬪叆鍙?async function batchCheckStreams(udpxyUrl, batchText) {
    if (isTaskPaused) {
        try {
            const res = await fetch('/api/task/resume', { method: 'POST' });
            const d = await res.json();
            if (d.success) {
                showProgress(0, 100, '浠诲姟宸叉仮澶?..');
            } else {
                showCenterConfirm('鎭㈠澶辫触: ' + d.message, null, true);
            }
        } catch (e) { console.error(e); }
        return;
    }

    if (!batchText || !batchText.trim()) {
        showCenterConfirm('璇疯緭鍏ユ垨鍔犺浇妫€娴嬪湴鍧€', null, true);
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
            showProgress(0, 100, '鍚庡彴浠诲姟宸插惎鍔?..');
        } else {
            showCenterConfirm('浠诲姟鍚姩澶辫触锛屽彲鑳藉凡鏈変换鍔″湪杩愯', null, true);
        }
    } catch (error) {
        console.error('Error:', error);
        showCenterConfirm('璇锋眰澶辫触', null, true);
    }
}

// 鑼冨洿妫€娴嬪叆鍙?async function rangeCheckStreams(udpxyUrl, startUrl, endUrl) {
    if (isTaskPaused) {
        try {
            const res = await fetch('/api/task/resume', { method: 'POST' });
            const d = await res.json();
            if (d.success) {
                showProgress(0, 100, '浠诲姟宸叉仮澶?..');
            } else {
                showCenterConfirm('鎭㈠澶辫触: ' + d.message, null, true);
            }
        } catch (e) { console.error(e); }
        return;
    }

    if (!udpxyUrl) { showCenterConfirm('璇峰厛閫夋嫨UDPXY鏈嶅姟鍣?, null, true); return; }
    if (!startUrl || !endUrl) { showCenterConfirm('璇疯緭鍏ユ纭殑鑼冨洿锛坮tp://ip:port锛?, null, true); return; }

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
            showProgress(0, 100, '鍚庡彴鑼冨洿妫€娴嬩换鍔″凡鍚姩...');
        } else {
            showCenterConfirm('浠诲姟鍚姩澶辫触锛屽彲鑳藉凡鏈変换鍔″湪杩愯', null, true);
        }
    } catch (error) {
        console.error('Error:', error);
        showCenterConfirm('璇锋眰澶辫触', null, true);
    }
}

// 鍒犻櫎娴?async function deleteStream(index) {
    showCenterConfirm('纭畾瑕佸垹闄よ娴佸悧锛?, async function (ok) {
        if (!ok) return;
        try {
            const response = await fetch(`/api/stream/${index}`, { method: 'DELETE' });
            const data = await response.json();
            if (data.success) getStreams();
        } catch (error) { console.error('Error:', error); }
    });
}

// --- 鏁版嵁灞曠ず涓庡浘琛?---

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
    // 1. 鐘舵€侀ゼ鍥?    const ctxStatus = document.getElementById('statusChart');
    if (ctxStatus) {
        const ctx = ctxStatus.getContext('2d');
        if (statusChartInstance) statusChartInstance.destroy();

        statusChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['鍦ㄧ嚎', '绂荤嚎'],
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

    // 2. 鍒嗚鲸鐜囨煴鐘跺浘 (鍙栧墠10涓?
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
                    label: '鏁伴噺',
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

    document.getElementById('stat-total').innerText = filtered.length;
    document.getElementById('stat-online').innerText = online.length;
    document.getElementById('stat-offline').innerText = offline.length;

    // 鍒嗛〉澶勭悊
    const total = filtered.length;
    const sizeVal = pageSize === 'all' ? total : Number(pageSize);
    const pages = sizeVal >= total ? 1 : Math.max(1, Math.ceil(total / sizeVal));
    if (currentPage > pages) currentPage = pages;
    if (currentPage < 1) currentPage = 1;

    const start = (sizeVal >= total) ? 0 : (currentPage - 1) * sizeVal;
    const end = (sizeVal >= total) ? total : Math.min(start + sizeVal, total);
    const pageArr = filtered.slice(start, end);

    // 娓叉煋鍒楄〃
    renderStreamsList(pageArr);

    // 鏇存柊鍒嗛〉鎺т欢
    updatePaginationControls(sizeVal, total, pages);
}


function renderStreamsList(arr) {
    const render = arr => arr.map((stream, idx) => `
<div class="stream-item d-flex align-items-center ${stream.isAvailable ? 'available' : 'unavailable'} p-3 mb-2 rounded border bg-white shadow-sm position-relative overflow-hidden">
    <div class="d-flex align-items-center flex-grow-1 gap-3 flex-wrap">
        <div class="form-check mb-0">
             <input type="checkbox" class="form-check-input sel-index" data-index="${allStreams.indexOf(stream)}">
        </div>
        
        ${stream.logo ? `<img src="${stream.logo}" alt="" class="rounded bg-light border" style="width:48px;height:48px;object-fit:contain;" onerror="if(!this.dataset.err){this.dataset.err=1;this.src='/api/proxy/stream?url='+encodeURIComponent(this.src);}">` : '<div class="rounded bg-light border d-flex align-items-center justify-content-center text-muted" style="width:48px;height:48px;"><i class="bi bi-tv"></i></div>'}
        
        <div class="d-flex flex-column" style="min-width: 180px; max-width: 300px;">
            <span class="fw-bold text-dark text-truncate" title="${stream.name || ''}">${stream.name || '鏈懡鍚嶉閬?}</span>
            <span class="small text-muted text-truncate font-monospace" title="${stream.multicastUrl}">${stream.multicastUrl}</span>
        </div>

        <div class="d-flex flex-wrap gap-2 align-items-center ms-lg-3">
             <span class="badge ${stream.isAvailable ? 'bg-success' : 'bg-danger'} rounded-pill d-flex align-items-center">
                ${stream.isAvailable ? '<i class="bi bi-check-circle-fill me-1"></i>鍦ㄧ嚎' : '<i class="bi bi-x-circle-fill me-1"></i>绂荤嚎'}
             </span>
             ${stream.isAvailable ? `
                 <span class="badge bg-light text-dark border">Resolution: ${stream.resolution || '-'}</span>
                 <span class="badge bg-light text-dark border">FPS: ${stream.frameRate || '-'}</span>
                 <span class="badge bg-light text-dark border">Codec: ${stream.codec || '-'}</span>
                 ${stream.hdr && stream.hdr !== '-' && stream.hdr !== 'SDR' ? `<span class="badge ${stream.hdr === 'HDR10' ? 'bg-danger' : stream.hdr === 'HLG' ? 'bg-warning text-dark' : 'bg-info'}">` + stream.hdr + `</span>` : (stream.hdr === 'SDR' ? '<span class="badge bg-secondary">SDR</span>' : '')}
                 ${stream.audio && stream.audio !== '-' ? `<span class="badge bg-light text-dark border">Audio: ${(stream.audio || '').toUpperCase()}${stream.audioChannels ? (stream.audioChannels >= 8 ? ' 7.1' : stream.audioChannels >= 6 ? ' 5.1' : ' ' + stream.audioChannels + 'ch') : ''}</span>` : ''}
             ` : ''}
             ${stream.groupTitle ? `<span class="badge bg-info text-dark bg-opacity-10 border border-info">Group: ${stream.groupTitle}</span>` : ''}
        </div>
    </div>

    <div class="d-flex gap-2 ms-auto align-self-center">
        <button class="btn btn-sm btn-outline-success" onclick="openPotPlayer('${stream.udpxyUrl}/rtp/${(stream.multicastUrl || '').replace('rtp://', '')}${stream.httpParam ? ('?' + stream.httpParam) : ''}')" title="鎾斁">
            <i class="bi bi-play-fill"></i> <span class="d-none d-md-inline">鎾斁</span>
        </button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteStream(${allStreams.indexOf(stream)})" title="鍒犻櫎">
            <i class="bi bi-trash"></i> <span class="d-none d-md-inline">鍒犻櫎</span>
        </button>
    </div>
</div>
`).join('');

    document.getElementById('streams-list').innerHTML = render(arr);
    bindListEvents(); // 閲嶆柊缁戝畾鍒楄〃鍐呯殑浜嬩欢锛堝checkbox锛?}

function updatePaginationControls(sizeVal, total, pages) {
    const info = document.getElementById('pageInfo');
    const sel = document.getElementById('pageSizeSelect');
    const prev = document.getElementById('prevPageBtn');
    const next = document.getElementById('nextPageBtn');

    if (info) info.textContent = (sizeVal >= total) ? `绗?1/1 椤碉紙鍏?${total} 鏉★級` : `绗?${currentPage}/${pages} 椤碉紙鍏?${total} 鏉★級`;

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

// --- 閰嶇疆涓庤缃浉鍏?---

// UDPXY 鏈嶅姟鍣ㄧ鐞?const UDPS_KEY = 'udpxyServers';
const UDP_CURR_KEY = 'udpxyCurrentId';
function getUdpxyServers() {
    try {
        const raw = localStorage.getItem(UDPS_KEY);
        let list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        if (list.length === 0) {
            list = [{ id: String(Date.now()), name: '榛樿鏈嶅姟鍣?, url: 'http://192.168.88.1:8333' }];
            localStorage.setItem(UDPS_KEY, JSON.stringify(list));
            localStorage.setItem(UDP_CURR_KEY, list[0].id);
        }
        return list;
    } catch (e) {
        const list = [{ id: String(Date.now()), name: '榛樿鏈嶅姟鍣?, url: 'http://192.168.88.1:8333' }];
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
        showCenterConfirm('璇峰～鍐欐纭殑鏈嶅姟鍣ㄥ湴鍧€锛坔ttp://鎴杊ttps://锛?, null, true);
        return;
    }
    if (!name) name = '鏈懡鍚嶆湇鍔″櫒';
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
        showCenterConfirm('鑷冲皯淇濈暀涓€涓湇鍔″櫒', null, true);
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
    select.innerHTML = list.map(s => `<option value="${s.id}">${s.name} (${s.url})</option>`).join('');
    if (curr) select.value = curr;
    const url = getCurrentUdpxyUrl();
    if (input) input.value = url || '';
}


// 鏂偣缁壂鐩稿叧
function clearScanTask() { try { localStorage.removeItem('scanTask'); } catch (e) { } }

// 鏁版嵁瀵煎嚭
function exportData(format) {
    if (!allStreams || allStreams.length === 0) {
        showCenterConfirm('褰撳墠娌℃湁鍙鍑虹殑鏁版嵁', null, true);
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
            content += `#EXTINF:-1 tvg-name="${s.name}" tvg-logo="${s.logo || ''}" group-title="${s.groupTitle || '榛樿'}",${s.name}\n`;
            let url = s.multicastUrl;
            // if (s.udpxyUrl) url = `${s.udpxyUrl}/rtp/${url.replace('rtp://', '')}`;
            content += `${url}\n`;
        });
    } else if (format === 'txt') {
        // 鍏堟寜 groupTitle 鎺掑簭浠ヤ究鍚堝苟杈撳嚭
        exportList.sort((a, b) => (a.groupTitle || '榛樿').localeCompare(b.groupTitle || '榛樿'));
        let currentGroup = '';
        exportList.forEach(s => {
            const group = s.groupTitle || '榛樿';
            if (group !== currentGroup) {
                content += `${group},#genre#\n`;
                currentGroup = group;
            }
            let url = s.multicastUrl;
            // if (s.udpxyUrl) url = `${s.udpxyUrl}/rtp/${url.replace('rtp://', '')}`;
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

// 杈呭姪鍔熻兘
function updateInputCount() {
    let rangeStart = document.getElementById('rangeStart') ? (document.getElementById('rangeStart').value || '').trim() : '';
    let rangeEnd = document.getElementById('rangeEnd') ? (document.getElementById('rangeEnd').value || '').trim() : '';
    let batchInput = document.getElementById('batchInput') ? (document.getElementById('batchInput').value || '').trim() : '';
    let count = 0;

    // 杩欓噷渚濊禆 utils.js 鐨?parseRtpUrl, ipv4ToInt
    if (rangeStart && rangeEnd) {
        const s = parseRtpUrl(rangeStart);
        const e = parseRtpUrl(rangeEnd);
        if (s && e) {
            let a = ipv4ToInt(s.ip), b = ipv4ToInt(e.ip);
            if (a > b) [a, b] = [b, a];
            count = Math.min(b - a + 1, 1000); // 浼扮畻
        }
    } else if (batchInput) {
        count = batchInput.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).length;
    }
    document.getElementById('stat-total').innerText = count;
    document.getElementById('stat-online').innerText = 0;
    document.getElementById('stat-offline').innerText = 0;
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
    const portLabel = ports.length > 1 ? ` 脳 ${ports.length}绔彛` : '';

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
    sumEl.value = `${s.ip} - ${e.ip}${portLabel}  妫€娴嬫€绘暟锛?{totalCheck}`;
}


// --- UI 浜嬩欢缁戝畾闆嗕腑澶勭悊 ---
function bindUIEvents() {
    // 鎼滅储
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            lastSearch = this.value;
            updateStatsAndDisplay();
        });
    }

    // 绛涢€夋寜閽?    const btnAll = document.getElementById('filterAll');
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

    // 娓呯┖鎸夐挳
    const clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) {
        clearAllBtn.onclick = async function () {
            showCenterConfirm('纭畾瑕佹竻绌烘墍鏈夋娴嬬粨鏋滃悧锛?, async function (ok) {
                if (!ok) return;
                try {
                    await fetch('/api/streams', { method: 'DELETE' });
                    getStreams();
                    showProgress(0, 0, '宸叉竻绌烘墍鏈夌粨鏋?);
                } catch (e) {
                    console.error(e);
                    showCenterConfirm('娓呯┖澶辫触', null, true);
                }
            });
        };
    }

    // 鎵归噺鍒犻櫎
    const batchDeleteBtn = document.getElementById('batchDeleteBtn');
    if (batchDeleteBtn) {
        batchDeleteBtn.onclick = async function () {
            const arr = Array.from(selectedSet);
            if (arr.length === 0) return;
            showCenterConfirm(`纭畾鍒犻櫎閫変腑鐨?${arr.length} 涓閬撳悧锛焋, async function (ok) {
                if (!ok) return;
                for (const i of arr) {
                    try { await fetch(`/api/stream/${i}`, { method: 'DELETE' }); } catch (e) { }
                }
                selectedSet = new Set();
                getStreams();
            });
        };
    }

    // 妫€娴嬮厤缃浉鍏崇粦瀹?    const loadBtn = document.getElementById('loadFileBtn');
    if (loadBtn) loadBtn.onclick = loadFromNetwork;

    // 寮€濮嬫娴?    document.getElementById('startDetectBtn').addEventListener('click', async () => {
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
            showCenterConfirm('璇峰厛濉啓UDPXY鏈嶅姟鍣ㄥ湴鍧€', null, true);
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
                showCenterConfirm('璇风矘璐寸粍鎾湴鍧€鎴栧～鍐欒寖鍥村啀鐐瑰嚮妫€娴?, null, true);
            }
        } finally {
            detectRunning = false;
            if (startBtn) startBtn.disabled = false;
        }
    });

    // 鍋滄妫€娴?    document.getElementById('stopDetectBtn').addEventListener('click', async function () {
        try {
            await fetch('/api/task/stop', { method: 'POST' });
            showProgress(0, 0, '姝ｅ湪鍋滄浠诲姟...');
        } catch (e) { }
    });

    // UDPXY 璁剧疆缁戝畾
    loadUdpxyServersBackend().then(() => { renderUdpxySelect(); });
    const select = document.getElementById('udpxySelect');
    const addBtn = document.getElementById('addUdpxyBtn');
    const delBtn = document.getElementById('delUdpxyBtn');
    const applyBtn = document.getElementById('applyUdpxyBtn');

    if (select) select.onchange = function () { setCurrentUdpxyId(this.value); renderUdpxySelect(); };
    if (addBtn) addBtn.onclick = function () {
        const name = document.getElementById('udpxyNameInput').value;
        const url = document.getElementById('udpxyAddInput').value;
        addUdpxy(name, url);
        document.getElementById('udpxyNameInput').value = '';
        document.getElementById('udpxyAddInput').value = '';
    };
    if (delBtn) delBtn.onclick = function () {
        showCenterConfirm('纭畾鍒犻櫎褰撳墠閫変腑鏈嶅姟鍣紵', function (ok) { if (ok) deleteCurrentUdpxy(); });
    };
    if (applyBtn) applyBtn.onclick = async function () {
        await syncUdpxyServersBackend();
        showCenterConfirm('宸插簲鐢ㄥ苟淇濆瓨褰撳墠鏈嶅姟鍣ㄨ缃?, null, true);
    };

    // CIDR 宸ュ叿缁戝畾
    const applyCidrBtn = document.getElementById('applyCidrBtn');
    const clearCidrBtn = document.getElementById('clearCidrBtn');
    const inputIds = ['rangeStart', 'rangeEnd', 'cidrInput', 'portInput'];

    inputIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateRangeSummary);
    });

    if (applyCidrBtn) applyCidrBtn.addEventListener('click', function () {
        const cidr = document.getElementById('cidrInput').value.trim();
        const rng = parseCIDR(cidr);
        if (rng) {
            document.getElementById('rangeStart').value = rng.start;
            document.getElementById('rangeEnd').value = rng.end;
            updateRangeSummary();
            showCenterConfirm('CIDR宸茶浆鎹负IP鑼冨洿', null, true);
        } else {
            showCenterConfirm('CIDR鏍煎紡涓嶆纭紝渚嬪: 192.168.1.0/24', null, true);
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

    // 淇妯℃€佹鍏抽棴鍚庤儗鏅笉鍙粴鍔ㄩ棶棰?    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('hidden.bs.modal', function () {
            if (document.querySelectorAll('.modal.show').length === 0) {
                document.body.classList.remove('modal-open');
                document.body.style.paddingRight = '';
                const backdrop = document.querySelector('.modal-backdrop');
                if (backdrop) backdrop.remove();
            }
        });
    });

    // 鐗堟湰蹇収缁戝畾
    const saveId = document.getElementById('saveBtnIndex') || document.getElementById('saveBtn');
    if (saveId) saveId.onclick = persistSave;
    const loadId = document.getElementById('loadBtnIndex') || document.getElementById('loadBtn');
    if (loadId) loadId.onclick = loadSelectedVersion;
    const delId = document.getElementById('deletePersistBtnIndex') || document.getElementById('deletePersistBtn');
    if (delId) delId.onclick = deleteSelectedVersion;
    const refreshId = document.getElementById('refreshVersionsBtnIndex') || document.getElementById('refreshVersionsBtn');
    if (refreshId) refreshId.onclick = refreshVersions;

    // 鍒濆鍖栫増鏈垪琛?    refreshVersions();

    // 缁戝畾鏇存柊涓庨€€鍑?    window.doLogout = async function () {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    }
}

async function loadUserSettings() {
    // 浠庡悗绔仮澶嶈缃埌鏈湴缂撳瓨锛堝垎缁勩€丩ogo妯℃澘銆丗CC鏈嶅姟鍣級
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
            document.getElementById('modalCurrentVersion').textContent = 'v' + j.version;
        }
    } catch (e) { }
}

async function loadFromNetwork() {
    const ta = document.getElementById('batchInput');
    const raw = (ta.value || '').trim();
    const urls = raw.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#') && (s.startsWith('http://') || s.startsWith('https://')));
    if (urls.length === 0) {
        showCenterConfirm('璇峰湪杈撳叆妗嗕腑濉叆m3u鎴杢xt鐨勭綉缁滃湴鍧€锛坔ttp/https锛夊悗鍐嶇偣鍑烩€滃姞杞解€?, null, true);
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
            showCenterConfirm('鏈В鏋愬埌鏈夋晥鍦板潃', null, true);
            return;
        }
        const lines = items.map(it => `${it.name || ''},${it.url}`);
        ta.value = lines.join('\n');
        updateInputCount();
        const okCount = texts.length;
        const failCount = urls.length - okCount;
        showCenterConfirm('缃戠粶婧愶細鎴愬姛' + okCount + ' 澶辫触' + failCount + '锛涜В鏋愬埌鍦板潃锛? + items.length + ' 鏉?, null, true);
    } catch (e) {
        showCenterConfirm('鍔犺浇缃戠粶鏂囦欢澶辫触锛堜唬鐞嗛敊璇垨缃戠粶闂锛?, null, true);
    }
}

// === 鐗堟湰蹇収 (Persistence) ===
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
    showCenterConfirm('纭畾灏嗗綋鍓嶇殑鎵€鏈夐厤缃拰鏁版嵁澶囦唤瀛樻。鍚楋紵', async function (ok) {
        if (!ok) return;
        try {
            const res = await fetch('/api/persist/save', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showCenterConfirm('澶囦唤鎴愬姛', null, true);
                refreshVersions();
            } else {
                showCenterConfirm('澶囦唤澶辫触: ' + data.message, null, true);
            }
        } catch (e) {
            console.error(e);
            showCenterConfirm('缃戠粶閿欒', null, true);
        }
    });
}

async function persistLoad() {
    try {
        const res = await fetch('/api/persist/load', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            getStreams(); // refresh list
            showCenterConfirm('宸查噸鏂板姞杞芥渶鏂版祦鏁版嵁', null, true);
        }
    } catch (e) {
        console.error(e);
    }
}

function loadSelectedVersion() {
    const sel1 = document.getElementById('versionsSelectIndex');
    const sel2 = document.getElementById('versionsSelect');
    const v = sel1 && sel1.value ? sel1.value : (sel2 ? sel2.value : null);
    if (!v) { showCenterConfirm('璇峰厛閫夋嫨涓€涓绾跨増鏈?, null, true); return; }

    showCenterConfirm(`璀﹀憡锛氬姞杞藉巻鍙茬増鏈?[${v}] 灏嗕細瑕嗙洊褰撳墠鐨勬墍鏈夋祦鏁版嵁锛屽苟涓旀鎿嶄綔涓嶅彲鎾ら攢銆俓n\n鎮ㄧ‘瀹氳瑕嗙洊鍚楋紵`, async function (ok) {
        if (!ok) return;
        try {
            const res = await fetch('/api/persist/load-version', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: v })
            });
            const data = await res.json();
            if (data.success) {
                showCenterConfirm('鐗堟湰宸叉仮澶?, null, true);
                getStreams();
            } else {
                showCenterConfirm('鎭㈠澶辫触: ' + data.message, null, true);
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
    if (!v) { showCenterConfirm('璇峰厛閫夋嫨涓€涓绾跨増鏈?, null, true); return; }

    showCenterConfirm(`纭畾鍒犻櫎璇ュ巻鍙茬増鏈?[${v}] 鍚楋紵`, async function (ok) {
        if (!ok) return;
        try {
            const res = await fetch('/api/persist/delete-version', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: v })
            });
            const data = await res.json();
            if (data.success) {
                showCenterConfirm('宸插垹闄ょ増鏈?, null, true);
                refreshVersions();
            } else {
                showCenterConfirm('鍒犻櫎澶辫触: ' + data.message, null, true);
            }
        } catch (e) {
            console.error(e);
        }
    });
}

