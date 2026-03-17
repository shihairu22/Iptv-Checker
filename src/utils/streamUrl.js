function normalizeMulticastUrl(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(rtp|udp):?\/+@?(.*)$/i);
    if (!match) return raw;
    const scheme = String(match[1] || '').toLowerCase();
    const rest = String(match[2] || '').replace(/^@+/, '');
    return `${scheme}://${rest}`;
}

module.exports = {
    normalizeMulticastUrl
};
