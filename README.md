# SovPin — Sovereign IPFS Pinning & Gateway Service

**Domain:** `https://ipfs.sovpin.com/ipfs/<cid>`
**Project:** Standalone IPFS storage service for the VREAL Sovereign Media platform and other Verus DREAM apps.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    SovPin Infrastructure                          │
│                                                                  │
│  ┌──────────────┐     ┌──────────────────────────────────────┐   │
│  │  Cloudflare   │     │  MacBook (192.168.86.110)           │   │
│  │  Edge Cache   │────►│  Kubo Docker Container              │   │
│  │  (1yr TTL)   │     │  :5001 RPC  (Tailscale only)        │   │
│  │              │     │  :8080 Gateway (Tailscale only)      │   │
│  └──────┬───────┘     └──────────────────────────────────────┘   │
│         │                                                         │
│  ┌──────┴───────┐                                                │
│  │  Cloudflare   │  Public: https://ipfs.sovpin.com/ipfs/<cid>    │
│  │  Tunnel       │  Private: http://100.66.85.86:5001 (Tailscale)│
│  └──────────────┘                                                │
└──────────────────────────────────────────────────────────────────┘
```

## Components

| Component | Technology | Location |
|-----------|-----------|----------|
| IPFS Node | Kubo v0.43.1 (Docker) | MacBook `192.168.86.110` |
| Mesh VPN | Tailscale (WireGuard) | Dev machine ↔ MacBook |
| Public Gateway | Cloudflare Tunnel + Edge Cache | `ipfs.sovpin.com` |
| Cache Ruleset | Cloudflare Rulesets API | `sovpin.com` zone |

## Kubo Hardening

| Setting | Value | Purpose |
|---------|-------|---------|
| `Gateway.NoFetch` | `true` | Only serve pinned CIDs (no public DHT proxying) |
| `Gateway.NoDNSLink` | `true` | Only immutable `/ipfs/<cid>` paths |
| `Access-Control-Allow-Origin` | `*` | Browser CORS for all origins |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `Content-Security-Policy` | `default-src 'none'; style-src 'unsafe-inline'; sandbox` | Isolate served content |
| Docker port binding | `100.66.85.86` (Tailscale only) | LAN/public isolation |
| Container restart | `unless-stopped` | Auto-recovery |
| Linux capabilities | `cap_drop: ALL` (only `CHOWN`, `SETUID`, `SETGID` retained) | Privilege minimization |
| Cloudflare rate limit | `200 req / 10s` per IP on `/ipfs/*` | DDoS / abuse protection |

## Quick Start

### Prerequisites
- Tailscale installed on both dev machine and MacBook
- Cloudflare account with `sovpin.com` zone
- `cf` CLI installed (`~/.local/bin/cf`)
- SSH access to MacBook (`~/.ssh/vreal_mirror_ed25519`)

### Deploy Kubo on MacBook
```bash
./scripts/deploy-kubo.sh
```

### Configure Cloudflare Tunnel
```bash
./scripts/configure-tunnel.sh
```

### Configure Cache Rules
```bash
./scripts/configure-cache.sh
```

### Verify
```bash
curl -sI https://ipfs.sovpin.com/ipfs/QmdJN78YiEAzh8xQ59YMsMW635cXtr24RDSz6zuJr1NyFk
# Expect: HTTP/2 200, cf-cache-status: HIT, cache-control: public, max-age=29030400, immutable
```

## Consumer Integration (VREAL)

VREAL connects to SovPin via two env vars:
```bash
IPFS_API_URL=http://100.66.85.86:5001        # Tailscale IP (private)
IPFS_LAN_GATEWAY_URL=http://100.66.85.86:8080 # Tailscale IP (private)
IPFS_GATEWAY_URL=https://ipfs.sovpin.com       # Public gateway
VITE_IPFS_GATEWAY=https://ipfs.sovpin.com/ipfs/
```

Upload flow: `POST /api/v0/add?pin=true` → returns CID → public URL = `https://ipfs.sovpin.com/ipfs/<cid>`

## License

MIT
EOF