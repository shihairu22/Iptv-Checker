const parseRtp = (url) => {
    const u = (url || '').trim();
    const match = u.match(/rtp:\/\/([^:]+):(\d+)/);
    if (!match) return null;
    return { host: match[1], port: parseInt(match[2], 10) };
};

const ipToInt = (ip) => {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

const intToIp = (intv) => {
    const a = (intv >>> 24) & 255;
    const b = (intv >>> 16) & 255;
    const c = (intv >>> 8) & 255;
    const d = intv & 255;
    return a + '.' + b + '.' + c + '.' + d; // Simplified string concat
};

let startUrl = 'rtp://239.77.0.1:5146';
let endUrl = 'rtp://239.77.0.5:5146';
let portStr = '';

const parsePorts = (str) => {
    const ports = [];
    const parts = (str || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
        if (p.includes('-')) {
            const [start, end] = p.split('-').map(Number);
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = Math.min(start, end); i <= Math.max(start, end); i++) ports.push(i);
            }
        } else {
            const n = Number(p);
            if (!isNaN(n)) ports.push(n);
        }
    }
    return [...new Set(ports)];
};

const s = parseRtp(startUrl);
const e = parseRtp(endUrl);

let items = [];
if (s && e) {
    let startIp = ipToInt(s.host);
    let endIp = ipToInt(e.host);
    console.log('computed:', startIp, endIp);
    if (startIp > endIp) {
        console.log('swapping');
        const tmp = startIp; startIp = endIp; endIp = tmp;
    }

    let ports = parsePorts(portStr);
    if (ports.length === 0) {
        ports.push(s.port);
        if (e.port !== s.port) ports.push(e.port);
    }
    console.log('ports:', ports);

    for (let ip = startIp; ip <= endIp; ip++) {
        const currentIp = intToIp(ip);
        for (const port of ports) {
            items.push({
                name: '',
                url: 'rtp://' + currentIp + ':' + port,
                udpxyUrl: 'test'
            });
        }
    }
} else {
    console.log('parseRtp returned null', s, e);
}

console.log('Total generated:', items.length);
console.log(items);
