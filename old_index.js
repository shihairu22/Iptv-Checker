const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

const cookieParser = require('cookie-parser');
const svgCaptcha = require('svg-captcha');
const { XMLParser } = require('fast-xml-parser');
const zlib = require('zlib');
const packageJson = require('../package.json');
const app = express();
const port = process.env.PORT || 3000;

// 鏃ュ織宸ュ叿
const logger = {
    info: (msg) => console.log(`[${new Date().toLocaleString()}] [INFO] ${msg}`),
    error: (msg) => console.error(`[${new Date().toLocaleString()}] [ERROR] ${msg}`),
    warn: (msg) => console.warn(`[${new Date().toLocaleString()}] [WARN] ${msg}`)
};

// 璇锋眰鏃ュ織涓棿浠?
app.use((req, res, next) => {
    const start = Date.now();
    const { method, originalUrl, ip } = req;

    // 鎷︽埅 res.end 鏉ユ崟鑾风姸鎬佺爜
    const originalEnd = res.end;
    res.end = function (...args) {
        const duration = Date.now() - start;
        const status = res.statusCode;
        // 鎺掗櫎闈欐€佽祫婧愭棩蹇椾互鍑忓皯鍒峰睆锛屼粎璁板綍 API 鍜岄〉闈㈣闂?
        if (!originalUrl.startsWith('/static') && !originalUrl.startsWith('/css') && !originalUrl.startsWith('/js') && !originalUrl.startsWith('/img') && !originalUrl.includes('.js') && !originalUrl.includes('.css')) {
            // 鐘舵€佺爜棰滆壊鍖哄垎
            let logMsg = `${method} ${originalUrl} ${status} - ${duration}ms - ${ip}`;
            if (status >= 500) logger.error(logMsg);
            else if (status >= 400) logger.warn(logMsg);
            else logger.info(logMsg);
        }
        originalEnd.apply(res, args);
    };
    next();
});

// 涓棿浠?
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());

// 閴存潈涓棿浠?
const USERS_FILE = path.join(__dirname, '../data/users.json');
const SESSIONS = new Map(); // token -> { username, expires }
const SESSION_TTL = 3650 * 24 * 60 * 60 * 1000;
const CAPTCHA_STORE = new Map(); // id -> { text, expires }

function loadUsers() {
    return readJson(USERS_FILE, { username: 'admin', password: 'admin' });
}
function saveUsers(u) {
    writeJson(USERS_FILE, u);
}
// 鍒濆鍖栫敤鎴锋枃浠?
if (!fs.existsSync(USERS_FILE)) {
    saveUsers({ username: 'admin', password: 'admin' });
}

// 妫€鏌ユ槸鍚︾櫥褰?
function requireAuth(req, res, next) {
    // 鎺掗櫎API鎺ュ彛锛堥櫎浜嗛渶瑕佺櫥褰曠殑鎺ュ彛锛夊拰闈欐€佽祫婧愶紙濡傛灉鏄櫥褰曢〉锛?
    // 浣嗗洜涓?express.static 鍦ㄥ墠闈紝杩欓噷涓昏鎷︽埅椤甸潰璺敱
    // 瀹為檯涓婃垜浠渶瑕佹嫤鎴?/, /results.html, /results
    // 闈欐€佽祫婧愪腑 login.html 涓嶉渶瑕佹嫤鎴?

    // 濡傛灉鏄?API 璇锋眰锛岄€氬父鐢卞墠绔嚜琛屽鐞?401锛岃繖閲屽彧澶勭悊椤甸潰璁块棶
    // 浣嗙敤鎴疯姹?"涓嶇櫥褰曠殑鏃跺€欎笉鑳借闂〉闈㈠姛鑳?锛屾剰鍛崇潃 index.html 鍜?results.html 闇€瑕佷繚鎶?

    // 妫€鏌?cookie
    const token = req.cookies['auth_token'];
    if (token && SESSIONS.has(token)) {
        return next();
    }

    // API 璇锋眰杩斿洖 401
    if (req.path.startsWith('/api/') && !['/api/login', '/api/auth/check', '/api/system/info', '/api/captcha'].includes(req.path)) {
        // 鎺掗櫎瀵煎嚭鎺ュ彛
        if (req.path.startsWith('/api/export/')) return next();
        // 鎺掗櫎娴佷唬鐞?
        if (req.path.startsWith('/api/proxy/')) return next();

        return res.status(401).json({ success: false, message: '鏈櫥褰? });
    }

    // 椤甸潰璇锋眰閲嶅畾鍚戝埌鐧诲綍椤?
    if (req.path === '/' || req.path === '/index.html' || req.path === '/results' || req.path === '/results.html') {
        return res.redirect('/login.html');
    }

    next();
}

// 楠岃瘉鐮佹帴鍙?
app.get('/api/captcha', (req, res) => {
    const captcha = svgCaptcha.create({
        size: 4,
        ignoreChars: '0o1i',
        noise: 2,
        color: true,
        background: '#f0f0f0'
    });
    const id = 'cap-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    // 5鍒嗛挓鏈夋晥鏈?
    CAPTCHA_STORE.set(id, { text: captcha.text.toLowerCase(), expires: Date.now() + 5 * 60 * 1000 });

    // 绠€鍗曟竻鐞嗚繃鏈熼獙璇佺爜
    if (CAPTCHA_STORE.size > 1000) {
        const now = Date.now();
        for (const [k, v] of CAPTCHA_STORE) {
            if (now > v.expires) CAPTCHA_STORE.delete(k);
        }
    }

    res.cookie('captcha_id', id, { httpOnly: true, maxAge: 5 * 60 * 1000 });
    res.type('svg');
    res.status(200).send(captcha.data);
});

// 鐧诲綍鎺ュ彛
app.post('/api/login', (req, res) => {
    const { username, password, captcha } = req.body;

    // 楠岃瘉楠岃瘉鐮?
    const captchaId = req.cookies['captcha_id'];
    if (!captchaId || !CAPTCHA_STORE.has(captchaId)) {
        return res.json({ success: false, message: '楠岃瘉鐮佸け鏁堬紝璇峰埛鏂伴噸璇? });
    }
    const stored = CAPTCHA_STORE.get(captchaId);
    CAPTCHA_STORE.delete(captchaId); // 楠岃瘉鐮佷竴娆℃€ф湁鏁?

    if (!captcha || captcha.toLowerCase() !== stored.text) {
        logger.warn(`鐧诲綍澶辫触: 楠岃瘉鐮侀敊璇?(鐢ㄦ埛: ${username || 'unknown'})`);
        return res.json({ success: false, message: '楠岃瘉鐮侀敊璇? });
    }

    const user = loadUsers();
    if (username === user.username && password === user.password) {
        logger.info(`鐢ㄦ埛 ${username} 鐧诲綍鎴愬姛`);
        const token = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        SESSIONS.set(token, { username, expires: Date.now() + SESSION_TTL });
        res.cookie('auth_token', token, { maxAge: SESSION_TTL, httpOnly: true });
        return res.json({ success: true });
    }
    logger.warn(`鐧诲綍澶辫触: 鐢ㄦ埛鍚嶆垨瀵嗙爜閿欒 (鐢ㄦ埛: ${username})`);
    res.json({ success: false, message: '鐢ㄦ埛鍚嶆垨瀵嗙爜閿欒' });
});

// 鐧诲嚭鎺ュ彛
app.post('/api/logout', (req, res) => {
    const token = req.cookies['auth_token'];
    if (token) {
        const sess = SESSIONS.get(token);
        if (sess) logger.info(`鐢ㄦ埛 ${sess.username} 閫€鍑虹櫥褰昤);
        SESSIONS.delete(token);
    }
    res.clearCookie('auth_token');
    res.json({ success: true });
});

// 妫€鏌ョ櫥褰曠姸鎬?
app.get('/api/auth/check', (req, res) => {
    const token = req.cookies['auth_token'];
    if (token && SESSIONS.has(token)) {
        const sess = SESSIONS.get(token);
        return res.json({ success: true, username: sess.username });
    }
    res.json({ success: false });
});

// 淇敼瀵嗙爜
app.post('/api/auth/update', (req, res) => {
    const token = req.cookies['auth_token'];
    if (!token || !SESSIONS.has(token)) return res.status(401).json({ success: false, message: '鏈櫥褰? });

    const { username, password, oldPassword } = req.body;
    const user = loadUsers();

    // 楠岃瘉鏃у瘑鐮侊紙濡傛灉闇€瑕佹洿涓ユ牸鐨勫畨鍏紝鍙互鍔犺繖涓瓧娈碉紝杩欓噷绠€鍖栧鐞嗙洿鎺ュ厑璁镐慨鏀癸紝鍥犱负宸茬粡鐧诲綍浜嗭級
    // 浣嗕负浜嗗畨鍏紝閫氬父闇€瑕侀獙璇佹棫瀵嗙爜
    if (user.password !== oldPassword) {
        return res.json({ success: false, message: '鏃у瘑鐮侀敊璇? });
    }

    if (username) user.username = username;
    if (password) user.password = password;
    saveUsers(user);

    // 鏇存柊 session
    const sess = SESSIONS.get(token);
    sess.username = user.username;

    res.json({ success: true, username: user.username });
});

// 搴旂敤閴存潈涓棿浠讹紙娉ㄦ剰锛氶潤鎬佹枃浠跺湪鍓嶉潰宸茬粡鎵樼锛屼絾鎴戜滑甯屾湜淇濇姢鐗瑰畾鐨?HTML锛?
// 涓轰簡淇濇姢 index.html 鍜?results.html锛屾垜浠渶瑕佸湪 express.static 涔嬪墠鎷︽埅锛屾垨鑰呭湪 static 涔嬪悗澶勭悊
// 鐢变簬 express.static 浼氱洿鎺ヨ繑鍥炴枃浠讹紝鎵€浠ュ繀椤绘斁鍦?static 涔嬪墠
// 浣嗘斁鍦?static 涔嬪墠浼氭嫤鎴?login.html css js 绛夎祫婧?
// 鏂规锛氬彧鎷︽埅鐗瑰畾璺緞
app.use(['/', '/index.html', '/results', '/results.html', '/api/*'], requireAuth);

app.use(express.static('public'));

// 瀛樺偍缁勬挱鍦板潃鍒楄〃
let multicastList = [];
let globalFcc = '';
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'streams.json');
const CFG_LOGO = path.join(DATA_DIR, 'logo_templates.json');
const CFG_FCC = path.join(DATA_DIR, 'fcc_servers.json');
const CFG_UDPXY = path.join(DATA_DIR, 'udpxy_servers.json');
const CFG_GROUPS = path.join(DATA_DIR, 'group_titles.json');
const CFG_GROUP_RULES = path.join(DATA_DIR, 'group_rules.json');
const CFG_EPG = path.join(DATA_DIR, 'epg_sources.json');
const CFG_PROXY = path.join(DATA_DIR, 'proxy_servers.json');
const CFG_APPSET = path.join(DATA_DIR, 'app_settings.json');
const EPG_DIR = path.join(DATA_DIR, 'epg');
let settings = {
    globalFcc: '',
    fccServers: [],
    logoTemplate: 'http://12.12.12.177:9443/lcmyhome/TVlive/raw/branch/main/LOGO/{name}.png',
    groupTitles: ['榛樿'],
    externalUrl: '',
    internalUrl: '',
    useInternal: false,
    useExternal: false,
    securityToken: '',
    enableToken: false,
    proxyList: []
};

function normalizeProxyType(t) {
    const v = String(t || '').trim();
    if (v === '浠ｇ悊' || v === '鍗曟挱浠ｇ悊') return '鍗曟挱浠ｇ悊';
    if (v === '澶栫綉' || v === '缁勬挱浠ｇ悊') return '缁勬挱浠ｇ悊';
    // 鍏煎鑻辨枃杈撳叆
    const low = v.toLowerCase();
    if (low === 'proxy') return '鍗曟挱浠ｇ悊';
    if (low === 'external' || low === 'internet') return '缁勬挱浠ｇ悊';
    return '缁勬挱浠ｇ悊';
}
function getProxyByType(type) {
    const list = Array.isArray(settings.proxyList) ? settings.proxyList : [];
    const want = normalizeProxyType(type);
    return list.find(x => normalizeProxyType(x && x.type) === want) || null;
}

function ensureDataDir() {
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
}
function readJson(file, defObj) {
    ensureDataDir();
    try {
        if (fs.existsSync(file)) {
            const txt = fs.readFileSync(file, 'utf-8');
            return JSON.parse(txt);
        }
    } catch (e) { }
    return defObj;
}
function writeJson(file, obj) {
    ensureDataDir();
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8'); return true; } catch (e) { console.error('鍐欏叆澶辫触', file); return false; }
}
function ensureEpgDir() {
    try {
        if (!fs.existsSync(EPG_DIR)) fs.mkdirSync(EPG_DIR, { recursive: true });
    } catch (e) { }
}
function persistSave() {
    ensureDataDir();
    const payload = { streams: multicastList, settings: { ...settings, globalFcc } };
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
        const verFile = path.join(DATA_DIR, `streams-${stamp}.json`);
        fs.writeFileSync(verFile, JSON.stringify(payload, null, 2), 'utf-8');
        return true;
    } catch (e) { return false; }
}
function persistLoad() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const txt = fs.readFileSync(DATA_FILE, 'utf-8');
            const json = JSON.parse(txt);
            multicastList = Array.isArray(json.streams) ? json.streams : [];
            globalFcc = json.settings && json.settings.globalFcc ? json.settings.globalFcc : '';
            if (json.settings) {
                settings.fccServers = Array.isArray(json.settings.fccServers) ? json.settings.fccServers : settings.fccServers;
                settings.logoTemplate = json.settings.logoTemplate || settings.logoTemplate;
                settings.groupTitles = Array.isArray(json.settings.groupTitles) ? json.settings.groupTitles : settings.groupTitles;
                settings.globalFcc = globalFcc;
                settings.externalUrl = json.settings.externalUrl || settings.externalUrl;
                settings.internalUrl = json.settings.internalUrl || settings.internalUrl;
                settings.useInternal = !!json.settings.useInternal;
                settings.useExternal = !!json.settings.useExternal;
                settings.securityToken = json.settings.securityToken || settings.securityToken;
                settings.enableToken = !!json.settings.enableToken;
                settings.proxyList = Array.isArray(json.settings.proxyList) ? json.settings.proxyList : settings.proxyList;
            }
            if (globalFcc) {
                const val = globalFcc.includes('=') ? globalFcc : `fcc=${globalFcc}`;
                multicastList = multicastList.map(s => ({ ...s, httpParam: val }));
            }
            return true;
        }
    } catch (e) { }
    return false;
}
const __loaded = persistLoad();
if (__loaded) {
    logger.info(`鍒濆鍖栨暟鎹姞杞芥垚鍔?(streams.json)锛岃褰曟暟: ${multicastList.length}`);
} else {
    logger.warn('鍒濆鍖栨暟鎹姞杞藉け璐?(streams.json 涓嶅瓨鍦ㄦ垨閿欒)锛屽皾璇曞姞杞芥渶鏂板巻鍙茬増鏈?);
    const __versions = listVersions();
    if (Array.isArray(__versions) && __versions.length > 0) {
        const vFile = __versions[0].file;
        const vOk = loadVersionFile(vFile);
        if (vOk) {
            logger.info(`鑷姩鍔犺浇鍘嗗彶鐗堟湰鎴愬姛: ${vFile}锛岃褰曟暟: ${multicastList.length}`);
        } else {
            logger.error(`鑷姩鍔犺浇鍘嗗彶鐗堟湰澶辫触: ${vFile}`);
        }
    } else {
        logger.info('鏃犲彲鐢ㄥ巻鍙茬増鏈紝鍚姩涓虹┖鏁版嵁鐘舵€?);
    }
}
const logoConfig = readJson(CFG_LOGO, { templates: [settings.logoTemplate], current: settings.logoTemplate });
const fccConfig = readJson(CFG_FCC, { servers: settings.fccServers, currentId: '' });
const udpxyConfig = readJson(CFG_UDPXY, { servers: [], currentId: '' });
const groupConfig = readJson(CFG_GROUPS, { titles: settings.groupTitles });
const proxyConfig = readJson(CFG_PROXY, { list: settings.proxyList });
const appSetCfg = readJson(CFG_APPSET, {
    useInternal: settings.useInternal,
    useExternal: settings.useExternal,
    internalUrl: settings.internalUrl,
    externalUrl: settings.externalUrl,
    securityToken: settings.securityToken,
    enableToken: settings.enableToken
});
settings.logoTemplate = logoConfig.current || settings.logoTemplate;
settings.fccServers = Array.isArray(fccConfig.servers) ? fccConfig.servers : settings.fccServers;
settings.groupTitles = Array.isArray(groupConfig.titles)
    ? (typeof groupConfig.titles[0] === 'object' ? groupConfig.titles.map(x => x && x.name ? x.name : '') : groupConfig.titles)
    : settings.groupTitles;
settings.proxyList = Array.isArray(proxyConfig.list) ? proxyConfig.list : settings.proxyList;
settings.useInternal = !!appSetCfg.useInternal;
settings.useExternal = !!appSetCfg.useExternal;
settings.internalUrl = appSetCfg.internalUrl || settings.internalUrl;
settings.externalUrl = appSetCfg.externalUrl || settings.externalUrl;
settings.securityToken = appSetCfg.securityToken || settings.securityToken;
settings.enableToken = !!appSetCfg.enableToken;
if ((!Array.isArray(settings.proxyList) || settings.proxyList.length === 0) && settings.externalUrl) {
    const url = String(settings.externalUrl || '').trim();
    if (url) {
        settings.proxyList = [{ type: '缁勬挱浠ｇ悊', url }];
        writeJson(CFG_PROXY, { list: settings.proxyList });
    }
}
function listVersions() {
    ensureDataDir();
    const files = fs.readdirSync(DATA_DIR).filter(f => /^streams-\d{8}-\d{6}\.json$/.test(f));
    const entries = files.map(f => {
        const full = path.join(DATA_DIR, f);
        let time = 0;
        try { const st = fs.statSync(full); time = st.mtimeMs || 0; } catch (e) { }
        return { file: f, time };
    });
    entries.sort((a, b) => b.time - a.time);
    return entries;
}
function loadVersionFile(filename) {
    ensureDataDir();
    const full = path.join(DATA_DIR, filename);
    if (!fs.existsSync(full)) return false;
    try {
        const txt = fs.readFileSync(full, 'utf-8');
        const json = JSON.parse(txt);
        multicastList = Array.isArray(json.streams) ? json.streams : [];
        const s = json.settings || {};
        globalFcc = s.globalFcc || '';
        settings.fccServers = Array.isArray(s.fccServers) ? s.fccServers : settings.fccServers;
        settings.logoTemplate = s.logoTemplate || settings.logoTemplate;
        settings.groupTitles = Array.isArray(s.groupTitles) ? s.groupTitles : settings.groupTitles;
        settings.globalFcc = globalFcc;
        if (globalFcc) {
            const val = globalFcc.includes('=') ? globalFcc : `fcc=${globalFcc}`;
            multicastList = multicastList.map(ss => ({ ...ss, httpParam: val }));
        }
        return true;
    } catch (e) { return false; }
}

const { ffprobeCheck } = require('./ffprobe');
const taskManager = require('./taskCheck');

// 鐩戝惉浠诲姟缁撴灉
taskManager.on('result', (data) => {
    const { isAvailable, frameRate, bitRate, speed, resolution, codec, serviceName, hdr, audio, audioChannels, audioSampleRate, originalUrl, name, udpxy } = data;

    // 鏋勯€犳洿鏂板瓧娈?
    const updateFields = {
        isAvailable,
        lastChecked: new Date().toISOString(),
        frameRate,
        bitRate: bitRate ? (bitRate / 1000000).toFixed(2) + 'Mbps' : '-',
        speed,
        resolution,
        codec,
        serviceName,
        hdr,
        audio,
        audioChannels,
        audioSampleRate
    };

    // 鏌ユ壘骞舵洿鏂?
    let found = false;
    // 浼樺厛鍖归厤 multicastUrl (rtp)
    if (originalUrl.startsWith('rtp://')) {
        const idx = multicastList.findIndex(i => i.multicastUrl === originalUrl);
        if (idx !== -1) {
            multicastList[idx] = { ...multicastList[idx], ...updateFields, udpxyUrl: udpxy };
            found = true;
        }
    } else {
        // http stream
        const idx = multicastList.findIndex(i => (i.url === originalUrl || i.multicastUrl === originalUrl));
        if (idx !== -1) {
            multicastList[idx] = { ...multicastList[idx], ...updateFields };
            found = true;
        }
    }

    if (!found && isAvailable) {
        multicastList.push({
            name: name || '',
            multicastUrl: originalUrl.startsWith('rtp://') ? originalUrl : '',
            url: originalUrl.startsWith('http') ? originalUrl : '',
            udpxyUrl: udpxy,
            startUrl: '',
            ...updateFields
        });
    }
});

// 浠诲姟鎺у埗璺敱
app.get('/api/task/status', (req, res) => res.json(taskManager.getStatus()));
app.post('/api/task/start', (req, res) => res.json({ success: taskManager.start(req.body) }));
app.post('/api/task/stop', (req, res) => { taskManager.stop(); res.json({ success: true }); });
app.post('/api/task/resume', (req, res) => res.json({ success: taskManager.resume() }));

// 鍗曟潯妫€娴嬬敤ffprobe
app.post('/api/check-stream', async (req, res) => {
    let { udpxyUrl, multicastUrl, name } = req.body;
    udpxyUrl = String(udpxyUrl || '').trim();
    multicastUrl = String(multicastUrl || '').trim();
    const fullUrl = `${udpxyUrl}/rtp/${multicastUrl.replace('rtp://', '')}`;
    ffprobeCheck(fullUrl, ({ isAvailable, frameRate, bitRate, speed, resolution, codec, serviceName, hdr, audio, audioChannels, audioSampleRate, raw }) => {
        // 鏇存柊鎴栨坊鍔犵粍鎾湴鍧€
        const existingIndex = multicastList.findIndex(item =>
            String(item.udpxyUrl || '').trim() === udpxyUrl && String(item.multicastUrl || '').trim() === multicastUrl
        );
        const detectFields = {
            udpxyUrl,
            multicastUrl,
            isAvailable,
            lastChecked: new Date().toISOString(),
            frameRate,
            bitRate,
            speed,
            resolution,
            codec,
            hdr,
            audio,
            audioChannels,
            audioSampleRate
        };
        if (existingIndex !== -1) {
            const prev = multicastList[existingIndex];
            // 鍙洿鏂扮姸鎬佸瓧娈碉紝淇濈暀鍘熸湁鍚嶇О銆佸垎缁勩€丩ogo绛変俊鎭?
            multicastList[existingIndex] = { ...prev, ...detectFields };
        } else {
            multicastList.push({
                ...detectFields,
                name: name || serviceName || '',
                tvgId: '',
                tvgName: '',
                logo: '',
                groupTitle: '',
                catchupFormat: '',
                catchupBase: '',
                httpParam: ''
            });
        }
        res.json({
            success: true,
            isAvailable,
            frameRate: frameRate || '-',
            bitRate: bitRate ? (bitRate / 1000000).toFixed(2) + 'Mbps' : '-',
            speed,
            resolution: resolution || '-',
            codec: codec || '-',
            hdr: hdr || '-',
            audio: audio || '-',
            audioChannels: audioChannels || '-',
            audioSampleRate: audioSampleRate || '-',
            name: existingIndex !== -1 ? multicastList[existingIndex].name : (name || serviceName || ''),
            raw, // 杩斿洖鍘熷鏁版嵁
            message: isAvailable ? '娴佸彲璁块棶' : '娴佷笉鍙闂?
        });
    });
});
app.post('/api/check-http-stream', async (req, res) => {
    let { url, name } = req.body;
    url = String(url || '').trim();
    ffprobeCheck(url, ({ isAvailable, frameRate, bitRate, speed, resolution, codec, serviceName, hdr, audio, audioChannels, audioSampleRate, raw }) => {
        const existingIndex = multicastList.findIndex(item => String(item.multicastUrl || '').trim() === url);
        const detectFields = {
            udpxyUrl: '',
            multicastUrl: url,
            isAvailable,
            lastChecked: new Date().toISOString(),
            frameRate,
            bitRate,
            speed,
            resolution,
            codec,
            hdr,
            audio,
            audioChannels,
            audioSampleRate
        };
        if (existingIndex !== -1) {
            const prev = multicastList[existingIndex];
            // 鍙洿鏂扮姸鎬佸瓧娈碉紝淇濈暀鍘熸湁鍚嶇О銆佸垎缁勩€丩ogo绛変俊鎭?
            multicastList[existingIndex] = { ...prev, ...detectFields };
        } else {
            multicastList.push({
                ...detectFields,
                name: name || serviceName || '',
                tvgId: '',
                tvgName: '',
                logo: '',
                groupTitle: '',
                catchupFormat: '',
                catchupBase: '',
                httpParam: prevGlobalParam()
            });
        }
        res.json({
            success: true,
            isAvailable,
            frameRate: frameRate || '-',
            bitRate: bitRate ? (bitRate / 1000000).toFixed(2) + 'Mbps' : '-',
            speed,
            resolution: resolution || '-',
            codec: codec || '-',
            hdr: hdr || '-',
            audio: audio || '-',
            audioChannels: audioChannels || '-',
            audioSampleRate: audioSampleRate || '-',
            name: existingIndex !== -1 ? multicastList[existingIndex].name : (name || serviceName || ''),
            raw,
            message: isAvailable ? '娴佸彲璁块棶' : '娴佷笉鍙闂?
        });
    });
});
app.post('/api/fetch-text', async (req, res) => {
    const { urls } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ success: false, message: 'urls蹇呴』涓洪潪绌烘暟缁? });
    }
    const results = [];
    for (const u of urls) {
        if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) {
            results.push({ url: u, ok: false, status: 'invalid', text: '' });
            continue;
        }
        try {
            const r = await fetch(u);
            const text = await r.text();
            results.push({ url: u, ok: true, status: r.status, text });
        } catch (e) {
            results.push({ url: u, ok: false, status: 'error', text: '' });
        }
    }
    res.json({ success: true, results });
});
function prevGlobalParam() {
    if (!globalFcc) return '';
    const val = globalFcc.includes('=') ? globalFcc : `fcc=${globalFcc}`;
    return val;
}

// 鎵归噺妫€娴嬬敤ffprobe骞跺彂锛岃繑鍥炶繘搴﹀拰璇︾粏淇℃伅
app.post('/api/check-streams-batch', async (req, res) => {
    logger.info('鏀跺埌鎵归噺妫€娴嬭姹?);
    let { udpxyUrl, multicastList: batchList } = req.body;
    udpxyUrl = String(udpxyUrl || '').trim();
    if (!Array.isArray(batchList)) {
        logger.warn('鎵归噺妫€娴嬪弬鏁伴敊璇? multicastList涓嶆槸鏁扮粍');
        return res.status(400).json({ success: false, message: 'multicastList蹇呴』涓烘暟缁? });
    }
    // 鍏煎鍓嶇浼犲弬鏍煎紡
    const fixedList = batchList.map(item => {
        if (typeof item === 'string') {
            const [name, multicastUrl] = item.split(',');
            return { name: name ? name.trim() : '', multicastUrl: multicastUrl ? multicastUrl.trim() : '' };
        }
        if (item && typeof item === 'object') {
            return { ...item, multicastUrl: String(item.multicastUrl || '').trim() };
        }
        return item;
    }).filter(item => item.multicastUrl && item.multicastUrl.startsWith('rtp://'));
    if (fixedList.length === 0) {
        logger.warn('鎵归噺妫€娴嬪け璐? 鏃犳湁鏁堢粍鎾湴鍧€');
        return res.status(400).json({ success: false, message: '鏃犳湁鏁堢粍鎾湴鍧€' });
    }
    logger.info(`寮€濮嬫墽琛屾壒閲忔娴嬶紝鏈夋晥浠诲姟鏁? ${fixedList.length}锛屽苟鍙戞暟: 5`);
    const limit = 5;
    let idx = 0;
    const results = [];
    let finished = 0;
    async function runNext(progressCallback) {
        if (idx >= fixedList.length) return;
        const item = fixedList[idx++];
        const multicastUrl = item.multicastUrl || item;
        const name = item.name || '';
        const fullUrl = `${udpxyUrl}/rtp/${multicastUrl.replace('rtp://', '')}`;
        await new Promise((resolve) => {
            ffprobeCheck(fullUrl, ({ isAvailable, frameRate, bitRate, speed, resolution, codec, serviceName }) => {
                results.push({
                    ...item,
                    udpxyUrl,
                    multicastUrl,
                    isAvailable,
                    lastChecked: new Date().toISOString(),
                    frameRate: frameRate || '-',
                    bitRate: bitRate ? (bitRate / 1000000).toFixed(2) + 'Mbps' : '-',
                    speed,
                    resolution: resolution || '-',
                    codec: codec || 'h264',
                    name: name || serviceName || '',
                    message: isAvailable ? '娴佸彲璁块棶' : '娴佷笉鍙闂?
                });
                finished++;
                if (progressCallback) progressCallback(finished, fixedList.length, name, multicastUrl, frameRate, bitRate, speed);
                resolve();
            });
        });
        await runNext(progressCallback);
    }
    await Promise.all(Array(limit).fill(0).map(() => runNext(null)));
    logger.info('鎵归噺妫€娴嬪畬鎴?);
    // 鍚堝苟鍒板叏灞€multicastList
    results.forEach(result => {
        const existingIndex = multicastList.findIndex(item =>
            String(item.udpxyUrl || '').trim() === udpxyUrl && String(item.multicastUrl || '').trim() === result.multicastUrl
        );
        if (existingIndex !== -1) {
            const prev = multicastList[existingIndex];
            // 鍙洿鏂扮姸鎬佸瓧娈?
            multicastList[existingIndex] = {
                ...prev,
                udpxyUrl,
                multicastUrl: result.multicastUrl,
                isAvailable: result.isAvailable,
                lastChecked: result.lastChecked,
                frameRate: result.frameRate,
                bitRate: result.bitRate,
                speed: result.speed,
                resolution: result.resolution,
                codec: result.codec
            };
        } else {
            multicastList.push({
                udpxyUrl,
                multicastUrl: result.multicastUrl,
                isAvailable: result.isAvailable,
                lastChecked: result.lastChecked,
                frameRate: result.frameRate,
                bitRate: result.bitRate,
                speed: result.speed,
                resolution: result.resolution,
                codec: result.codec,
                name: result.name || '',
                tvgId: '',
                tvgName: '',
                logo: '',
                groupTitle: '',
                catchupFormat: '',
                catchupBase: '',
                httpParam: prevGlobalParam()
            });
        }
    });
    res.json({ success: true, results });
});

// 鑾峰彇鎵€鏈夌粍鎾湴鍧€
app.get('/api/streams', (req, res) => {
    res.json({ success: true, streams: multicastList });
});

function qualityLabelBackend(resolution) {
    const r = (resolution || '').toLowerCase();
    if (r === '720x576' || r === '1280x720') return '鏍囨竻';
    if (r === '1920x1080') return '楂樻竻';
    if (r === '3840x2160') return '瓒呴珮娓?;
    return '鏈煡';
}
function filterByStatus(list, status) {
    if (status === 'online') return list.filter(s => s.isAvailable);
    if (status === 'offline') return list.filter(s => !s.isAvailable);
    return list;
}
function isHttpUrl(u) {
    return /^https?:\/\//i.test(String(u || '').trim());
}
function isMulticastStream(s) {
    const u = String(s.multicastUrl || '').trim();
    const scheme = u.split(':')[0].toLowerCase();
    return !!s.udpxyUrl || scheme === 'rtp' || scheme === 'udp';
}
function cctvNumberFrom(str) {
    const m = String(str || '').toUpperCase().match(/CCTV[ -]?(\d{1,2})/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n >= 1 && n <= 17) return n;
    return null;
}
function findUnicastMatchByMeta(name, resolution, frameRate) {
    const nm = String(name || '').trim();
    const rs = String(resolution || '').trim();
    const frStr = String(frameRate || '').trim();
    const frNum = frStr ? (parseFloat(frStr) || null) : null;
    const list = Array.isArray(multicastList) ? multicastList : [];
    const candidates = list.filter(x => isHttpUrl(x.multicastUrl));
    const fullNameEq = (x) => String(x.tvgName || x.name || '').trim() === nm;
    const normalizeName = (s) => String(s || '').trim().replace(/\s+/g, '').replace(/4K$/i, '');
    const nmBase = normalizeName(nm);
    const fullNameBaseEq = (x) => normalizeName(String(x.tvgName || x.name || '').trim()) === nmBase;
    const eqRes = (x) => String(x.resolution || '').trim() === rs;
    const eqFps = (x) => {
        const xf = String(x.frameRate || '').trim();
        if (!xf || !frStr) return false;
        const a = parseFloat(xf);
        const b = frNum;
        if (!isNaN(a) && b !== null) return Math.abs(a - b) <= 0.1;
        return xf === frStr;
    };
    const areaOf = (r) => {
        const m = String(r || '').trim().match(/^(\d+)\s*x\s*(\d+)$/i);
        if (!m) return 0;
        const w = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        if (isNaN(w) || isNaN(h)) return 0;
        return w * h;
    };
    let nameCandidates = candidates.filter(fullNameEq);
    if (nameCandidates.length === 0) {
        nameCandidates = candidates.filter(fullNameBaseEq);
    }
    if (nameCandidates.length === 0) return null;
    const exactRF = nameCandidates.filter(x => eqRes(x) && eqFps(x));
    if (exactRF.length > 0) return exactRF[0];
    const exactR = nameCandidates.filter(x => eqRes(x));
    if (exactR.length > 0) {
        const withFps = exactR.filter(x => eqFps(x));
        if (withFps.length > 0) return withFps[0];
        return exactR[0];
    }
    const is4k = rs === '3840x2160';
    const fourK = nameCandidates.filter(x => String(x.resolution || '').trim() === '3840x2160');
    const withFps = nameCandidates.filter(x => eqFps(x));
    if (is4k) {
        if (withFps.length > 0) {
            const fourKFps = withFps.filter(x => String(x.resolution || '').trim() === '3840x2160');
            if (fourKFps.length > 0) return fourKFps[0];
            withFps.sort((a, b) => areaOf(b.resolution) - areaOf(a.resolution));
            return withFps[0];
        }
        if (fourK.length > 0) return fourK[0];
        const sorted = [...nameCandidates].sort((a, b) => areaOf(b.resolution) - areaOf(a.resolution));
        return sorted[0];
    } else {
        if (withFps.length > 0) {
            withFps.sort((a, b) => areaOf(b.resolution) - areaOf(a.resolution));
            return withFps[0];
        }
        const sorted = [...nameCandidates].sort((a, b) => areaOf(b.resolution) - areaOf(a.resolution));
        return sorted[0];
    }
}
function buildUnicastCatchupBase(scope, unicastUrl, proto = 'http') {
    const raw = String(unicastUrl || '').trim();
    if (!raw) return '';
    if (proto === 'rtsp') {
        return stripQuery(raw);
    }
    if (scope === 'external') {
        const proxyBase = getProxyByType('鍗曟挱浠ｇ悊');
        let pb = proxyBase && proxyBase.url ? proxyBase.url : '';
        if (pb && !/^https?:\/\//i.test(pb)) pb = 'http://' + pb.replace(/^\/+/, '');
        if (pb) return pb + '/' + stripScheme(stripQuery(raw));
    }
    return stripQuery(raw);
}
const GROUP_ORDER = ['4K棰戦亾', '澶棰戦亾', '婀栧崡棰戦亾', '鍗棰戦亾', '娓彴棰戦亾', '鏁板瓧棰戦亾', '灏戝効棰戦亾', '璐墿棰戦亾', '棰勭暀棰戦亾', '鏈垎绫婚閬?];
function groupRankOf(s) {
    const g = (s.groupTitle || '').trim() || '鏈垎绫婚閬?;
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
}
function parseCCTVNum(s) {
    const str = String((s.tvgName || s.name || '')).toUpperCase();
    const m = str.match(/CCTV[ -]?(\d+)(?:\+)?/);
    return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}
function getQualityScore(s) {
    // 鍩虹鍒嗘暟锛氱粍鎾?2000) > 鍗曟挱(0)
    let score = isMulticastStream(s) ? 2000 : 0;

    // 鍒嗚鲸鐜囧垎鏁帮細4K(500) > 1080P(300) > 720P(100) > 鍏朵粬(0)
    const res = (s.resolution || '').toLowerCase();
    if (res === '3840x2160') score += 500;
    else if (res === '1920x1080') score += 300;
    else if (res === '1280x720') score += 100;

    // 甯х巼鍒嗘暟锛?0fps(50) > 25fps(25) > 鍏朵粬(0)
    const fps = parseFloat(s.frameRate || '0');
    if (!isNaN(fps)) score += fps;

    return score;
}
function sortStreamsForExport(list) {
    return [...list].sort((a, b) => {
        const ra = groupRankOf(a);
        const rb = groupRankOf(b);
        if (ra !== rb) return ra - rb;
        const ga = (a.groupTitle || '').trim();
        const gb = (b.groupTitle || '').trim();
        if (ga === '澶棰戦亾' && gb === '澶棰戦亾') {
            const ca = parseCCTVNum(a);
            const cb = parseCCTVNum(b);
            if (ca !== cb) return ca - cb;
        }
        const na = (a.name || a.tvgName || '');
        const nb = (b.name || b.tvgName || '');
        // 鍚屽悕棰戦亾鎸夎川閲忔帓搴?
        if (na === nb) {
            return getQualityScore(b) - getQualityScore(a);
        }
        return na.localeCompare(nb, 'zh', { numeric: true, sensitivity: 'base' });
    });
}
function filterHttpParam(paramStr) {
    const s = String(paramStr || '').trim();
    if (!s) return '';
    const pairs = s.split('&').map(x => x.trim()).filter(Boolean);
    const filtered = pairs.filter(p => {
        const k = p.split('=')[0].toLowerCase();
        return k !== 'zte_offset' && k !== 'ispcode' && k !== 'starttime';
    });
    return filtered.join('&');
}
function stripScheme(urlStr) {
    return String(urlStr || '').replace(/^https?:\/\//i, '');
}
function stripQuery(urlStr) {
    const s = String(urlStr || '');
    const i = s.indexOf('?');
    return i >= 0 ? s.slice(0, i) : s;
}
app.get('/api/export/txt', (req, res) => {
    // Token validation logic moved to common function or executed here
    const scope = String(req.query.scope || 'internal').toLowerCase();
    if (scope === 'external' && settings.enableToken && settings.securityToken) {
        const token = String(req.query.token || '').trim();
        if (token !== settings.securityToken) {
            return res.status(403).send('Access Denied: Invalid Token');
        }
    }
    const udpxyCfg = readJson(CFG_UDPXY, { servers: [], currentId: '' });
    const udpxyServers = Array.isArray(udpxyCfg.servers) ? udpxyCfg.servers : [];
    const udpxyCurr = udpxyServers.find(x => x.id === udpxyCfg.currentId) || null;
    const udpxyCurrUrl = udpxyCurr ? (udpxyCurr.url || '') : '';
    const status = String(req.query.status || 'all').toLowerCase();
    const stripSuffixParam = String(req.query.stripSuffix || '').toLowerCase();
    const noSuffix = stripSuffixParam === '1' || stripSuffixParam === 'true' || stripSuffixParam === 'yes';
    const filtered = filterByStatus(multicastList, status);
    const ordered = sortStreamsForExport(filtered);
    const lines = [];
    let lastGroup = null;
    ordered.forEach(s => {
        const nm = s.name || '';
        const u = String(s.multicastUrl || '').trim();
        const scheme = u.split(':')[0].toLowerCase();
        const isMulticast = !!s.udpxyUrl || scheme === 'rtp' || scheme === 'udp';
        let httpUrlBase = '';
        if (isMulticast) {
            const extBase = getProxyByType('缁勬挱浠ｇ悊');
            if (scope === 'external' && !(extBase && extBase.url)) return;
            let base = '';
            if (scope === 'external') {
                base = extBase.url;
            } else {
                base = udpxyCurrUrl || '';
            }
            if (!base) return;
            if (base && !/^https?:\/\//i.test(base)) base = 'http://' + base.replace(/^\/+/, '');
            const path = '/rtp/' + u.replace(/^rtp:\/\//i, '').replace(/^udp:\/\//i, '');
            httpUrlBase = `${base}${path}`;
        } else {
            const proxyBase = getProxyByType('鍗曟挱浠ｇ悊');
            if (scope === 'external' && !(proxyBase && proxyBase.url)) return;
            let base = scope === 'external' ? (proxyBase.url || '') : '';
            if (scope === 'external' && base && !/^https?:\/\//i.test(base)) base = 'http://' + base.replace(/^\/+/, '');
            httpUrlBase = scope === 'external' ? (base + '/' + stripScheme(u)) : u;
        }
        const hp = filterHttpParam(s.httpParam || '');
        const httpUrl = (isMulticast && hp) ? (httpUrlBase + '?' + hp) : (httpUrlBase);
        const grp = (s.groupTitle || '鏈垎缁?).trim() || '鏈垎缁?;
        if (grp !== lastGroup) {
            lines.push(`${grp},#genre#`);
            lastGroup = grp;
        }
        lines.push(`${nm},${httpUrl}`);
    });
    const content = lines.join('\r\n');
    res.type('text/plain; charset=utf-8').send(content);
});
app.get('/api/export/m3u', (req, res) => {
    const scope = String(req.query.scope || 'internal').toLowerCase();
    if (scope === 'external' && settings.enableToken && settings.securityToken) {
        const token = String(req.query.token || '').trim();
        if (token !== settings.securityToken) {
            return res.status(403).send('Access Denied: Invalid Token');
        }
    }
    const status = String(req.query.status || 'all').toLowerCase();
    const fmt = String(req.query.fmt || 'default').toLowerCase();
    const proto = String(req.query.proto || 'http').toLowerCase();
    const stripSuffixParam = String(req.query.stripSuffix || '').toLowerCase();
    const noSuffix = (fmt === 'default') || stripSuffixParam === '1' || stripSuffixParam === 'true' || stripSuffixParam === 'yes';
    const udpxyCfg = readJson(CFG_UDPXY, { servers: [], currentId: '' });
    const udpxyServers = Array.isArray(udpxyCfg.servers) ? udpxyCfg.servers : [];
    const udpxyCurr = udpxyServers.find(x => x.id === udpxyCfg.currentId) || null;
    const udpxyCurrUrl = udpxyCurr ? (udpxyCurr.url || '') : '';
    const defLogo = { templates: [{ id: 'ltpl-default', name: '榛樿妯℃澘', url: settings.logoTemplate, category: '鍐呯綉鍙版爣' }], currentId: 'ltpl-default' };
    const logoCfg = readJson(CFG_LOGO, defLogo);
    const logoListRaw = Array.isArray(logoCfg.templates) ? logoCfg.templates : [];
    const logoList = logoListRaw.map(t => {
        if (typeof t === 'string') return { id: 'ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36), name: '鏈懡鍚嶆ā鏉?, url: t, category: '鍐呯綉鍙版爣' };
        return { id: t.id || ('ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36)), name: t.name || '鏈懡鍚嶆ā鏉?, url: t.url || '', category: typeof t.category === 'string' ? (t.category === '鍐呯綉' ? '鍐呯綉鍙版爣' : (t.category === '澶栫綉' ? '澶栫綉鍙版爣' : t.category)) : '鍐呯綉鍙版爣' };
    }).filter(x => x.url);
    const pickLogoTpl = (scope === 'external' ? (logoList.find(x => x.category === '澶栫綉鍙版爣') || null) : (logoList.find(x => x.category === '鍐呯綉鍙版爣') || null)) || null;
    const defEpg = { sources: [] };
    const epgCfg = readJson(CFG_EPG, defEpg);
    const epgListRaw = Array.isArray(epgCfg.sources) ? epgCfg.sources : [];
    const epgList = epgListRaw.map(x => ({
        id: x && x.id ? x.id : ('epg-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
        name: x && x.name ? x.name : '鏈懡鍚岴PG',
        url: x && x.url ? x.url : '',
        scope: (x && x.scope === '澶栫綉' || x && x.scope === '澶栫綉EPG') ? '澶栫綉EPG' : '鍐呯綉EPG'
    })).filter(x => x.url);
    const pickEpg = (scope === 'external' ? (epgList.find(x => x.scope === '澶栫綉EPG') || null) : (epgList.find(x => x.scope === '鍐呯綉EPG') || null)) || null;
    const filtered = filterByStatus(multicastList, status);
    const ordered = sortStreamsForExport(filtered);
    const epgHeaderUrl = pickEpg ? pickEpg.url : '';
    const head = '#EXTM3U' + (epgHeaderUrl ? (' x-tvg-url="' + epgHeaderUrl + '"') : '') + '\r\n';
    const body = ordered.map(s => {
        const q = qualityLabelBackend(s.resolution);
        const fpsStr = s.frameRate ? `${s.frameRate}fps` : '-';
        const u = String(s.multicastUrl || '').trim();
        const scheme = u.split(':')[0].toLowerCase();
        const isMulticast = !!s.udpxyUrl || scheme === 'rtp' || scheme === 'udp';
        const suffix = noSuffix ? '' : (isMulticast ? (`$缁勬挱${q}-${fpsStr}`) : (`$鍗曟挱${q}-${fpsStr}`));
        let httpUrlBase = '';
        if (isMulticast) {
            const extBase = getProxyByType('缁勬挱浠ｇ悊');
            if (scope === 'external' && !(extBase && extBase.url)) return null;
            let base = '';
            if (scope === 'external') {
                base = extBase.url;
            } else {
                base = udpxyCurrUrl || '';
            }
            if (!base) return null;
            if (base && !/^https?:\/\//i.test(base)) base = 'http://' + base.replace(/^\/+/, '');
            const path = '/rtp/' + u.replace(/^rtp:\/\//i, '').replace(/^udp:\/\//i, '');
            httpUrlBase = `${base}${path}`;
        } else {
            const proxyBase = getProxyByType('鍗曟挱浠ｇ悊');
            if (scope === 'external' && !(proxyBase && proxyBase.url)) return null;
            let base = scope === 'external' ? (proxyBase.url || '') : '';
            if (scope === 'external' && base && !/^https?:\/\//i.test(base)) base = 'http://' + base.replace(/^\/+/, '');
            httpUrlBase = scope === 'external' ? (base + '/' + stripScheme(u)) : u;
        }
        const hp = filterHttpParam(s.httpParam || '');
        const httpUrl = (isMulticast && hp) ? (httpUrlBase + '?' + hp + suffix) : (httpUrlBase + suffix);
        const tvgId = s.tvgId || '';
        const tvgName = s.tvgName || s.name || '';
        let tvgLogo = s.logo || '';
        const logoTpl = pickLogoTpl ? pickLogoTpl.url : settings.logoTemplate;
        if (logoTpl && tvgName) tvgLogo = logoTpl.replace('{name}', tvgName);
        const groupTitle = s.groupTitle || '';
        let catchupAttr = '';
        let unicastBase = '';
        if (!isMulticast) {
            unicastBase = buildUnicastCatchupBase(scope, s.multicastUrl || '', proto);
        } else {
            const match = findUnicastMatchByMeta(s.tvgName || s.name || '', s.resolution || '', s.frameRate);
            if (match && isHttpUrl(match.multicastUrl)) {
                unicastBase = buildUnicastCatchupBase(scope, match.multicastUrl || '', proto);
            }
        }
        if (!unicastBase && s.catchupBase && fmt === 'default') {
            let cb = s.catchupBase;
            if (scope === 'external') {
                const proxyBase = getProxyByType('鍗曟挱浠ｇ悊');
                let pb = proxyBase && proxyBase.url ? proxyBase.url : '';
                if (pb && !/^https?:\/\//i.test(pb)) pb = 'http://' + pb.replace(/^\/+/, '');
                if (pb) cb = pb + cb;
            }
            unicastBase = cb;
        }
        if (unicastBase) {
            if (fmt === 'ku9') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?starttime=${'${(b)yyyyMMdd|UTC}'}T${'${(b)HHmmss|UTC}'}&endtime=${'${(e)yyyyMMdd|UTC}'}T${'${(e)HHmmss|UTC}'}"`;
            } else if (fmt === 'mytv') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?starttime={utc:yyyyMMddHHmmss}&endtime={utcend:yyyyMMddHHmmss}"`;
            } else if (fmt === 'playseek') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?playseek=${'${(b)yyyyMMddHHmmss}'}-${'${(e)yyyyMMddHHmmss}'}"`;
            } else if (fmt === 'startend14') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?starttime=${'${(b)yyyyMMddHHmmss}'}&endtime=${'${(e)yyyyMMddHHmmss}'}"`;
            } else if (fmt === 'beginend14') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?begin=${'${(b)yyyyMMddHHmmss}'}&end=${'${(e)yyyyMMddHHmmss}'}"`;
            } else if (fmt === 'iso8601') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?start=${'${(b)yyyy-MM-dd|UTC}'}T${'${(b)HH:mm:ss|UTC}'}Z&end=${'${(e)yyyy-MM-dd|UTC}'}T${'${(e)HH:mm:ss|UTC}'}Z"`;
            } else if (fmt === 'npt') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?npt=${'${(b)HH}'}:${'${(b)mm}'}:${'${(b)ss}'}-${'${(e)HH}'}:${'${(e)mm}'}:${'${(e)ss}'}"`;
            } else if (fmt === 'rtsp_range') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?npt=${'${(b)HH}'}:${'${(b)mm}'}:${'${(b)ss}'}-${'${(e)HH}'}:${'${(e)mm}'}:${'${(e)ss}'}"`;
            } else if (fmt === 'unix_s') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?start=${'${(b)unix_s|UTC}'}&end=${'${(e)unix_s|UTC}'}"`;
            } else if (fmt === 'unix_ms') {
                catchupAttr = ` catchup="default" catchup-source="${unicastBase}?start=${'${(b)unix_ms|UTC}'}&end=${'${(e)unix_ms|UTC}'}"`;
            } else {
                catchupAttr = '';
            }
        }
        const line1 = `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${tvgLogo}" group-title="${groupTitle}"${catchupAttr},${s.name || ''}`;
        return `${line1}\r\n${httpUrl}`;
    }).filter(Boolean).join('\r\n');
    res.type('text/plain; charset=utf-8').send(head + body);
});
app.get('/api/export/json', (req, res) => {
    const scope = String(req.query.scope || 'internal').toLowerCase();
    if (scope === 'external' && settings.enableToken && settings.securityToken) {
        const token = String(req.query.token || '').trim();
        if (token !== settings.securityToken) {
            return res.status(403).json({ success: false, message: 'Access Denied: Invalid Token' });
        }
    }
    const status = String(req.query.status || 'all').toLowerCase();
    const udpxyCfg = readJson(CFG_UDPXY, { servers: [], currentId: '' });
    const udpxyServers = Array.isArray(udpxyCfg.servers) ? udpxyCfg.servers : [];
    const udpxyCurr = udpxyServers.find(x => x.id === udpxyCfg.currentId) || null;
    const udpxyCurrUrl = udpxyCurr ? (udpxyCurr.url || '') : '';
    const baseList = filterByStatus(multicastList, status);
    const orderedList = sortStreamsForExport(baseList);
    const filtered = orderedList.map(s => {
        const name = s.name || '';
        const udpxyUrl = s.udpxyUrl || '';
        const multicastUrl = s.multicastUrl || '';
        const httpUrl = (function () {
            const u = String(s.multicastUrl || '').trim();
            const scheme = u.split(':')[0].toLowerCase();
            const isMulticast = !!s.udpxyUrl || scheme === 'rtp' || scheme === 'udp';
            let base = '';
            if (isMulticast) {
                const extBase = getProxyByType('缁勬挱浠ｇ悊');
                if (scope === 'external' && !(extBase && extBase.url)) return null;
                let b = '';
                if (scope === 'external') {
                    b = extBase.url;
                } else {
                    b = udpxyCurrUrl || '';
                }
                if (!b) return null;
                if (b && !/^https?:\/\//i.test(b)) b = 'http://' + b.replace(/^\/+/, '');
                const path = '/rtp/' + u.replace(/^rtp:\/\//i, '').replace(/^udp:\/\//i, '');
                base = `${b}${path}`;
            } else {
                const proxyBase = getProxyByType('鍗曟挱浠ｇ悊');
                if (scope === 'external' && !(proxyBase && proxyBase.url)) return null;
                let b = scope === 'external' ? (proxyBase.url || '') : '';
                if (scope === 'external' && b && !/^https?:\/\//i.test(b)) b = 'http://' + b.replace(/^\/+/, '');
                base = scope === 'external' ? (b + '/' + stripScheme(u)) : u;
            }
            const suf = `$${qualityLabelBackend(s.resolution)}-${s.frameRate ? `${s.frameRate}fps` : '-'}`;
            const hp = filterHttpParam(s.httpParam || '');
            return (isMulticast && hp) ? (base + '?' + hp + suf) : (base + suf);
        })();
        if (httpUrl === null) return null;
        return {
            name,
            udpxyUrl,
            multicastUrl,
            httpUrl,
            isAvailable: !!s.isAvailable,
            resolution: s.resolution || '',
            frameRate: s.frameRate || '',
            codec: s.codec || '',
            tvgId: s.tvgId || '',
            tvgName: s.tvgName || '',
            logo: s.logo || '',
            groupTitle: s.groupTitle || '',
            catchupFormat: s.catchupFormat || '',
            catchupBase: s.catchupBase || '',
            httpParam: s.httpParam || ''
        };
    }).filter(Boolean);
    res.json({ success: true, count: filtered.length, streams: filtered });
});

// 鎵归噺鍒犻櫎缁勬挱鍦板潃
app.post('/api/streams/batch-delete', (req, res) => {
    const { indices } = req.body;
    if (!Array.isArray(indices)) {
        return res.status(400).json({ success: false, message: 'indices蹇呴』涓烘暟缁? });
    }
    // 鍘婚噸骞堕檷搴忔帓搴忥紝闃叉绱㈠紩鍋忕Щ
    const sorted = [...new Set(indices)].filter(i => typeof i === 'number').sort((a, b) => b - a);
    let count = 0;
    for (const idx of sorted) {
        if (idx >= 0 && idx < multicastList.length) {
            multicastList.splice(idx, 1);
            count++;
        }
    }
    // 鎵归噺鍒犻櫎閫氬父鎰忓懗鐫€鐢ㄦ埛纭浜嗗彉鏇达紝鍚屾淇濆瓨
    persistSave();
    res.json({ success: true, count, message: `宸插垹闄?${count} 鏉¤褰曞苟淇濆瓨` });
});

// 鍒犻櫎缁勬挱鍦板潃
app.delete('/api/stream/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (index >= 0 && index < multicastList.length) {
        multicastList.splice(index, 1);
        // 鍗曟潯鍒犻櫎涔熷悓姝ヤ繚瀛?
        persistSave();
        res.json({ success: true, message: '鍒犻櫎鎴愬姛' });
    } else {
        res.status(400).json({ success: false, message: '鏃犳晥鐨勭储寮? });
    }
});
// 娓呯┖鎵€鏈夌粍鎾湴鍧€
app.delete('/api/streams', (req, res) => {
    multicastList = [];
    // 娓呯┖鏃跺悓姝ヤ繚瀛樺埌纾佺洏锛岄槻姝?fallback 鏈哄埗璇诲彇鍒版棫鏁版嵁
    persistSave();
    res.json({ success: true, message: '宸叉竻绌烘墍鏈夋娴嬬粨鏋滃苟淇濆瓨' });
});

// 鏂板锛氬己鍒跺埛鏂版娴嬶紝鍓嶇浼犻€抐orce鍙傛暟锛屽悗绔竻绌烘墍鏈夋娴嬫暟鎹?
app.post('/api/force-refresh', (req, res) => {
    multicastList = [];
    streamCache.clear();
    res.json({ success: true, message: '宸插己鍒舵竻绌烘墍鏈夋娴嬫暟鎹? });
});

// 鏇存柊娴佺殑鍏冩暟鎹?
app.post('/api/stream/update', (req, res) => {
    const { udpxyUrl, multicastUrl, update } = req.body || {};
    if (!multicastUrl || typeof update !== 'object') {
        return res.status(400).json({ success: false, message: '缂哄皯蹇呰鍙傛暟' });
    }
    let index = -1;
    if (udpxyUrl) {
        index = multicastList.findIndex(item => item.udpxyUrl === udpxyUrl && item.multicastUrl === multicastUrl);
    }
    if (index === -1) {
        index = multicastList.findIndex(item => item.multicastUrl === multicastUrl);
    }
    if (index === -1) {
        const obj = {
            udpxyUrl,
            multicastUrl,
            isAvailable: false,
            lastChecked: new Date().toISOString()
        };
        multicastList.push(obj);
        index = multicastList.length - 1;
    }
    multicastList[index] = { ...multicastList[index], ...update };
    res.json({ success: true, stream: multicastList[index] });
});

app.post('/api/set-fcc', (req, res) => {
    const { fcc } = req.body || {};
    if (!fcc || typeof fcc !== 'string') {
        return res.status(400).json({ success: false, message: '缂哄皯fcc鍙傛暟' });
    }
    globalFcc = fcc;
    settings.globalFcc = fcc;
    const val = fcc.includes('=') ? fcc : `fcc=${fcc}`;
    multicastList = multicastList.map(s => {
        const u = String(s.multicastUrl || '').trim();
        const scheme = u.split(':')[0].toLowerCase();
        const isMulticast = !!s.udpxyUrl || scheme === 'rtp' || scheme === 'udp';
        return { ...s, httpParam: isMulticast ? val : '' };
    });
    res.json({ success: true, globalFcc: val, count: multicastList.length });
});

app.post('/api/persist/save', (req, res) => {
    logger.info('璇锋眰淇濆瓨褰撳墠鏁版嵁涓庨厤缃?);
    const ok = persistSave();
    if (ok) {
        logger.info('鏁版嵁淇濆瓨鎴愬姛');
        return res.json({ success: true });
    }
    logger.error('鏁版嵁淇濆瓨澶辫触');
    res.status(500).json({ success: false, message: '淇濆瓨澶辫触' });
});

app.post('/api/persist/load', (req, res) => {
    logger.info('璇锋眰鍔犺浇鏁版嵁');
    const ok = persistLoad();
    if (ok) return res.json({ success: true, streams: multicastList, settings: { globalFcc } });
    logger.warn('鍔犺浇鏁版嵁澶辫触: 鏈壘鍒版寔涔呭寲鏂囦欢');
    res.status(404).json({ success: false, message: '鏈壘鍒版寔涔呭寲鏂囦欢' });
});
app.post('/api/persist/delete', (req, res) => {
    logger.info('璇锋眰鍒犻櫎鎵€鏈夋暟鎹?);
    ensureDataDir();
    try {
        if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
        return res.json({ success: true });
    } catch (e) {
        logger.error(`鍒犻櫎鏁版嵁澶辫触: ${e.message}`);
        return res.status(500).json({ success: false, message: '鍒犻櫎澶辫触' });
    }
});
app.get('/api/persist/list', (req, res) => {
    try { return res.json({ success: true, versions: listVersions() }); } catch (e) { res.status(500).json({ success: false }); }
});
app.post('/api/persist/load-version', (req, res) => {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ success: false, message: '缂哄皯filename' });
    logger.info(`璇锋眰鍔犺浇鐗堟湰: ${filename}`);
    const ok = loadVersionFile(filename);
    if (ok) {
        logger.info(`鐗堟湰鍔犺浇鎴愬姛: ${filename}`);
        return res.json({ success: true, streams: multicastList, settings });
    }
    logger.error(`鐗堟湰鍔犺浇澶辫触: ${filename}`);
    res.status(404).json({ success: false, message: '鐗堟湰鏂囦欢涓嶅瓨鍦ㄦ垨璇诲彇澶辫触' });
});
app.post('/api/persist/delete-version', (req, res) => {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ success: false, message: '缂哄皯filename' });
    logger.info(`璇锋眰鍒犻櫎鐗堟湰: ${filename}`);
    ensureDataDir();
    const full = path.join(DATA_DIR, filename);
    try {
        if (fs.existsSync(full)) {
            fs.unlinkSync(full);
            return res.json({ success: true });
        } else {
            return res.status(404).json({ success: false, message: '鏂囦欢涓嶅瓨鍦? });
        }
    } catch (e) { return res.status(500).json({ success: false, message: '鍒犻櫎澶辫触' }); }
});
app.get('/api/config/logo-templates', (req, res) => {
    const defId = 'ltpl-default';
    const cfg = readJson(CFG_LOGO, { templates: [{ id: defId, name: '榛樿妯℃澘', url: settings.logoTemplate }], currentId: defId });
    const listRaw = Array.isArray(cfg.templates) ? cfg.templates : [];
    const listObj = listRaw.map(t => {
        if (typeof t === 'string') {
            return { id: 'ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36), name: '鏈懡鍚嶆ā鏉?, url: t, category: '鍐呯綉鍙版爣' };
        }
        return { id: t.id || ('ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36)), name: t.name || '鏈懡鍚嶆ā鏉?, url: t.url || '', category: typeof t.category === 'string' ? (t.category === '鍐呯綉' ? '鍐呯綉鍙版爣' : (t.category === '澶栫綉' ? '澶栫綉鍙版爣' : t.category)) : '鍐呯綉鍙版爣' };
    }).filter(x => x.url);
    let currId = typeof cfg.currentId === 'string' ? cfg.currentId : '';
    let currUrl = '';
    if (!currId && typeof cfg.current === 'string') {
        const it = listObj.find(x => x.url === cfg.current);
        currId = it ? it.id : '';
    }
    if (!currId && listObj[0]) currId = listObj[0].id;
    const currItem = listObj.find(x => x.id === currId) || listObj[0] || null;
    currUrl = currItem ? currItem.url : settings.logoTemplate;
    const listStr = listObj.map(x => x.url);
    res.json({ success: true, templates: listStr, current: currUrl, templatesObj: listObj, currentId: currId });
});
app.post('/api/config/logo-templates', (req, res) => {
    const { templates, current, templatesObj, currentId } = req.body || {};
    let listObj = Array.isArray(templatesObj) ? templatesObj.map(t => ({
        id: t && t.id ? t.id : ('ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
        name: t && t.name ? t.name : '鏈懡鍚嶆ā鏉?,
        url: t && t.url ? t.url : '',
        category: t && typeof t.category === 'string' ? t.category : '鍐呯綉鍙版爣'
    })) : [];
    if (listObj.length === 0) {
        const listStr = Array.isArray(templates) ? templates : [];
        listObj = listStr.filter(u => typeof u === 'string' && u).map(u => ({
            id: 'ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36),
            name: '鏈懡鍚嶆ā鏉?,
            url: u,
            category: '鍐呯綉鍙版爣'
        }));
    }
    listObj = listObj.filter(x => x.url);
    let currId = typeof currentId === 'string' ? currentId : '';
    if (!currId && typeof current === 'string') {
        const it = listObj.find(x => x.url === current);
        currId = it ? it.id : '';
    }
    if (!currId && listObj[0]) currId = listObj[0].id;
    const currItem = listObj.find(x => x.id === currId) || listObj[0] || null;
    const currUrl = currItem ? currItem.url : '';
    writeJson(CFG_LOGO, { templates: listObj, currentId: currId });
    settings.logoTemplate = currUrl || settings.logoTemplate;
    res.json({ success: true });
});
app.get('/api/config/fcc-servers', (req, res) => {
    const cfg = readJson(CFG_FCC, { servers: settings.fccServers, currentId: '' });
    res.json({ success: true, servers: Array.isArray(cfg.servers) ? cfg.servers : [], currentId: cfg.currentId || '' });
});
app.post('/api/config/fcc-servers', (req, res) => {
    const { servers, currentId } = req.body || {};
    const list = Array.isArray(servers) ? servers : [];
    writeJson(CFG_FCC, { servers: list, currentId: typeof currentId === 'string' ? currentId : '' });
    settings.fccServers = list;
    res.json({ success: true });
});
app.get('/api/config/udpxy-servers', (req, res) => {
    const cfg = readJson(CFG_UDPXY, { servers: [], currentId: '' });
    res.json({ success: true, servers: Array.isArray(cfg.servers) ? cfg.servers : [], currentId: cfg.currentId || '' });
});
app.post('/api/config/udpxy-servers', (req, res) => {
    const { servers, currentId } = req.body || {};
    const list = Array.isArray(servers) ? servers : [];
    writeJson(CFG_UDPXY, { servers: list, currentId: typeof currentId === 'string' ? currentId : '' });
    res.json({ success: true });
});
app.get('/api/config/group-titles', (req, res) => {
    const cfg = readJson(CFG_GROUPS, { titles: settings.groupTitles });
    const raw = Array.isArray(cfg.titles) ? cfg.titles : [];
    const titlesObj = raw.map(x => {
        if (typeof x === 'string') return { name: x, color: '' };
        return { name: x && x.name ? x.name : '鏈懡鍚嶅垎缁?, color: x && x.color ? x.color : '' };
    }).filter(x => x.name);
    const titles = titlesObj.map(x => x.name);
    res.json({ success: true, titles, titlesObj });
});
app.post('/api/config/group-titles', (req, res) => {
    const { titles, titlesObj } = req.body || {};
    let listObj = Array.isArray(titlesObj) ? titlesObj.map(x => ({
        name: x && x.name ? x.name : '鏈懡鍚嶅垎缁?,
        color: x && x.color ? x.color : ''
    })).filter(x => x.name) : [];
    if (listObj.length === 0) {
        const names = Array.isArray(titles) ? titles : [];
        listObj = names.filter(n => typeof n === 'string' && n).map(n => ({ name: n, color: '' }));
    }
    writeJson(CFG_GROUPS, { titles: listObj });
    settings.groupTitles = listObj.map(x => x.name);
    res.json({ success: true });
});
app.get('/api/config/group-rules', (req, res) => {
    const cfg = readJson(CFG_GROUP_RULES, { rules: [] });
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    const normalized = rules.map(r => ({
        name: r && r.name ? r.name : '',
        matchers: Array.isArray(r && r.matchers) ? r.matchers : []
    })).filter(x => x.name);
    res.json({ success: true, rules: normalized });
});
app.post('/api/config/group-rules', (req, res) => {
    const { rules } = req.body || {};
    const list = Array.isArray(rules) ? rules.map(r => ({
        name: r && r.name ? r.name : '',
        matchers: Array.isArray(r && r.matchers) ? r.matchers.map(m => ({
            field: m && m.field ? m.field : 'name',
            op: m && m.op ? m.op : 'contains',
            value: m && m.value ? String(m.value) : ''
        })).filter(m => m.value) : []
    })).filter(x => x.name) : [];
    writeJson(CFG_GROUP_RULES, { rules: list });
    res.json({ success: true });
});
app.get('/api/settings', (req, res) => {
    res.json({ success: true, settings });
});
app.post('/api/settings/update', (req, res) => {
    const { fccServers, logoTemplate, groupTitles, globalFcc: gf, externalUrl, internalUrl, useInternal, useExternal, securityToken, enableToken, proxyList } = req.body || {};
    if (Array.isArray(fccServers)) settings.fccServers = fccServers;
    if (typeof logoTemplate === 'string') settings.logoTemplate = logoTemplate;
    if (Array.isArray(groupTitles)) settings.groupTitles = groupTitles;
    if (typeof externalUrl === 'string') settings.externalUrl = externalUrl;
    if (typeof internalUrl === 'string') settings.internalUrl = internalUrl;
    if (typeof useInternal === 'boolean') settings.useInternal = useInternal;
    if (typeof useExternal === 'boolean') settings.useExternal = useExternal;
    if (typeof securityToken === 'string') settings.securityToken = securityToken;
    if (typeof enableToken === 'boolean') settings.enableToken = enableToken;
    if (typeof externalUrl === 'string' || typeof internalUrl === 'string' || typeof useInternal === 'boolean' || typeof useExternal === 'boolean' || typeof securityToken === 'string' || typeof enableToken === 'boolean') {
        writeJson(CFG_APPSET, {
            useInternal: settings.useInternal,
            useExternal: settings.useExternal,
            internalUrl: settings.internalUrl,
            externalUrl: settings.externalUrl,
            securityToken: settings.securityToken,
            enableToken: settings.enableToken
        });
    }
    if (Array.isArray(proxyList)) {
        settings.proxyList = proxyList.map(x => ({
            type: normalizeProxyType(x && x.type),
            url: x && x.url ? x.url.trim() : ''
        })).filter(x => !!x.url);
        writeJson(CFG_PROXY, { list: settings.proxyList });
    }
    if (typeof gf === 'string') {
        globalFcc = gf;
        settings.globalFcc = gf;
        const val = gf.includes('=') ? gf : `fcc=${gf}`;
        multicastList = multicastList.map(s => ({ ...s, httpParam: val }));
    }
    res.json({ success: true, settings });
});
app.post('/api/settings/rename-group', (req, res) => {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ success: false, message: '缂哄皯鍒嗙粍鍚嶇О' });
    let updated = 0;
    multicastList = multicastList.map(s => {
        if ((s.groupTitle || '') === from) {
            updated++;
            return { ...s, groupTitle: to };
        }
        return s;
    });
    if (Array.isArray(settings.groupTitles)) {
        const idx = settings.groupTitles.findIndex(g => g === from);
        if (idx !== -1) settings.groupTitles[idx] = to;
    }
    res.json({ success: true, updated, groupTitles: settings.groupTitles });
});

// 浠ｇ悊鍒楄〃閰嶇疆
app.get('/api/config/proxies', (req, res) => {
    const cfg = readJson(CFG_PROXY, { list: settings.proxyList });
    res.json({ success: true, list: Array.isArray(cfg.list) ? cfg.list : [] });
});
app.post('/api/config/proxies', (req, res) => {
    const { list } = req.body || {};
    const arr = Array.isArray(list) ? list.map(x => ({
        type: normalizeProxyType(x && x.type),
        url: x && x.url ? x.url.trim() : ''
    })).filter(x => !!x.url) : [];
    writeJson(CFG_PROXY, { list: arr });
    settings.proxyList = arr;
    res.json({ success: true });
});

app.get('/api/config/app-settings', (req, res) => {
    const cfg = readJson(CFG_APPSET, {
        useInternal: settings.useInternal,
        useExternal: settings.useExternal,
        internalUrl: settings.internalUrl,
        externalUrl: settings.externalUrl,
        securityToken: settings.securityToken,
        enableToken: settings.enableToken
    });
    res.json({ success: true, appSettings: cfg });
});
app.post('/api/config/app-settings', (req, res) => {
    const { useInternal, useExternal, internalUrl, externalUrl, securityToken, enableToken } = req.body || {};
    if (typeof useInternal === 'boolean') settings.useInternal = useInternal;
    if (typeof useExternal === 'boolean') settings.useExternal = useExternal;
    if (typeof internalUrl === 'string') settings.internalUrl = internalUrl.trim();
    if (typeof externalUrl === 'string') settings.externalUrl = externalUrl.trim();
    if (typeof securityToken === 'string') settings.securityToken = securityToken.trim();
    if (typeof enableToken === 'boolean') settings.enableToken = enableToken;
    writeJson(CFG_APPSET, {
        useInternal: settings.useInternal,
        useExternal: settings.useExternal,
        internalUrl: settings.internalUrl,
        externalUrl: settings.externalUrl,
        securityToken: settings.securityToken,
        enableToken: settings.enableToken
    });
    res.json({ success: true });
});
app.get('/api/config/epg-sources', (req, res) => {
    const cfg = readJson(CFG_EPG, { sources: [] });
    const list = Array.isArray(cfg.sources) ? cfg.sources : [];
    const normalized = list.map(x => ({
        id: x && x.id ? x.id : ('epg-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
        name: x && x.name ? x.name : '鏈懡鍚岴PG',
        url: x && x.url ? x.url : '',
        scope: (x && x.scope === '澶栫綉' || x && x.scope === '澶栫綉EPG') ? '澶栫綉EPG' : '鍐呯綉EPG'
    })).filter(x => !!x.url);
    res.json({ success: true, sources: normalized });
});
app.post('/api/config/epg-sources', (req, res) => {
    const { sources } = req.body || {};
    const list = Array.isArray(sources) ? sources.map(x => ({
        id: x && x.id ? x.id : ('epg-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
        name: x && x.name ? x.name : '鏈懡鍚岴PG',
        url: x && x.url ? x.url : '',
        scope: (x && x.scope === '澶栫綉EPG') ? '澶栫綉EPG' : '鍐呯綉EPG'
    })).filter(x => !!x.url) : [];
    writeJson(CFG_EPG, { sources: list });
    res.json({ success: true });
});

const epgCache = new Map();
function parseXmltvDatetime(s) {
    const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+\-]\d{4}|Z))?$/);
    if (!m) return null;
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
    const hh = parseInt(m[4], 10), mm = parseInt(m[5], 10), ss = parseInt(m[6], 10);
    let dt = Date.UTC(y, mo, d, hh, mm, ss);
    const tz = m[7] || null;
    if (tz && tz !== 'Z') {
        const sign = tz.startsWith('-') ? -1 : 1;
        const offH = parseInt(tz.slice(1, 3), 10);
        const offM = parseInt(tz.slice(3, 5), 10);
        const off = sign * (offH * 60 + offM) * 60 * 1000;
        dt -= off;
    }
    return new Date(dt).getTime();
}
function epgFileFor(id) {
    ensureEpgDir();
    const safe = String(id || 'default').replace(/[^a-zA-Z0-9_\-]/g, '');
    return path.join(EPG_DIR, `${safe}.xml`);
}
async function fetchAndStoreXmltv(id, url) {
    ensureEpgDir();
    const resp = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    if (resp.status < 200 || resp.status >= 300) throw new Error('fetch epg failed');
    const buf = Buffer.from(resp.data);
    const ctype = (resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type'])) || '';
    const isGz = /\.gz($|\?)/i.test(url) || /gzip/i.test(String(ctype));
    let xml = null;
    try {
        if (isGz) {
            xml = zlib.gunzipSync(buf).toString('utf-8');
        } else {
            xml = buf.toString('utf-8');
        }
    } catch (e) {
        // 鍥為€€锛氬綋鏍囪瘑涓篻z浣嗛潪gz鍐呭鏃讹紝鐩存帴鎸夋枃鏈鐞?
        xml = buf.toString('utf-8');
    }
    const file = epgFileFor(id);
    fs.writeFileSync(file, xml, 'utf-8');
    return file;
}
function parseXmlFile(file) {
    const xml = fs.readFileSync(file, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const data = parser.parse(xml);
    const tv = data && (data.tv || data.TV || data.xmltv) ? (data.tv || data.TV || data.xmltv) : data;
    const channels = Array.isArray(tv && tv.channel) ? tv.channel : (tv && tv.channel ? [tv.channel] : []);
    const programmes = Array.isArray(tv && tv.programme) ? tv.programme : (tv && tv.programme ? [tv.programme] : []);
    return { channels, programmes };
}
async function loadXmltvFromLocalOrRemote(source, maxAgeMs = 60 * 60 * 1000, forceRefresh = false) {
    const id = source.id || 'epg';
    const url = source.url;
    const now = Date.now();
    const cacheKey = `local:${id}`;

    if (!forceRefresh) {
        const cached = epgCache.get(cacheKey);
        if (cached && now - cached.ts < maxAgeMs) return cached.data;
    }

    const f = epgFileFor(id);
    let needRefresh = true;

    if (!forceRefresh) {
        try {
            if (fs.existsSync(f)) {
                const stat = fs.statSync(f);
                if (now - stat.mtimeMs < maxAgeMs) needRefresh = false;
            }
        } catch (e) { }
    }

    if (needRefresh) {
        try {
            await fetchAndStoreXmltv(id, url);
        } catch (e) {
            // 濡傛灉杩滅澶辫触涓旀湰鍦板瓨鍦ㄦ棫鏂囦欢锛屽垯缁х画鐢ㄦ棫鏂囦欢
        }
    }
    if (!fs.existsSync(f)) throw new Error('no epg file');
    const norm = parseXmlFile(f);
    epgCache.set(cacheKey, { ts: now, data: norm });
    return norm;
}

function formatUtc(dt, fmt) {
    const d = new Date(dt);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const y = d.getUTCFullYear();
    const M = pad(d.getUTCMonth() + 1);
    const D = pad(d.getUTCDate());
    const H = pad(d.getUTCHours());
    const m = pad(d.getUTCMinutes());
    const s = pad(d.getUTCSeconds());
    if (fmt === 'yyyyMMddHHmmss') return `${y}${M}${D}${H}${m}${s}`;
    if (fmt === 'yyyy-MM-ddTHH:mm:ssZ') return `${y}-${M}-${D}T${H}:${m}:${s}Z`;
    if (fmt === 'HH:mm:ss') return `${H}:${m}:${s}`;
    if (fmt === 'unix_s') return Math.floor(d.getTime() / 1000).toString();
    if (fmt === 'unix_ms') return d.getTime().toString();
    return `${y}${M}${D}${H}${m}${s}`;
}

app.get('/api/epg/programs', async (req, res) => {
    try {
        const scope = String(req.query.scope || 'internal').toLowerCase();
        const channelId = String(req.query.channelId || '').trim();
        const channelName = String(req.query.channelName || '').trim();
        const dateStr = String(req.query.date || '').trim();
        const epgId = String(req.query.epgId || '').trim();
        const forceRefresh = String(req.query.refresh || '') === 'true';

        const defEpg = { sources: [] };
        const epgCfg = readJson(CFG_EPG, defEpg);
        const epgListRaw = Array.isArray(epgCfg.sources) ? epgCfg.sources : [];
        const epgList = epgListRaw.map(x => ({
            id: x && x.id ? x.id : ('epg-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
            name: x && x.name ? x.name : '鏈懡鍚岴PG',
            url: x && x.url ? x.url : '',
            scope: (x && x.scope === '澶栫綉' || x && x.scope === '澶栫綉EPG') ? '澶栫綉EPG' : '鍐呯綉EPG'
        })).filter(x => x.url);

        let pick = null;
        if (epgId) {
            pick = epgList.find(x => x.id === epgId) || null;
        }
        if (!pick) {
            pick = (scope === 'external' ? (epgList.find(x => x.scope === '澶栫綉EPG') || null) : (epgList.find(x => x.scope === '鍐呯綉EPG') || null)) || null;
        }

        if (!pick) return res.json({ success: true, programs: [], channel: null, message: 'No EPG source found' });

        const tv = await loadXmltvFromLocalOrRemote(pick, 60 * 60 * 1000, forceRefresh);
        const chans = tv.channels || [];
        const progs = tv.programmes || [];
        let ch = null;
        if (channelId) ch = chans.find(c => String(c && c['@_id']).trim() === channelId) || null;
        if (!ch && channelName) {
            const nm = String(channelName).trim();
            // 浼樺寲鍖归厤閫昏緫锛氱粺涓€杞ぇ鍐欙紝鍘婚櫎闈炲瓧姣嶆暟瀛椾腑鏂囷紝鍘婚櫎楂樻竻/4K/棰戦亾绛夊父瑙佸悗缂€
            const normalize = s => String(s || '').trim().toUpperCase()
                .replace(/HD/g, '')
                .replace(/4K/g, '')
                .replace(/楂樻竻/g, '')
                .replace(/棰戦亾/g, '')
                .replace(/[^A-Z0-9\u4e00-\u9fa5]/g, '');
            const target = normalize(nm);

            ch = chans.find(c => {
                const arr = [];
                if (Array.isArray(c['display-name'])) arr.push(...c['display-name']);
                if (c['display-name'] && typeof c['display-name'] === 'object' && c['display-name']['#text']) arr.push(c['display-name']['#text']);
                const names = arr.map(x => (typeof x === 'string') ? x : (x && x['#text'] ? x['#text'] : '')).filter(Boolean);
                return names.some(n => normalize(n) === target);
            }) || null;
        }
        const chId = ch ? String(ch['@_id'] || '').trim() : (channelId || '');
        const day = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
        const startDay = day.getTime();
        const endDay = startDay + 24 * 60 * 60 * 1000;
        const list = progs.filter(p => {
            if (chId && String(p['@_channel'] || '').trim() !== chId) return false;
            const st = parseXmltvDatetime(p['@_start']);
            const en = parseXmltvDatetime(p['@_stop'] || p['@_end'] || '');
            if (st == null) return false;
            const e = en != null ? en : (st + 60 * 60 * 1000);
            return !(e <= startDay || st >= endDay);
        }).map(p => {
            const st = parseXmltvDatetime(p['@_start']);
            const en = parseXmltvDatetime(p['@_stop'] || p['@_end'] || '');
            let title = '';
            if (typeof p.title === 'string') title = p.title;
            else if (Array.isArray(p.title)) title = p.title.map(x => (typeof x === 'string') ? x : (x && x['#text'] ? x['#text'] : '')).filter(Boolean)[0] || '';
            else if (p.title && p.title['#text']) title = p.title['#text'];
            let desc = '';
            if (typeof p.desc === 'string') desc = p.desc;
            else if (Array.isArray(p.desc)) desc = p.desc.map(x => (typeof x === 'string') ? x : (x && x['#text'] ? x['#text'] : '')).filter(Boolean)[0] || '';
            else if (p.desc && p.desc['#text']) desc = p.desc['#text'];
            return { startMs: st, endMs: en != null ? en : (st + 3600000), title, desc };
        }).sort((a, b) => a.startMs - b.startMs);
        res.json({ success: true, channel: ch ? { id: chId, names: ch['display-name'] } : null, programs: list, epgName: pick.name, epgId: pick.id });
    } catch (e) {
        res.json({ success: true, channel: null, programs: [] });
    }
});
app.post('/api/epg/refresh', async (req, res) => {
    try {
        const { scope, id } = req.body || {};
        const defEpg = { sources: [] };
        const epgCfg = readJson(CFG_EPG, defEpg);
        const epgListRaw = Array.isArray(epgCfg.sources) ? epgCfg.sources : [];
        const epgList = epgListRaw.map(x => ({
            id: x && x.id ? x.id : ('epg-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
            name: x && x.name ? x.name : '鏈懡鍚岴PG',
            url: x && x.url ? x.url : '',
            scope: (x && x.scope === '澶栫綉' || x && x.scope === '澶栫綉EPG') ? '澶栫綉EPG' : '鍐呯綉EPG'
        })).filter(x => x.url);
        let targets = epgList;
        if (typeof scope === 'string') {
            if (scope.toLowerCase() === 'internal') targets = epgList.filter(x => x.scope === '鍐呯綉EPG');
            else if (scope.toLowerCase() === 'external') targets = epgList.filter(x => x.scope === '澶栫綉EPG');
        }
        if (typeof id === 'string' && id) {
            const t = epgList.find(x => x.id === id);
            targets = t ? [t] : [];
        }
        const results = [];
        for (const s of targets) {
            try {
                const f = await fetchAndStoreXmltv(s.id, s.url);
                results.push({ id: s.id, ok: true, file: path.basename(f) });
            } catch (e) {
                results.push({ id: s.id, ok: false, error: 'fetch failed' });
            }
        }
        res.json({ success: true, results });
    } catch (e) {
        res.json({ success: false, message: 'refresh error' });
    }
});
app.get('/api/catchup/play', (req, res) => {
    const scope = String(req.query.scope || 'internal').toLowerCase();
    const fmt = String(req.query.fmt || 'iso8601').toLowerCase();
    const proto = String(req.query.proto || 'http').toLowerCase();
    const name = String(req.query.name || '').trim();
    const tvgName = String(req.query.tvgName || '').trim();
    const resolution = String(req.query.resolution || '').trim();
    const frameRate = String(req.query.frameRate || '').trim();
    const multicastUrl = String(req.query.multicastUrl || '').trim();
    const catchupBase = String(req.query.catchupBase || '').trim();
    const startMs = parseInt(String(req.query.startMs || ''), 10);
    const endMs = parseInt(String(req.query.endMs || ''), 10);
    if (!(startMs > 0 && endMs > 0 && endMs > startMs)) return res.status(400).json({ success: false, message: 'invalid time' });
    let unicastBase = '';
    const u = multicastUrl;
    const scheme = u ? u.split(':')[0].toLowerCase() : '';
    const isMulti = !!u && (scheme === 'rtp' || scheme === 'udp');
    if (u && !isMulti && isHttpUrl(u)) {
        unicastBase = buildUnicastCatchupBase(scope, u, proto);
    } else {
        const nm = tvgName || name || '';
        const match = findUnicastMatchByMeta(nm, resolution, frameRate);
        if (match && isHttpUrl(match.multicastUrl)) {
            unicastBase = buildUnicastCatchupBase(scope, match.multicastUrl || '', proto);
        }
    }
    if (!unicastBase && catchupBase && fmt === 'default') {
        let cb = catchupBase;
        if (scope === 'external') {
            const proxyBase = getProxyByType('鍗曟挱浠ｇ悊');
            let pb = proxyBase && proxyBase.url ? proxyBase.url : '';
            if (pb && !/^https?:\/\//i.test(pb)) pb = 'http://' + pb.replace(/^\/+/, '');
            if (pb) cb = pb + cb;
        }
        unicastBase = cb;
    }
    if (!unicastBase) return res.json({ success: false, message: 'no unicast base' });
    let url = unicastBase;
    if (fmt === 'ku9') {
        const b = formatUtc(startMs, 'yyyyMMddHHmmss');
        const e = formatUtc(endMs, 'yyyyMMddHHmmss');
        url += `?starttime=${b.slice(0, 8)}T${b.slice(8)}&endtime=${e.slice(0, 8)}T${e.slice(8)}`;
    } else if (fmt === 'mytv') {
        const b = formatUtc(startMs, 'yyyyMMddHHmmss');
        const e = formatUtc(endMs, 'yyyyMMddHHmmss');
        url += `?starttime=${b}&endtime=${e}`;
    } else if (fmt === 'playseek') {
        const b = formatUtc(startMs, 'yyyyMMddHHmmss');
        const e = formatUtc(endMs, 'yyyyMMddHHmmss');
        url += `?playseek=${b}-${e}`;
    } else if (fmt === 'startend14') {
        const b = formatUtc(startMs, 'yyyyMMddHHmmss');
        const e = formatUtc(endMs, 'yyyyMMddHHmmss');
        url += `?starttime=${b}&endtime=${e}`;
    } else if (fmt === 'beginend14') {
        const b = formatUtc(startMs, 'yyyyMMddHHmmss');
        const e = formatUtc(endMs, 'yyyyMMddHHmmss');
        url += `?begin=${b}&end=${e}`;
    } else if (fmt === 'iso8601') {
        const b = formatUtc(startMs, 'yyyy-MM-ddTHH:mm:ssZ');
        const e = formatUtc(endMs, 'yyyy-MM-ddTHH:mm:ssZ');
        url += `?start=${encodeURIComponent(b)}&end=${encodeURIComponent(e)}`;
    } else if (fmt === 'npt' || fmt === 'rtsp_range') {
        const b = formatUtc(startMs, 'HH:mm:ss');
        const e = formatUtc(endMs, 'HH:mm:ss');
        url += `?npt=${b}-${e}`;
    } else if (fmt === 'unix_s') {
        const b = formatUtc(startMs, 'unix_s');
        const e = formatUtc(endMs, 'unix_s');
        url += `?start=${b}&end=${e}`;
    } else if (fmt === 'unix_ms') {
        const b = formatUtc(startMs, 'unix_ms');
        const e = formatUtc(endMs, 'unix_ms');
        url += `?start=${b}&end=${e}`;
    }
    res.json({ success: true, url });
});
// 绠€鍗曟祦浠ｇ悊锛堢敤浜嶩LS鎾斁璺ㄥ煙缁曡繃锛?
app.get('/api/proxy/stream', async (req, res) => {
    try {
        const url = String(req.query.url || '').trim();
        if (!/^https?:\/\//i.test(url)) {
            return res.status(400).send('invalid url');
        }
        const hdrs = {};
        ['range', 'referer', 'user-agent', 'origin', 'accept', 'accept-encoding', 'accept-language', 'cookie'].forEach(h => {
            const v = req.headers[h];
            if (v) hdrs[h] = v;
        });
        const resp = await axios.get(url, { responseType: 'stream', headers: hdrs, validateStatus: () => true });
        res.status(resp.status);
        const ct = resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type']);
        if (ct) res.set('Content-Type', ct);
        const ar = resp.headers && (resp.headers['accept-ranges'] || resp.headers['Accept-Ranges']);
        if (ar) res.set('Accept-Ranges', ar);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Expose-Headers', '*');
        resp.data.pipe(res);
    } catch (e) {
        res.status(502).send('proxy error');
    }
});
function rewriteHlsPlaylist(content, baseUrl) {
    const lines = String(content || '').split(/\r?\n/);
    const toAbs = (p) => {
        try { return new URL(p, baseUrl).href; } catch (e) { return p; }
    };
    const rewriteAttrUri = (line) => {
        const m = line.match(/URI="([^"]+)"/i);
        if (!m) return line;
        const abs = toAbs(m[1]);
        const isM3u8 = /\.m3u8(\?|$)/i.test(abs);
        const prox = (isM3u8 ? '/api/proxy/hls?url=' : '/api/proxy/stream?url=') + encodeURIComponent(abs);
        return line.replace(/URI="([^"]+)"/i, 'URI="' + prox + '"');
    };
    const out = lines.map(l => {
        const t = l.trim();
        if (!t) return l;
        if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) {
            return rewriteAttrUri(l);
        }
        if (t.startsWith('#')) return l;
        const abs = toAbs(t);
        const isM3u8 = /\.m3u8(\?|$)/i.test(abs);
        return (isM3u8 ? '/api/proxy/hls?url=' : '/api/proxy/stream?url=') + encodeURIComponent(abs);
    });
    return out.join('\n');
}
app.get('/api/proxy/hls', async (req, res) => {
    try {
        const url = String(req.query.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return res.status(400).send('invalid url');
        const hdrs = {};
        ['referer', 'user-agent', 'origin', 'accept', 'accept-language', 'cookie'].forEach(h => {
            const v = req.headers[h];
            if (v) hdrs[h] = v;
        });
        const resp = await axios.get(url, { responseType: 'arraybuffer', headers: hdrs, validateStatus: () => true });
        if (resp.status < 200 || resp.status >= 300) {
            res.status(resp.status).send(String(resp.data || ''));
            return;
        }
        let text = Buffer.from(resp.data).toString('utf-8');
        const enc = (resp.headers && (resp.headers['content-encoding'] || resp.headers['Content-Encoding'])) || '';
        if (/gzip/i.test(enc)) {
            try { text = zlib.gunzipSync(Buffer.from(resp.data)).toString('utf-8'); } catch (e) { }
        }
        const body = rewriteHlsPlaylist(text, url);
        res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.set('Access-Control-Allow-Origin', '*');
        res.send(body);
    } catch (e) {
        res.status(502).send('proxy hls error');
    }
});

// 绯荤粺淇℃伅鎺ュ彛
app.get('/api/system/info', (req, res) => {
    // 绠€鍗曞垽鏂槸鍚﹀湪Docker瀹瑰櫒涓細妫€鏌?/.dockerenv 鏂囦欢
    const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
    res.json({
        success: true,
        version: packageJson.version,
        author: 'cgg888', // 鏆傛椂纭紪鐮侊紝涔熷彲浠ヤ粠 package.json 鑾峰彇
        isDocker
    });
});

// 绯荤粺鏇存柊鎺ュ彛
app.post('/api/system/update', (req, res) => {
    logger.info('鏀跺埌绯荤粺鏇存柊璇锋眰');
    // 绠€鍗曞垽鏂槸鍚﹀湪Docker瀹瑰櫒涓?
    const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
    // 妫€鏌ユ槸鍚︽寕杞戒簡 .git 鐩綍锛堝紑鍙戞ā寮忥級
    const hasGit = fs.existsSync(path.join(__dirname, '../.git'));

    if (isDocker && !hasGit) {
        logger.warn('Docker鐜鏃?git鎸傝浇锛屾棤娉曡嚜鍔ㄦ洿鏂?);
        return res.json({ success: false, message: 'Docker 鐜璇锋墜鍔ㄦ媺鍙栨柊闀滃儚鏇存柊锛歞ocker-compose pull && docker-compose up -d' });
    }

    // 鏈湴婧愮爜鏇存柊锛氭墽琛?git pull
    // 娉ㄦ剰锛氶渶瑕佺郴缁熷畨瑁呬簡 git锛屼笖褰撳墠鐩綍鏄?git 浠撳簱
    exec('git pull', { cwd: path.join(__dirname, '../') }, (error, stdout, stderr) => {
        if (error) {
            logger.error(`鏇存柊澶辫触: ${error}`);
            return res.json({ success: false, message: `鏇存柊澶辫触: ${error.message}` });
        }
        logger.info(`git pull output: ${stdout}`);
        // 鏇存柊鎴愬姛鍚庯紝鐞嗚涓婇渶瑕侀噸鍚湇鍔°€?
        // 杩欓噷杩斿洖鎴愬姛锛岀敱鍓嶇鎻愮ず鐢ㄦ埛閲嶅惎鎴栧埛鏂?
        res.json({ success: true, message: '鏇存柊鎴愬姛锛岃鎵嬪姩閲嶅惎鏈嶅姟鐢熸晥锛乗n' + stdout });
    });
});

// 鎻愪緵鍓嶇椤甸潰
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/results', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/results.html'));
});

// 鍏ㄥ眬閿欒澶勭悊
app.use((err, req, res, next) => {
    logger.error(`鏈崟鑾峰紓甯? ${err.stack}`);
    res.status(500).json({ success: false, message: '鏈嶅姟鍣ㄥ唴閮ㄩ敊璇? });
});

app.listen(port, () => {
    logger.info(`鏈嶅姟鍣ㄥ惎鍔ㄦ垚鍔燂紝杩愯鍦?http://localhost:${port}`);
});
