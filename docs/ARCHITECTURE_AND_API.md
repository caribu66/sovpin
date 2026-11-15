# SovPin Architecture, API & Operations Guide

> **Single Source of Truth:** This document is automatically checked against the live Express routes, SQLite schema, `.env.example`, and repository file paths by [`dashboard/test/docs-reality.test.js`](../dashboard/test/docs-reality.test.js) on every `npm test` run. If a route, table, env var, or file path changes without updating this document, `npm test` fails.

---

## 1. What SovPin Is (in 30 Seconds)

Verus blockchains (`VRSC`, `VRSCTEST`, and PBaaS chains) excel at self-sovereign identity (`VerusID`), deterministic data keys (`VDXF`), and verifiable commitments (`ContentMultiMap` / `MMR`), while **IPFS (`Kubo`)** excels at content-addressed storage and CDN delivery of large media files.

**SovPin** connects the two for Verus developers:

1. **Identity-Keyed Multi-Tenancy:** Developers sign in with their VerusID (`LoginConsent` QR or `verus signdata`). Accounts, quotas, pins, and API keys are keyed to the permanent on-chain `i-address` (`identityaddress`), never an email or password.
2. **Large-File IPFS Ingestion without Base64 Bloat:** Applications upload files via streaming multipart (`POST /v1/pin/upload/stream`, up to 100 MiB per request) or chunked upload sessions (`POST /v1/pin/upload/chunked/*`, for multi-hundred-MiB+ files). SovPin streams bytes to Kubo while computing the exact byte length and SHA-256 hash.
3. **Verus-Standard `URLRef` Compiler:** When a developer supplies a VDXF URI, SovPin resolves its canonical `i-address` via `getvdxfid` on the live Verus daemon and returns `verus_vdxf.serializedhex`, a Verus `DataDescriptor(CrossChainDataRef(URLRef))` ready for a CMM update. VREAL supplies its exact `vreal.vrsctest::identity.assets.content.main` or `.content.alt` key so the returned descriptor is bound to the CMM slot it will occupy.
4. **On-Chain CMM Watchers & Reverse Resolver:** SovPin can poll any VerusID’s `contentmultimap` via `getidentitycontent`, traverse sub-identities, auto-pin discovered IPFS CIDs on Kubo, and report live pin health (`PINNED`, `MISSING_FROM_NODE`, `UNREACHABLE`).

---

## 2. System Topology

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                         Public Internet / Clients                          │
│   • Verus dApps (e.g. VREAL IpfsUploader)                                  │
│   • Developer Browser Console (https://dashboard.sovpin.com)               │
│   • Public Media Readers (https://ipfs.sovpin.com/ipfs/<cid>)              │
└───────────────────┬────────────────────────────────────────┬───────────────┘
                    │ HTTPS (Cloudflare Tunnel)              │ HTTPS (1yr Edge Cache TTL)
                    ▼                                        ▼
┌───────────────────────────────────────────┐    ┌───────────────────────────┐
│ Debian Host (127.0.0.1:3001)              │    │ MacBook Kubo Node         │
│ • systemd user unit: sovpin.service       │    │ • Tailscale: 100.66.85.86 │
│ • Express API: dashboard/server.js        │───►│ • Kubo RPC: :5001         │
│ • React SPA: web/dist                     │    │ • Kubo Gateway: :8080     │
│ • SQLite WAL DB: dashboard/data/          │    └───────────────────────────┘
└───────────────────┬───────────────────────┘
                    │ JSON-RPC (LAN 192.168.86.110:25779)
                    ▼
┌───────────────────────────────────────────┐
│ Verus Daemon (verusd -chain=VRSCTEST)     │
│ • getidentity / getidentitycontent        │
│ • getvdxfid / verifysignature             │
└───────────────────────────────────────────┘
```

---

## 3. Upload Modes & Cloudflare Edge Limits

Cloudflare enforces a **100 MB per-HTTP-request body limit** on Free/Pro zones (`dashboard.sovpin.com`). SovPin provides three upload paths so developers can store objects of any size:

| Mode | Endpoint | Max Size | When to Use |
| :--- | :--- | :--- | :--- |
| **1. JSON / Text** | `POST /v1/pin/upload` | `~35 MiB` (50 MB JSON parser cap) | Small JSON manifests (`nft-metadata.json`), text descriptors, or legacy Base64 payloads. |
| **2. Streaming Multipart** | `POST /v1/pin/upload/stream` | `100 MiB` (`MAX_SINGLE_UPLOAD_BYTES`) | Standard binary files (images, audio, video, bundles) up to ~95 MiB in a single HTTP request. Streams directly through Busboy to Kubo without buffering in RAM. |
| **3. Chunked / Resumable** | `POST /v1/pin/upload/chunked/init`<br>`PUT /v1/pin/upload/chunked/:uploadId/part`<br>`POST /v1/pin/upload/chunked/:uploadId/complete` | Plan quota (`1 GB` – `1 TB`) | Files `> 80–100 MiB` over Cloudflare edge. Each `PUT .../part?partNumber=N` sends a `<= 50 MiB` binary slice to disk staging; `/complete` streams the concatenated parts to Kubo and verifies the full-file SHA-256. (The React UI in `web/src/lib/api.ts` switches to chunked mode automatically for files `> 80 MiB`.) |

---

## 4. Complete HTTP API Reference

### 4.1 System Health, Metrics & Ops Endpoints (`dashboard/server.js`)

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` | Public | Liveness/readiness check (also mounted at `/v1/healthz`). Verifies SQLite, Kubo RPC, and Verus RPC; returns `200` (`ok`) or `503` (`degraded`). |
| `GET` | `/v1/healthz` | Public | Alias for `/healthz`. |
| `GET` | `/metrics` | Public | Prometheus text exposition format (`sovpin_tenants_total`, `sovpin_pins_active_total`, `sovpin_pins_bytes_total`, `sovpin_uploads_in_flight`, `sovpin_kubo_online`, `sovpin_verus_online`, `sovpin_verus_block_height`, etc.). |
| `GET` | `/v1/metrics` | Public | JSON summary of the system metrics above. |
| `GET` | `/api/health` | Public | Legacy ops composite check (Kubo, Verus, Cloudflare Tunnel, Tailscale). |
| `GET` | `/api/kubo` | Public | Kubo node version, repo size, block count, recursive pin count, peer count, and bandwidth stats. |
| `GET` | `/api/verus` | Public | Live Verus daemon chain name, version, block height, and peer connections. |
| `GET` | `/api/cloudflare` | Public | Cloudflare Tunnel ingress and cache/rate-limit ruleset inspection. |
| `GET` | `/api/tailscale` | Public | Tailscale mesh peer status between Debian API host and MacBook Kubo host. |

### 4.2 Verus-Native Commercial SaaS API (`dashboard/src/saas-routes.js`, mounted at `/v1`)

| Method | Path | Auth / Scope | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/public/info` | Public | Service catalog, UK company details, `gatewayUrl`, `maxSingleUploadBytes`, live Verus daemon status, and plan tiers (`builder`, `indie`, `studio`). |
| `POST` | `/v1/auth/challenge` | Public | Issue a `verus signdata` challenge for a VerusID name (`vreal@`) or `i-address`. |
| `POST` | `/v1/auth/sign-with-node` | Loopback only | Helper for local loopback (`127.0.0.1`) development/tests to sign a challenge via local `verusd`. Blocked on proxied public Cloudflare requests unless `ALLOW_PUBLIC_NODE_SIGN=true`. |
| `POST` | `/v1/auth/verify` | Public | Verify a `signdata` signature via live `verifysignature`, upsert the tenant by `i-address`, and issue a `svps_...` session token (HttpOnly `svp_session` cookie for browsers, body token for CLI/API). |
| `POST` | `/v1/auth/logout` | Session or Key | Invalidate the caller's active `svps_...` session token in SQLite, clear the `svp_session` cookie, and record an `auth.logout` audit log. |
| `POST` | `/v1/auth/login-consent/challenge` | Public | Create a signed Verus Mobile `LoginConsentRequest` deep link + QR code (`sovpin.VRSCTEST@`). |
| `POST` | `/v1/auth/login-consent/callback` | Public | Webhook callback receiving `LoginConsentResponse` from Verus Mobile and verifying it on-chain. |
| `GET` | `/v1/auth/login-consent/poll` | Public | Poll a pending `LoginConsent` challenge (`challengeId` + `pollToken`) until verified. |
| `GET` | `/v1/account` | Session or Key | Return authenticated tenant profile, active plan, storage/key/watcher usage, and UK company info. |
| `PATCH` | `/v1/account/billing-profile` | Session or Key | Update tenant UK company name, VAT number (`GB...`), and billing country. |
| `DELETE` | `/v1/account` | Session or Key | UK GDPR Right-to-Erasure: unpins all tenant CIDs with zero remaining active references on Kubo, logs erasure, and deletes the tenant account. |
| `GET` | `/v1/audit-logs` | Session or Key | List append-only security and pin lifecycle audit events for the authenticated tenant. |
| `GET` | `/v1/keys` | Session or Key | List scoped developer API keys (`svp_live_...`) for the tenant. |
| `POST` | `/v1/keys` | Session or Key | Mint a new scoped developer API key (`pin:read`, `pin:write`, `vdxf:build`). Plaintext secret is returned once; only its SHA-256 hash is stored. |
| `DELETE` | `/v1/keys/:keyId` | Session or Key | Revoke an API key immediately. |
| `DELETE` | `/v1/keys/cleanup-revoked` | Session or Key | Permanently delete all revoked API keys for the tenant. |
| `GET` | `/v1/webhooks` | Session or Key | List registered outbound webhooks for the tenant. |
| `GET` | `/v1/webhook-events` | Session or Key | Return the catalog of available webhook event types with descriptions (for UI selection). |
| `POST` | `/v1/webhooks` | Session or Key | Register an HTTPS webhook URL with event subscriptions (`pin.created`, `pin.deleted`, `watcher.created`, `watcher.synced`, `watcher.repaired`). Returns a `whsec_...` HMAC signing secret (shown once). |
| `DELETE` | `/v1/webhooks/:webhookId` | Session or Key | Delete a registered webhook. |
| `GET` | `/v1/webhooks/:webhookId/deliveries` | Session or Key | List recent webhook delivery attempts with status, HTTP response code, and retry count. |
| `GET` | `/v1/pins` | `pin:read` | IPFS Pinning Service API: list pinned objects for the tenant (supports `?status=` and `?cid=`). |
| `POST` | `/v1/pins` | `pin:write` | IPFS Pinning Service API: pin an existing CID on Kubo and build a Verus `URLRef` descriptor (without a byte-hash commitment, since raw bytes were not uploaded through SovPin). |
| `POST` | `/v1/pin/upload` | `pin:write` | Upload JSON, text, or Base64 payload to Kubo, compute SHA-256, and return `DataDescriptor(CrossChainDataRef(URLRef))`. |
| `POST` | `/v1/pin/upload/stream` | `pin:write` | Stream a `multipart/form-data` file (`file` field + optional `meta` JSON field and optional `?vdxfUri=`) to Kubo without Base64 buffering. Enforces quota and `MAX_SINGLE_UPLOAD_BYTES`. |
| `POST` | `/v1/pin/upload/chunked/init` | `pin:write` | Initialize a chunked/resumable upload session (`up_...`) for files `> 100 MiB`. |
| `PUT` | `/v1/pin/upload/chunked/:uploadId/part` | `pin:write` | Upload binary part `?partNumber=1..10000` (`application/octet-stream`) to disk staging with per-part SHA-256 tracking. |
| `POST` | `/v1/pin/upload/chunked/:uploadId/complete` | `pin:write` | Stream concatenated parts from disk to Kubo, compute full-file SHA-256, record pin, and clean up staging files. |
| `DELETE` | `/v1/pin/upload/chunked/:uploadId` | `pin:write` | Abort an open chunked upload session and delete staged parts. |
| `POST` | `/v1/pins/import-kubo` | `pin:write` | Import recursive pins from the Kubo node into the tenant ledger, reading each CID from Kubo gateway to record exact byte size, MIME type, and verified SHA-256. |
| `GET` | `/v1/pins/:requestid` | `pin:read` | Inspect a single pin job by `requestid`. |
| `POST` | `/v1/pins/:requestid/verify` | `pin:read` | Verify that a pin is recursively pinned on Kubo, reachable via gateway, and matches its recorded byte size and SHA-256 digest. |
| `POST` | `/v1/pins/:requestid/receipt` | `pin:read` | Issue or refresh a Verus-signed cryptographic storage attestation (`sovpin.VRSCTEST@`) committing to `{ tenantIAddress, cid, sha256, sizeBytes, blockHeight }` and verify it via live `verifysignature`. |
| `POST` | `/v1/pins/gc` | `pin:write` | Sweep `unpinned` and `blocked_uk_osa` CIDs with zero active tenant references from Kubo and optionally trigger `ipfs repo gc`. |
| `DELETE` | `/v1/pins/:requestid` | `pin:write` | Mark pin as `unpinned` for the tenant and remove from Kubo **only** if `countActivePinReferences(cid) === 0` across all tenants. |
| `POST` | `/v1/vdxf/resolve` | Public | Resolve a human-readable VDXF URI (`vreal::nft.asset.media`) to its deterministic `i-address` via live `getvdxfid`. |
| `POST` | `/v1/verus/native-storage/entry` | `vdxf:build` | Build Verus’s native `updateidentity` `data` wrapper entry (`address`, `filename`, `createmmr`, `label`, `mimetype`) for callers using local `verusd -enablefileencryption`. |
| `GET` | `/v1/watchers` | Session or Key | List active ContentMultiMap (`CMM`) auto-pin watchers for the tenant. |
| `POST` | `/v1/watchers` | Session or Key | Register a VerusID (`NftIndex.vreal@`) to watch via 2-level `getidentitycontent` traversal and auto-pin discovered CIDs. |
| `POST` | `/v1/watchers/:watcherId/sync` | Session or Key | Trigger an immediate on-chain CMM sync for a watcher. |
| `POST` | `/v1/watchers/:watcherId/repair` | `pin:write` | Re-pin all on-chain CIDs discovered by a watcher, verify their byte SHA-256 against the on-chain `URLRef.datahash`, and record them in the tenant’s pin ledger. |
| `DELETE` | `/v1/watchers/:watcherId` | Session or Key | Remove a CMM watcher from the tenant account. |
| `GET` | `/v1/watchers/:watcherId/traversal` | Session or Key | Return the 2-level CMM discovery tree (`L0 Registry → L1 Sub-Identities → L2 IPFS CIDs`) with live Kubo pin health for each CID. |
| `POST` | `/v1/internal/blocknotify` | Loopback or Secret | Block-driven watcher sync: triggered by `verusd -blocknotify`. Syncs all active CMM watchers, pins discovered CIDs, and dispatches `watcher.synced` webhooks. |
| `GET` | `/v1/resolve/:identity` | `pin:read` | Resolve a VerusID’s on-chain `contentmultimap` (optionally filtered by `?vdxf=`), decode `URLRef` and CID entries, and report Kubo pin status + gateway URLs. |
| `GET` | `/v1/resolve/:identity/content` | Public | Resolve the latest IPFS CID stored under a VerusID’s `contentmultimap` (optionally filtered by `?vdxf=`) and `302` redirect to `https://ipfs.sovpin.com/ipfs/<cid>` (or return JSON when `?format=json`). |
| `GET` | `/v1/billing/invoices` | Session or Key | List UK VAT & VerusPay invoices for the tenant. |
| `POST` | `/v1/billing/checkout` | Session or Key | Select a plan (`builder`, `indie`, `studio`) and generate a UK VAT invoice (`20%` VAT) payable via VerusPay (`VRSC`) or Stripe UK (`GBP £`). |
| `POST` | `/v1/billing/invoices/:invoiceId/settle` | Session or Key | Settle an open invoice (verifying an on-chain `txid` when supplied) and upgrade the tenant’s plan. |
| `POST` | `/v1/billing/stripe-webhook` | Stripe HMAC | Handle `checkout.session.completed` webhook events (verifies `Stripe-Signature` HMAC-SHA256 when `STRIPE_WEBHOOK_SECRET` is set). |
| `GET` | `/v1/compliance/status` | Public | Return UK Online Safety Act 2023 / UK GDPR compliance status and blocked CID denylist. |
| `POST` | `/v1/compliance/takedown` | Admin or Owner | Block a CID under HTTP 451, mark matching pins `blocked_uk_osa`, and unpin from Kubo. Restricted to platform admins (`ADMIN_IDENTITIES`) or the tenant who pinned the CID. |

---

## 5. SQLite Database Schema (`dashboard/src/db.js`)

SovPin uses Node’s built-in `node:sqlite` (`DatabaseSync`) in `WAL` mode (`dashboard/data/sovpin.sqlite`):

| Table | Primary Key | Purpose |
| :--- | :--- | :--- |
| `tenants` | `i_address` | VerusID tenant records (`friendly_name`, `primary_address`, `plan_id`, UK VAT details). |
| `auth_challenges` | `challenge_id` | Short-lived (10 min) `signdata` login challenges. |
| `login_consent_sessions` | `challenge_id` | Short-lived (5 min) Verus Mobile QR `LoginConsent` sessions. |
| `sessions` | `token` | Authenticated dashboard session tokens (`svps_...`, 7-day expiry). |
| `api_keys` | `key_id` | Scoped developer API keys (`key_prefix`, `key_hash`, `scopes`, `revoked`, `last_used_at`). |
| `pins` | `request_id` | Pinned objects (`i_address`, `cid`, `name`, `mime_type`, `size_bytes`, `sha256_hex`, `sha256_verified`, `vdxf_uri`, `vdxf_id`, `status`). |
| `chunked_uploads` | `upload_id` | Multi-part upload sessions (`filename`, `mime_type`, `total_size_bytes`, `received_parts_json`, `status`, `expires_at`). |
| `cmm_watchers` | `watcher_id` | On-chain VerusID CMM watchers (`target_identity`, `target_i_address`, `vdxf_uri`, `pins_discovered`, `last_result_json`). |
| `invoices` | `invoice_id` | UK VAT (`20%`) and VerusPay (`VRSC`) invoices (`invoice_number`, `subtotal_gbp_pence`, `vat_gbp_pence`, `total_gbp_pence`, `amount_vrsc`, `status`, `txid`). |
| `blocked_cids` | `cid` | UK Online Safety Act 2023 HTTP 451 denylist (`reason`, `legislation`, `reporter_identity`). |
| `webhooks` | `webhook_id` | Outbound webhook registrations (`i_address`, `url`, `secret`, `events`, `active`). |
| `webhook_deliveries` | `delivery_id` | Webhook delivery audit trail (`webhook_id`, `i_address`, `event`, `payload_json`, `status`, `attempts`, `response_status`). |
| `audit_logs` | `log_id` | Append-only security & pin lifecycle audit log (`i_address`, `actor_type`, `action`, `target_id`, `details_json`, `ip_address`). |

---

## 6. Environment Configuration (`dashboard/.env.example` & `dashboard/src/config.js`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3001` | HTTP port for the Express API & React console. |
| `BIND_HOST` | `127.0.0.1` | Loopback bind address (exposed publicly via Cloudflare Tunnel). |
| `SOVPIN_DB_PATH` | `./data/sovpin.sqlite` | Path to the SQLite WAL database file. |
| `VERUS_RPC_HOST` | `192.168.86.110` | Verus daemon RPC host. |
| `VERUS_RPC_PORT` | `25779` | Verus daemon RPC port (`VRSCTEST`). |
| `VERUS_RPC_USER` | `test` | Verus daemon RPC username. |
| `VERUS_RPC_PASSWORD` | `test` | Verus daemon RPC password. |
| `VERUS_CHAIN` | `VRSCTEST` | Active Verus chain name. |
| `VERUS_CHAIN_I_ADDRESS` | `iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq` | Canonical chain `i-address` (`VRSCTEST`). |
| `SOVPIN_SIGNER_ID` | `sovpin.VRSCTEST@` | Service VerusID used to sign `LoginConsent` QR challenges. |
| `SOVPIN_SIGNER_I_ADDRESS` | `iCyhNFeRiKdX7rgAYJdz54z2pTT9M1RYUt` | Service VerusID `i-address`. |
| `SOVPIN_SIGNER_WIF` | *(testnet WIF)* | WIF private key for signing `LoginConsent` challenges (override via secret in prod). |
| `SOVPIN_CALLBACK_HOST` | `https://dashboard.sovpin.com` | Public HTTPS origin for `LoginConsent` mobile callbacks. |
| `ALLOW_PUBLIC_NODE_SIGN` | `false` | When `false`, blocks public Cloudflare requests to `/v1/auth/sign-with-node`. |
| `ADMIN_IDENTITIES` | `iEmX7...,iCyhN...,vreal.VRSCTEST@,sovpin.VRSCTEST@` | Comma-separated VerusIDs allowed to execute global statutory takedowns. |
| `TAILSCALE_IP` | `100.66.85.86` | Tailscale IP of the MacBook Kubo storage node. |
| `KUBO_RPC_URL` | `http://100.66.85.86:5001` | Primary Kubo RPC URL (Tailscale-isolated). |
| `KUBO_REPLICA_URLS` | *(empty)* | Optional comma-separated secondary Kubo RPC URLs for multi-node pin replication. |
| `KUBO_GATEWAY_URL` | `http://100.66.85.86:8080` | Internal Kubo HTTP gateway URL. |
| `PUBLIC_GATEWAY_URL` | `https://ipfs.sovpin.com` | Public Cloudflare-cached IPFS gateway origin. |
| `MAX_SINGLE_UPLOAD_BYTES` | `104857600` (100 MiB) | Single-request upload limit matching Cloudflare Free/Pro edge body cap. |
| `UPLOAD_RATE_LIMIT_PER_MIN` | `60` | Per-tenant upload rate limit (requests per minute). |
| `CF_TUNNEL_ID` | `990fae36-b92b-457b-af17-5737ed2d8a35` | Cloudflare Tunnel ID routing `dashboard.sovpin.com` and `ipfs.sovpin.com`. |
| `CF_RULESET_ID` | `2e7849d6314246df8346142659b21066` | Cloudflare Cache Ruleset ID for 1-year immutable `/ipfs/*` caching. |
| `CF_ZONE` | `sovpin.com` | Cloudflare DNS zone name. |
| `SOVPIN_RECEIVING_ID` | `vreal.VRSCTEST@` | VerusID receiving VerusPay invoice settlements. |
| `GBP_PER_VRSC_RATE` | `3.0` | Reference GBP spot rate per VRSC for HMRC VAT invoices. |
| `UK_COMPANY_NAME` | `SovPin Technologies Ltd` | Legal supplier name on UK VAT invoices. |
| `STRIPE_SECRET_KEY` | *(empty)* | Optional Stripe UK API secret key. |
| `STRIPE_WEBHOOK_SECRET` | *(empty)* | Optional Stripe webhook signing secret (`whsec_...`) for HMAC verification. |

---

## 7. Operations & Anti-Drift Verification

```bash
# 1. Build the React frontend into web/dist
cd /home/demon/sovpin/dashboard
npm run build:web

# 2. Run the full integration + documentation reality-check suite
#    (Always uses an isolated /tmp/sovpin-test-*.sqlite database)
npm test

# 3. Manage the production systemd user service
systemctl --user status sovpin.service
systemctl --user restart sovpin.service

# 4. Check live health and Prometheus metrics
curl -s https://dashboard.sovpin.com/healthz | jq .
curl -s https://dashboard.sovpin.com/metrics
```
