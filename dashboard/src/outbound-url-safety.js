const dns = require('node:dns').promises;
const net = require('node:net');

class UnsafeOutboundUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeOutboundUrlError';
    this.code = 'UNSAFE_OUTBOUND_URL';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.arpa'];

function normalizeHostname(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // Strip trailing dot for FQDNs.
  host = host.replace(/\.$/, '');
  // Normalize IPv4-mapped IPv6 textual forms if present.
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) host = mapped;
  }
  return host;
}

function isBlockedHostname(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidrV4(ipInt, base, maskBits) {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  const cidrs = [
    ['0.0.0.0', 8],        // "this" network
    ['10.0.0.0', 8],       // RFC1918
    ['100.64.0.0', 10],    // CGNAT
    ['127.0.0.0', 8],      // loopback
    ['169.254.0.0', 16],   // link-local
    ['172.16.0.0', 12],    // RFC1918
    ['192.0.0.0', 24],     // IETF protocol assignments
    ['192.0.2.0', 24],     // TEST-NET-1
    ['192.88.99.0', 24],   // 6to4 relay anycast (deprecated)
    ['192.168.0.0', 16],   // RFC1918
    ['198.18.0.0', 15],    // benchmark
    ['198.51.100.0', 24],  // TEST-NET-2
    ['203.0.113.0', 24],   // TEST-NET-3
    ['224.0.0.0', 4],      // multicast
    ['240.0.0.0', 4],      // reserved/future + broadcast
  ];
  for (const [baseIp, bits] of cidrs) {
    const base = ipv4ToInt(baseIp);
    if (base !== null && inCidrV4(n, base, bits)) return true;
  }
  return false;
}

function parseIpv6ToBigInt(ip) {
  let input = ip.toLowerCase();
  const zoneIndex = input.indexOf('%');
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);

  // Handle embedded IPv4 in last segment (e.g. ::ffff:127.0.0.1)
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = input.slice(lastColon + 1);
    if (net.isIP(v4) !== 4) return null;
    const n = ipv4ToInt(v4);
    if (n === null) return null;
    const hi = ((n >>> 16) & 0xffff).toString(16);
    const lo = (n & 0xffff).toString(16);
    input = `${input.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const parts = input.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').filter((x) => x.length > 0) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').filter((x) => x.length > 0) : [];
  const fill = 8 - (left.length + right.length);
  if (parts.length === 2) {
    if (fill < 0) return null;
  } else if (fill !== 0) {
    return null;
  }
  const full = parts.length === 2 ? [...left, ...Array(fill).fill('0'), ...right] : left;
  if (full.length !== 8) return null;
  let value = 0n;
  for (const hextet of full) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null;
    value = (value << 16n) + BigInt(parseInt(hextet, 16));
  }
  return value;
}

function ipv6InCidr(addr, base, prefix) {
  if (addr === null || base === null) return false;
  const shift = 128n - BigInt(prefix);
  if (shift < 0n) return false;
  const mask = shift === 128n ? 0n : (((1n << 128n) - 1n) >> shift) << shift;
  // simpler: compare top prefix bits
  return ((addr >> shift) === (base >> shift));
}

function isPrivateIpv6(ip) {
  const addr = parseIpv6ToBigInt(ip);
  if (addr === null) return true;
  const ranges = [
    ['::', 128],           // unspecified
    ['::1', 128],          // loopback
    ['fc00::', 7],         // unique local
    ['fe80::', 10],        // link-local
    ['ff00::', 8],         // multicast
    ['2001:db8::', 32],    // documentation
    ['100::', 64],         // discard-only
    ['64:ff9b::', 96],     // IPv4/IPv6 translation (well-known prefix)
    ['64:ff9b:1::', 48],   // local IPv4/IPv6 translation
  ];
  for (const [baseIp, prefix] of ranges) {
    const base = parseIpv6ToBigInt(baseIp);
    if (ipv6InCidr(addr, base, prefix)) return true;
  }

  // IPv4-mapped ::ffff:0:0/96
  const mappedBase = parseIpv6ToBigInt('::ffff:0:0');
  if (ipv6InCidr(addr, mappedBase, 96)) {
    const v4Int = Number(addr & 0xffffffffn);
    const v4 = `${(v4Int >>> 24) & 255}.${(v4Int >>> 16) & 255}.${(v4Int >>> 8) & 255}.${v4Int & 255}`;
    return isPrivateIpv4(v4);
  }
  return false;
}

function isUnsafeIpAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true;
}

function isNumericHostLiteral(host) {
  // Catches decimal/octal/hex integer IPv4 forms and other non-standard numeric literals.
  if (/^(0x[0-9a-f]+|0[0-7]*|[0-9]+)$/i.test(host)) return true;
  if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host)) return true; // dotted (valid or not, validate separately)
  if (/^0x[0-9a-f]+(\.0x?[0-9a-f]+)*$/i.test(host)) return true;
  return false;
}

function validateParsedUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(String(urlString || '').trim());
  } catch {
    throw new UnsafeOutboundUrlError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError('Only http(s) webhook URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeOutboundUrlError('Webhook URLs must not include credentials');
  }
  const host = normalizeHostname(parsed.hostname);
  if (!host) throw new UnsafeOutboundUrlError('Webhook URL must include a host');
  if (isBlockedHostname(host)) {
    throw new UnsafeOutboundUrlError('Webhook URL host is not allowed');
  }

  const ipKind = net.isIP(host);
  if (ipKind) {
    if (isUnsafeIpAddress(host)) {
      throw new UnsafeOutboundUrlError('Webhook URL must not target a private or local IP address');
    }
  } else if (isNumericHostLiteral(host)) {
    throw new UnsafeOutboundUrlError('Numeric or non-standard IP host literals are not allowed');
  }

  return { parsed, host };
}

async function assertSafeOutboundUrl(urlString, { resolveDns = false } = {}) {
  const { host } = validateParsedUrl(urlString);

  if (!resolveDns) return;
  if (net.isIP(host)) return; // already validated as public literal

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    // Fail closed: if DNS cannot be resolved at validation time, reject.
    throw new UnsafeOutboundUrlError('Webhook hostname could not be resolved');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new UnsafeOutboundUrlError('Webhook hostname did not resolve to any address');
  }
  for (const record of records) {
    const addr = normalizeHostname(record?.address || '');
    if (!addr || isUnsafeIpAddress(addr)) {
      throw new UnsafeOutboundUrlError('Webhook hostname resolves to a private or local IP address');
    }
  }
}

module.exports = {
  UnsafeOutboundUrlError,
  assertSafeOutboundUrl,
  validateParsedUrl,
  isUnsafeIpAddress,
  normalizeHostname,
};
