const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const cookieParser = require('cookie-parser');
const streamService = require('./services/streamService');
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
const logger = {
    info: (msg) => console.log(`[${new Date().toLocaleString()}] [INFO] ${msg}`),
    error: (msg) => console.error(`[${new Date().toLocaleString()}] [ERROR] ${msg}`),
    warn: (msg) => console.warn(`[${new Date().toLocaleString()}] [WARN] ${msg}`)
};

// 中间件配置
app.use(cors());
app.use(bodyParser.json());
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
            if (status >= 500) logger.error(logMsg);
            else if (status >= 400) logger.warn(logMsg);
            else logger.info(logMsg);
        }
        originalEnd.apply(res, args);
    };
    next();
});

// 初始化数据
async function startServer() {
    try {
        await streamService.init();
        logger.info(`初始化数据加载成功，记录数: ${streamService.getStreams().length}`);

        // 路由挂载
        // 鉴权路由 (不需要保护)
        app.use('/api', authRouter);

        // 静态文件保护和其它路由
        app.use(['/', '/index.html', '/results', '/results.html', '/api/*'], requireAuth);

        // 业务路由
        app.use('/api', streamRouter);
        app.use('/api/persist', persistRouter);
        app.use('/', configRouter);
        app.get('/api/system/info', (req, res) => res.json({ success: true, version: require('../package.json').version }));

        // 任务管理路由
        app.get('/api/task/status', (req, res) => res.json(taskManager.getStatus()));
        app.post('/api/task/start', (req, res) => res.json({ success: taskManager.start(req.body) }));
        app.post('/api/task/stop', (req, res) => { taskManager.stop(); res.json({ success: true }); });
        app.post('/api/task/resume', (req, res) => res.json({ success: taskManager.resume() }));

        // 静态资源
        app.use(express.static('public'));

        // 页面辅助路由
        app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
        app.get('/results', (req, res) => res.sendFile(path.join(__dirname, '../public/results.html')));

        // 全局错误处理

        // ... (省略中间代码) ...

        app.use((err, req, res, next) => {
            logger.error(`系统错误: ${err.stack}`);
            res.status(500).json({ success: false, message: '服务器内部错误' });
        });

        const server = app.listen(port, () => {
            logger.info(`服务器已在端口 ${port} 启动`);
        });

        // 初始化 Socket.IO
        const io = socketIo(server, { cors: { origin: "*" } });
        taskManager.setIo(io);

        io.on('connection', (socket) => {
            logger.info(`客户端已连接: ${socket.id}`);
            // 发送当前状态
            socket.emit('task:status', taskManager.getStatus());

            socket.on('disconnect', () => {
                // logger.info(`客户端断开: ${socket.id}`);
            });
        });

    } catch (e) {
        logger.error(`启动失败: ${e.message}`);
        process.exit(1);
    }
}

startServer();
