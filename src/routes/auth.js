const express = require('express');
const svgCaptcha = require('svg-captcha');
const persistence = require('../services/persistenceService');
const crypto = require('crypto');

const router = express.Router();

// Shared session store (memory + persisted snapshot).
const SESSIONS = new Map();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const CAPTCHA_STORE = new Map();

const SESSIONS_FILE = 'sessions.json';
let sessionsSaveTimer = null;
const SESSIONS_SAVE_DELAY = 1000;

async function loadSessions() {
    try {
        const list = await persistence.readJson(SESSIONS_FILE, []);
        if (!Array.isArray(list)) return;

        for (const item of list) {
            if (!item || !item.token) continue;
            SESSIONS.set(item.token, {
                username: item.username,
                expires: item.expires
            });
        }
    } catch (_) {
        // Ignore corrupted session snapshots and continue with an empty map.
    }
}

function scheduleSaveSessions() {
    if (sessionsSaveTimer) clearTimeout(sessionsSaveTimer);
    sessionsSaveTimer = setTimeout(async () => {
        try {
            const list = Array.from(SESSIONS.entries()).map(([token, value]) => ({
                token,
                username: value.username,
                expires: value.expires
            }));
            await persistence.writeJson(SESSIONS_FILE, list);
        } catch (_) {
            // Ignore write failures; sessions still exist in memory for this process.
        }
    }, SESSIONS_SAVE_DELAY);
}

function setSession(token, session) {
    SESSIONS.set(token, session);
    scheduleSaveSessions();
}

function deleteSession(token) {
    if (!SESSIONS.has(token)) return;
    SESSIONS.delete(token);
    scheduleSaveSessions();
}

const sessionsReady = loadSessions();
router.ready = async () => {
    await sessionsReady;
};

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    if (typeof password !== 'string' || typeof storedPassword !== 'string' || !storedPassword) {
        return false;
    }

    if (!storedPassword.includes(':')) {
        const a = Buffer.from(password);
        const b = Buffer.from(storedPassword);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    }

    const [salt, hash] = storedPassword.split(':');
    if (!salt || !hash) return false;
    const key = crypto.scryptSync(password, salt, 64).toString('hex');
    const keyBuf = Buffer.from(key, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    if (keyBuf.length !== hashBuf.length) return false;
    return crypto.timingSafeEqual(keyBuf, hashBuf);
}

function createInitialAdminPassword() {
    const presetPassword = typeof process.env.IPTV_ADMIN_PASSWORD === 'string'
        ? process.env.IPTV_ADMIN_PASSWORD.trim()
        : '';

    if (presetPassword) {
        return { password: presetPassword, fromEnv: true };
    }

    return {
        password: crypto.randomBytes(18).toString('base64url'),
        fromEnv: false
    };
}

async function loadUsers() {
    const existing = await persistence.readJson('users.json', null);
    if (existing && typeof existing.username === 'string' && typeof existing.password === 'string') {
        return existing;
    }

    const initialAdmin = createInitialAdminPassword();
    const user = {
        username: 'admin',
        password: hashPassword(initialAdmin.password)
    };

    const saved = await persistence.writeJson('users.json', user);
    if (saved) {
        if (initialAdmin.fromEnv) {
            console.warn('[Auth] users.json 不存在，已使用环境变量 IPTV_ADMIN_PASSWORD 初始化管理员密码。');
        } else {
            console.warn('[Auth] users.json 不存在，已自动生成初始管理员密码。');
            console.warn(`[Auth] 初始管理员账号: admin / ${initialAdmin.password}`);
            console.warn('[Auth] 请立即登录并在设置中修改密码。');
        }
    } else {
        console.error('[Auth] users.json 初始化失败，请检查 data 目录写权限。');
    }

    return user;
}

router.get('/captcha', (req, res) => {
    const captcha = svgCaptcha.create({
        size: 4,
        ignoreChars: '0o1i',
        noise: 2,
        color: true,
        background: '#f0f0f0'
    });
    const id = `cap-${crypto.randomBytes(8).toString('hex')}`;
    CAPTCHA_STORE.set(id, {
        text: captcha.text.toLowerCase(),
        expires: Date.now() + 5 * 60 * 1000
    });

    res.cookie('captcha_id', id, { httpOnly: true, maxAge: 5 * 60 * 1000 });
    res.type('svg');
    res.status(200).send(captcha.data);
});

router.post('/login', async (req, res) => {
    const { username, password, captcha } = req.body || {};
    const captchaId = req.cookies.captcha_id;

    if (!captchaId || !CAPTCHA_STORE.has(captchaId)) {
        return res.json({ success: false, message: '验证码失效，请刷新重试' });
    }

    const storedCaptcha = CAPTCHA_STORE.get(captchaId);
    CAPTCHA_STORE.delete(captchaId);

    if (Date.now() > storedCaptcha.expires) {
        return res.json({ success: false, message: '验证码已过期，请刷新重试' });
    }

    if (typeof captcha !== 'string' || captcha.toLowerCase() !== storedCaptcha.text) {
        return res.json({ success: false, message: '验证码错误' });
    }

    const user = await loadUsers();
    if (username === user.username && verifyPassword(password, user.password)) {
        if (!user.password.includes(':')) {
            user.password = hashPassword(password);
            await persistence.writeJson('users.json', user);
            console.log(`用户 ${username} 密码已自动升级为安全哈希格式`);
        }

        const token = `sess-${crypto.randomUUID()}`;
        setSession(token, {
            username,
            expires: Date.now() + SESSION_TTL
        });
        res.cookie('auth_token', token, {
            maxAge: SESSION_TTL,
            httpOnly: true,
            sameSite: 'strict'
        });
        return res.json({ success: true });
    }

    return res.json({ success: false, message: '用户名或密码错误' });
});

router.post('/logout', (req, res) => {
    const token = req.cookies.auth_token;
    if (token) {
        const session = SESSIONS.get(token);
        if (session) console.log(`用户 ${session.username} 退出登录`);
        deleteSession(token);
    }
    res.clearCookie('auth_token');
    res.json({ success: true });
});

router.get('/auth/check', (req, res) => {
    const token = req.cookies.auth_token;
    if (token && SESSIONS.has(token)) {
        const session = SESSIONS.get(token);
        if (Date.now() > session.expires) {
            deleteSession(token);
            res.clearCookie('auth_token');
            return res.json({ success: false });
        }
        return res.json({ success: true, username: session.username });
    }
    return res.json({ success: false });
});

router.post('/auth/update', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token || !SESSIONS.has(token)) {
        return res.status(401).json({ success: false, message: '未登录' });
    }

    try {
        const { username, password, oldPassword } = req.body || {};
        if (typeof oldPassword !== 'string' || oldPassword.trim() === '') {
            return res.status(400).json({ success: false, message: '请输入旧密码' });
        }

        const user = await loadUsers();
        if (!verifyPassword(oldPassword, user.password)) {
            return res.json({ success: false, message: '旧密码错误' });
        }

        if (typeof username === 'string' && username.trim()) {
            user.username = username.trim();
        }
        if (typeof password === 'string' && password) {
            user.password = hashPassword(password);
        }

        const ok = await persistence.writeJson('users.json', user);
        if (!ok) {
            return res.json({ success: false, message: '系统保存失败' });
        }

        const session = SESSIONS.get(token);
        if (session) {
            session.username = user.username;
            setSession(token, session);
        }

        return res.json({ success: true, username: user.username });
    } catch (_) {
        return res.status(500).json({ success: false, message: '修改失败' });
    }
});

router.isValidToken = (token) => {
    if (!token) return false;
    const session = SESSIONS.get(token);
    if (!session) return false;
    if (Date.now() > session.expires) {
        deleteSession(token);
        return false;
    }
    return true;
};

router._internal = {
    hashPassword,
    verifyPassword,
    createInitialAdminPassword
};

const cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [id, data] of CAPTCHA_STORE.entries()) {
        if (now > data.expires) CAPTCHA_STORE.delete(id);
    }

    for (const [token, session] of SESSIONS.entries()) {
        if (now > session.expires) deleteSession(token);
    }
}, 5 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
}

module.exports = router;
