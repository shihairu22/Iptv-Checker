/**
 * utils.js - 通用工具函数库
 * 包含：UI弹窗、进度条控制、网络地址解析、格式化工具等
 */

// --- UI 显示相关 ---
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// 居中确认弹窗
function showCenterConfirm(msg, callback, onlyOk = false) {
    let modal = document.getElementById('centerModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'centerModal';
        modal.innerHTML = `
<div class="modal fade" tabindex="-1" style="display:block;background:rgba(0,0,0,0.25);z-index:9999;">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content" style="border-radius:12px;box-shadow:0 4px 24px #0002;">
      <div class="modal-body text-center" id="centerModalMsg" style="font-size:1.08rem;padding:32px 18px 18px 18px;color:#222;"></div>
      <div class="modal-footer justify-content-center" style="border-top:none;padding-bottom:24px;">
        <button type="button" class="btn btn-primary px-4 me-3" id="centerModalOk" style="font-size:1.08rem;">确定</button>
        <button type="button" class="btn btn-secondary px-4" id="centerModalCancel" style="font-size:1.08rem;display:none;">取消</button>
      </div>
    </div>
  </div>
</div>`;
        document.body.appendChild(modal);
    }
    document.getElementById('centerModalMsg').innerText = msg;
    modal.style.display = 'block';
    modal.querySelector('.modal').classList.add('show');

    const okBtn = document.getElementById('centerModalOk');
    const cancelBtn = document.getElementById('centerModalCancel');

    if (onlyOk) {
        cancelBtn.style.display = 'none';
        okBtn.classList.remove('me-3');
    } else {
        cancelBtn.style.display = '';
        okBtn.classList.add('me-3');
    }

    function close() {
        modal.style.display = 'none';
        modal.querySelector('.modal').classList.remove('show');
    }

    // 移除之前的事件监听器以防重复绑定 (使用 onclick 简单覆盖)
    okBtn.onclick = function () { close(); if (callback) callback(true); };
    cancelBtn.onclick = function () { close(); if (callback) callback(false); };
}

// 显示状态信息（进度条上方）
function showStatusInfo(text) {
    let statusDiv = document.getElementById('progressStatusInfo');
    if (!statusDiv) {
        statusDiv = document.createElement('div');
        statusDiv.id = 'progressStatusInfo';
        // 尝试插入到进度条容器前
        const barWrap = document.getElementById('progressBarWrap');
        if (barWrap) {
            barWrap.parentNode.insertBefore(statusDiv, barWrap);
        }
    }
    if (statusDiv) {
        statusDiv.style.display = '';
        statusDiv.style.marginTop = '12px';
        statusDiv.innerHTML = text;
    }
}

function hideStatusInfo() {
    let statusDiv = document.getElementById('progressStatusInfo');
    if (statusDiv) statusDiv.style.display = 'none';
}

// 显示进度条
function showProgress(done, total, status) {
    const barWrap = document.getElementById('progressBarWrap');
    const bar = document.getElementById('progressBar');
    if (barWrap && bar) {
        barWrap.style.display = '';
        let percent = total ? Math.round(done / total * 100) : 0;
        bar.style.width = percent + '%';
        bar.innerText = `${percent}% | 已检测: ${done}/${total} | ${status || ''}`;
        showStatusInfo(status || '');
    }
}

// 隐藏进度条
function hideProgress() {
    const barWrap = document.getElementById('progressBarWrap');
    if (barWrap) barWrap.style.display = 'none';
    hideStatusInfo();

    let lastResultDiv = document.getElementById('lastResultInfo');
    if (lastResultDiv) lastResultDiv.style.display = 'none';

    let currentCheckInfo = document.getElementById('currentCheckInfo');
    if (currentCheckInfo) currentCheckInfo.style.display = 'none';
}

// 在进度条下方显示上一条检测结果
function showLastResult(data, name, multicastUrl) {
    let lastResultDiv = document.getElementById('lastResultInfo');
    if (!lastResultDiv) {
        lastResultDiv = document.createElement('div');
        lastResultDiv.id = 'lastResultInfo';
        lastResultDiv.className = 'alert alert-secondary mt-2';
        const progressBarWrap = document.getElementById('progressBarWrap');
        if (progressBarWrap) {
            progressBarWrap.parentNode.insertBefore(lastResultDiv, progressBarWrap.nextSibling);
        }
    }
    if (lastResultDiv) {
        lastResultDiv.style.display = '';
        lastResultDiv.innerHTML = `最近检测：<b>${escapeHTML(name || data.name || '-')}</b> | <span style='color:#888;'>${escapeHTML(multicastUrl || data.multicastUrl || '-')}</span> | 分辨率:<b>${escapeHTML(data.resolution || '-')}</b> | 编码:<b>${escapeHTML(data.codec || '-')}</b> | 帧率:<b>${escapeHTML(data.frameRate || '-')}</b> | <span style='color:${data.isAvailable ? '#28a745' : '#dc3545'};font-weight:bold;'>${data.isAvailable ? '在线' : '离线'}</span>`;
    }
}


// --- 地址与网络解析相关 ---

function parseCIDR(cidrStr) {
    const parts = (cidrStr || '').trim().split('/');
    if (parts.length !== 2) return null;
    const ipStr = parts[0].trim();
    const maskLen = parseInt(parts[1], 10);
    if (isNaN(maskLen) || maskLen < 0 || maskLen > 32) return null;

    const octets = ipStr.split('.').map(n => parseInt(n, 10));
    if (octets.length !== 4 || octets.some(n => isNaN(n) || n < 0 || n > 255)) return null;

    const ip = ((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | (octets[3] >>> 0);
    const mask = maskLen === 0 ? 0 : ((0xFFFFFFFF << (32 - maskLen)) >>> 0);
    const network = (ip & mask) >>> 0;
    const hostmask = (~mask) >>> 0;

    let start = network;
    let end = (network | hostmask) >>> 0;
    //Exclude network and broadcast address for subnets larger than /31 if strict, but here we just follow simple logic
    if (maskLen <= 30) {
        start = (network + 1) >>> 0;
        end = (end - 1) >>> 0;
    }

    function toIpString(v) {
        return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF].join('.');
    }
    return { start: toIpString(start), end: toIpString(end) };
}

function parsePorts(portStr) {
    const ports = [];
    const parts = (portStr || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
        if (p.includes('-')) {
            const segs = p.split('-').map(Number);
            const a = segs[0], b = segs[1];
            if (!isNaN(a) && !isNaN(b)) {
                for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
                    if (i >= 1 && i <= 65535) ports.push(i);
                }
            }
        } else {
            const n = Number(p);
            if (!isNaN(n) && n >= 1 && n <= 65535) ports.push(n);
        }
    }
    return [...new Set(ports)];
}

function parseRtpUrl(u) {
    let s = (u || '').trim();
    // 与后端逻辑同步：移除协议前缀和 @ 符号
    s = s.replace(/^(rtp|udp):\/\/@?/, '').replace(/^@/, '');

    const parts = s.split(':');
    if (parts.length > 2) return null;

    const ip = parts[0];
    const port = parts[1] ? parseInt(parts[1], 10) : 0;

    const octets = ip.split('.').map(n => parseInt(n, 10));
    if (octets.length !== 4 || octets.some(n => isNaN(n) || n < 0 || n > 255)) return null;

    return { ip, port: port || 0 };
}

function ipv4ToInt(ip) {
    const o = ip.split('.').map(n => parseInt(n, 10));
    return ((o[0] << 24) >>> 0) | (o[1] << 16) | (o[2] << 8) | (o[3] >>> 0);
}

// 简单的播放列表解析

function parsePlaylistText(text) {

    if (!text) return [];

    const lines = text.split('
');

    const items = [];

    let currentName = '';

    let currentMeta = {};



    for (let line of lines) {

        line = line.trim();

        if (!line) continue;



        if (line.startsWith('#EXTINF:')) {

            // 解析扩展属性: tvg-id, tvg-name, tvg-logo, group-title

            // 格式: #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",频道名

            currentMeta = {};

            const commaIdx = line.lastIndexOf(',');

            if (commaIdx !== -1) {

                currentName = line.substring(commaIdx + 1).trim();

                const attrPart = line.substring(0, commaIdx);

                const tvgId = attrPart.match(/tvg-id="([^"]*)"/i);

                const tvgName = attrPart.match(/tvg-name="([^"]*)"/i);

                const tvgLogo = attrPart.match(/tvg-logo="([^"]*)"/i);

                const groupTitle = attrPart.match(/group-title="([^"]*)"/i);

                if (tvgId) currentMeta.tvgId = tvgId[1];

                if (tvgName) currentMeta.tvgName = tvgName[1];

                if (tvgLogo) currentMeta.logo = tvgLogo[1];

                if (groupTitle) currentMeta.groupTitle = groupTitle[1];

            }

        } else if (line.startsWith('#')) {

            // ignore other directives

            continue;

        } else if (line.includes(',') && line.includes('://')) {

            // 简单格式: CCTV1,http://...

            const parts = line.split(',');

            if (parts.length >= 2) {

                const url = parts.pop().trim();

                const name = parts.join(',').trim();

                if (url && (url.startsWith('rtp://') || url.startsWith('udp://') || url.startsWith('http'))) {

                    items.push({ name, url });

                }

            }

        } else {

            // 纯 URL 行

            if (line.startsWith('rtp://') || line.startsWith('udp://') || line.startsWith('http')) {

                items.push({ name: currentName || '未命名频道', url: line, ...currentMeta });

                currentName = '';

                currentMeta = {};

            }

        }

    }

    return items;

}
function unifyChannelNames(items) {
    // 简单的名称清理，实际项目中可能需要更复杂的逻辑
    return items.map(item => {
        item.name = (item.name || '未命名频道').trim();
        return item;
    });
}
