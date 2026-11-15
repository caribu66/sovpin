// Client IP resolution behind the Cloudflare Tunnel.
// The dashboard sits behind cloudflared on loopback, so req.ip is 127.0.0.1
// for every public visitor. Cloudflare sets CF-Connecting-IP per request and
// clients cannot spoof it through the edge, so rate-limit buckets and audit
// identity use it first and fall back to the socket peer otherwise.
function getClientIp(req) {
  const cfIp = (req.get && req.get('cf-connecting-ip')) || '';
  const first = String(cfIp).split(',')[0].trim();
  if (first) return first;
  return (req.ip || 'anonymous').trim() || 'anonymous';
}

module.exports = { getClientIp };
