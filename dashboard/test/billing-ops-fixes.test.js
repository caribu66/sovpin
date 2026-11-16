const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function quoteForPlan(priceGbpPence, spotRateGbp) {
  const subtotalPence = priceGbpPence;
  const vatPence = Math.round(subtotalPence / 5);
  const totalPence = subtotalPence + vatPence;
  const amountSatoshi = Math.round((totalPence / 100 / spotRateGbp) * 1e8);
  return { subtotalPence, vatPence, totalPence, amountSatoshi, amountVrsc: amountSatoshi / 1e8 };
}

test('indie quote is integer-pence with satoshi-exact VRSC', () => {
  const q = quoteForPlan(1200, 3.0);
  assert.equal(q.subtotalPence, 1200);
  assert.equal(q.vatPence, 240);
  assert.equal(q.totalPence, 1440);
  assert.equal(q.amountSatoshi, 480000000);
  assert.equal(q.amountVrsc, 4.8);
});

test('studio quote is integer-pence with satoshi-exact VRSC', () => {
  const q = quoteForPlan(4900, 3.0);
  assert.equal(q.vatPence, 980);
  assert.equal(q.totalPence, 5880);
  assert.equal(q.amountSatoshi, 1960000000);
  assert.equal(q.amountVrsc, 19.6);
});

test('arbitrary spot rate stays satoshi-integer (no float dust)', () => {
  const q = quoteForPlan(1200, 2.37);
  assert.equal(Number.isInteger(q.amountSatoshi), true);
  assert.equal(q.amountVrsc, q.amountSatoshi / 1e8);
});

test('db migration adds sessions.expires_at index and invoices satoshi column', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovpin-test-'));
  process.env.SOVPIN_DB_PATH = path.join(tmp, 'test.sqlite');
  delete require.cache[require.resolve('../src/db')];
  const { getDb } = require('../src/db');
  const db = getDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_expires_at'").get();
  assert.ok(idx, 'idx_sessions_expires_at must exist');
  const cols = db.prepare('PRAGMA table_info(invoices)').all();
  assert.ok(cols.some((c) => c.name === 'amount_vrsc_sat'), 'invoices.amount_vrsc_sat must exist');
});

test('plans carry no float VRSC field (integer pence only)', () => {
  const config = require('../src/config');
  for (const plan of Object.values(config.PLANS)) {
    assert.ok(!('priceVrsc' in plan), `${plan.id} must not carry priceVrsc`);
    assert.equal(Number.isInteger(plan.priceGbpPence), true);
  }
});

test('pins status-only index exists for GC candidate scans', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovpin-test-'));
  process.env.SOVPIN_DB_PATH = path.join(tmp, 'test.sqlite');
  delete require.cache[require.resolve('../src/db')];
  const { getDb } = require('../src/db');
  const db = getDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pins_status'").get();
  assert.ok(idx, 'idx_pins_status must exist');
});

const crypto = require('node:crypto');

function stripeHeaderFor(payload, secret, ts) {
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`, 'utf8').digest('hex');
  return `t=${ts},v1=${v1}`;
}

test('stripe webhook: fresh signature verifies, stale/tampered do not', () => {
  const routes = require('../src/saas-routes');
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ type: 'checkout.session.completed' });
  const freshTs = Math.floor(Date.now() / 1000);
  assert.equal(routes.verifyStripeWebhookSignature(payload, stripeHeaderFor(payload, secret, freshTs), secret), true);
  const staleTs = freshTs - (routes.STRIPE_WEBHOOK_TOLERANCE_SEC + 60);
  assert.equal(routes.verifyStripeWebhookSignature(payload, stripeHeaderFor(payload, secret, staleTs), secret), false);
  const futureTs = freshTs + routes.STRIPE_WEBHOOK_TOLERANCE_SEC + 60;
  assert.equal(routes.verifyStripeWebhookSignature(payload, stripeHeaderFor(payload, secret, futureTs), secret), false);
  const badSig = `t=${freshTs},v1=${'0'.repeat(64)}`;
  assert.equal(routes.verifyStripeWebhookSignature(payload, badSig, secret), false);
  assert.equal(routes.verifyStripeWebhookSignature(payload, '', secret), false);
  assert.equal(routes.verifyStripeWebhookSignature(payload, stripeHeaderFor(payload, secret, freshTs), ''), false);
});

test('invoice number generator format and unique-violation classifier', () => {
  const routes = require('../src/saas-routes');
  for (let i = 0; i < 50; i++) {
    assert.match(routes.generateInvoiceNumber('20261116'), /^UK-SVP-20261116-\d{4}$/);
  }
  assert.equal(routes.isUniqueConstraintViolation({ code: 'ERR_SQLITE_CONSTRAINT_UNIQUE' }), true);
  assert.equal(routes.isUniqueConstraintViolation(new Error('UNIQUE constraint failed: invoices.invoice_number')), true);
  assert.equal(routes.isUniqueConstraintViolation(new Error('boom')), false);
  assert.equal(routes.isUniqueConstraintViolation(null), false);
});

test('ops scripts have jq fallback and restore integrity gate', () => {
  const tunnel = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'configure-tunnel.sh'), 'utf8');
  const kubo = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'deploy-kubo.sh'), 'utf8');
  const restore = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'sovpin-restore.sh'), 'utf8');
  assert.ok(tunnel.includes('command -v jq'), 'tunnel script must handle missing jq');
  assert.ok(kubo.includes('command -v jq'), 'kubo script must handle missing jq');
  assert.ok(restore.includes('integrity_check'), 'restore must verify integrity');
  assert.ok(restore.includes('--force'), 'restore must require --force for live DB');
});
