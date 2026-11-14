#!/usr/bin/env bash
# Best-of-the-best origin TLS setup for SovPin (Caddy + hardening).
# Run as root on the Debian host that runs the SovPin dashboard.
set -euo pipefail

DOMAIN="${SOVPIN_DOMAIN:-dashboard.sovpin.com}"
APP_PORT="${SOVPIN_APP_PORT:-3001}"

# 1. Install Caddy (official repo)
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# 2. Write Caddyfile
mkdir -p /var/log/caddy
cat >/etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    tls {
        protocols tls1.2 tls1.3
        curves x25519 secp384r1
    }
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "geolocation=(), microphone=(), camera=()"
        -Server
    }
    encode zstd gzip
    reverse_proxy 127.0.0.1:${APP_PORT} {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
        health_uri /healthz
        health_interval 10s
    }
    log {
        output file /var/log/caddy/sovpin.log {
            roll_size 100mb
            roll_keep 10
        }
        format json
    }
}
www.${DOMAIN} {
    redir https://${DOMAIN}{uri} permanent
}
EOF

# 3. Firewall (ufw) — only 22/80/443 exposed; 3001 stays loopback-only
if command -v ufw >/dev/null 2>&1; then
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
fi

# 4. Enable + reload Caddy
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "Caddy + firewall configured for ${DOMAIN} -> 127.0.0.1:${APP_PORT}"
echo "Next: in Cloudflare set SSL/TLS to 'Full (strict)', enable WAF + rate limits, submit HSTS preload."
EOF
chmod +x /home/demon/sovpin/scripts/setup-caddy.sh
echo "written"