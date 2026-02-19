const net = require('net');
const dgram = require('dgram');
const { URL } = require('url');

// 预检超时 (毫秒)
const TIMEOUT_HTTP = 1000;
const TIMEOUT_UDP = 1000; // 等待 UDP 包的时间，IPTV 通常流量很大，1秒没包基本就是死链

/**
 * 检查 IP 是否为组播地址
 */
function isMulticast(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    const first = parseInt(parts[0], 10);
    return first >= 224 && first <= 239;
}

/**
 * 快速检测 URL 可达性
 * @param {string} urlStr 
 * @returns {Promise<boolean>}
 */
function checkNetwork(urlStr) {
    return new Promise((resolve) => {
        try {
            // 处理 rtp://IP:PORT 或 udp://@IP:PORT
            if (urlStr.startsWith('rtp://') || urlStr.startsWith('udp://')) {
                // Remove protocol
                const raw = urlStr.replace(/^(rtp|udp):\/\/@?/, '');
                const [host, portStr] = raw.split(':');
                const port = parseInt(portStr, 10);

                if (!host || !port) {
                    resolve(false);
                    return;
                }

                const socket = dgram.createSocket('udp4');
                let satisfied = false;

                const timer = setTimeout(() => {
                    if (!satisfied) {
                        try { socket.close(); } catch (e) { }
                        resolve(false); // 超时未收到包
                    }
                }, TIMEOUT_UDP);

                socket.on('message', (msg, rinfo) => {
                    if (!satisfied) {
                        satisfied = true;
                        clearTimeout(timer);
                        try { socket.close(); } catch (e) { }
                        resolve(true); // 收到包，认为是通的
                    }
                });

                socket.on('error', (err) => {
                    if (!satisfied) {
                        satisfied = true;
                        clearTimeout(timer);
                        try { socket.close(); } catch (e) { }
                        resolve(false);
                    }
                });

                try {
                    socket.bind(port, () => {
                        if (isMulticast(host)) {
                            try {
                                socket.addMembership(host);
                            } catch (e) {
                                // console.log('Multicast add membership failed:', e.message);
                            }
                        }
                    });
                } catch (e) {
                    resolve(false);
                }

            } else if (urlStr.startsWith('http')) {
                // 对于 HTTP/HTTPS，简单的 Socket 连接检查即可 (检查 TCP 握手)
                // udpxy 的情况：http://IP:PORT/rtp/...
                // 我们只检查 IP:PORT 是否可 TCP 建立连接
                let u;
                try {
                    u = new URL(urlStr);
                } catch (e) {
                    resolve(false);
                    return;
                }

                const socket = new net.Socket();
                socket.setTimeout(TIMEOUT_HTTP);

                socket.on('connect', () => {
                    socket.destroy();
                    resolve(true);
                });

                socket.on('timeout', () => {
                    socket.destroy();
                    resolve(false);
                });

                socket.on('error', (err) => {
                    socket.destroy();
                    resolve(false);
                });

                socket.connect(u.port || (u.protocol === 'https:' ? 443 : 80), u.hostname);

            } else {
                // 其他协议直接放行给 ffprobe
                resolve(true);
            }
        } catch (e) {
            console.error('Pre-flight check error:', e);
            resolve(true); // 出错则保守策略，放行
        }
    });
}

module.exports = { checkNetwork };
