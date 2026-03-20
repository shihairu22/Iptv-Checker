const crypto = require('crypto');
const dns = require('dns').promises;
const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const axios = require('axios');
const persistence = require('../services/persistenceService');
const streamService = require('../services/streamService');

const router = express.Router();
const PROXY_SIGNING_SECRET = getProxySigningSecret();

function getProxySigningSecret() {
    const envSecret = String(process.env.PROXY_SIGNING_SECRET || '').trim();
    if (envSecret) return envSecret;
    try {
        const row = persistence.db.prepare("SELECT value FROM kv_store WHERE key='proxy_signing_secret'").get();
        if (row && row.value) return String(row.value);
        const generated = crypto.randomBytes(32).toString('hex');
        persistence.db.prepare("INSERT OR REPLACE INTO kv_store(key,value) VALUES('proxy_signing_secret',?)").run(generated);
        return generated;
    } catch (_) {
        return crypto.randomBytes(32).toString('hex');
    }
}

function normalizeHost(host) {
    return String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function isPrivateIp(host) {
    const normalized = normalizeHost(host);
    if (!normalized) return true;
    if (normalized === 'localhost') return true;
    if (normalized.startsWith('127.')) return true;
    if (normalized.startsWith('169.254.')) return true;
    if (normalized.startsWith('100.') || normalized.startsWith('0.')) {
        const parts = normalized.split('.').map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
            if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
            if (parts[0] === 0) return true;
        }
    }

    const parts = normalized.split('.').map(Number);
    if (parts.length === 4 && parts.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
        if (parts[0] === 10) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    }

    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
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

async function resolveHostRecords(host) {
    const normalized = normalizeHost(host);
    if (!normalized) return [];
    const family = net.isIP(normalized);
    if (family) {
        return [{ address: normalized, family }];
    }
    if (normalized === 'localhost') {
        return [{ address: '127.0.0.1', family: 4 }];
    }
    try {
        const records = await dns.lookup(normalized, { all: true, verbatim: true });
        return Array.isArray(records) ? records.filter(record => record && record.address) : [];
    } catch (_) {
        return [];
    }
}

async function isUrlSafeResolved(urlStr, options = {}) {
    const { allowPrivate = false } = options;
    try {
        const url = new URL(urlStr);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
        const records = await resolveHostRecords(url.hostname);
        if (records.length === 0) return false;
        if (allowPrivate) return true;
        return records.every(record => !isPrivateIp(record.address));
    } catch (_) {
        return false;
    }
}

async function buildPinnedAgentConfig(urlStr, options = {}) {
    const { allowPrivate = false } = options;
    try {
        const url = new URL(urlStr);
        const records = await resolveHostRecords(url.hostname);
        if (records.length === 0) return null;
        if (!allowPrivate && records.some(record => isPrivateIp(record.address))) return null;
        const preferred = records.find(record => allowPrivate || !isPrivateIp(record.address)) || records[0];
        if (!preferred || !preferred.address) return null;
        const family = preferred.family || net.isIP(preferred.address);
        const lookup = (_, __, callback) => callback(null, preferred.address, family);
        const agentOptions = { keepAlive: false, lookup };
        return url.protocol === 'https:'
            ? { httpsAgent: new https.Agent(agentOptions) }
            : { httpAgent: new http.Agent(agentOptions) };
    } catch (_) {
        return null;
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

async function getProxyUrlPolicy(urlStr, signature) {
    if (await isUrlSafeResolved(urlStr)) {
        return { allowed: true, allowPrivate: false };
    }
    if (!await isUrlSafeResolved(urlStr, { allowPrivate: true })) {
        return { allowed: false, allowPrivate: false };
    }
    return {
        allowed: hasValidProxySignature(urlStr, signature) || isKnownProxyUrl(urlStr),
        allowPrivate: true
    };
}

function buildSignedProxyUrl(absUrl) {
    const isPlaylist = /\.m3u8($|\?)/i.test(absUrl);
    const endpoint = isPlaylist ? '/api/proxy/hls' : '/api/proxy/stream';
    const signature = createProxySignature(absUrl);
    return `${endpoint}?url=${encodeURIComponent(absUrl)}&sig=${signature}`;
}

async function rewriteHlsPlaylist(text, streamUrl, options = {}) {
    const { allowPrivateBase = false } = options;
    const canProxyUrl = typeof options.canProxyUrl === 'function'
        ? options.canProxyUrl
        : isUrlSafeResolved;
    const baseUrl = new URL(streamUrl);

    const rewriteUri = async (uri) => {
        const trimmed = uri.trim();
        if (!trimmed || trimmed.startsWith('#')) return uri;
        if (/^(data:|blob:|javascript:)/i.test(trimmed)) return uri;

        let absolute;
        try {
            absolute = new URL(trimmed, baseUrl).toString();
        } catch (_) {
            return uri;
        }
        const targetUrl = new URL(absolute);
        const allowPrivate = allowPrivateBase && normalizeHost(targetUrl.hostname) === normalizeHost(baseUrl.hostname);
        if (!await canProxyUrl(absolute, { allowPrivate })) return uri;
        return buildSignedProxyUrl(absolute);
    };

    const lines = String(text || '').split(/\r?\n/);
    const rewrittenLines = [];

    for (const line of lines) {
        const uriPattern = /URI="([^"]+)"/gi;
        let cursor = 0;
        let rebuilt = '';
        let match;
        while ((match = uriPattern.exec(line)) !== null) {
            const rewrittenUri = await rewriteUri(match[1]);
            rebuilt += line.slice(cursor, match.index) + `URI="${rewrittenUri}"`;
            cursor = uriPattern.lastIndex;
        }
        if (cursor > 0) {
            rebuilt += line.slice(cursor);
            rewrittenLines.push(rebuilt);
            continue;
        }
        if (line.startsWith('#')) {
            rewrittenLines.push(line);
            continue;
        }
        rewrittenLines.push(await rewriteUri(line));
    }

    return rewrittenLines.join('\n');
}

function copyResponseHeaders(sourceHeaders, res, headerNames) {
    headerNames.forEach((name) => {
        const value = sourceHeaders[name];
        if (value) res.setHeader(name, value);
    });
}

router.get('/proxy/stream', async (req, res) => {
    const streamUrl = req.query.url;
    if (!streamUrl) return res.status(400).send('Missing url');
    const policy = await getProxyUrlPolicy(streamUrl, req.query.sig);
    if (!policy.allowed) return res.status(403).send('URL not allowed');
    const agentConfig = await buildPinnedAgentConfig(streamUrl, { allowPrivate: policy.allowPrivate });
    if (!agentConfig) return res.status(403).send('URL not allowed');

    try {
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'stream',
            timeout: 10000,
            maxRedirects: 0,
            headers: {
                'User-Agent': 'IPTV-Checker/1.0',
                ...(req.headers.range ? { Range: req.headers.range } : {})
            },
            validateStatus: (status) => status >= 200 && status < 400,
            ...agentConfig
        });
        res.status(response.status);
        copyResponseHeaders(response.headers, res, [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'cache-control',
            'content-disposition',
            'etag',
            'last-modified'
        ]);
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
    const policy = await getProxyUrlPolicy(streamUrl, req.query.sig);
    if (!policy.allowed) return res.status(403).send('URL not allowed');
    const agentConfig = await buildPinnedAgentConfig(streamUrl, { allowPrivate: policy.allowPrivate });
    if (!agentConfig) return res.status(403).send('URL not allowed');

    try {
        const response = await axios({
            method: 'get',
            url: streamUrl,
            responseType: 'arraybuffer',
            timeout: 10000,
            maxRedirects: 0,
            headers: {
                'User-Agent': 'IPTV-Checker/1.0',
                ...(req.headers.range ? { Range: req.headers.range } : {})
            },
            validateStatus: (status) => status >= 200 && status < 400,
            ...agentConfig
        });

        const upstreamType = String(response.headers['content-type'] || '').toLowerCase();
        const isM3u8 = streamUrl.includes('.m3u8') || upstreamType.includes('mpegurl') || upstreamType.includes('vnd.apple.mpegurl');

        if (isM3u8) {
            const text = Buffer.from(response.data).toString('utf8');
            const rewritten = await rewriteHlsPlaylist(text, streamUrl, { allowPrivateBase: policy.allowPrivate });

            res.status(response.status);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(rewritten);
            return;
        }

        res.status(response.status);
        copyResponseHeaders(response.headers, res, [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'cache-control',
            'content-disposition',
            'etag',
            'last-modified'
        ]);
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
        if (!await isUrlSafeResolved(url)) {
            return { url, ok: false, error: 'URL not allowed' };
        }
        const agentConfig = await buildPinnedAgentConfig(url);
        if (!agentConfig) {
            return { url, ok: false, error: 'URL not allowed' };
        }
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                responseType: 'text',
                maxContentLength: 5 * 1024 * 1024,
                maxRedirects: 0,
                ...agentConfig
            });
            return { url, ok: true, text: response.data };
        } catch (_) {
            return { url, ok: false, error: 'Fetch failed' };
        }
    }));

    res.json({ success: true, results: results.map(result => result.value || result.reason) });
});

router._internal = {
    normalizeHost,
    isPrivateIp,
    isUrlSafe,
    isUrlSafeResolved,
    buildPinnedAgentConfig,
    createProxySignature,
    hasValidProxySignature,
    getProxyUrlPolicy,
    buildSignedProxyUrl,
    rewriteHlsPlaylist
};

module.exports = router;
