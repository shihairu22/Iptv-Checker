const test = require('node:test');
const assert = require('node:assert/strict');
const proxyRouter = require('../src/routes/proxy');

const {
    isUrlSafe,
    isUrlSafeResolved,
    createProxySignature,
    hasValidProxySignature,
    buildSignedProxyUrl,
    rewriteHlsPlaylist
} = proxyRouter._internal;

test('isUrlSafe blocks private IPs by default but allows them when requested', () => {
    assert.equal(isUrlSafe('http://127.0.0.1/live.m3u8'), false);
    assert.equal(isUrlSafe('http://127.0.0.1/live.m3u8', { allowPrivate: true }), true);
    assert.equal(isUrlSafe('https://example.com/live.m3u8'), true);
});

test('isUrlSafeResolved blocks localhost hostnames too', async () => {
    assert.equal(await isUrlSafeResolved('http://localhost/live.m3u8'), false);
    assert.equal(await isUrlSafeResolved('http://localhost/live.m3u8', { allowPrivate: true }), true);
});

test('proxy signatures round-trip correctly', () => {
    const url = 'http://10.0.0.1/live.m3u8';
    const sig = createProxySignature(url);
    assert.equal(hasValidProxySignature(url, sig), true);
    assert.equal(hasValidProxySignature(url, 'bad-signature'), false);
});

test('buildSignedProxyUrl chooses correct endpoint by resource type', () => {
    assert.match(buildSignedProxyUrl('https://cdn.example.com/master.m3u8'), /^\/api\/proxy\/hls\?url=/);
    assert.match(buildSignedProxyUrl('https://cdn.example.com/segment.ts'), /^\/api\/proxy\/stream\?url=/);
});

test('rewriteHlsPlaylist rewrites segment lines and URI attributes', async () => {
    const playlist = [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
        '#EXT-X-MAP:URI="init.mp4"',
        'segment-0001.ts'
    ].join('\n');

    const rewritten = await rewriteHlsPlaylist(playlist, 'https://media.example.com/path/master.m3u8', {
        canProxyUrl: async () => true
    });
    assert.match(rewritten, /\/api\/proxy\/stream\?url=https%3A%2F%2Fmedia\.example\.com%2Fpath%2Fkeys%2Fkey\.bin&sig=/);
    assert.match(rewritten, /\/api\/proxy\/stream\?url=https%3A%2F%2Fmedia\.example\.com%2Fpath%2Finit\.mp4&sig=/);
    assert.match(rewritten, /\/api\/proxy\/stream\?url=https%3A%2F%2Fmedia\.example\.com%2Fpath%2Fsegment-0001\.ts&sig=/);
});

test('rewriteHlsPlaylist does not proxy private subresources from a public playlist', async () => {
    const playlist = [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1/key.bin"',
        'http://127.0.0.1/segment.ts'
    ].join('\n');

    const rewritten = await rewriteHlsPlaylist(playlist, 'https://media.example.com/path/master.m3u8');
    assert.match(rewritten, /URI="http:\/\/127\.0\.0\.1\/key\.bin"/);
    assert.match(rewritten, /http:\/\/127\.0\.0\.1\/segment\.ts/);
    assert.doesNotMatch(rewritten, /\/api\/proxy\/stream\?url=http%3A%2F%2F127\.0\.0\.1/);
});

test('proxy router still exposes expected endpoints', () => {
    const paths = proxyRouter.stack.map((layer) => layer.route && layer.route.path).filter(Boolean);
    assert.deepEqual(paths.sort(), ['/fetch-text', '/proxy/hls', '/proxy/stream']);
});
