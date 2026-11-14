# SovPin Migration: Chromebook (App) + MacBook (Daemon + Storage)

## Goal
Move the SovPin dashboard/API (and its SQLite ledger) to a Chromebook for isolation.
The MacBook keeps **only** the Verus daemon (`verusd`) and Kubo (IPFS) + its hard drive.

## Topology after migration

```
┌──────────────────────┐         ┌──────────────────────────────┐
│  Chromebook          │         │  MacBook (192.168.86.110)     │
│  ─ SovPin dashboard  │  RPC    │  ─ verusd (port 25779)        │
│  ─ SQLite ledger     │ ──────► │  ─ Kubo RPC (5001)            │
│  ─ Caddy (TLS)       │  Tailscale/ │  ─ Kubo gateway (8080)      │
│  ─ Cloudflare tunnel │  LAN    │  ─ hard drive (storage)       │
└──────────────────────┘         └──────────────────────────────┘
```

## 1. MacBook (daemon + storage only)

- Keep `verusd` running (chain VRSCTEST/VRSC) on `0.0.0.0:25779` with `rpcallowip` covering the Chromebook's IP (LAN `192.168.86.0/24` and/or Tailscale `100.64.0.0/10`).
- Keep Kubo on Tailscale IP `100.66.85.86:5001` (RPC) and `:8080` (gateway).
- Firewall: allow inbound 25779, 5001, 8080 only from the Chromebook/Tailscale. Block everything else.
- Remove the SovPin dashboard, node, Caddy, cloudflared from the MacBook (free the machine).
- Ensure the hard drive mount is stable and Kubo's storage path points at it.

## 2. Chromebook (app host)

### 2.1 Linux environment
Use ChromeOS Linux (Crostini) or a container runtime. Install Node 20+, git, caddy, tailscale.

### 2.2 Clone + configure
```
git clone <sovpin-repo> /home/<user>/sovpin
cd /home/<user>/sovpin/dashboard
cp .env.example .env
```
Edit `.env`:
```
BIND_HOST=127.0.0.1
PORT=3001
VERUS_RPC_HOST=192.168.86.110        # MacBook LAN (or Tailscale IP)
VERUS_RPC_PORT=25779
VERUS_RPC_USER=<macbook rpc user>
VERUS_RPC_PASSWORD=<macbook rpc password>
VERUS_CHAIN=VRSCTEST
KUBO_RPC_URL=http://100.66.85.86:5001
KUBO_GATEWAY_URL=http://100.66.85.86:8080
PUBLIC_GATEWAY_URL=https://ipfs.sovpin.com
SOVPIN_SIGNER_WIF=<secure wif>
SOVPIN_INTERNAL_SECRET=<random secret>
STRIPE_WEBHOOK_SECRET=<stripe secret>
# ... other secrets
```

### 2.3 Migrate data
Copy `dashboard/data/sovpin.sqlite` (and `-wal`/`-shm`) from the old host to the Chromebook. Ensure file ownership matches the running user.

### 2.4 Install + run
```
cd /home/<user>/sovpin/dashboard
npm ci
npm run build:web
# Run under pm2 or a systemd user unit (Crostini has no system systemd; use pm2)
npm i -g pm2
pm2 start server.js --name sovpin
pm2 save
pm2 startup
```

### 2.5 TLS (best-of-best)
Run the included `scripts/setup-caddy.sh` on the Chromebook (adapted for the user's domain). Caddy terminates TLS and proxies to 127.0.0.1:3001.

### 2.6 Cloudflare Tunnel
Either keep the tunnel on the Chromebook (install `cloudflared`) or switch DNS to point at the Chromebook's public IP (if any). Recommended: keep Cloudflare Tunnel on the Chromebook so the origin IP stays hidden.

## 3. Verify
- `curl http://127.0.0.1:3001/healthz` → healthy (verus + kubo online).
- Upload a test file → CID pinned on MacBook Kubo → verify via `https://ipfs.sovpin.com/ipfs/<cid>`.
- Watcher sync discovers CIDs on the MacBook's chain.

## 4. Security notes
- The Chromebook now holds the SQLite ledger + signer WIF. Protect it: full-disk encryption, strong user password, no shared accounts.
- The MacBook holds only daemon keys + storage; if compromised, the attacker gets chain data but not user ledgers or billing.
- Keep Tailscale ACLs tight: only the Chromebook can reach Kubo/verusd ports.

## 5. Rollback
Keep the old host's data backup until the migration is verified. The SQLite file + `.env` are the only state to move.