const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const axios = require('axios');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');
const streamService = require('../services/streamService');

const DATA_DIR = path.join(__dirname, '../../data');
const CFG_LOGO = path.join(DATA_DIR, 'logo_templates.json');
const CFG_FCC = path.join(DATA_DIR, 'fcc_servers.json');
const CFG_UDPXY = path.join(DATA_DIR, 'udpxy_servers.json');
const CFG_GROUPS = path.join(DATA_DIR, 'group_titles.json');
const CFG_GROUP_RULES = path.join(DATA_DIR, 'group_rules.json');
const CFG_EPG = path.join(DATA_DIR, 'epg_sources.json');
const CFG_PROXY = path.join(DATA_DIR, 'proxy_servers.json');
const CFG_APPSET = path.join(DATA_DIR, 'app_settings.json');
const EPG_DIR = path.join(DATA_DIR, 'epg');

async function ensureDataDir() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
}
function readJson(file, defObj) {
    try {
        if (fsSync.existsSync(file)) {
            const txt = fsSync.readFileSync(file, 'utf-8');
            return JSON.parse(txt);
        }
    } catch (e) { }
    return defObj;
}
async function writeJson(file, obj) {
    await ensureDataDir();
    try {
        await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error('写入失败', file);
        return false;
    }
}

function normalizeProxyType(t) {
    const v = String(t || '').trim();
    if (v === '代理' || v === '单播代理') return '单播代理';
    if (v === '外网' || v === '组播代理') return '组播代理';
    const low = v.toLowerCase();
    if (low === 'proxy') return '单播代理';
    if (low === 'external' || low === 'internet') return '组播代理';
    return '组播代理';
}

function ensureEpgDir() {
    try {
        if (!fs.existsSync(EPG_DIR)) fs.mkdirSync(EPG_DIR, { recursive: true });
    } catch (e) { }
}

let settings = streamService.settings;

router.get('/api/config/logo-templates', (req, res) => {
    const defId = 'ltpl-default';
    const cfg = readJson(CFG_LOGO, { templates: [{ id: defId, name: '默认模板', url: settings.logoTemplate }], currentId: defId });
    const listRaw = Array.isArray(cfg.templates) ? cfg.templates : [];
    const listObj = listRaw.map(t => {
        if (typeof t === 'string') {
            return { id: 'ltpl-' + require('crypto').randomUUID(), name: '未命名模板', url: t, category: '内网台标' };
        }
        return { id: t.id || ('ltpl-' + require('crypto').randomUUID()), name: t.name || '未命名模板', url: t.url || '', category: typeof t.category === 'string' ? (t.category === '内网' ? '内网台标' : (t.category === '外网' ? '外网台标' : t.category)) : '内网台标' };
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
router.post('/api/config/logo-templates', (req, res) => {
    const { templates, current, templatesObj, currentId } = req.body || {};
    let listObj = Array.isArray(templatesObj) ? templatesObj.map(t => ({
        id: t && t.id ? t.id : ('ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
        name: t && t.name ? t.name : '未命名模板',
        url: t && t.url ? t.url : '',
        category: t && typeof t.category === 'string' ? t.category : '鍐呯綉鍙版爣'
    })) : [];
    if (listObj.length === 0) {
        const listStr = Array.isArray(templates) ? templates : [];
        listObj = listStr.filter(u => typeof u === 'string' && u).map(u => ({
            id: 'ltpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36),
            name: '未命名模板',
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
router.get('/api/config/fcc-servers', (req, res) => {
    const cfg = readJson(CFG_FCC, { servers: settings.fccServers, currentId: '' });
    res.json({ success: true, servers: Array.isArray(cfg.servers) ? cfg.servers : [], currentId: cfg.currentId || '' });
});
router.post('/api/config/fcc-servers', (req, res) => {
    const { servers, currentId } = req.body || {};
    const list = Array.isArray(servers) ? servers : [];
    writeJson(CFG_FCC, { servers: list, currentId: typeof currentId === 'string' ? currentId : '' });
    settings.fccServers = list;
    res.json({ success: true });
});
router.get('/api/config/udpxy-servers', (req, res) => {
    const cfg = readJson(CFG_UDPXY, { servers: [], currentId: '' });
    res.json({ success: true, servers: Array.isArray(cfg.servers) ? cfg.servers : [], currentId: cfg.currentId || '' });
});
router.post('/api/config/udpxy-servers', (req, res) => {
    const { servers, currentId } = req.body || {};
    const list = Array.isArray(servers) ? servers : [];
    writeJson(CFG_UDPXY, { servers: list, currentId: typeof currentId === 'string' ? currentId : '' });
    res.json({ success: true });
});
router.get('/api/config/group-titles', (req, res) => {
    const cfg = readJson(CFG_GROUPS, { titles: settings.groupTitles });
    const raw = Array.isArray(cfg.titles) ? cfg.titles : [];
    const titlesObj = raw.map(x => {
        if (typeof x === 'string') return { name: x, color: '' };
        return { name: x && x.name ? x.name : '未命名分组', color: x && x.color ? x.color : '' };
    }).filter(x => x.name);
    const titles = titlesObj.map(x => x.name);
    res.json({ success: true, titles, titlesObj });
});
router.post('/api/config/group-titles', (req, res) => {
    const { titles, titlesObj } = req.body || {};
    let listObj = Array.isArray(titlesObj) ? titlesObj.map(x => ({
        name: x && x.name ? x.name : '未命名分组',
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
router.get('/api/config/group-rules', (req, res) => {
    const cfg = readJson(CFG_GROUP_RULES, { rules: [] });
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    const normalized = rules.map(r => ({
        name: r && r.name ? r.name : '',
        matchers: Array.isArray(r && r.matchers) ? r.matchers : []
    })).filter(x => x.name);
    res.json({ success: true, rules: normalized });
});
router.post('/api/config/group-rules', (req, res) => {
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
router.get('/api/settings', (req, res) => {
    res.json({ success: true, settings });
});
router.post('/api/settings/update', (req, res) => {
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
        settings.globalFcc = gf;
        const val = gf.includes('=') ? gf : `fcc=${gf}`;
        // 更新内存中的流列表参数
        streamService.setStreams(streamService.getStreams().map(s => ({ ...s, httpParam: val })));
    }
    res.json({ success: true, settings });
});
router.post('/api/settings/rename-group', (req, res) => {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ success: false, message: '缂哄皯鍒嗙bb缁勫鍚嶇О' });
    let updated = 0;
    const streams = streamService.getStreams();
    const newStreams = streams.map(s => {
        if ((s.groupTitle || '') === from) {
            updated++;
            return { ...s, groupTitle: to };
        }
        return s;
    });
    if (updated > 0) streamService.setStreams(newStreams);
    if (Array.isArray(settings.groupTitles)) {
        const idx = settings.groupTitles.findIndex(g => g === from);
        if (idx !== -1) settings.groupTitles[idx] = to;
    }
    res.json({ success: true, updated, groupTitles: settings.groupTitles });
});

// 浠ｇ悊鍒楄〃閰嶇疆
router.get('/api/config/proxies', (req, res) => {
    const cfg = readJson(CFG_PROXY, { list: settings.proxyList });
    res.json({ success: true, list: Array.isArray(cfg.list) ? cfg.list : [] });
});
router.post('/api/config/proxies', (req, res) => {
    const { list } = req.body || {};
    const arr = Array.isArray(list) ? list.map(x => ({
        type: normalizeProxyType(x && x.type),
        url: x && x.url ? x.url.trim() : ''
    })).filter(x => !!x.url) : [];
    writeJson(CFG_PROXY, { list: arr });
    settings.proxyList = arr;
    res.json({ success: true });
});

router.get('/api/config/app-settings', (req, res) => {
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
router.post('/api/config/app-settings', (req, res) => {
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
router.get('/api/config/epg-sources', (req, res) => {
    const cfg = readJson(CFG_EPG, { sources: [] });
    const list = Array.isArray(cfg.sources) ? cfg.sources : [];
    const normalized = list.map(x => ({
        id: x && x.id ? x.id : ('epg-' + require('crypto').randomUUID()),
        name: x && x.name ? x.name : '未命名EPG',
        url: x && x.url ? x.url : '',
        scope: (x && (x.scope === '外网' || x.scope === '外网EPG')) ? '外网EPG' : '内网EPG'
    })).filter(x => !!x.url);
    res.json({ success: true, sources: normalized });
});
router.post('/api/config/epg-sources', (req, res) => {
    const { sources } = req.body || {};
    const list = Array.isArray(sources) ? sources.map(x => ({
        id: x && x.id ? x.id : ('epg-' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
        name: x && x.name ? x.name : '未命名EPG',
        url: x && x.url ? x.url : '',
        scope: (x && x.scope === '澶栫綉EPG') ? '澶栫綉EPG' : '鍐呯綉EPG'
    })).filter(x => !!x.url) : [];
    writeJson(CFG_EPG, { sources: list });
    res.json({ success: true });
});





module.exports = router;
