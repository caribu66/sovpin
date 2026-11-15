const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { parsePinDateBound, resolvePinDateRange } = require('../src/pin-date-range');

test('pins date filter: date-only bounds expand to the full UTC day', () => {
  assert.equal(parsePinDateBound('2026-11-01', false), '2026-11-01T00:00:00.000Z');
  assert.equal(parsePinDateBound('2026-11-15', true), '2026-11-15T23:59:59.999Z');
});

test('pins date filter: full timestamps pass through as instants', () => {
  assert.equal(
    parsePinDateBound('2026-11-15T10:30:00.000Z', true),
    '2026-11-15T10:30:00.000Z'
  );
  assert.equal(parsePinDateBound('', false), null);
  assert.equal(parsePinDateBound(undefined, false), null);
  assert.equal(parsePinDateBound('not-a-date', false), undefined);
});

test('pins date filter: invalid input and reversed ranges report errors', () => {
  assert.ok(resolvePinDateRange({ from: 'nope' }).error);
  assert.ok(resolvePinDateRange({ from: '2026-11-15', to: '2026-11-01' }).error);
  assert.equal(resolvePinDateRange({}).error, undefined);
});

test('pins date filter: SQL range over ISO created_at keeps boundary rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE pins (cid TEXT, created_at TEXT)');
  const insert = db.prepare('INSERT INTO pins (cid, created_at) VALUES (?, ?)');
  insert.run('before', '2026-10-31T23:59:59.999Z');
  insert.run('start-edge', '2026-11-01T00:00:00.000Z');
  insert.run('mid', '2026-11-08T12:00:00.000Z');
  insert.run('end-edge', '2026-11-15T23:59:59.000Z');
  insert.run('after', '2026-11-16T00:00:00.000Z');

  const { fromBound, toBound, error } = resolvePinDateRange({
    from: '2026-11-01',
    to: '2026-11-15',
  });
  assert.equal(error, undefined);
  const rows = db
    .prepare('SELECT cid FROM pins WHERE created_at >= ? AND created_at <= ? ORDER BY created_at')
    .all(fromBound, toBound)
    .map((r) => r.cid);
  assert.deepEqual(rows, ['start-edge', 'mid', 'end-edge']);
  db.close();
});
