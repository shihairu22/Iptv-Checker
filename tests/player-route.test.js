const test = require('node:test');
const assert = require('node:assert/strict');
const playerRouter = require('../src/routes/player');

const {
    buildPlaybackUrlForScope,
    buildScopedExport,
    pickLogoTemplate,
    filterStreamsByStatus
} = playerRouter._internal;

test('buildPlaybackUrlForScope uses singlecast proxy for external http streams', () => {
    const settings = {
        proxyList: [{ type: '单播代理', url: 'https://proxy.example.com' }]
    };
    const stream = { multicastUrl: 'https://origin.example.com/live/index.m3u8' };
    assert.equal(
        buildPlaybackUrlForScope(stream, 'external', settings),
        'https://proxy.example.com/origin.example.com/live/index.m3u8'
    );
});

test('buildPlaybackUrlForScope uses multicast proxy for external udp streams', () => {
    const settings = {
        proxyList: [{ type: '组播代理', url: 'https://edge.example.com/base/' }]
    };
    const stream = { multicastUrl: 'udp://239.0.0.1:1234', udpxyUrl: 'http://local-proxy:4022' };
    assert.equal(
        buildPlaybackUrlForScope(stream, 'external', settings),
        'https://edge.example.com/base/udp/239.0.0.1:1234'
    );
});

test('buildScopedExport attaches httpUrl to each stream', () => {
    const settings = { internalUrl: 'http://127.0.0.1:4022' };
    const streams = [{ multicastUrl: 'rtp://239.0.0.1:1234' }];
    const exported = buildScopedExport(streams, 'internal', settings);
    assert.equal(exported[0].httpUrl, 'http://127.0.0.1:4022/rtp/239.0.0.1:1234');
});

test('pickLogoTemplate prefers scope-matching template and current fallback', () => {
    const cfg = {
        currentId: 'b',
        templates: [
            { id: 'a', url: 'https://internal.example/{name}.png', category: '内网台标' },
            { id: 'b', url: 'https://external.example/{name}.png', category: '外网台标' }
        ]
    };
    assert.equal(pickLogoTemplate(cfg, 'external').id, 'b');
    assert.equal(pickLogoTemplate(cfg, 'internal').id, 'b');
});

test('filterStreamsByStatus keeps only requested availability', () => {
    const list = [
        { isAvailable: true, id: 1 },
        { isAvailable: false, id: 2 }
    ];
    assert.deepEqual(filterStreamsByStatus(list, 'online').map(item => item.id), [1]);
    assert.deepEqual(filterStreamsByStatus(list, 'offline').map(item => item.id), [2]);
});
