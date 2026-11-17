const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { after } = test;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovpin-reservations-'));
process.env.SOVPIN_DB_PATH = path.join(tempDir, 'reservations.db');
const dbModule = require('../src/db');
const db = dbModule.getDb();
const owner = 'iLeaseTest';
db.prepare(
  'INSERT INTO tenants (i_address, friendly_name, created_at, updated_at) VALUES (?, ?, ?, ?)'
).run(owner, 'Lease test', new Date().toISOString(), new Date().toISOString());

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('reservation lease renews, expires and releases temporary pins', () => {

  const cid = 'bafybeigdyrzt5sfp7udm7hu76uhdpx4gd5x2u7n2h7yq5v5y5q5q5q5q5q';
  const pin = dbModule.upsertActivePinRecord({ iAddress: owner, cid, name: 'lease', sha256Hex: '', temporary: true });
  const reservationId = dbModule.createPinReservation({ iAddress: owner, requestId: pin.request_id, cid });
  assert.match(reservationId, /^res_[a-f0-9]{48}$/);

  const start = Date.now();
  assert.equal(dbModule.attachPinReservation(reservationId, owner, 2 * 24 * 60 * 60 * 1000), true);
  const lease = db.prepare('SELECT expires_at FROM pin_reservations WHERE reservation_id = ?').get(reservationId);
  assert.ok(lease.expires_at >= start + 2 * 24 * 60 * 60 * 1000);
  assert.equal(dbModule.attachPinReservation(reservationId, 'iWrongOwner', 1000), false);

  db.prepare('UPDATE pin_reservations SET expires_at = ? WHERE reservation_id = ?').run(Date.now() - 1, reservationId);
  assert.deepEqual(dbModule.expirePinReservations(), [cid]);
  assert.equal(db.prepare('SELECT status FROM pins WHERE cid = ?').get(cid).status, 'unpinned');
  assert.equal(db.prepare('SELECT temporary FROM pins WHERE cid = ?').get(cid).temporary, 1);
  assert.deepEqual(dbModule.expirePinReservations(), [cid]);
  dbModule.completeTemporaryPinRelease(cid);
  assert.deepEqual(dbModule.expirePinReservations(), []);
});

test('commit makes a reservation permanent and release does not unpin it', () => {
  const cid = 'bafybeigdyrzt5sfp7udm7hu76uhdpx4gd5x2u7n2h7yq5v5y5q5q5q5q6';
  const row = dbModule.upsertActivePinRecord({ iAddress: owner, cid, name: 'committed', sha256Hex: '', temporary: true });
  const reservationId = dbModule.createPinReservation({ iAddress: owner, requestId: row.request_id, cid });
  assert.equal(dbModule.settlePinReservation(reservationId, owner, 'commit').committed, true);
  assert.equal(db.prepare('SELECT temporary FROM pins WHERE request_id = ?').get(row.request_id).temporary, 0);
  assert.equal(dbModule.settlePinReservation(reservationId, owner, 'release').removedFromKubo, false);
  assert.equal(db.prepare('SELECT status FROM pins WHERE request_id = ?').get(row.request_id).status, 'pinned');
});

test('releasing a temporary pin preserves a CID with another permanent reference', () => {
  const cid = 'bafybeigdyrzt5sfp7udm7hu76uhdpx4gd5x2u7n2h7yq5v5y5q5q5q5q7';
  const secondOwner = 'iLeaseTestSecond';
  db.prepare(
    'INSERT INTO tenants (i_address, friendly_name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(secondOwner, 'Second lease test', new Date().toISOString(), new Date().toISOString());
  const permanent = dbModule.upsertActivePinRecord({ iAddress: owner, cid, name: 'permanent', sha256Hex: '' });
  const temporary = dbModule.upsertActivePinRecord({ iAddress: secondOwner, cid, name: 'temporary', sha256Hex: '', temporary: true });
  const reservationId = dbModule.createPinReservation({ iAddress: secondOwner, requestId: temporary.request_id, cid });
  assert.equal(dbModule.settlePinReservation(reservationId, secondOwner, 'release').removedFromKubo, false);
  assert.equal(db.prepare('SELECT status FROM pins WHERE request_id = ?').get(permanent.request_id).status, 'pinned');
});
