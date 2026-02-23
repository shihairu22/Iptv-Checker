const express = require('express');
const router = express.Router();
const svgCaptcha = require('svg-captcha');
const persistence = require('../services/persistenceService');
const crypto = require('crypto');

// 共享的 Session 存储 (内存 Map + 持久化到 data/sessions.json)
const SESSIONS = new Map();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 缩短为 30 天
const CAPTCHA_STORE = new Map();

// 持久化配置
const SESSIONS_FILE = 'sessions.json';
let _sessionsSaveTimer = null;
const SESSIONS_SAVE_DELAY = 1000; // ms, debounce 写入

async function loadSessions() {
    try {
        const arr = await persistence.readJson(SESSIONS_FILE, []);
        if (Array.isArray(arr)) {
            arr.forEach(item => {
                if (item && item.token) {
                    SESSIONS.set(item.token, { username: item.username, expires: item.expires });
                }
            });
        }
    } catch (e) {
        // ignore
    }
}

function scheduleSaveSessions() {
    if (_sessionsSaveTimer) clearTimeout(_sessionsSaveTimer);
    _sessionsSaveTimer = setTimeout(async () => {
        try {
            const list = Array.from(SESSIONS.entries()).map(([token, v]) => ({ token, username: v.username, expires: v.expires }));
            await persistence.writeJson(SESSIONS_FILE, list);
        } catch (e) {
            // ignore write errors
        }
    }, SESSIONS_SAVE_DELAY);
}

function setSession(token, sess) {
    SESSIONS.set(token, sess);
    scheduleSaveSessions();
}

function deleteSession(token) {
    if (SESSIONS.has(token)) {
        SESSIONS.delete(token);
        scheduleSaveSessions();
    }
}

(async () => { await loadSessions(); })();


// --- 密码安全辅助函数 ---
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    if (!storedPassword.includes(':')) {
        // 兼容旧版明文密码 — 使用常量时间比较
        const a = Buffer.from(password);
        const b = Buffer.from(storedPassword);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    }
    const [salt, hash] = storedPassword.split(':');
    const key = crypto.scryptSync(password, salt, 64).toString('hex');
    // 常量时间比较，防止时序攻击
    const keyBuf = Buffer.from(key, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    if (keyBuf.length !== hashBuf.length) return false;
    return crypto.timingSafeEqual(keyBuf, hashBuf);
}

async function loadUsers() {
    return await persistence.readJson('users.json', { username: 'admin', password: hashPassword('admin') });
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
    const id = 'cap-' + crypto.randomBytes(8).toString('hex');
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

    if (Date.now() > stored.expires) {
        return res.json({ success: false, message: '验证码已过期，请刷新重试' });
    }

    if (!captcha || captcha.toLowerCase() !== stored.text) {
        return res.json({ success: false, message: '验证码错误' });
    }

    const user = await loadUsers();
    if (username === user.username && verifyPassword(password, user.password)) {
        // 如果是明文密码，自动迁移到加盐哈希
        if (!user.password.includes(':')) {
            user.password = hashPassword(password);
            await persistence.writeJson('users.json', user);
            console.log(`用户 ${username} 密码已自动升级为安全哈希格式`);
        }

        const token = 'sess-' + crypto.randomUUID();
        setSession(token, { username, expires: Date.now() + SESSION_TTL });
        // 虽然持久化是异步的，但立即设置 cookie，防止会话丢失风险通过更频繁的心跳处理
        res.cookie('auth_token', token, { maxAge: SESSION_TTL, httpOnly: true, sameSite: 'strict' });
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
        deleteSession(token);
    }
    res.clearCookie('auth_token');
    res.json({ success: true });
});

// 检查状态
router.get('/auth/check', (req, res) => {
    const token = req.cookies['auth_token'];
    if (token && SESSIONS.has(token)) {
        const sess = SESSIONS.get(token);
        if (Date.now() > sess.expires) {
            deleteSession(token);
            res.clearCookie('auth_token');
            return res.json({ success: false });
        }
        return res.json({ success: true, username: sess.username });
    }
    res.json({ success: false });
});

// 修改密码
router.post('/auth/update', async (req, res) => {
    const token = req.cookies['auth_token'];
    if (!token || !SESSIONS.has(token)) return res.status(401).json({ success: false, message: '未登录' });

    const { username, password, oldPassword } = req.body;
    const user = await loadUsers();

    if (!verifyPassword(oldPassword, user.password)) {
        return res.json({ success: false, message: '旧密码错误' });
    }

    if (username) user.username = username;
    if (password) user.password = hashPassword(password);

    const ok = await persistence.writeJson('users.json', user);
    if (!ok) return res.json({ success: false, message: '系统保存失败' });

    // 更新 session
    const sess = SESSIONS.get(token);
    if (sess) {
        sess.username = user.username;
        setSession(token, sess);
    }

    res.json({ success: true, username: user.username });
});

// 导出 Session 检查函数供中间件使用
router.isValidToken = (token) => {
    if (!token) return false;
    const sess = SESSIONS.get(token);
    if (!sess) return false;
    if (Date.now() > sess.expires) {
        deleteSession(token);
        return false;
    }
    return true;
};
// 定期清理过期的验证码和 Session（每 5 分钟）
setInterval(() => {
    const now = Date.now();
    // 清理过期验证码
    for (const [id, data] of CAPTCHA_STORE.entries()) {
        if (now > data.expires) CAPTCHA_STORE.delete(id);
    }
    // 清理过期 Session
    for (const [token, sess] of SESSIONS.entries()) {
        if (now > sess.expires) deleteSession(token);
    }
}, 5 * 60 * 1000);

module.exports = router;
