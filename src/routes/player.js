const express = require('express');
const axios = require('axios');
const persistence = require('../services/persistenceService');
const streamService = require('../services/streamService');
const logger = require('../services/logService');
const { buildProxyPlaybackUrl } = require('../utils/streamUrl');

const router = express.Router();

function trimTrailingSlashes(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function stripLeadingHttpScheme(url) {
    return String(url || '').trim().replace(/^https?:\/\//i, '').replace(/^\/+/, '');
}

function normalizeProxyKind(type) {
    const text = String(type || '').trim();
    const lower = text.toLowerCase();
    if (text === '单播代理' || lower === 'proxy' || lower === 'single' || lower === 'singlecast' || lower === 'unicast') {
        return 'unicast';
    }
    if (text === '组播代理' || lower === 'external' || lower === 'internet' || lower === 'multicast') {
        return 'multicast';
    }
    return '';
}

function findProxyBase(settings, kind) {
    const list = Array.isArray(settings && settings.proxyList) ? settings.proxyList : [];
    const matched = list.find(item => normalizeProxyKind(item && item.type) === kind);
    return trimTrailingSlashes(matched && matched.url ? matched.url : '');
}

function buildSingleCastProxyUrl(rawUrl, proxyBase) {
    const base = trimTrailingSlashes(proxyBase);
    if (!base) return rawUrl;
    const stripped = stripLeadingHttpScheme(rawUrl);
    return stripped ? `${base}/${stripped}` : base;
}

function filterStreamsByStatus(streams, status) {
    if (!status || status === 'all') return streams;
    const wantOnline = status === 'ok' || status === 'online';
    return streams.filter(stream => !!stream.isAvailable === wantOnline);
}

function buildPlaybackUrlForScope(stream, scope, settings) {
    const rawUrl = String(stream.multicastUrl || '').trim();
    if (!rawUrl) return '';

    if (/^https?:\/\//i.test(rawUrl)) {
        if (scope === 'external') {
            return buildSingleCastProxyUrl(rawUrl, findProxyBase(settings, 'unicast'));
        }
        return rawUrl;
    }

    const baseUrl = scope === 'external'
        ? trimTrailingSlashes(findProxyBase(settings, 'multicast') || settings.externalUrl || '')
        : trimTrailingSlashes(settings.internalUrl || stream.udpxyUrl || '');

    return buildProxyPlaybackUrl(rawUrl, baseUrl);
}

function buildScopedExport(streams, scope, settings) {
    return streams.map(stream => ({
        ...stream,
        httpUrl: buildPlaybackUrlForScope(stream, scope, settings)
    }));
}

function normalizeLogoTemplate(item) {
    if (typeof item === 'string') {
        return { id: '', url: item, category: '内网台标' };
    }
    return {
        id: item && item.id ? String(item.id) : '',
        url: item && item.url ? String(item.url) : '',
        category: item && item.category ? String(item.category) : '内网台标'
    };
}

function pickLogoTemplate(cfg, scope) {
    const list = Array.isArray(cfg && cfg.templates) ? cfg.templates.map(normalizeLogoTemplate).filter(item => item.url) : [];
    if (list.length === 0) return null;

    const currentId = typeof cfg.currentId === 'string' ? cfg.currentId : '';
    const current = list.find(item => item.id === currentId) || null;
    if (scope === 'external') {
        return list.find(item => item.category === '外网台标') || current || list[0];
    }
    return current || list.find(item => item.category === '内网台标') || list[0];
}

router.post('/player/log', (req, res) => {
    try {
        const body = req.body || {};
        const name = String(body.name || body.tvgName || '').trim();
        const mode = String(body.mode || '').trim();
        const cast = String(body.cast || '').trim();
        const programTitle = String(body.programTitle || '').trim();
        const url = String(body.url || '').trim();
        const info = [
            name ? `频道: ${name}` : '',
            mode ? `类型: ${mode}` : '',
            cast ? `/${cast}` : '',
            programTitle ? `节目: ${programTitle}` : '',
            url ? `地址: ${url}` : ''
        ].filter(Boolean).join(' | ');
        if (info) logger.info(`播放日志 -> ${info}`);
        res.json({ success: true });
    } catch (_) {
        res.json({ success: false });
    }
});

router.get('/epg/programs', (req, res) => {
    res.json({ success: true, programs: [] });
});

router.post('/catchup/play', (req, res) => {
    res.json({ success: false, message: '时移功能暂未实现' });
});

router.get('/catchup/play', (req, res) => {
    res.json({ success: false, message: '时移功能暂未实现' });
});

router.get('/export/json', (req, res) => {
    const scope = String(req.query.scope || 'internal').trim().toLowerCase() === 'external' ? 'external' : 'internal';
    const settings = streamService.getSettings();
    if (scope === 'external' && settings.enableToken) {
        const token = String(req.query.token || '').trim();
        if (!token || token !== settings.securityToken) {
            return res.status(403).json({ success: false, message: 'Invalid token' });
        }
    }

    const status = String(req.query.status || 'all').trim().toLowerCase();
    const streams = filterStreamsByStatus(streamService.getAllStreams(), status);
    res.json({ success: true, streams: buildScopedExport(streams, scope, settings) });
});

router.get('/logo', async (req, res) => {
    try {
        const name = String(req.query.name || '').trim();
        const scope = String(req.query.scope || 'internal').trim().toLowerCase() === 'external' ? 'external' : 'internal';
        if (!name) return res.status(400).send('missing name');

        const cfg = await persistence.readJson('logo_templates.json', { templates: [] });
        const template = pickLogoTemplate(cfg, scope);
        if (!template || !template.url) return res.status(404).send('no template');

        const target = String(template.url).replace('{name}', encodeURIComponent(name));
        const response = await axios.get(target, {
            responseType: 'arraybuffer',
            validateStatus: () => true,
            headers: { 'User-Agent': 'IPTV-Checker/1.0' }
        });
        if (response.status < 200 || response.status >= 300) {
            return res.status(404).send('not found');
        }

        const contentType = response.headers['content-type'] || 'image/png';
        res.set('Cache-Control', 'public, max-age=604800');
        res.type(contentType);
        res.send(Buffer.from(response.data));
    } catch (_) {
        res.status(404).send('not found');
    }
});

router._internal = {
    trimTrailingSlashes,
    stripLeadingHttpScheme,
    normalizeProxyKind,
    findProxyBase,
    buildSingleCastProxyUrl,
    filterStreamsByStatus,
    buildPlaybackUrlForScope,
    buildScopedExport,
    normalizeLogoTemplate,
    pickLogoTemplate
};

module.exports = router;
