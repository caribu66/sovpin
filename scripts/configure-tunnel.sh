#!/usr/bin/env bash
# Configure the Cloudflare Tunnel for SovPin.
# Routes ipfs.sovpin.com (^/ipfs/[A-Za-z0-9]+) → http://100.66.85.86:8080
# Usage: ./scripts/configure-tunnel.sh
set -euo pipefail

TUNNEL_ID="990fae36-b92b-457b-af17-5737ed2d8a35"
TAILSCALE_IP="100.66.85.86"
CF_BIN="${CF_BIN:-$HOME/.local/bin/cf}"

echo "=== SovPin Cloudflare Tunnel Configuration ==="
echo "Tunnel: $TUNNEL_ID"
echo ""

# Fetch current config
echo "[1/3] Fetching current tunnel config..."
CURRENT=$("$CF_BIN" tunnels config get "$TUNNEL_ID" --quiet 2>/dev/null || true)

# Build new ingress (prepend sovpin rule, keep existing rules)
echo "[2/3] Updating tunnel ingress..."
"$CF_BIN" tunnels config update "$TUNNEL_ID" --body '{
  "config": {
    "ingress": [
      {
        "hostname": "dashboard.sovpin.com",
        "service": "http://127.0.0.1:3001"
      },
      {
        "hostname": "ipfs.sovpin.com",
        "path": "^/ipfs/[A-Za-z0-9]+",
        "service": "http://100.66.85.86:8080"
      },
      {
        "hostname": "vreal.live",
        "service": "http://127.0.0.1:3000"
      },
      {
        "hostname": "www.vreal.live",
        "service": "http://127.0.0.1:3000"
      },
      {
        "hostname": "alerts.vreal.live",
        "path": "^/webhook/c13059b6597860fbae4b14adb72780736644e5b2b4d61d7a8580d9719877beb4$",
        "service": "http://127.0.0.1:1880"
      },
      {
        "hostname": "veruspulse.com",
        "service": "http://127.0.0.1:3000"
      },
      {
        "hostname": "www.veruspulse.com",
        "service": "http://127.0.0.1:3000"
      },
      {
        "service": "http_status:404"
      }
    ],
    "warp-routing": {
      "enabled": false
    }
  }
}'

echo "[3/3] Verifying..."
if command -v jq >/dev/null 2>&1; then
  "$CF_BIN" tunnels config get "$TUNNEL_ID" | jq -r '.config.ingress[] | "  \(.hostname // "(catch-all)") → \(.service)"'
else
  "$CF_BIN" tunnels config get "$TUNNEL_ID" | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(f"  {i.get(\"hostname\",\"(catch-all)\")} → {i.get(\"service\")}\") for i in d.get("config",{}).get("ingress",[])]'
fi

echo ""
echo "=== Tunnel configured ==="