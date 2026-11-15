const test = require('node:test');
const assert = require('node:assert/strict');
const { getClientIp } = require('../src/client-ip');

function fakeReq({ cfConnectingIp, ip } = {}) {
  return {
    ip,
    get(name) {
      if (String(name).toLowerCase() === 'cf-connecting-ip') return cfConnectingIp;
      return undefined;
    },
  };
}

test('prefers CF-Connecting-IP over the loopback socket peer', () => {
  assert.equal(
    getClientIp(fakeReq({ cfConnectingIp: '203.0.113.7', ip: '127.0.0.1' })),
    '203.0.113.7'
  );
});

test('takes the first address from a chained CF-Connecting-IP value', () => {
  assert.equal(
    getClientIp(fakeReq({ cfConnectingIp: '203.0.113.7, 70.41.3.18', ip: '127.0.0.1' })),
    '203.0.113.7'
  );
});

test('falls back to the socket peer when the edge header is absent', () => {
  assert.equal(
    getClientIp(fakeReq({ cfConnectingIp: undefined, ip: '192.168.86.20' })),
    '192.168.86.20'
  );
});

test('never returns an empty identity', () => {
  assert.equal(getClientIp(fakeReq({})), 'anonymous');
  assert.equal(getClientIp(fakeReq({ cfConnectingIp: '   ', ip: '' })), 'anonymous');
});
