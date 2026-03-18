function normalizeMulticastUrl(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(rtp|udp):?\/+@?(.*)$/i);
    if (!match) return raw;
    const scheme = String(match[1] || '').toLowerCase();
    const rest = String(match[2] || '').replace(/^@+/, '');
    return `${scheme}://${rest}`;
}

function trimTrailingSlashes(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function parseProxySourceUrl(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(rtp|udp|rtsp|rtsps):?\/+@?(.*)$/i);
    if (!match) return null;

    const protocol = String(match[1] || '').toLowerCase();
    const address = String(match[2] || '').replace(/^@+/, '');
    if (!address) return null;

    return {
        protocol,
        address,
        pathProtocol: protocol.startsWith('rtsp') ? 'rtsp' : protocol
    };
}

function buildProxyPlaybackUrl(rawUrl, baseUrl) {
    const raw = String(rawUrl || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;

    const parsed = parseProxySourceUrl(raw);
    const base = trimTrailingSlashes(baseUrl);
    if (!parsed || !base) return raw;

    return `${base}/${parsed.pathProtocol}/${parsed.address}`;
}

module.exports = {
    normalizeMulticastUrl,
    parseProxySourceUrl,
    buildProxyPlaybackUrl
};
