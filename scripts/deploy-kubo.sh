#!/usr/bin/env bash
# Deploy or update the Kubo IPFS node on the MacBook via Tailscale.
# Usage: ./scripts/deploy-kubo.sh
set -euo pipefail

MACBOOK="macbook@192.168.86.110"
SSH_KEY="$HOME/.ssh/vreal_mirror_ed25519"
TAILSCALE_IP="100.66.85.86"

echo "=== SovPin Kubo Deploy ==="
echo "Target: $MACBOOK (Tailscale: $TAILSCALE_IP)"
echo ""

# Copy docker-compose.yml to MacBook
echo "[1/4] Copying docker-compose.yml..."
scp -i "$SSH_KEY" docker-compose.yml "$MACBOOK:/tmp/sovpin-docker-compose.yml"

# Deploy on MacBook
echo "[2/4] Deploying Kubo container..."
ssh -i "$SSH_KEY" "$MACBOOK" '
  set -e
  # Fix volume permissions (Kubo runs as UID 1000)
  docker run --rm --privileged -v kubo-data:/data alpine chown -R 1000:1000 /data >/dev/null 2>&1 || true
  docker compose -f /tmp/sovpin-docker-compose.yml up -d --force-recreate
  sleep 6
'

# Verify
echo "[3/4] Verifying Kubo..."
ssh -i "$SSH_KEY" "$MACBOOK" 'docker ps --format "  {{.Names}}: {{.Status}} {{.Ports}}" | grep kubo'

echo "[4/4] Testing endpoints..."
curl -sf -X POST -m 5 "http://$TAILSCALE_IP:5001/api/v0/version" | jq -r '"  RPC: \(.Version) (\(.Commit))"'
curl -sf -m 5 "http://$TAILSCALE_IP:8080/ipfs/QmdJN78YiEAzh8xQ59YMsMW635cXtr24RDSz6zuJr1NyFk" -o /dev/null -w "  Gateway: HTTP %{http_code}\n"

echo ""
echo "=== Deploy complete ==="