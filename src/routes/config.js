const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const persistence = require('../services/persistenceService');
const streamService = require('../services/streamService');

// 配置文件名（由 persistenceService 统一管理读写）
const CFG_LOGO = 'logo_templates.json';
const CFG_FCC = 'fcc_servers.json';
const CFG_UDPXY = 'udpxy_servers.json';
const CFG_GROUPS = 'group_titles.json';
const CFG_GROUP_RULES = 'group_rules.json';
const CFG_EPG = 'epg_sources.json';
const CFG_PROXY = 'proxy_servers.json';
const CFG_APPSET = 'app_settings.json';

// 统一使用 persistenceService 的原子读写（自带写锁 + temp+rename）
async function readJson(file, defObj) {
    return await persistence.readJson(file, defObj);
}
async function writeJson(file, obj) {
    return await persistence.writeJson(file, obj);
}

function cleanText(value, maxLen = 256) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLen);
}

function cleanUrl(value, maxLen = 2048) {
    return cleanText(value, maxLen);
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

function createTempId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function normalizeLogoCategory(category, mapLegacy) {
    if (typeof category !== 'string') return '内网台标';
    if (!mapLegacy) return category;
    if (category === '内网') return '内网台标';
    if (category === '外网') return '外网台标';
    return category;
}

function normalizeLogoTemplateForRead(item) {
    if (typeof item === 'string') {
        return { id: 'ltpl-' + crypto.randomUUID(), name: '未命名模板', url: item, category: '内网台标' };
    }
    return {
        id: item && item.id ? item.id : ('ltpl-' + crypto.randomUUID()),
        name: item && item.name ? item.name : '未命名模板',
        url: item && item.url ? item.url : '',
        category: normalizeLogoCategory(item && item.category, true)
    };
}

function normalizeLogoTemplateForWrite(item) {
    const fixedId = cleanText(item && item.id, 96);
    return {
        id: fixedId || createTempId('ltpl'),
        name: cleanText(item && item.name, 128) || '未命名模板',
        url: cleanUrl(item && item.url),
        category: normalizeLogoCategory(item && item.category, false)
    };
}

function resolveCurrentItem(listObj, currentId, currentUrl, fallbackUrl) {
    let resolvedId = typeof currentId === 'string' ? currentId : '';
    if (!resolvedId && typeof currentUrl === 'string') {
        const matched = listObj.find(x => x.url === currentUrl);
        resolvedId = matched ? matched.id : '';
    }
    if (!resolvedId && listObj[0]) resolvedId = listObj[0].id;
    const item = listObj.find(x => x.id === resolvedId) || listObj[0] || null;
    return {
        currentId: resolvedId,
        currentItem: item,
        currentUrl: item ? item.url : fallbackUrl
    };
}

function normalizeGroupTitleForRead(item) {
    if (typeof item === 'string') return { name: item, color: '' };
    return { name: item && item.name ? item.name : '未命名分组', color: item && item.color ? item.color : '' };
}

function normalizeGroupTitleForWrite(item) {
    return {
        name: cleanText(item && item.name, 64) || '未命名分组',
        color: cleanText(item && item.color, 32)
    };
}

function normalizeProxyList(list) {
    return Array.isArray(list) ? list.map(x => ({
        type: normalizeProxyType(x && x.type),
        url: cleanUrl(x && x.url)
    })).filter(x => !!x.url) : [];
}

function normalizeEpgSourceForRead(item) {
    return {
        id: item && item.id ? item.id : ('epg-' + crypto.randomUUID()),
        name: item && item.name ? item.name : '未命名EPG',
        url: item && item.url ? item.url : '',
        scope: (item && item.scope === '外网EPG') ? '外网EPG' : '内网EPG'
    };
}

function normalizeEpgSourceForWrite(item) {
    const fixedId = cleanText(item && item.id, 96);
    return {
        id: fixedId || createTempId('epg'),
        name: cleanText(item && item.name, 128) || '未命名EPG',
        url: cleanUrl(item && item.url),
        scope: (item && item.scope === '外网EPG') ? '外网EPG' : '内网EPG'
    };
}

function applyAppSettingsPatch(payload) {
    const { useInternal, useExternal, internalUrl, externalUrl, securityToken, enableToken } = payload || {};
    let changed = false;

    if (typeof useInternal === 'boolean') {
        settings.useInternal = useInternal;
        changed = true;
    }
    if (typeof useExternal === 'boolean') {
        settings.useExternal = useExternal;
        changed = true;
    }
    if (typeof internalUrl === 'string') {
        settings.internalUrl = cleanUrl(internalUrl);
        changed = true;
    }
    if (typeof externalUrl === 'string') {
        settings.externalUrl = cleanUrl(externalUrl);
        changed = true;
    }
    if (typeof securityToken === 'string') {
        settings.securityToken = cleanText(securityToken, 256);
        changed = true;
    }
    if (typeof enableToken === 'boolean') {
        settings.enableToken = enableToken;
        changed = true;
    }

    return changed;
}

function getCurrentAppSettingsPayload() {
    return {
        useInternal: settings.useInternal,
        useExternal: settings.useExternal,
        internalUrl: settings.internalUrl,
        externalUrl: settings.externalUrl,
        securityToken: settings.securityToken,
        enableToken: settings.enableToken
    };
}

async function saveCurrentAppSettings() {
    return await writeJson(CFG_APPSET, getCurrentAppSettingsPayload());
}
// streamService.init() 现已改用 Object.assign，保持对象引用不变，直接使用即可
const settings = streamService.settings;

router.get('/api/config/logo-templates', async (req, res) => {
    const defId = 'ltpl-default';
    const cfg = await readJson(CFG_LOGO, { templates: [{ id: defId, name: '默认模板', url: settings.logoTemplate }], currentId: defId });
    const listRaw = Array.isArray(cfg.templates) ? cfg.templates : [];
    const listObj = listRaw.map(normalizeLogoTemplateForRead).filter(x => x.url);
    const current = resolveCurrentItem(listObj, cfg.currentId, cfg.current, settings.logoTemplate);
    const listStr = listObj.map(x => x.url);
    res.json({ success: true, templates: listStr, current: current.currentUrl, templatesObj: listObj, currentId: current.currentId });
});
router.post('/api/config/logo-templates', async (req, res) => {
    const { templates, current, templatesObj, currentId } = req.body || {};
    let listObj = Array.isArray(templatesObj) ? templatesObj.map(normalizeLogoTemplateForWrite) : [];
    if (listObj.length === 0) {
        const listStr = Array.isArray(templates) ? templates : [];
        listObj = listStr.filter(u => typeof u === 'string' && u).map(u => ({
            id: createTempId('ltpl'),
            name: '未命名模板',
            url: cleanUrl(u),
            category: '内网台标'
        }));
    }
    listObj = listObj.filter(x => x.url);
    const currentResolved = resolveCurrentItem(listObj, currentId, current, '');

    if (await writeJson(CFG_LOGO, { templates: listObj, currentId: currentResolved.currentId })) {
        settings.logoTemplate = currentResolved.currentUrl || settings.logoTemplate;
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});
router.get('/api/config/fcc-servers', async (req, res) => {
    const cfg = await readJson(CFG_FCC, { servers: settings.fccServers, currentId: '' });
    res.json({ success: true, servers: Array.isArray(cfg.servers) ? cfg.servers : [], currentId: cfg.currentId || '' });
});
router.post('/api/config/fcc-servers', async (req, res) => {
    const { servers, currentId } = req.body || {};
    const list = Array.isArray(servers) ? servers : [];
    if (await writeJson(CFG_FCC, { servers: list, currentId: typeof currentId === 'string' ? currentId : '' })) {
        settings.fccServers = list;
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});
router.get('/api/config/udpxy-servers', async (req, res) => {
    const cfg = await readJson(CFG_UDPXY, { servers: [], currentId: '' });
    res.json({ success: true, servers: Array.isArray(cfg.servers) ? cfg.servers : [], currentId: cfg.currentId || '' });
});
router.post('/api/config/udpxy-servers', async (req, res) => {
    const { servers, currentId } = req.body || {};
    const list = Array.isArray(servers) ? servers : [];
    if (await writeJson(CFG_UDPXY, { servers: list, currentId: typeof currentId === 'string' ? currentId : '' })) {
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});
router.get('/api/config/group-titles', async (req, res) => {
    const cfg = await readJson(CFG_GROUPS, { titles: settings.groupTitles });
    const raw = Array.isArray(cfg.titles) ? cfg.titles : [];
    const titlesObj = raw.map(normalizeGroupTitleForRead).filter(x => x.name);
    const titles = titlesObj.map(x => x.name);
    res.json({ success: true, titles, titlesObj });
});
router.post('/api/config/group-titles', async (req, res) => {
    const { titles, titlesObj } = req.body || {};
    let listObj = Array.isArray(titlesObj) ? titlesObj.map(normalizeGroupTitleForWrite).filter(x => x.name) : [];
    if (listObj.length === 0) {
        const names = Array.isArray(titles) ? titles : [];
        listObj = names.filter(n => typeof n === 'string' && n).map(n => ({ name: n, color: '' }));
    }
    if (await writeJson(CFG_GROUPS, { titles: listObj })) {
        settings.groupTitles = listObj.map(x => x.name);
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});
router.get('/api/config/group-rules', async (req, res) => {
    const cfg = await readJson(CFG_GROUP_RULES, { rules: [] });
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    const normalized = rules.map(r => ({
        name: r && r.name ? r.name : '',
        matchers: Array.isArray(r && r.matchers) ? r.matchers : []
    })).filter(x => x.name);
    res.json({ success: true, rules: normalized });
});
router.post('/api/config/group-rules', async (req, res) => {
    const { rules } = req.body || {};
    const list = Array.isArray(rules) ? rules.map(r => ({
        name: cleanText(r && r.name, 64),
        matchers: Array.isArray(r && r.matchers) ? r.matchers.map(m => ({
            field: cleanText(m && m.field, 24) || 'name',
            op: cleanText(m && m.op, 24) || 'contains',
            value: cleanText(m && m.value !== undefined ? String(m.value) : '', 256)
        })).filter(m => m.value) : []
    })).filter(x => x.name) : [];
    if (await writeJson(CFG_GROUP_RULES, { rules: list })) {
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});
router.get('/api/settings', (req, res) => {
    res.json({ success: true, settings });
});
router.post('/api/settings/update', async (req, res) => {
    const { fccServers, logoTemplate, groupTitles, globalFcc: gf, externalUrl, internalUrl, useInternal, useExternal, securityToken, enableToken, proxyList } = req.body || {};
    if (Array.isArray(fccServers)) settings.fccServers = fccServers;
    if (typeof logoTemplate === 'string') settings.logoTemplate = cleanUrl(logoTemplate);
    if (Array.isArray(groupTitles)) settings.groupTitles = groupTitles;
    const appSettingsChanged = applyAppSettingsPatch({ externalUrl, internalUrl, useInternal, useExternal, securityToken, enableToken });

    let ok = true;
    if (appSettingsChanged) {
        ok = await saveCurrentAppSettings();
    }

    if (Array.isArray(proxyList)) {
        settings.proxyList = normalizeProxyList(proxyList);
        const ok2 = await writeJson(CFG_PROXY, { list: settings.proxyList });
        ok = ok && ok2;
    }

    if (typeof gf === 'string') {
        settings.globalFcc = cleanText(gf, 256);
        const gfValue = settings.globalFcc;
        const val = gfValue.includes('=') ? gfValue : `fcc=${gfValue}`;
        // 更新内存中的流列表参数
        streamService.setStreams(streamService.getStreams().map(s => ({ ...s, httpParam: val })));
        const ok3 = await streamService.save();
        ok = ok && !!ok3;
    }

    if (ok) {
        res.json({ success: true, settings });
    } else {
        res.status(500).json({ success: false, message: '部分配置保存失败' });
    }
});
router.post('/api/settings/rename-group', async (req, res) => {
    const { from, to } = req.body || {};
    const fromName = cleanText(from, 64);
    const toName = cleanText(to, 64);
    if (!fromName || !toName) return res.status(400).json({ success: false, message: '缺少分组名称' });
    let updated = 0;
    const streams = streamService.getStreams();
    const newStreams = streams.map(s => {
        if ((s.groupTitle || '') === fromName) {
            updated++;
            return { ...s, groupTitle: toName };
        }
        return s;
    });
    if (updated > 0) {
        streamService.setStreams(newStreams);
        await streamService.save(); // 修复: 确保重命名后持久化
    }
    if (Array.isArray(settings.groupTitles)) {
        const idx = settings.groupTitles.findIndex(g => g === fromName);
        if (idx !== -1) settings.groupTitles[idx] = toName;
    }
    // 读取现有 group_titles.json，保留颜色等属性，只替换名称
    const existingGroupsCfg = await readJson(CFG_GROUPS, { titles: [] });
    const existingTitles = Array.isArray(existingGroupsCfg.titles) ? existingGroupsCfg.titles.map(normalizeGroupTitleForRead) : [];
    const mergedTitles = settings.groupTitles.map(name => {
        const existing = existingTitles.find(t => t.name === name);
        return existing ? existing : { name, color: '' };
    });
    await writeJson(CFG_GROUPS, { titles: mergedTitles });

    res.json({ success: true, updated, groupTitles: settings.groupTitles });
});

// 代理列表配置
router.get('/api/config/proxies', async (req, res) => {
    const cfg = await readJson(CFG_PROXY, { list: settings.proxyList });
    res.json({ success: true, list: Array.isArray(cfg.list) ? cfg.list : [] });
});
router.post('/api/config/proxies', async (req, res) => {
    const { list } = req.body || {};
    const arr = normalizeProxyList(list);
    if (await writeJson(CFG_PROXY, { list: arr })) {
        settings.proxyList = arr;
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});

router.get('/api/config/app-settings', async (req, res) => {
    const cfg = await readJson(CFG_APPSET, getCurrentAppSettingsPayload());
    res.json({ success: true, appSettings: cfg });
});
router.post('/api/config/app-settings', async (req, res) => {
    applyAppSettingsPatch(req.body || {});
    if (await saveCurrentAppSettings()) {
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});

router.get('/api/config/epg-sources', async (req, res) => {
    const cfg = await readJson(CFG_EPG, { sources: [] });
    const list = Array.isArray(cfg.sources) ? cfg.sources : [];
    const normalized = list.map(normalizeEpgSourceForRead);
    res.json({ success: true, sources: normalized });
});

router.post('/api/config/epg-sources', async (req, res) => {
    const { sources } = req.body || {};
    const list = Array.isArray(sources) ? sources.map(normalizeEpgSourceForWrite).filter(x => !!x.url) : [];
    if (await writeJson(CFG_EPG, { sources: list })) {
        res.json({ success: true });
    } else {
        res.status(500).json({ success: false, message: '保存配置失败' });
    }
});


module.exports = router;
