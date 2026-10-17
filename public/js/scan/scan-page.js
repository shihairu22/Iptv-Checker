/**
 * 扫描队列页面
 *
 * 后端：src/routes/scan-tasks.js
 *   POST /api/scan-tasks/start | stop | resume | retry-failed
 *   GET  /api/scan-tasks/status | failures
 *
 * 页面只做「提交参数 + 展示状态」，调度/持久化都在服务端队列里，
 * 所以关掉浏览器、刷新页面、服务重启都不影响任务。
 */
(function () {
  const core = window.IptvCore = window.IptvCore || {};
  const FORM_KEY = 'scan:form';
  const POLL_RUNNING = 1200;
  const POLL_IDLE = 4000;

  const $ = (id) => document.getElementById(id);

  function apiJson(url, options) {
    if (core.api && typeof core.api.request === 'function') {
      return core.api.request(url, options || {}).then((r) => (r && r.data) || {});
    }
    return fetch(url, options || {}).then((r) => r.json());
  }

  let timer = null;
  let lastStatus = null;
  let lastFailRefresh = 0;

  // ---------- 提示 ----------
  function alertMsg(text, kind) {
    const el = $('pageAlert');
    if (!el) return;
    if (!text) {
      el.classList.add('d-none');
      el.textContent = '';
      return;
    }
    el.className = 'alert alert-' + (kind || 'info') + ' py-2 small';
    el.textContent = text;
    el.classList.remove('d-none');
    if (kind !== 'danger') {
      setTimeout(() => { if (el.textContent === text) el.classList.add('d-none'); }, 4000);
    }
  }

  // ---------- 表单持久化 ----------
  function readForm() {
    return {
      type: document.querySelector('input[name="scanType"]:checked')?.value || 'batch',
      udpxyUrl: $('udpxyUrl').value.trim(),
      batchText: $('batchInput').value,
      startUrl: $('startUrl').value.trim(),
      endUrl: $('endUrl').value.trim(),
      ports: $('ports').value.trim(),
      concurrency: $('concurrencyInput').value,
      retry: $('retryInput').value,
      throttleEnabled: $('throttleEnabled').checked,
      throttleRun: $('throttleRun').value,
      throttlePause: $('throttlePause').value
    };
  }

  function saveForm() {
    try { localStorage.setItem(FORM_KEY, JSON.stringify(readForm())); } catch (e) {}
  }

  function restoreForm() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(FORM_KEY) || 'null'); } catch (e) {}
    if (!data) return;
    if (data.type === 'range') $('typeRange').checked = true;
    if (data.udpxyUrl) $('udpxyUrl').value = data.udpxyUrl;
    if (data.batchText) $('batchInput').value = data.batchText;
    if (data.startUrl) $('startUrl').value = data.startUrl;
    if (data.endUrl) $('endUrl').value = data.endUrl;
    if (data.ports) $('ports').value = data.ports;
    if (data.concurrency) $('concurrencyInput').value = data.concurrency;
    if (data.retry) $('retryInput').value = data.retry;
    $('throttleEnabled').checked = !!data.throttleEnabled;
    if (data.throttleRun) $('throttleRun').value = data.throttleRun;
    if (data.throttlePause) $('throttlePause').value = data.throttlePause;
  }

  // ---------- 地址解析（与后端 parseBatchText 同规则，仅用于预览计数）----------
  function expandBracket(text) {
    const m = String(text || '').match(/^(.*)\[(\d+)-(\d+)\](.*)$/);
    if (!m) return [text];
    const start = Number(m[2]);
    const end = Number(m[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 5000) return [text];
    const out = [];
    for (let i = start; i <= end; i += 1) out.push(m[1] + i + m[4]);
    return out;
  }

  function countBatch(text) {
    let n = 0;
    String(text || '').split('\n').forEach((line) => {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) return;
      const body = raw.includes(',') ? raw.slice(raw.lastIndexOf(',') + 1).trim() : raw;
      if (!body) return;
      n += expandBracket(body).length;
    });
    return n;
  }

  function ipToInt(ip) {
    const p = String(ip || '').split('.').map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return null;
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  }

  function estimateRange() {
    const s = $('startUrl').value.trim().match(/(\d+\.\d+\.\d+\.\d+)/);
    const e = $('endUrl').value.trim().match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!s || !e) return 0;
    const a = ipToInt(s[1]);
    const b = ipToInt(e[1]);
    if (a == null || b == null || b < a) return 0;
    const ports = $('ports').value.trim() ? $('ports').value.split(/[,\s]+/).filter(Boolean).length : 1;
    return (b - a + 1) * ports;
  }

  function refreshCounts() {
    const isBatch = $('typeBatch').checked;
    const n = isBatch ? countBatch($('batchInput').value) : estimateRange();
    if (isBatch) $('batchCount').textContent = n + ' 个有效地址';
    else $('rangeCount').textContent = n ? ('预计 ' + n + ' 个地址') : '按起始/结束地址逐行展开；端口可选，留空用地址里的端口。';
    $('formHint').textContent = n ? ('本次 ' + n + ' 个地址') : '';
  }

  function syncTypePane() {
    const isBatch = $('typeBatch').checked;
    $('batchPane').classList.toggle('d-none', !isBatch);
    $('rangePane').classList.toggle('d-none', isBatch);
    refreshCounts();
  }

  // ---------- udpxy 服务器 ----------
  async function loadUdpxyServers() {
    const sel = $('udpxySelect');
    let list = [];
    let currentId = '';
    try {
      const j = await apiJson('/api/config/udpxy-servers');
      if (j && j.success) {
        list = Array.isArray(j.servers) ? j.servers : [];
        currentId = j.currentId || '';
      }
    } catch (e) { /* 取不到就让用户手填 */ }
    sel.innerHTML = '';
    if (!list.length) {
      sel.innerHTML = '<option value="">（未配置，请手填）</option>';
      return;
    }
    list.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.url;
      opt.textContent = s.name ? (s.name + ' (' + s.url + ')') : s.url;
      sel.appendChild(opt);
    });
    const cur = list.find((s) => String(s.id) === String(currentId)) || list[0];
    sel.value = cur.url;
    if (!$('udpxyUrl').value.trim()) $('udpxyUrl').value = cur.url;
  }

  // ---------- 渲染 ----------
  function fmtElapsed(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const r = s % 60;
    const h = Math.floor(m / 60);
    const mm = h ? m % 60 : m;
    return (h ? String(h).padStart(2, '0') + ':' : '') + String(mm).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  function renderStatus(st) {
    if (!st) return;
    lastStatus = st;
    const p = st.progress || {};
    const total = p.total || 0;
    const finished = p.finished || 0;
    const pct = total ? Math.min(100, Math.round((finished / total) * 100)) : 0;

    $('statTotal').textContent = total;
    $('statPending').textContent = p.pending || 0;
    $('statInflight').textContent = p.inFlight || 0;
    $('statSuccess').textContent = p.success || 0;
    $('statFailed').textContent = p.failed || 0;
    $('progressBar').style.width = pct + '%';
    $('progressText').textContent = pct + '%';
    $('elapsed').textContent = '用时 ' + fmtElapsed(st.elapsedSeconds);

    const badge = $('stateBadge');
    let state = 'idle';
    let label = '空闲';
    if (st.running) { state = 'running'; label = '运行中'; }
    else if (st.paused) { state = 'paused'; label = '节流暂停'; }
    else if (total && finished < total) { state = 'stopped'; label = '已停止'; }
    else if (total) { state = 'done'; label = '已完成'; }
    badge.dataset.state = state;
    badge.textContent = label;

    $('taskMeta').textContent = total
      ? ((st.type === 'range' ? '网段' : '列表') + ' · 并发 ' + st.concurrency + (st.retry ? ' · 重试 ' + st.retry : ''))
      : '';

    if (st.throttle && st.throttle.enabled) {
      $('throttleRow').classList.remove('d-none');
      const phase = st.throttle.phase === 'pause' ? '暂停阶段' : '扫描阶段';
      $('throttleState').textContent = phase + '，剩余 ' + fmtElapsed(st.throttle.remainingSeconds)
        + '（跑 ' + st.throttle.runMinutes + ' 分 / 停 ' + st.throttle.pauseMinutes + ' 分）';
    } else {
      $('throttleRow').classList.add('d-none');
    }

    const logs = Array.isArray(st.logs) ? st.logs.slice().reverse() : [];
    const box = $('logBox');
    box.textContent = logs.length ? logs.join('\n') : '暂无日志';
    $('logCount').textContent = logs.length + ' 条';
    box.scrollTop = box.scrollHeight;

    $('startBtn').disabled = !!st.running;
    $('stopBtn').disabled = !st.running;
    $('resumeBtn').disabled = !(total && !st.running && (p.pending > 0 || p.inFlight > 0));
  }

  async function refreshStatus() {
    try {
      const st = await apiJson('/api/scan-tasks/status');
      if (st && st.success !== false) renderStatus(st.data || st);
    } catch (e) { /* 网络抖动忽略，下一轮再试 */ }
  }

  async function refreshFailures() {
    try {
      const j = await apiJson('/api/scan-tasks/failures?limit=50');
      const payload = (j && j.data) || j || {};
      const list = Array.isArray(payload.failures) ? payload.failures : [];
      const body = $('failBody');
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="3" class="text-secondary small">暂无失败项</td></tr>';
        return;
      }
      body.innerHTML = list.map((f) => {
        const url = String(f.url || '');
        const err = String(f.error || '');
        return '<tr>'
          + '<td class="addr-mono small scan-ellipsis" title="' + esc(url) + '">' + esc(url) + '</td>'
          + '<td class="small">' + (f.attempts || 0) + '</td>'
          + '<td class="small text-danger scan-ellipsis" title="' + esc(err) + '">' + esc(err) + '</td>'
          + '</tr>';
      }).join('');
    } catch (e) { /* ignore */ }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- 轮询 ----------
  function schedule() {
    if (timer) clearTimeout(timer);
    const interval = (lastStatus && lastStatus.running) ? POLL_RUNNING : POLL_IDLE;
    timer = setTimeout(async () => {
      if (!document.hidden) {
        await refreshStatus();
        const running = lastStatus && lastStatus.running;
        const due = Date.now() - lastFailRefresh > (running ? 6000 : 15000);
        if (due) { lastFailRefresh = Date.now(); await refreshFailures(); }
      }
      schedule();
    }, interval);
  }

  // ---------- 动作 ----------
  async function startScan() {
    const f = readForm();
    if (!f.udpxyUrl) return alertMsg('请先填 udpxy 服务器地址', 'danger');
    if (f.type === 'batch' && !f.batchText.trim()) return alertMsg('请粘贴地址列表', 'danger');
    if (f.type === 'range' && (!f.startUrl || !f.endUrl)) return alertMsg('请填起始与结束地址', 'danger');

    const body = {
      type: f.type,
      udpxyUrl: f.udpxyUrl,
      concurrency: Number(f.concurrency) || 20,
      retry: Number(f.retry) || 0,
      throttle: f.throttleEnabled
        ? { enabled: true, runMinutes: Number(f.throttleRun) || 30, pauseMinutes: Number(f.throttlePause) || 10 }
        : { enabled: false }
    };
    if (f.type === 'batch') body.batchText = f.batchText;
    else { body.startUrl = f.startUrl; body.endUrl = f.endUrl; body.ports = f.ports; }

    $('startBtn').disabled = true;
    try {
      const j = await apiJson('/api/scan-tasks/start', { method: 'POST', body });
      if (j && j.success === false) {
        alertMsg(j.message || '启动失败', 'danger');
        $('startBtn').disabled = false;
        return;
      }
      const payload = (j && j.data) || j || {};
      alertMsg('已入队 ' + (payload.total || 0) + ' 个地址，并发 ' + (payload.concurrency || '-'), 'success');
      saveForm();
      await refreshStatus();
      await refreshFailures();
    } catch (e) {
      alertMsg('启动失败：' + (e && e.message ? e.message : e), 'danger');
      $('startBtn').disabled = false;
    }
    schedule();
  }

  async function post(url, okText) {
    try {
      const j = await apiJson(url, { method: 'POST', body: {} });
      if (j && j.success === false) { alertMsg(j.message || '操作失败', 'danger'); return; }
      if (okText) alertMsg(okText, 'success');
      await refreshStatus();
      await refreshFailures();
    } catch (e) {
      alertMsg('请求失败：' + (e && e.message ? e.message : e), 'danger');
    }
    schedule();
  }

  function wire() {
    document.querySelectorAll('input[name="scanType"]').forEach((el) => {
      el.addEventListener('change', () => { syncTypePane(); saveForm(); });
    });
    ['batchInput', 'startUrl', 'endUrl', 'ports', 'concurrencyInput', 'retryInput',
      'throttleRun', 'throttlePause', 'udpxyUrl'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', () => { refreshCounts(); saveForm(); });
    });
    $('throttleEnabled').addEventListener('change', saveForm);
    $('udpxySelect').addEventListener('change', (e) => {
      $('udpxyUrl').value = e.target.value;
      saveForm();
    });

    $('startBtn').addEventListener('click', startScan);
    $('stopBtn').addEventListener('click', () => post('/api/scan-tasks/stop', '已停止，剩余项保持待处理'));
    $('resumeBtn').addEventListener('click', () => post('/api/scan-tasks/resume', '已继续'));
    $('retryFailedBtn').addEventListener('click', () => post('/api/scan-tasks/retry-failed', '失败项已重新入队'));
    $('refreshFailBtn').addEventListener('click', refreshFailures);

    $('clearBatchBtn').addEventListener('click', () => {
      $('batchInput').value = '';
      refreshCounts(); saveForm();
    });
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        const lines = text.split('\n').filter((l) => l.trim() && !/^\s*#EXTM3U/i.test(l));
        $('batchInput').value = lines.join('\n').trim();
        refreshCounts(); saveForm();
        alertMsg('已导入 ' + file.name + '（' + lines.length + ' 行）', 'success');
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
  }

  async function boot() {
    if (core.auth && typeof core.auth.ensureAuth === 'function') {
      const ok = await core.auth.ensureAuth();
      if (!ok) return;
    }
    restoreForm();
    syncTypePane();
    wire();
    await loadUdpxyServers();
    refreshCounts();
    await refreshStatus();
    await refreshFailures();
    lastFailRefresh = Date.now();
    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
