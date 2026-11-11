# SovPin Dashboard

Lightweight monitoring dashboard for the SovPin IPFS storage service.

## Quick Start

```bash
cd ~/sovpin/dashboard
npm install
npm start
# Open http://127.0.0.1:3001
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Dashboard HTTP port |

## Data Sources

| Source | Endpoint | Auth |
|--------|----------|------|
| Kubo RPC | `http://100.66.85.86:5001` (Tailscale) | None (Tailscale ACL) |
| Cloudflare | `cf` CLI | OAuth token |
| Tailscale | `tailscale status --json` | None (local) |
| MacBook System | SSH (`~/.ssh/vreal_mirror_ed25519`) | SSH key |

## Security

- Backend binds to `127.0.0.1` only (not exposed to network)
- Only accessible via Tailscale or localhost
- No authentication needed (Tailscale ACL protects the MacBook)

## Auto-Refresh

The dashboard polls all endpoints every 10 seconds.