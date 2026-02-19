const authRouter = require('../routes/auth');

function requireAuth(req, res, next) {
    const token = req.cookies['auth_token'];

    // 检查 Token 效性
    if (authRouter.isValidToken(token)) {
        return next();
    }

    // API 请求返回 401
    if (req.path.startsWith('/api/') && !['/api/login', '/api/auth/check', '/api/system/info', '/api/captcha'].includes(req.path)) {
        // 排除导出接口和流代理
        if (req.path.startsWith('/api/export/')) return next();
        if (req.path.startsWith('/api/proxy/')) return next();

        return res.status(401).json({ success: false, message: '未登录' });
    }

    // 页面请求重定向到登录页
    const protectedPages = ['/', '/index.html', '/results', '/results.html'];
    if (protectedPages.includes(req.path)) {
        return res.redirect('/login.html');
    }

    next();
}

module.exports = { requireAuth };
