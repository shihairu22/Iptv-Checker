const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const cookieParser = require('cookie-parser');
const streamService = require('./services/streamService');
const logger = require('./services/logService');
const { requireAuth } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const streamRouter = require('./routes/stream');
const persistRouter = require('./routes/persist');
const configRouter = require('./routes/config');
const playerRouter = require('./routes/player');
const logsRouter = require('./routes/logs');
const proxyRouter = require('./routes/proxy');
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
            const safeUrl = redactSensitiveUrlParts(originalUrl);
            let logMsg = `${method} ${safeUrl} ${status} - ${duration}ms - ${ip}`;
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

function redactSensitiveUrlParts(urlValue) {
    const source = String(urlValue || '');
    try {
        const parsed = new URL(source, 'http://local.invalid');
        ['token', 'securityToken', 'auth_token', 'sig'].forEach((key) => {
            if (parsed.searchParams.has(key)) {
                parsed.searchParams.set(key, '[redacted]');
            }
        });
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_) {
        return source.replace(/([?&](?:token|securityToken|auth_token|sig)=)[^&#]*/gi, '$1[redacted]');
    }
}

async function startServer() {
    try {
        if (typeof authRouter.ready === 'function') {
            await authRouter.ready();
        }
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
        app.use('/api', playerRouter);
        app.use('/api', proxyRouter);
        app.use('/api/logs', logsRouter);
        app.get('/api/system/info', (req, res) => res.json({ success: true, version: require('../package.json').version }));
        app.post('/api/system/update', (req, res) => {
            res.status(501).json({
                success: false,
                message: '当前版本未内置自动更新，请使用 Git 或 Docker 手动更新。'
            });
        });

        // 6. 任务管理路由
        app.get('/api/task/status', (req, res) => res.json(taskManager.getStatus()));
        app.post('/api/task/start', (req, res) => res.json({ success: taskManager.start(req.body) }));
        app.post('/api/task/stop', (req, res) => { taskManager.stop(); res.json({ success: true }); });
        app.post('/api/task/resume', (req, res) => res.json({ success: taskManager.resume() }));

        // 7. 配置相关路由
        app.use('/', configRouter);

        // 8. 页面回退路由
        app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
        app.get('/results', (req, res) => res.sendFile(path.join(publicDir, 'results.html')));
        app.get('/player.html', (req, res) => res.sendFile(path.join(publicDir, 'player.html')));

        // 全局错误处理

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
