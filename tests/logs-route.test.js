const test = require('node:test');
const assert = require('node:assert/strict');
const logsRouter = require('../src/routes/logs');

test('logs router exposes file download and stream endpoints', () => {
    const paths = logsRouter.stack.map((layer) => layer.route && layer.route.path).filter(Boolean);
    assert.deepEqual(paths.sort(), ['/download', '/files', '/stream']);
});
