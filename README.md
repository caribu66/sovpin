# SovPin — Sovereign IPFS & VDXF Storage Engine for Verus Developers

**Public IPFS Edge Gateway:** `https://ipfs.sovpin.com/ipfs/<cid>`
**Developer SaaS Console & API:** `https://dashboard.sovpin.com` (`http://127.0.0.1:3001`)
**Jurisdiction:** United Kingdom (`SovPin Technologies Ltd`, England & Wales — GBP `£` + `VRSC` VerusPay Billing)

## Documentation Map (Anti-Drift Enforced)

| Document | Purpose |
| :--- | :--- |
| [**`docs/ARCHITECTURE_AND_API.md`**](docs/ARCHITECTURE_AND_API.md) | **Canonical Technical & API Guide:** Complete system topology, upload modes (JSON, streaming up to 100 MiB, chunked `> 100 MiB`), every REST endpoint, SQLite table schema, `.env` variables, and ops commands. Verified on every `npm test` run by `dashboard/test/docs-reality.test.js`. |
| [**`docs/FOUNDATION.md`**](docs/FOUNDATION.md) | **Product Charter & Protocol Benchmarks:** The 5 architectural pillars of SovPin, Verus `URLRef` / `DataDescriptor` binary encoding rules, native `verusd` storage fee measurements, and live Cloudflare edge upload benchmarks. |

---

## Core Verus-Native Capabilities

1. **VerusID Passwordless Authentication (`/v1/auth/*`):**
   - Accounts are keyed to the developer's canonical on-chain **`i-address`** (`identityaddress`), never an email or password.
   - Supports **Verus Mobile QR (`LoginConsent`)** and **CLI/RPC (`verus signdata`)** verified live via `verifysignature` with `checklatest: true`.
2. **Large-File Streaming & Chunked IPFS Ingestion + Verus `URLRef` Compiler (`/v1/pin/*`, `/v1/pins`):**
   - **Standard IPFS Pinning Service API:** `GET/POST/DELETE /v1/pins` plus live Kubo verification (`POST /v1/pins/:requestid/verify`) and unreferenced pin garbage collection (`POST /v1/pins/gc`).
   - **Streaming Multipart (`POST /v1/pin/upload/stream`):** Streams files up to `100 MiB` (`MAX_SINGLE_UPLOAD_BYTES`) directly to Kubo without Base64 buffering.
   - **Chunked / Resumable Upload (`POST /v1/pin/upload/chunked/*`):** Uploads files `> 100 MiB` over Cloudflare's 100 MB per-request edge limit in `<= 50 MiB` binary slices and assembles them into Kubo with full SHA-256 verification.
   - **Verus `URLRef` Payload Generation:** When a `vdxfUri` is supplied, resolves its `i-address` via live `getvdxfid` and returns the serialized `DataDescriptor(CrossChainDataRef(URLRef))` `contentmultimap` payload ready for `updateidentity`. When omitted (e.g. by VREAL, which owns its own CMM schema), returns the verified CID, byte size, and SHA-256 digest.
3. **ContentMultiMap (CMM) Auto-Pin Watchers & Identity Resolver (`/v1/watchers`, `/v1/resolve/:identity`):**
   - Polls watched VerusIDs (such as `NftIndex.vreal@`) via 2-level `getidentitycontent` traversal, decodes `URLRef` and CID references, auto-pins discovered CIDs on Kubo, and reports live Kubo pin health.
4. **Reference-Counted Multi-Tenant Unpinning, Audit Trail & UK Compliance:**
   - `DELETE /v1/pins/:requestid` only removes a CID from Kubo when **zero** active tenants reference it.
   - Includes per-tenant append-only audit logs (`GET /v1/audit-logs`), UK GDPR right-to-erasure offboarding (`DELETE /v1/account`), UK VAT (`20%`) + VerusPay invoicing (`/v1/billing/*`), HTTP 451 statutory takedowns (`/v1/compliance/takedown`), readiness probes (`/healthz`), and Prometheus metrics (`/metrics`).

---

## Repository Structure

```text
/home/demon/sovpin/
├── README.md                          # Project overview & documentation map
├── docker-compose.yml                 # Hardened Kubo v0.43.1 container definition (MacBook Tailscale node)
├── docs/
│   ├── ARCHITECTURE_AND_API.md        # Canonical architecture, REST API, DB schema & env reference
│   └── FOUNDATION.md                  # Product charter, Verus VDXF rules & live benchmarks
├── scripts/
│   ├── sovpin.service                 # Production systemd user unit (127.0.0.1:3001)
│   ├── deploy-kubo.sh                 # Deploy/update Kubo container on MacBook (100.66.85.86)
│   ├── configure-tunnel.sh            # Configure Cloudflare Tunnel ingress (dashboard + ipfs.sovpin.com)
│   └── configure-cache.sh             # Configure 1-year immutable Cloudflare edge cache rules
├── web/                               # Production React + Vite + Tailwind Developer Console
│   └── src/
│       ├── App.tsx                    # Console shell, navigation & Cmd+K command palette
│       ├── lib/api.ts                 # API client + automatic single-stream / chunked file uploader
│       └── pages/                     # Landing, SignIn, Dashboard, PinStudio, Watchers, Billing, Compliance
└── dashboard/                         # Express API Server, SQLite WAL Ledger & Integration Tests
    ├── server.js                      # Express server (:3001), /healthz, /metrics & graceful shutdown
    ├── .env.example                   # Complete environment variable template
    ├── src/
    │   ├── config.js                  # Plans (£ GBP / VRSC), UK VAT, limits, Verus RPC & Kubo config
    │   ├── db.js                      # SQLite WAL schema, tenant usage, reference counting & audit logs
    │   ├── verus-rpc.js               # Verus JSON-RPC client with retry & getvdxfid/getinfo caching
    │   ├── verus-storage.js           # Verus URLRef / CrossChainDataRef / DataDescriptor encoder & decoder
    │   ├── kubo-service.js            # Kubo RPC client (stream add, pin/rm, verify, GC, replication)
    │   └── saas-routes.js             # /v1/* REST API routes
    └── test/
        ├── saas.test.js               # Live end-to-end integration test suite (VRSCTEST + Kubo)
        ├── verus-storage.test.js      # Verus URLRef & native-storage unit tests
        └── docs-reality.test.js       # Automated check preventing documentation drift from code
```

---

## Quick Start & Verification

```bash
cd /home/demon/sovpin/dashboard
npm run build:web               # Build React frontend into ../web/dist
npm test                        # Run live integration + VDXF + docs reality-check tests
systemctl --user status sovpin  # Inspect live systemd service on 127.0.0.1:3001
```
