#!/usr/bin/env bash
# Configure Cloudflare edge rate limiting for SovPin auth endpoints.
# Caps /v1/auth/* at 20 req/10s per IP to slow credential-stuffing / bot floods
# before they reach the origin. Complements the in-process buckets in saas-routes.js.
# Usage: ./scripts/configure-auth-ratelimit.sh
set -euo pipefail

ZONE="sovpin.com"
CF_BIN="/home/chromebook/.local/bin/cf"

echo "=== SovPin Auth Rate Limit (edge) ==="
echo "Zone: $ZONE"
echo ""

echo "[1/1] Creating http_ratelimit ruleset for /v1/auth/* (20 req/10s per IP)..."
"$CF_BIN" rulesets create -z "$ZONE" --body '{
  "name": "sovpin_auth_ratelimit",
  "kind": "zone",
  "phase": "http_ratelimit",
  "rules": [
    {
      "action": "block",
      "ratelimit": {
        "characteristics": ["cf.colo.id", "ip.src"],
        "period": 10,
        "requests_per_period": 20,
        "mitigation_timeout": 60
      },
      "expression": "(starts_with(http.request.uri.path, \"/v1/auth/\"))",
      "description": "Rate limit SovPin auth endpoints: 20 req/10s per IP",
      "enabled": true
    }
  ]
}' >/dev/null 2>&1 || echo "  (Ruleset already exists — update it manually via the dashboard)"

echo ""
echo "=== Done. Verify with: ==="
echo "  for i in \$(seq 1 25); do curl -s -o /dev/null -w '%{http_code}\\n' https://dashboard.sovpin.com/v1/auth/challenge -X POST -d '{}'; done"
echo "  # Expect: first ~20 return 4xx/2xx, then 429."
