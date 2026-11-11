#!/usr/bin/env bash
# Configure Cloudflare Cache Rules for SovPin.
# Sets edge_ttl and browser_ttl to respect_origin on the sovpin.com zone.
# Kubo sets Cache-Control: public, max-age=29030400, immutable on 200 OK.
# Usage: ./scripts/configure-cache.sh
set -euo pipefail

ZONE="sovpin.com"
RULESET_ID="2e7849d6314246df8346142659b21066"

echo "=== SovPin Cache Configuration ==="
echo "Zone: $ZONE"
echo ""

echo "[1/2] Updating cache ruleset (respect_origin for edge + browser TTL)..."
/home/demon/.local/bin/cf rulesets update "$RULESET_ID" -z "$ZONE" --body '{
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

echo "[2/2] Purging zone cache..."
/home/demon/.local/bin/cf cache purge -z "$ZONE" -f --body '{"purge_everything":true}'

echo ""
echo "=== Cache configured. Verify with: ==="
echo "  curl -sI https://ipfs.sovpin.com/ipfs/QmdJN78YiEAzh8xQ59YMsMW635cXtr24RDSz6zuJr1NyFk"
echo "  # Expect: HTTP/2 200, cf-cache-status: HIT, cache-control: public, max-age=29030400, immutable"