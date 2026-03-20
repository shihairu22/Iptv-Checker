const authRouter = require('../routes/auth');
const streamService = require('../services/streamService');

function hasValidExternalToken(req) {
    const settings = streamService.getSettings();
    if (!settings.enableToken) return true;

    const expected = String(settings.securityToken || '').trim();
    const provided = String(req.query.token || '').trim();
    return !!expected && !!provided && provided === expected;
}

function isPublicExternalApiRequest(req) {
    const publicApis = new Set([
        '/api/export/json',
        '/api/logo',
        '/api/epg/programs',
        '/api/catchup/play'
    ]);
    if (!publicApis.has(req.path)) return false;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
    if (String(req.query.scope || '').trim().toLowerCase() !== 'external') return false;
    return hasValidExternalToken(req);
}

function requireAuth(req, res, next) {
    const token = req.cookies['auth_token'];

    // 1. 检查 Token 有效性
    const isValid = authRouter.isValidToken(token);

    // 2. CSRF 防护 (KISS 方案): 所有非 GET 的 API 写入请求必须携带自定义 Header
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
            return res.status(403).json({ success: false, message: '请求安全校验失败 (CSRF Protected)' });
        }
    }

    if (isValid || isPublicExternalApiRequest(req)) {
        return next();
    }

    // 3. API 请求鉴权 (排除登录/基础信息/验证码)
    const authWhitelist = ['/api/login', '/api/auth/check', '/api/system/info', '/api/captcha'];
    if (req.path.startsWith('/api/') && !authWhitelist.includes(req.path)) {
        return res.status(401).json({ success: false, message: '未登录' });
    }

    // 4. 页面请求重定向到登录页
    const protectedPages = ['/', '/index.html', '/results', '/results.html', '/player.html', '/logs.html'];
    if (protectedPages.includes(req.path)) {
        return res.redirect('/login.html');
    }

    next();
}

module.exports = { requireAuth };
