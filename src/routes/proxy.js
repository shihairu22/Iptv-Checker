const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const streamService = require('../services/streamService');

const router = express.Router();
const PROXY_SIGNING_SECRET = crypto.randomBytes(32).toString('hex');

function isPrivateIp(host) {
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.startsWith('169.254.')) return true;

    const parts = host.split('.').map(Number);
    if (parts.length === 4 && parts.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
        if (parts[0] === 10) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 0) return true;
    }

    if (host === '::1') return true;
    const lowerHost = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (lowerHost.startsWith('fe80:') || lowerHost.startsWith('fc') || lowerHost.startsWith('fd')) return true;
    return false;
}

function isUrlSafe(urlStr, options = {}) {
    const { allowPrivate = false } = options;
    try {
        const url = new URL(urlStr);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
        if (!allowPrivate && isPrivateIp(url.hostname)) return false;
        return true;
    } catch (_) {
        return false;
    }
}

function createProxySignature(urlValue) {
    return crypto
        .createHmac('sha256', PROXY_SIGNING_SECRET)
        .update(String(urlValue || ''))
        .digest('hex');
}

function hasValidProxySignature(urlValue, signature) {
    const expected = createProxySignature(urlValue);
    const provided = String(signature || '').trim();
    if (!provided || provided.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch (_) {
        return false;
    }
}

function isKnownProxyUrl(urlStr) {
    const target = String(urlStr || '').trim();
    if (!target) return false;
    const streams = streamService.getAllStreams();
    return streams.some((stream) => {
        return [
            stream && stream.multicastUrl,
            stream && stream.logo,
            stream && stream.catchupBase
        ].some((value) => String(value || '').trim() === target);
    });
}

function isProxyUrlAllowed(urlStr, signature) {
    if (isUrlSafe(urlStr)) return true;
    if (!isUrlSafe(urlStr, { allowPrivate: true })) return false;
    return hasValidProxySignature(urlStr, signature) || isKnownProxyUrl(urlStr);
}

function buildSignedProxyUrl(absUrl) {
    const isPlaylist = /\.m3u8($|\?)/i.test(absUrl);
    const endpoint = isPlaylist ? '/api/proxy/hls' : '/api/proxy/stream';
    const signature = createProxySignature(absUrl);
    return `${endpoint}?url=${encodeURIComponent(absUrl)}&sig=${signature}`;
}

function rewriteHlsPlaylist(text, streamUrl) {
    const baseUrl = new URL(streamUrl);

    const rewriteUri = (uri) => {
        const trimmed = uri.trim();
        if (!trimmed || trimmed.startsWith('#')) return uri;
        if (/^(data:|blob:|javascript:)/i.test(trimmed)) return uri;

        let absolute;
        try {
            absolute = new URL(trimmed, baseUrl).toString();
        } catch (_) {
            return uri;
        }
        if (!isUrlSafe(absolute, { allowPrivate: true })) return uri;
        return buildSignedProxyUrl(absolute);
    };

    return String(text || '')
        .split(/\r?\n/)
        .map((line) => {
            const withUriAttrs = line.replace(/URI="([^"]+)"/gi, (_, uriValue) => `URI="${rewriteUri(uriValue)}"`);
            if (withUriAttrs !== line) return withUriAttrs;
            if (line.startsWith('#')) return line;
            return rewriteUri(line);
        })
        .join('\n');
}

router.get('/proxy/stream', async (req, res) => {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).send('Missing url');
    if (!isProxyUrlAllowed(streamUrl, req.query.sig)) return res.status(403).send('URL not allowed');

    try {
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'stream',
            timeout: 10000,
            headers: { 'User-Agent': 'IPTV-Checker/1.0' }
        });
        res.setHeader('Content-Type', 'video/mp2t');
        response.data.pipe(res);
        res.on('close', () => {
            if (response.data.destroy) response.data.destroy();
        });
    } catch (_) {
        res.status(502).send('Proxy error');
    }
});

router.get('/proxy/hls', async (req, res) => {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).send('Missing url');
    if (!isProxyUrlAllowed(streamUrl, req.query.sig)) return res.status(403).send('URL not allowed');

    try {
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
                'User-Agent': 'IPTV-Checker/1.0',
                ...(req.headers.range ? { Range: req.headers.range } : {})
            },
            validateStatus: (status) => status >= 200 && status < 400
        });

        const upstreamType = String(response.headers['content-type'] || '').toLowerCase();
        const isM3u8 = streamUrl.includes('.m3u8') || upstreamType.includes('mpegurl') || upstreamType.includes('vnd.apple.mpegurl');

        if (isM3u8) {
            const text = Buffer.from(response.data).toString('utf8');
            const rewritten = rewriteHlsPlaylist(text, streamUrl);

            res.status(response.status);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(rewritten);
            return;
        }

        res.status(response.status);
        if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
        if (response.headers['accept-ranges']) res.setHeader('Accept-Ranges', response.headers['accept-ranges']);
        res.end(Buffer.from(response.data));
    } catch (_) {
        res.status(502).send('Proxy error');
    }
});

router.post('/fetch-text', async (req, res) => {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ success: false, message: 'Missing urls' });
    }

    const limited = urls.slice(0, 10);
    const results = await Promise.allSettled(limited.map(async (url) => {
        if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
            return { url, ok: false, error: 'Invalid URL' };
        }
        if (!isUrlSafe(url)) {
            return { url, ok: false, error: 'URL not allowed' };
        }
        try {
            const response = await axios.get(url, { timeout: 15000, responseType: 'text', maxContentLength: 5 * 1024 * 1024 });
            return { url, ok: true, text: response.data };
        } catch (_) {
            return { url, ok: false, error: 'Fetch failed' };
        }
    }));

    res.json({ success: true, results: results.map(result => result.value || result.reason) });
});

router._internal = {
    isPrivateIp,
    isUrlSafe,
    createProxySignature,
    hasValidProxySignature,
    isProxyUrlAllowed,
    buildSignedProxyUrl,
    rewriteHlsPlaylist
};

module.exports = router;
