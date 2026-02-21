const express = require('express');
const router = express.Router();
const svgCaptcha = require('svg-captcha');
const persistence = require('../services/persistenceService');
const path = require('path');

// 共享的 Session 存储 (在模块化后可能需要迁移到 Redis 或数据库，暂时保留内存 Map)
const SESSIONS = new Map();
const SESSION_TTL = 3650 * 24 * 60 * 60 * 1000;
const CAPTCHA_STORE = new Map();

// 辅助函数
async function loadUsers() {
    return await persistence.readJson('users.json', { username: 'admin', password: 'admin' });
}

// 验证码接口
router.get('/captcha', (req, res) => {
    const captcha = svgCaptcha.create({
        size: 4,
        ignoreChars: '0o1i',
        noise: 2,
        color: true,
        background: '#f0f0f0'
    });
    const id = 'cap-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    CAPTCHA_STORE.set(id, { text: captcha.text.toLowerCase(), expires: Date.now() + 5 * 60 * 1000 });

    res.cookie('captcha_id', id, { httpOnly: true, maxAge: 5 * 60 * 1000 });
    res.type('svg');
    res.status(200).send(captcha.data);
});

// 登录接口
router.post('/login', async (req, res) => {
    const { username, password, captcha } = req.body;
    const captchaId = req.cookies['captcha_id'];

    if (!captchaId || !CAPTCHA_STORE.has(captchaId)) {
        return res.json({ success: false, message: '验证码失效，请刷新重试' });
    }
    const stored = CAPTCHA_STORE.get(captchaId);
    CAPTCHA_STORE.delete(captchaId);

    if (!captcha || captcha.toLowerCase() !== stored.text) {
        return res.json({ success: false, message: '验证码错误' });
    }

    const user = await loadUsers();
    if (username === user.username && password === user.password) {
        const token = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        SESSIONS.set(token, { username, expires: Date.now() + SESSION_TTL });
        res.cookie('auth_token', token, { maxAge: SESSION_TTL, httpOnly: true });
        return res.json({ success: true });
    }
    res.json({ success: false, message: '用户名或密码错误' });
});
// 登出接口
router.post('/logout', (req, res) => {
    const token = req.cookies['auth_token'];
    if (token) {
        const sess = SESSIONS.get(token);
        if (sess) console.log(`用户 ${sess.username} 退出登录`);
        SESSIONS.delete(token);
    }
    res.clearCookie('auth_token');
    res.json({ success: true });
});

// 检查状态
router.get('/auth/check', (req, res) => {
    const token = req.cookies['auth_token'];
    if (token && SESSIONS.has(token)) {
        const sess = SESSIONS.get(token);
        return res.json({ success: true, username: sess.username });
    }
    res.json({ success: false });
});

// 导出 Session 检查函数供中间件使用
router.isValidToken = (token) => {
    if (!token) return false;
    const sess = SESSIONS.get(token);
    if (!sess) return false;
    if (Date.now() > sess.expires) {
        SESSIONS.delete(token);
        return false;
    }
    return true;
};

module.exports = router;
