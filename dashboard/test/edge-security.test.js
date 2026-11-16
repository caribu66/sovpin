const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { getDb, withImmediateTransaction } = require('../src/db');

test('Edge Security: loopback endpoints reject requests carrying Cloudflare/proxy headers', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovpin-edge-test-'));
  process.env.NODE_ENV = 'test';
  process.env.SOVPIN_DB_PATH = path.join(tmp, 'edge-test.sqlite');
  const app = require('../server');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    // 1. A simulated external request arriving through Cloudflare Tunnel (has CF-Connecting-IP)
    const cfReq = await fetch(`${base}/api/kubo`, {
      headers: { 'CF-Connecting-IP': '198.51.100.42' },
    });
    assert.equal(cfReq.status, 403, 'Expected 403 Forbidden when CF-Connecting-IP is present');

    const cfMetrics = await fetch(`${base}/metrics`, {
      headers: { 'CF-Connecting-IP': '198.51.100.42' },
    });
    assert.equal(cfMetrics.status, 403, 'Expected 403 Forbidden on /metrics with CF-Connecting-IP');

    const xffReq = await fetch(`${base}/api/cloudflare`, {
      headers: { 'X-Forwarded-For': '198.51.100.42' },
    });
    assert.equal(xffReq.status, 403, 'Expected 403 Forbidden with X-Forwarded-For');

    // 2. Genuine loopback request without proxy headers is allowed past the guard
    const localReq = await fetch(`${base}/metrics`);
    assert.equal(localReq.status, 200, 'Expected 200 OK for genuine loopback request');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Financial Math: VAT pence and VRSC conversion consistency', () => {
  const vatRate = config.ukCompany.vatRate;
  assert.equal(vatRate, 0.20, 'UK VAT rate must be 20%');

  // Builder Plan
  const builder = config.PLANS.builder;
  assert.equal(builder.priceGbpPence, 0);
  assert.equal(builder.priceVrsc, 0);

  // Indie Plan (£12.00 ex VAT)
  const indie = config.PLANS.indie;
  assert.equal(indie.priceGbpPence, 1200);
  const indieVat = Math.round(indie.priceGbpPence * vatRate);
  assert.equal(indieVat, 240); // £2.40 VAT
  const indieTotalPence = indie.priceGbpPence + indieVat;
  assert.equal(indieTotalPence, 1440); // £14.40 total
  const indieTotalVrsc = Number((indieTotalPence / 100 / config.gbpPerVrscRate).toFixed(4));
  assert.equal(indieTotalVrsc, 4.8); // 4.8 VRSC total

  // Studio Plan (£49.00 ex VAT)
  const studio = config.PLANS.studio;
  assert.equal(studio.priceGbpPence, 4900);
  const studioVat = Math.round(studio.priceGbpPence * vatRate);
  assert.equal(studioVat, 980); // £9.80 VAT
  const studioTotalPence = studio.priceGbpPence + studioVat;
  assert.equal(studioTotalPence, 5880); // £58.80 total
  const studioTotalVrsc = Number((studioTotalPence / 100 / config.gbpPerVrscRate).toFixed(4));
  assert.equal(studioTotalVrsc, 19.6); // 19.6 VRSC total
  assert.equal(Number((studio.priceVrsc * 1.2).toFixed(2)), 19.6);
});

test('SQLite Transactions: withImmediateTransaction executes atomically and handles rollback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovpin-tx-test-'));
  process.env.SOVPIN_DB_PATH = path.join(tmp, 'tx-test.sqlite');
  const db = getDb();

  // Test successful commit
  const ret = withImmediateTransaction(db, () => {
    db.prepare(`INSERT INTO blocked_cids (cid, reason, created_at) VALUES ('QmTxCommitTest', 'Test', '2026-01-01')`).run();
    return 'ok';
  });
  assert.equal(ret, 'ok');
  const row = db.prepare(`SELECT * FROM blocked_cids WHERE cid = 'QmTxCommitTest'`).get();
  assert.ok(row, 'Committed row should exist in database');

  // Test rollback on exception
  assert.throws(() => {
    withImmediateTransaction(db, () => {
      db.prepare(`INSERT INTO blocked_cids (cid, reason, created_at) VALUES ('QmTxRollbackTest', 'Test', '2026-01-01')`).run();
      throw new Error('Simulated failure');
    });
  }, /Simulated failure/);

  const rollbackRow = db.prepare(`SELECT * FROM blocked_cids WHERE cid = 'QmTxRollbackTest'`).get();
  assert.equal(rollbackRow, undefined, 'Rolled back row must not exist in database');

  fs.rmSync(tmp, { recursive: true, force: true });
});
