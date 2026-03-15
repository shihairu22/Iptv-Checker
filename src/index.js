const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const cookieParser = require('cookie-parser');
const axios = require('axios'); // Add this line
const streamService = require('./services/streamService');
const logger = require('./services/logService');
const { requireAuth } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const streamRouter = require('./routes/stream');
const persistRouter = require('./routes/persist');
const configRouter = require('./routes/config');
const taskManager = require('./taskCheck');
const socketIo = require('socket.io');

const app = express();
const port = process.env.PORT || 8848;

// 日志工具 (可进一步迁移到 service)
// 中间件配置
app.use(cors({
    origin: '*',
    credentials: false
}));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(cookieParser());

// 请求日志中间件
app.use((req, res, next) => {
    const start = Date.now();
    const { method, originalUrl, ip } = req;

    const originalEnd = res.end;
    res.end = function (...args) {
        const duration = Date.now() - start;
        const status = res.statusCode;
        if (!originalUrl.startsWith('/static') && !originalUrl.startsWith('/css') && !originalUrl.startsWith('/js')) {
            let logMsg = `${method} ${originalUrl} ${status} - ${duration}ms - ${ip}`;
            if (status >= 500) logger.error(logMsg, 'HTTP');
            else if (status >= 400) logger.warn(logMsg, 'HTTP');
            else logger.info(logMsg, 'HTTP');
        }
        originalEnd.apply(res, args);
    };
    next();
});

// 全局进程错误捕获，防止因未捕获的 Promise 等导致进程直接崩溃
process.on('uncaughtException', (err) => {
    logger.error(`未捕获的异常 (Uncaught Exception): ${err.stack || err}`);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`未处理的 Promise 拒绝 (Unhandled Rejection): ${reason}`);
});

// 初始化数据
function getCookieValue(cookieHeader, key) {
    const source = String(cookieHeader || '');
    const prefix = `${key}=`;
    return source.split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(prefix))
        ?.slice(prefix.length) || '';
}

function trimTrailingSlashes(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function filterStreamsByStatus(streams, status) {
    if (!status || status === 'all') return streams;
    const wantOnline = status === 'ok' || status === 'online';
    return streams.filter(stream => !!stream.isAvailable === wantOnline);
}

function buildPlaybackUrlForScope(stream, scope, settings) {
    const rawUrl = String(stream.multicastUrl || '').trim();
    if (!rawUrl) return '';

    if (/^https?:\/\//i.test(rawUrl)) return rawUrl;

    const baseUrl = scope === 'external'
        ? trimTrailingSlashes(settings.externalUrl || '')
        : trimTrailingSlashes(settings.internalUrl || stream.udpxyUrl || '');

    if (!baseUrl) return rawUrl;

    const rtpMatch = rawUrl.match(/^(rtp|udp):?\/+@?(.+)/i);
    if (rtpMatch) return `${baseUrl}/rtp/${rtpMatch[2]}`;

    const rtspMatch = rawUrl.match(/^rtsps?:\/+@?(.+)/i);
    if (rtspMatch) return `${baseUrl}/rtsp/${rtspMatch[1]}`;

    return rawUrl;
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

async function startServer() {
    try {
        await streamService.init();
        logger.info(`初始化数据加载成功，记录数: ${streamService.getStreamsCount()}`);

        // 路由挂载开始
        const publicDir = path.join(__dirname, '../public');

        // 1. 公开静态资源 (CSS, JS, Vendor 库)
        // 确保播放器和样式脚本始终可访问，避免因鉴权拦截导致的 404 或 MIME 冲突
        app.use('/vendor', express.static(path.join(publicDir, 'vendor')));
        app.use('/css', express.static(path.join(publicDir, 'css')));
        app.use('/js', express.static(path.join(publicDir, 'js')));
        app.use('/login.html', express.static(path.join(publicDir, 'login.html')));

        // 2. 鉴权路由 (登录、验证码)
        app.use('/api', authRouter);

        // 3. 业务逻辑鉴权中间件
        // 保护所有页面请求及 API 接口
        app.use(['/', '/index.html', '/results', '/results.html', '/player.html', '/logs.html', '/api/*'], requireAuth);
        app.get('/logs.html', requireAuth, (req, res) => res.sendFile(path.join(publicDir, 'logs.html')));

        // 4. 业务 API 路由
        app.use('/api', streamRouter);
        app.use('/api/persist', persistRouter);
        app.get('/api/system/info', (req, res) => res.json({ success: true, version: require('../package.json').version }));
        app.post('/api/system/update', (req, res) => {
            res.status(501).json({
                success: false,
                message: '当前版本未内置自动更新，请使用 Git 或 Docker 手动更新。'
            });
        });

        // 5. 流媒体代理模块 (GET 请求，不受 CSRF 影响)
        // URL 安全校验：仅允许 http/https，屏蔽本地回环和链路本地地址
        function isPrivateIp(host) {
            // IPv4 loopback and link-local
            if (host === 'localhost' || host === '127.0.0.1') return true;
            if (host.startsWith('169.254.')) return true;
            // Private IPv4 ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
            const parts = host.split('.').map(Number);
            if (parts.length === 4 && parts.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
                if (parts[0] === 10) return true;
                if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
                if (parts[0] === 192 && parts[1] === 168) return true;
                if (parts[0] === 0) return true;
            }
            // IPv6 loopback, link-local (fe80::/10), unique-local (fc00::/7)
            if (host === '::1') return true;
            const lowerHost = host.replace(/^\[|\]$/g, '').toLowerCase();
            if (lowerHost.startsWith('fe80:') || lowerHost.startsWith('fc') || lowerHost.startsWith('fd')) return true;
            return false;
        }

        function isUrlSafe(urlStr, options = {}) {
            const { allowPrivate = false } = options;
            try {
                const u = new URL(urlStr);
                if (!['http:', 'https:'].includes(u.protocol)) return false;
                const host = u.hostname;
                if (!allowPrivate && isPrivateIp(host)) return false;
                return true;
            } catch (e) {
                return false;
            }
        }
        app.get('/api/proxy/stream', async (req, res) => {
            const streamUrl = req.query.url;
            if (!streamUrl) return res.status(400).send('Missing url');
            if (!isUrlSafe(streamUrl, { allowPrivate: true })) return res.status(403).send('URL not allowed');
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
                res.on('close', () => { if (response.data.destroy) response.data.destroy(); });
            } catch (e) {
                res.status(502).send('Proxy error');
            }
        });

        app.get('/api/proxy/hls', async (req, res) => {
            const streamUrl = req.query.url;
            if (!streamUrl) return res.status(400).send('Missing url');
            if (!isUrlSafe(streamUrl, { allowPrivate: true })) return res.status(403).send('URL not allowed');
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
                    validateStatus: (s) => s >= 200 && s < 400
                });

                const upstreamType = String(response.headers['content-type'] || '').toLowerCase();
                const isM3u8 = streamUrl.includes('.m3u8') || upstreamType.includes('mpegurl') || upstreamType.includes('vnd.apple.mpegurl');

                if (isM3u8) {
                    const text = Buffer.from(response.data).toString('utf8');
                    const baseUrl = new URL(streamUrl);

                    const toProxyUrl = (absUrl) => {
                        const isPlaylist = /\.m3u8($|\?)/i.test(absUrl);
                        const endpoint = isPlaylist ? '/api/proxy/hls' : '/api/proxy/stream';
                        return `${endpoint}?url=${encodeURIComponent(absUrl)}`;
                    };

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
                        return toProxyUrl(absolute);
                    };

                    const rewritten = text
                        .split(/\r?\n/)
                        .map((line) => {
                            const keyMatch = line.match(/^(#EXT-X-KEY:.*URI=")([^"]+)(".*)$/i);
                            if (keyMatch) {
                                const replaced = rewriteUri(keyMatch[2]);
                                return `${keyMatch[1]}${replaced}${keyMatch[3]}`;
                            }
                            if (line.startsWith('#')) return line;
                            return rewriteUri(line);
                        })
                        .join('\n');

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
            } catch (e) {
                res.status(502).send('Proxy error');
            }
        });

        // 6. 任务管理路由
        app.get('/api/task/status', (req, res) => res.json(taskManager.getStatus()));
        app.post('/api/task/start', (req, res) => res.json({ success: taskManager.start(req.body) }));
        app.post('/api/task/stop', (req, res) => { taskManager.stop(); res.json({ success: true }); });
        app.post('/api/task/resume', (req, res) => res.json({ success: taskManager.resume() }));

        // 6b. 播放器相关接口
        app.post('/api/player/log', (req, res) => {
            try {
                const b = req.body || {};
                const name = String(b.name || b.tvgName || '').trim();
                const mode = String(b.mode || '').trim();
                const cast = String(b.cast || '').trim();
                const programTitle = String(b.programTitle || '').trim();
                const url = String(b.url || '').trim();
                const info = [name ? `频道: ${name}` : '', mode ? `类型: ${mode}` : '', cast ? `/${cast}` : '', programTitle ? `节目: ${programTitle}` : '', url ? `地址: ${url}` : ''].filter(Boolean).join(' | ');
                if (info) logger.info(`播放日志 -> ${info}`);
                res.json({ success: true });
            } catch (e) { res.json({ success: false }); }
        });

        // EPG节目表（桩接口，暂不实现EPG解析）
        app.get('/api/logs/files', (req, res) => {
            res.json({ success: true, files: logger.listFiles() });
        });

        app.get('/api/logs/download', (req, res) => {
            const filePath = logger.getFilePath(req.query.file);
            if (!filePath) return res.status(404).json({ success: false, message: 'Log file not found' });
            res.download(filePath, path.basename(filePath));
        });

        app.get('/api/logs/stream', (req, res) => {
            logger.stream(res, {
                level: String(req.query.level || 'info'),
                module: String(req.query.module || 'all'),
                keyword: String(req.query.keyword || '').trim()
            }, req.query.tail);
        });

        app.get('/api/epg/programs', (req, res) => {
            res.json({ success: true, programs: [] });
        });

        // 时移回看（桩接口）
        app.post('/api/catchup/play', (req, res) => {
            res.json({ success: false, message: '时移功能暂未实现' });
        });

        // 导出 JSON（供播放器加载频道列表）
        app.get('/api/catchup/play', (req, res) => {
            res.json({ success: false, message: '鏃剁Щ鍔熻兘鏆傛湭瀹炵幇' });
        });

        app.get('/api/export/json', (req, res) => {
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

        // 台标代理（简单透传，不做图像处理）
        app.get('/api/logo', async (req, res) => {
            try {
                const nm = String(req.query.name || '').trim();
                const scope = String(req.query.scope || 'internal').trim().toLowerCase() === 'external' ? 'external' : 'internal';
                if (!nm) return res.status(400).send('missing name');
                const persistence = require('./services/persistenceService');
                const cfg = await persistence.readJson('logo_templates.json', { templates: [] });
                const template = pickLogoTemplate(cfg, scope);
                if (!template || !template.url) return res.status(404).send('no template');
                const target = String(template.url).replace('{name}', encodeURIComponent(nm));
                const resp = await axios.get(target, {
                    responseType: 'arraybuffer',
                    validateStatus: () => true,
                    headers: { 'User-Agent': 'IPTV-Checker/1.0' }
                });
                if (resp.status < 200 || resp.status >= 300) return res.status(404).send('not found');
                const ct = resp.headers['content-type'] || 'image/png';
                res.set('Cache-Control', 'public, max-age=604800');
                res.type(ct);
                res.send(Buffer.from(resp.data));
            } catch (e) { res.status(404).send('not found'); }
        });

        // 7. 配置相关路由
        app.use('/', configRouter);

        // 8. 页面回退路由
        app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
        app.get('/results', (req, res) => res.sendFile(path.join(publicDir, 'results.html')));
        app.get('/player.html', (req, res) => res.sendFile(path.join(publicDir, 'player.html')));

        // 全局错误处理

        // 9. 远程文件抓取（前端"从网络加载 m3u/txt"功能）
        app.post('/api/fetch-text', async (req, res) => {
            const { urls } = req.body;
            if (!Array.isArray(urls) || urls.length === 0) {
                return res.status(400).json({ success: false, message: 'Missing urls' });
            }
            const limited = urls.slice(0, 10);
            const results = await Promise.allSettled(limited.map(async (url) => {
                if (typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
                    return { url, ok: false, error: 'Invalid URL' };
                }
                // SSRF 防护：禁止请求本地回环和链路本地地址
                if (!isUrlSafe(url)) {
                    return { url, ok: false, error: 'URL not allowed' };
                }
                try {
                    const resp = await axios.get(url, { timeout: 15000, responseType: 'text', maxContentLength: 5 * 1024 * 1024 });
                    return { url, ok: true, text: resp.data };
                } catch (e) {
                    return { url, ok: false, error: 'Fetch failed' };
                }
            }));
            res.json({ success: true, results: results.map(r => r.value || r.reason) });
        });
        app.use((err, req, res, next) => {
            logger.error(`系统错误: ${err.stack}`);
            res.status(500).json({ success: false, message: '服务器内部错误' });
        });

        const server = app.listen(port, () => {
            logger.info(`服务器已在端口 ${port} 启动`);
        });

        // 初始化 Socket.IO
        const io = socketIo(server, {
            cors: {
                origin: '*'
            }
        });
        taskManager.setIo(io);

        io.use((socket, next) => {
            const token = getCookieValue(socket.request.headers.cookie, 'auth_token');
            if (authRouter.isValidToken(token)) return next();
            const err = new Error('Unauthorized');
            err.data = { code: 'UNAUTHORIZED' };
            return next(err);
        });

        io.on('connection', (socket) => {
            logger.info(`客户端已连接: ${socket.id}`);
            // 发送当前状态
            socket.emit('task:status', taskManager.getStatus());

            socket.on('disconnect', () => {
            });
        });

    } catch (e) {
        logger.error(`启动失败: ${e.message}`);
        process.exit(1);
    }
}

startServer();
