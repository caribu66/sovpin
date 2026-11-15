const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const webDist = path.join(repoRoot, 'web', 'dist');
const hasDist = fs.existsSync(path.join(webDist, 'index.html'));

test(
  'SPA fallback: missing /assets/* 404s (never index.html), client routes still serve the SPA',
  { skip: !hasDist ? 'web/dist not built' : false },
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovpin-spa-'));
    process.env.NODE_ENV = 'test';
    process.env.SOVPIN_DB_PATH = path.join(tmp, 'spa-fallback.sqlite');
    const app = require('../server');

    const realAsset = fs
      .readdirSync(path.join(webDist, 'assets'))
      .filter((f) => f.endsWith('.js'))
      .sort()[0];
    assert.ok(realAsset, 'expected at least one built JS asset');

    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;

      const missing = await fetch(`${base}/assets/sovpin-probe-missing-abc123.js`);
      assert.equal(missing.status, 404);
      assert.doesNotMatch(
        String(missing.headers.get('content-type') || ''),
        /text\/html/
      );

      const asset = await fetch(`${base}/assets/${realAsset}`);
      assert.equal(asset.status, 200);
      assert.match(String(asset.headers.get('content-type') || ''), /javascript/);

      const route = await fetch(`${base}/dashboard`);
      assert.equal(route.status, 200);
      assert.match(String(route.headers.get('content-type') || ''), /text\/html/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
);
