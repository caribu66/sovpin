const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SOVPIN_INTERNAL_SECRET = 'secret-box-unit-test-key';
const { sealSecret, openSecret, needsMigration } = require('../src/secret-box');

test('webhook secret round-trips through authenticated encryption', () => {
  const sealed = sealSecret('whsec_abc123def456');
  assert.ok(sealed.startsWith('enc1:'));
  const { secret, migrated } = openSecret(sealed);
  assert.equal(secret, 'whsec_abc123def456');
  assert.equal(migrated, true);
  assert.equal(needsMigration(sealed), false);
});

test('sealed payloads are non-deterministic and tamper-evident', () => {
  const a = sealSecret('whsec_abc123def456');
  const b = sealSecret('whsec_abc123def456');
  assert.notEqual(a, b);
  const tampered = a.slice(0, -2) + (a.endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => openSecret(tampered));
});

test('legacy plaintext rows are accepted once and flagged for migration', () => {
  const { secret, migrated } = openSecret('whsec_legacyrow0001');
  assert.equal(secret, 'whsec_legacyrow0001');
  assert.equal(migrated, false);
  assert.equal(needsMigration('whsec_legacyrow0001'), true);
});

test('garbage and wrong-format values fail closed', () => {
  assert.throws(() => openSecret(''));
  assert.throws(() => openSecret('not-a-secret'));
  assert.throws(() => openSecret('enc1:broken'));
});
