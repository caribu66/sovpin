const test = require('node:test');
const assert = require('node:assert/strict');
const {
  UnsafeOutboundUrlError,
  assertSafeOutboundUrl,
  validateParsedUrl,
  isUnsafeIpAddress,
} = require('../src/outbound-url-safety');

function rejectsSync(url) {
  assert.throws(() => validateParsedUrl(url), UnsafeOutboundUrlError);
}

test('rejects non-http schemes, credentials, and missing hosts', () => {
  rejectsSync('ftp://example.com/hook');
  rejectsSync('https://user:pass@example.com/hook');
  rejectsSync('not a url');
});

test('rejects single-label intranet hostnames', () => {
  rejectsSync('https:///hook'); // WHATWG collapses this to host `hook`
  rejectsSync('https://intranet/hook');
  rejectsSync('https://hook./hook');
});

test('rejects loopback, private, and link-local literals (v4)', () => {
  rejectsSync('https://127.0.0.1/hook');
  rejectsSync('http://10.0.0.5/hook');
  rejectsSync('http://192.168.1.1/hook');
  rejectsSync('http://172.16.9.9/hook');
  rejectsSync('http://169.254.169.254/latest');
  rejectsSync('http://0.0.0.0/hook');
  assert.equal(isUnsafeIpAddress('127.0.0.1'), true);
  assert.equal(isUnsafeIpAddress('8.8.8.8'), false);
});

test('rejects disguised numeric literals (decimal, octal, hex)', () => {
  rejectsSync('http://2130706433/hook'); // 127.0.0.1 as decimal
  rejectsSync('http://0177.0.0.1/hook'); // octal dotted
  rejectsSync('http://0x7f.0x0.0x0.0x1/hook'); // hex dotted
  rejectsSync('http://0x7f000001/hook'); // hex integer
});

test('rejects IPv6 loopback, unspecified, mapped, and ULA forms', () => {
  rejectsSync('http://[::1]/hook');
  rejectsSync('http://[::]/hook');
  rejectsSync('http://[::ffff:127.0.0.1]/hook');
  rejectsSync('http://[::ffff:7f00:1]/hook');
  rejectsSync('http://[fc00::1]/hook');
  rejectsSync('http://[fe80::1]/hook');
  assert.equal(isUnsafeIpAddress('::1'), true);
  assert.equal(isUnsafeIpAddress('::ffff:127.0.0.1'), true);
  assert.equal(isUnsafeIpAddress('2606:4700:4700::1111'), false);
});

test('rejects metadata and internal hostnames', () => {
  rejectsSync('http://metadata.google.internal/hook');
  rejectsSync('http://instance-data/hook');
  rejectsSync('http://localhost/hook');
  rejectsSync('http://LOCALHOST:8080/hook');
  rejectsSync('http://service.internal/hook');
  rejectsSync('http://host.local/hook');
});

test('accepts public literals and public hostnames (syntax only)', () => {
  const { host } = validateParsedUrl('https://8.8.8.8/hook');
  assert.equal(host, '8.8.8.8');
  const named = validateParsedUrl('https://example.com/ipfs/hook');
  assert.equal(named.host, 'example.com');
});

test('DNS validation fails closed on private resolution', async () => {
  // localhost resolves via the local hosts file — no external DNS needed.
  await assert.rejects(
    assertSafeOutboundUrl('https://localhost/hook', { resolveDns: true }),
    UnsafeOutboundUrlError
  );
});

test('DNS validation fails closed when the name cannot resolve', async () => {
  // Over-long label: getaddrinfo rejects it locally without network I/O.
  const bad = `https://${'a'.repeat(64)}.example/hook`;
  await assert.rejects(assertSafeOutboundUrl(bad, { resolveDns: true }), UnsafeOutboundUrlError);
});
