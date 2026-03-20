const test = require('node:test');
const assert = require('node:assert/strict');
const authRouter = require('../src/routes/auth');

const {
    hashPassword,
    verifyPassword,
    createInitialAdminPassword
} = authRouter._internal;

test('createInitialAdminPassword uses IPTV_ADMIN_PASSWORD when provided', () => {
    const original = process.env.IPTV_ADMIN_PASSWORD;
    process.env.IPTV_ADMIN_PASSWORD = 'custom-secret';
    try {
        const result = createInitialAdminPassword();
        assert.deepEqual(result, {
            password: 'custom-secret',
            fromEnv: true
        });
    } finally {
        if (original === undefined) delete process.env.IPTV_ADMIN_PASSWORD;
        else process.env.IPTV_ADMIN_PASSWORD = original;
    }
});

test('createInitialAdminPassword generates a non-default password when env is absent', () => {
    const original = process.env.IPTV_ADMIN_PASSWORD;
    delete process.env.IPTV_ADMIN_PASSWORD;
    try {
        const result = createInitialAdminPassword();
        assert.equal(result.fromEnv, false);
        assert.notEqual(result.password, 'admin');
        assert.ok(result.password.length >= 16);
    } finally {
        if (original === undefined) delete process.env.IPTV_ADMIN_PASSWORD;
        else process.env.IPTV_ADMIN_PASSWORD = original;
    }
});

test('verifyPassword rejects malformed input and still validates matching hashes', () => {
    const hashed = hashPassword('secret-123');
    assert.equal(verifyPassword(undefined, hashed), false);
    assert.equal(verifyPassword('secret-123', ''), false);
    assert.equal(verifyPassword('secret-123', hashed), true);
    assert.equal(verifyPassword('wrong', hashed), false);
});
