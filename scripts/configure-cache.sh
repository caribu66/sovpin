#!/usr/bin/env bash
# Configure Cloudflare Cache Rules for SovPin.
# Sets edge_ttl and browser_ttl to respect_origin on the sovpin.com zone.
# Kubo sets Cache-Control: public, max-age=29030400, immutable on 200 OK. Errors (4xx/5xx) are
# forced to no-store so an unpinned-then-pinned CID never stays 404.
# Usage: ./scripts/configure-cache.sh
set -euo pipefail

ZONE="sovpin.com"
RULESET_ID="2e7849d6314246df8346142659b21066"
CF_BIN="${CF_BIN:-$HOME/.local/bin/cf}"

echo "=== SovPin Cache Configuration ==="
echo "Zone: $ZONE"
echo ""

echo "[1/5] Updating cache ruleset (respect_origin for edge + browser TTL)..."
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

echo "[2/5] Never cache IPFS gateway errors at the edge..."
# A CID requested before it is pinned returns 404. Without this, the 1-year immutable header
# made Cloudflare (and browsers) keep that 404 after the pin landed.
"$CF_BIN" rulesets entrypoint update http_response_cache_settings -z "$ZONE" --body '{
  "rules": [
    {
      "action": "set_cache_control",
      "action_parameters": {
        "no-store": { "operation": "set" },
        "immutable": { "operation": "remove" },
        "max-age": { "operation": "remove" },
        "s-maxage": { "operation": "remove" }
      },
      "description": "Never cache IPFS gateway errors (a CID requested before it is pinned must not stay 404)",
      "enabled": true,
      "expression": "(starts_with(http.request.uri.path, \"/ipfs/\") and http.response.code ge 400)"
    }
  ]
}' >/dev/null

echo "[3/5] Hardening headers: immutable only on successful gateway responses..."
"$CF_BIN" rulesets entrypoint update http_response_headers_transform -z "$ZONE" --body '{
  "rules": [
    {
      "action": "rewrite",
      "action_parameters": { "headers": {
        "Cache-Control": { "operation": "set", "value": "public, max-age=31536000, immutable" },
        "Content-Security-Policy": { "operation": "set", "value": "sandbox" },
        "X-Content-Type-Options": { "operation": "set", "value": "nosniff" }
      } },
      "description": "Harden IPFS gateway responses",
      "enabled": true,
      "expression": "(starts_with(http.request.uri.path, \"/ipfs/\") and http.response.code lt 400)"
    },
    {
      "action": "rewrite",
      "action_parameters": { "headers": {
        "Cache-Control": { "operation": "set", "value": "no-store" },
        "Content-Security-Policy": { "operation": "set", "value": "sandbox" },
        "X-Content-Type-Options": { "operation": "set", "value": "nosniff" }
      } },
      "description": "IPFS gateway errors are never cached (a CID requested before it is pinned must not stay 404)",
      "enabled": true,
      "expression": "(starts_with(http.request.uri.path, \"/ipfs/\") and http.response.code ge 400)"
    }
  ]
}' >/dev/null

echo "[4/5] Purging zone cache..."
"$CF_BIN" cache purge -z "$ZONE" -f --body '{"purge_everything":true}'

echo "[5/5] Ensuring rate limit ruleset (200 req/10s per IP on /ipfs/*)..."
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