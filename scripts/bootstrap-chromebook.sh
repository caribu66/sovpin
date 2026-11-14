#!/usr/bin/env bash
# SovPin bootstrap for a Chromebook (Crostini/Debian). Run as the Linux user.
set -euo pipefail

echo "==> Installing prerequisites"
sudo apt-get update
sudo apt-get install -y git curl nodejs npm caddy tailscale

echo "==> Cloning SovPin"
mkdir -p "$HOME/src"
cd "$HOME/src"
if [ ! -d sovpin ]; then
  git clone https://github.com/<your-org>/sovpin.git sovpin
fi
cd sovpin

echo "==> Installing dashboard deps"
cd dashboard
npm ci
npm run build:web

echo "==> Configuring .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "EDIT $HOME/src/sovpin/dashboard/.env now (set VERUS_RPC_*, KUBO_*, SOVPIN_SIGNER_WIF, secrets)."
  echo "Then re-run this script with --run."
  exit 0
fi

if [ "${1:-}" != "--run" ]; then
  echo "Config present. Re-run with --run to start services."
  exit 0
fi

echo "==> Starting SovPin under pm2"
sudo npm i -g pm2
pm2 delete sovpin 2>/dev/null || true
pm2 start server.js --name sovpin
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

echo "==> Installing Caddy (best-of-best TLS)"
sudo bash "$HOME/src/sovpin/scripts/setup-caddy.sh"

echo "==> Done. Check: curl http://127.0.0.1:3001/healthz"
echo "    Then migrate dashboard/data/sovpin.sqlite from the old host."