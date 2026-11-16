#!/usr/bin/env bash
# Configure Cloudflare Cache Rules for SovPin.
# Sets edge_ttl and browser_ttl to respect_origin on the sovpin.com zone.
# Kubo sets Cache-Control: public, max-age=29030400, immutable on 200 OK.
# Usage: ./scripts/configure-cache.sh
set -euo pipefail

ZONE="sovpin.com"
RULESET_ID="2e7849d6314246df8346142659b21066"
CF_BIN="${CF_BIN:-$HOME/.local/bin/cf}"

echo "=== SovPin Cache Configuration ==="
echo "Zone: $ZONE"
echo ""

echo "[1/2] Updating cache ruleset (respect_origin for edge + browser TTL)..."
"$CF_BIN" rulesets update "$RULESET_ID" -z "$ZONE" --body '{
  "rules": [
    {
      "action": "set_cache_settings",
      "action_parameters": {
        "cache": true,
        "edge_ttl": {
          "mode": "respect_origin"
        },
        "browser_ttl": {
          "mode": "respect_origin"
        }
      },
      "description": "Immutable IPFS CIDs",
      "enabled": true,
      "expression": "(starts_with(http.request.uri.path, \"/ipfs/\"))"
    }
  ]
}'

echo "[2/3] Purging zone cache..."
"$CF_BIN" cache purge -z "$ZONE" -f --body '{"purge_everything":true}'

echo "[3/3] Ensuring rate limit ruleset (200 req/10s per IP on /ipfs/*)..."
"$CF_BIN" rulesets create -z "$ZONE" --body '{
  "name": "rate_limiting",
  "kind": "zone",
  "phase": "http_ratelimit",
  "rules": [
    {
      "action": "block",
      "ratelimit": {
        "characteristics": ["cf.colo.id", "ip.src"],
        "period": 10,
        "requests_per_period": 200,
        "mitigation_timeout": 10
      },
      "expression": "(starts_with(http.request.uri.path, \"/ipfs/\"))",
      "description": "Rate limit IPFS gateway: 200 req/10s per IP",
      "enabled": true
    }
  ]
}' >/dev/null 2>&1 || echo "  (Rate limit ruleset already exists)"

echo ""
echo "=== Cache configured. Verify with: ==="
echo "  curl -sI https://ipfs.sovpin.com/ipfs/QmdJN78YiEAzh8xQ59YMsMW635cXtr24RDSz6zuJr1NyFk"
echo "  # Expect: HTTP/2 200, cf-cache-status: HIT, cache-control: public, max-age=29030400, immutable"