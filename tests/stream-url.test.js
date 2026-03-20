const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMulticastUrl, parseProxySourceUrl, buildProxyPlaybackUrl } = require('../src/utils/streamUrl');

test('normalizeMulticastUrl removes extra @ and normalizes scheme', () => {
    assert.equal(normalizeMulticastUrl('RTP://@239.1.1.1:1234'), 'rtp://239.1.1.1:1234');
    assert.equal(normalizeMulticastUrl('udp://@@239.1.1.2:5678'), 'udp://239.1.1.2:5678');
});

test('parseProxySourceUrl supports rtp udp and rtsp families', () => {
    assert.deepEqual(parseProxySourceUrl('udp://@239.0.0.1:1234'), {
        protocol: 'udp',
        address: '239.0.0.1:1234',
        pathProtocol: 'udp'
    });
    assert.deepEqual(parseProxySourceUrl('rtsp://camera/live'), {
        protocol: 'rtsp',
        address: 'camera/live',
        pathProtocol: 'rtsp'
    });
});

test('buildProxyPlaybackUrl maps multicast protocols onto proxy path', () => {
    assert.equal(
        buildProxyPlaybackUrl('rtp://239.0.0.1:1234', 'http://127.0.0.1:4022/'),
        'http://127.0.0.1:4022/rtp/239.0.0.1:1234'
    );
    assert.equal(
        buildProxyPlaybackUrl('udp://239.0.0.2:1234', 'http://127.0.0.1:4022'),
        'http://127.0.0.1:4022/udp/239.0.0.2:1234'
    );
    assert.equal(
        buildProxyPlaybackUrl('rtsp://camera/live', 'http://127.0.0.1:4022'),
        'http://127.0.0.1:4022/rtsp/camera/live'
    );
    assert.equal(
        buildProxyPlaybackUrl('https://example.com/live.m3u8', 'http://127.0.0.1:4022'),
        'https://example.com/live.m3u8'
    );
});
