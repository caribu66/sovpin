# SovPin Foundation & Product Charter

**Product Name:** SovPin  
**Category:** B2B Developer Infrastructure — Verus-Native IPFS Pinning, VDXF Data Engine & On-Chain Content Indexer  
**Target Audience:** Software engineers, protocol builders, and studios building decentralized applications (dApps) on the **Verus Protocol** (`VRSC`, `VRSCTEST`, and PBaaS chains).

---

## 1. Why SovPin Exists (The Problem)

The Verus Protocol provides a distinctive combination of identity, data, and cross-chain primitives:
- **VerusID (`i-address`):** Self-sovereign, revocable, recoverable on-chain namespaces that hold funds, keys, and structured data.
- **VDXF (Verus Data Exchange Format):** Deterministic, globally collision-free key hashing (`getvdxfid`) and structured data envelopes (`DataDescriptor`).
- **ContentMultiMap (CMM):** On-chain key-value maps embedded directly inside every VerusID, queried historically or live via `getidentitycontent`.
- **DREAM Architecture:** Decentralized, Rights-preserving, Encrypted Application Model.

Verus supports both structured data in VerusID `contentmultimap`s and native on-chain data-storage flows, including multipart data handling. Those capabilities are valuable, but they are not a universal replacement for object storage: large media and application bundles are usually better served from IPFS, while compact state, commitments, and selected data can live on-chain. Verus identities can also reference off-chain objects using protocol data-reference types such as `CrossChainDataRef` / `URLRef`.

Today, a Verus developer trying to ship an application faces a painful infrastructure gap:

1. **Generic IPFS Providers (Pinata, Filebase, Web3.Storage) Are Blind to Verus:**
   - They do not understand VerusIDs (`i-addresses`), VDXF URIs (`namespace::key`), `DataDescriptor` wrappers (`i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv`), or `contentmultimap` structures.
   - Developers must write glue code to upload a file, resolve VDXF keys via `verusd`, choose the appropriate on-chain representation (for example, a `URLRef` with a content hash for an IPFS object), serialize it into the identity's CMM, and submit the identity update.
2. **State Desynchronization Between Chain and Storage:**
   - On Verus, the **VerusID is the database**. When a dApp updates an identity's `contentmultimap` or mints sub-identities under a namespace (`*.myproject@` or an index identity like `NftIndex.vreal@`), generic IPFS services have no idea what is referenced on-chain, what is orphaned, or whether an on-chain CID is actually pinned and resolvable.
3. **Web2 Identity & Billing Friction:**
   - Generic pinning services authenticate via emails, passwords, and credit cards—breaking the sovereign Verus developer workflow where project ownership lives in a multisig or team VerusID (`myproject@`) and treasury funds sit in `VRSC` or PBaaS reserve currencies.

---

## 2. What SovPin Is (And What It Is Not)

### What SovPin IS:
**SovPin is "Pinata / Filebase purpose-built for the Verus Protocol."**
It is a headless-first developer API and technical operations ledger that bridges **Kubo IPFS storage** directly to **Verus daemon RPC (`verusd`)**.

A developer integrates SovPin into their backend or CI/CD pipeline via an API key (`svp_live_...`). The target experience is:
1. **One API call pins bytes and prepares Verus-native references/VDXF payloads** suitable for an application to submit through its own authorized identity workflow.
2. **On-chain CMM Watchers** traverse a project's VerusIDs (`getidentitycontent`), decode supported data types, pin discovered IPFS references, and report pin health.
3. **VerusID-native resolution** lets applications fetch content and decoded VDXF metadata by VerusID + VDXF key, not just raw IPFS CIDs.
4. **Sovereign tenancy & billing** binds accounts to canonical `i-addresses` (surviving key rotation, revocation, and recovery) and settles invoices in `VRSC`/PBaaS currencies or UK GBP (`£`).

### What SovPin Is NOT:
- **NOT a consumer NFT marketplace or creator upload toy:** End-users and artists use applications *built on* SovPin (like VREAL); they do not use SovPin directly.
- **NOT a generic Web2 cloud drive:** Every feature in SovPin exists to serve a Verus protocol primitive (`VerusID`, `VDXF`, `CMM`, `DataDescriptor`, `signdata`, `Sapling viewing keys`, `PBaaS`).
- **NOT a bloated analytics dashboard:** The UI is a high-density, low-noise **Technical Ledger** for engineers inspecting pins, VDXF structures, CMM traversal maps, webhook deliveries, and storage quotas.

---

## 3. The Five Architectural Pillars of SovPin

Everything we build in SovPin must directly strengthen one of these five pillars:

### Pillar 1: Drop-In Programmatic Pinning + Verus Data Compiler (`/v1/pin/*`, `/v1/pins`)
- **Standard IPFS Pinning Service Spec:** Full compatibility with standard `/v1/pins` endpoints so existing IPFS tooling works out of the box with a `Bearer svp_live_...` token.
- **Large-file upload (`/v1/pin/upload/stream`):** Accepts multipart file streams and streams them to Kubo while calculating the content hash; it does not Base64-encode or buffer the whole request in SovPin. The JSON/text compatibility endpoint remains available for small payloads.
- **Verus-Native Pin & Reference Builder (`/v1/pin/upload*`):** Resolves the developer's target VDXF URI (e.g., `vreal::nft.asset.media`) and returns the correctly typed Verus representation. For media pointers, this uses the protocol's `URLRef` inside a `CrossChainDataRef`; it does not invent a `dataHash` field on `DataDescriptor`.
  - The pinned CID and edge gateway URL (`https://ipfs.sovpin.com/ipfs/<cid>`)
  - The appropriate encoded descriptor/reference and its decoded JSON form
  - A ready-to-merge `contentmultimap` fragment so the developer's backend can pass the correctly serialized value to its authorized `updateidentity` flow without implementing the binary reference encoding itself.

### Pillar 2: On-Chain CMM Indexer & Autonomous Pinning Engine (`/v1/watchers`)
- **Multi-Level CMM Traversal:** Watches a project's root registry identity (e.g., `NftIndex.vreal@`) or individual identities, traverses referenced sub-identities (`L0 Registry → L1 Sub-Identities → L2 IPFS Objects`), and extracts all CIDs.
- **Native `DataDescriptor` Decoding:** Parses on-chain `contentmultimap` entries beyond raw CID regexes—extracting VDXF key IDs, `DataDescriptor` version/flags, `mimetype`, `label`, and `objectdata`.
- **On-Chain Pin Health Auditing:** Cross-checks every CID discovered in a watched VerusID's `contentmultimap` against Kubo's actual pin set and reports **Pin Health** (`PINNED`, `MISSING_FROM_NODE`, `UNREACHABLE`) so developers immediately know if an on-chain asset has broken off-chain storage.

### Pillar 3: VerusID-Addressed Gateway & Reverse Resolver (`/v1/resolve/*`)
- In a Verus dApp, data is addressed by **Identity + VDXF Key**, not static CIDs (which change whenever an identity updates its CMM).
- SovPin exposes a deterministic resolution layer:
  - `GET /v1/resolve/:identity` — Resolves the identity's live `getidentitycontent`, decodes all VDXF `DataDescriptor` entries, and returns a clean JSON manifest of all IPFS objects attached to that VerusID along with their SovPin pin status and gateway URLs.
  - `GET /v1/resolve/:identity/content?vdxf=<uri_or_iaddress>` — Resolves the latest CID stored under that VDXF key on-chain and redirects/streams the pinned object from the edge gateway.

### Pillar 4: Cryptographic Provenance & DREAM Privacy Support
- **Verus-Signed Pin Receipts (`signmessage` / `verifysignature`):** Every pin operation can issue a cryptographic storage attestation signed by SovPin's service VerusID (`sovpin@` / configured signer identity) binding `{ tenantIAddress, cid, sha256, sizeBytes, blockHeight, timestamp }`. Developers can verify pin receipts on-chain or via `verifysignature`.
- **Sapling-Encrypted Data Awareness (DREAM):** Supports opaque ciphertext pinning and indexing of public descriptor metadata. Encryption and decryption remain client-/identity-controlled; SovPin must not require or retain a user's EVK, IVK, or spending key to store ciphertext.

### Pillar 5: Sovereign Multi-Tenant Operations & UK Commercial Compliance
- **`i-address` Tenancy:** Every tenant, API key, watcher, pin reference count, and invoice is keyed strictly to the immutable 34-character Verus `i-address`.
- **Reference-Counted Storage Engine:** Deduplicates identical CIDs across tenants while guaranteeing a CID is never garbage-collected from Kubo while at least one active tenant or CMM watcher references it.
- **Dual-Rail Billing & Statutory Compliance:** Supports native VerusPay (`sendcurrency` with invoice memo verification on-chain) alongside UK GBP (£ + 20% VAT) billing and statutory HTTP 451 CID takedown controls.

---

## 4. Verus Hybrid Storage Architecture (Target)

SovPin should expose Verus's storage choices as a developer-facing **hybrid storage engine**, not force every object into IPFS or every object onto the chain. The application chooses the storage class based on size, access/privacy needs, update frequency, and cost. The details below describe the product target; they are not a claim that all paths are currently implemented or enabled on every chain/daemon version.

| Storage class | Verus/IPFS mechanism | Best fit | SovPin's role |
| --- | --- | --- | --- |
| **1. Inline identity data** | Small values in a VerusID `contentmultimap`, encoded with VDXF types such as `DataDescriptor` | Identity/profile fields, compact configuration, pointers, commitments | Resolve keys, validate/decode known encodings, and prepare update payloads. Enforce payload-size guidance; don't treat CMM as a blob store. |
| **2. Native Verus data storage** | Daemon-supported data flows associated with identity updates or data transactions; multipart evidence can be split/reassembled by Verus storage primitives | Data that benefits from chain-level persistence, provenance, or Verus-native retrieval and whose size/cost is justified | Offer an opt-in orchestration/diagnostic path around supported RPCs, chunking limits, transaction tracking, and retrieval. Keep chain fees and data visibility explicit. |
| **3. IPFS object + on-chain reference** | Kubo-pinned object addressed by CID, with a Verus `CrossChainDataRef` containing a `URLRef` (URL plus optional content hash) in the identity's CMM | Large media, software bundles, frequently fetched assets, and datasets | Pin/replicate the object, produce the hash-committing reference, index identity references, expose gateway delivery, and report pin/availability health. |

### Protocol-native integrity and privacy

- **`URLRef` is a pointer with an optional byte commitment, not a storage guarantee.** A `dataHash` lets a client check retrieved bytes against the on-chain commitment; it does not prove that an IPFS node currently has the object. SovPin's pin-health and replication status are separate operational claims.
- **`DataDescriptor`, `CrossChainDataRef`, and `URLRef` are different types.** SovPin must decode/encode the actual VDXF serialization and use the right wrapper for each use case. In particular, media hash commitments should use the ecosystem's URL-reference representation rather than adding non-standard hash fields to a `DataDescriptor`.
- **The VDXF key belongs to the application schema.** SovPin resolves the URI the developer supplies with `getvdxfid` on the selected chain; it must not substitute a hardcoded i-address or present a SovPin example URI as a Verus-wide standard.
- **Native multipart data is not the same as IPFS pinning.** Verus data RPC flows can create transaction-backed data and require transaction-aware retrieval/reassembly. SovPin may make this easier, but must expose fees, confirmation state, supported size limits, and retrieval behavior instead of presenting it as a free or instant object store. Exact limits and costs must be measured against the target daemon and chain before being promised.
- **MMR is an integrity/indexing primitive, not another storage tier.** `signdata` MMRs can commit to a collection and support inclusion proofs while the leaves or files live elsewhere. SovPin can optionally pin the leaves and provide proofs, but the Verus signature/commitment and the off-chain availability claim must remain distinct.
- **Privacy is a hard boundary.** SovPin should accept and pin ciphertext without decrypting it. A workflow that invokes `decryptdata` or uses a viewing key must be explicitly opt-in, narrowly scoped, and preferably run client-side or under the developer's own infrastructure. Never ask developers to submit spend keys or silently turn viewing keys into a service credential.
- **Availability is layered.** Verus anchors identity state and references; Kubo/IPFS stores content-addressed objects; SovPin provides pinning and gateway operations. A CID or on-chain reference alone is not a guarantee of availability, so the API must report what SovPin actually pins and serves.

### The developer decision rule

```text
Small structured state / identity fields   → Verus CMM
Large or routinely served binary objects   → IPFS + URLRef + content hash
Chain-native persistence required           → Verus data-storage flow, after cost/privacy review
Large collection requiring integrity proof  → MMR commitment + off-chain leaves (often IPFS)
Private application data                    → Client-side encryption, then chosen storage tier
```

The product opportunity is to let a Verus application select among these modes through a consistent API/SDK, while returning the exact Verus representation, transaction or pin status, and verifiable integrity information for each mode.

---

## 5. Target Developer Workflow (How a Verus Project Uses SovPin)

Here is the intended lifecycle of a Verus application (such as **VREAL**) using the target SovPin architecture:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. AUTH & PROVISIONING                                                     │
│ Developer signs in with project VerusID (e.g. vreal@) -> generates         │
│ scoped backend API key (svp_live_...) -> registers CMM Watcher on          │
│ registry identity (NftIndex.vreal@).                                       │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 2. INGESTION & VDXF COMPILATION (WRITE PATH)                               │
│ App Backend calls SovPin with bytes + a selected storage class and key.    │
│ SovPin pins to Kubo or prepares an explicitly requested native-data path, │
│ then returns the typed reference/payload and integrity details.            │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 3. ON-CHAIN COMMIT & AUTONOMOUS VERIFICATION (CHAIN PATH)                  │
│ App Backend broadcasts the authorized identity/data transaction using     │
│ the returned Verus payload (SovPin does not custody the app's identity).  │
│ SovPin's CMM Watcher detects the new sub-identity / CMM entry on-chain,    │
│ verifies all referenced CIDs are pinned in Kubo, and updates the           │
│ Content Discovery Map & Pin Health ledger.                                 │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 4. EDGE DELIVERY & IDENTITY RESOLUTION (READ PATH)                         │
│ DApp Frontend fetches either:                                              │
│   • Direct IPFS CID through SovPin's gateway                              │
│   • VerusID + VDXF reference through a resolver (planned capability)       │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. VREAL Migration: Adopting Verus Standards (SovPin Integration)

VREAL currently stores NFT media references as `DataDescriptor` with JSON `objectdata` containing `https://ipfs.filebase.io/ipfs/<cid>` URLs. This works but does not use Verus-standard `URLRef` format, meaning:
- No on-chain SHA-256 hash commitment (can't verify byte integrity)
- SovPin can find CIDs via regex but can't verify or build CMM payloads
- Media is on Filebase, not SovPin's Kubo

### Migration Steps

1. **SovPin parses VREAL's format** (✅ Done): `verus-storage.js` now decodes VREAL's JSON-in-DataDescriptor format, extracting the `uri` field and synthesizing a `URLRef`-like object with `datahash: null`.

2. **VREAL adopts SovPin for uploads** (Next): Replace Filebase upload with `POST /v1/pin/upload/stream?vdxfUri=vreal::nft.asset.media`. SovPin returns a `serializedhex` (DataDescriptor(CrossChainDataRef(URLRef))) with `dataHash`.

3. **VREAL stores the serializedhex** under `assets.content.main` instead of JSON with `uri`. Keep rich metadata (title, mime, width, height) as separate JSON entries under their existing VDXF keys.

4. **One-time migration** of existing NFTs: Use `scripts/migrate-vreal-to-sovpin.js` to read VREAL identities, extract CIDs, upload to SovPin, and generate new CMM entries.

### Standard Format (Verus `URLRef`)

```json
{
  "version": 1,
  "flags": 96,
  "label": "assets.content.main",
  "mimetype": "image/jpeg",
  "objectdata": "<CrossChainDataRef(URLRef) serialized bytes>"
}
```

Where `objectdata` decodes to:
```
CrossChainDataRef (type=2/URL_REF) → URLRef (version=2, flags=1, url="ipfs://Qm...", dataHash=<32-byte SHA-256>)
```

### What VREAL Keeps as JSON (Not Migrated)

| VDXF Key | Content | Why Not Migrated |
| :--- | :--- | :--- |
| `assets.description` | `{"description":"..."}` | Text metadata, not a media pointer |
| `assets.provenance` | `{"minter":"...","minterIAddress":"..."}` | Identity metadata, not a media pointer |
| `assets.traits` | `{"traits":[...]}` | Structured data, not a media pointer |
| `assets.root` | `{"status":"active"}` | Status flag, not a media pointer |
| `assets` | `{"v":1,"loc":[...]}` | Location hints, not a media pointer |

Only `assets.content.main` (and `assets.content.alt`) need migration — they're the only ones that point to IPFS media.

To make the current SovPin implementation match this target architecture completely, here is our prioritized execution plan:

1. **Phase 1 — Deep VDXF & CMM Intelligence (Core Protocol Value)**
   - **Initial slice implemented:** Watcher traversal and `GET /v1/resolve/:identity` decode the standard serialized URLRef CMM value and report Kubo recursive-pin status. CID-only legacy references remain discoverable. URLRef write/read conformance is still a separate test.
   - **Streaming & chunked ingestion implemented and verified on public Cloudflare edge:** Authenticated multipart file uploads stream through SovPin to Kubo without Base64 buffering. Over the live public edge (`https://dashboard.sovpin.com`), single-request streaming uploads (`POST /v1/pin/upload/stream`) succeeded at 50 MiB (`QmPRwfFBW4JjbqjznxqWcBDricq6LFjHBgp4XKPVAJy7b5`, read back from `https://ipfs.sovpin.com` with exact SHA-256 match) and 95 MiB (`QmTLdCap2Mf7ZBi9KgXo26x7CfZbSv3BtGGNEGFvvxEFXZ`), while 105 MiB cleanly returned `HTTP 413 PAYLOAD_TOO_LARGE` at the 100 MiB single-request edge boundary. For payloads above 100 MiB, chunked/resumable upload (`POST /v1/pin/upload/chunked/init`, `PUT .../part`, `POST .../complete`) succeeded at 150 MiB (3 × 50 MiB parts, `QmZvUvDoveLyFkPYCgeP7ke9jchCjD7WVpL2BM4nfbFL4m`) over `https://dashboard.sovpin.com` with full Kubo pin & SHA-256 verification.
   - **Native `DataDescriptor` Decoder in CMM Traversal & Resolver:** Decode real `DataDescriptor` fields (`version`, `flags`, `mimetype`, `label`, `objectdata`) inside `getidentitycontent` instead of only regex-matching CIDs, and surface them in the API and Content Discovery Map.
   - **On-Chain Pin Health Check in Traversal:** For every CID discovered on-chain in a watched identity tree, report whether it is actively pinned in SovPin/Kubo (`pinned: true/false`, `sizeBytes`, `pinStatus`) and allow one-click or automatic repair/pinning of any unpinned on-chain CIDs.
   - **VerusID Resolver Endpoint (`GET /v1/resolve/:identity`):** Allow developers to query any VerusID (+ optional `?vdxf=` filter) and get back its decoded VDXF descriptors, CIDs, pin health, and gateway URLs in one JSON call.

2. **Phase 2 — Verus Hybrid Storage Conformance**
   - **Initial slice implemented:** `/v1/pin/upload` now additionally returns a `DataDescriptor(CrossChainDataRef(URLRef))` CMM fragment. It commits the SHA-256 of bytes uploaded through this endpoint; for pins where SovPin cannot verify the original bytes, it returns a URLRef without a hash rather than asserting an unverified commitment. Existing response fields remain for compatibility.
   - Unit tests round-trip the serialized value through the Verus primitives library. This validates local encoding/decoding only—not an on-chain write/read or native multipart flow.
   - **Native-storage preparation implemented:** `POST /v1/verus/native-storage/entry` resolves the developer's VDXF URI and returns Verus's `updateidentity` `data` wrapper shape. The filename is for the caller's own `verusd`; SovPin does not read it, sign, or broadcast. The caller merges the entry into its existing identity update so other identity fields are preserved.
   - **Small-file VRSCTEST round-trip verified:** The standard `updateidentity` data wrapper was written to `sovpin.VRSCTEST@`, confirmed, read through `getidentitycontent`, and retrieved with `decryptdata`; the recovered 51 bytes matched the source SHA-256. The transaction fee was 0.001 VRSCTEST. The daemon needed `-enablefileencryption` for filename input.
   - **Above-threshold VRSCTEST round-trip verified:** An 8 KiB fixture crossed the documented ~6 KiB threshold, produced three cryptocondition outputs (versus two for the 51-byte fixture), and `decryptdata` reassembled all 8,192 bytes with an exact SHA-256 match. It confirmed twice and cost 0.1 VRSCTEST.
   - **100 KiB VRSCTEST round-trip verified:** After the 1 VRSCTEST cap was insufficient, the authorized 1.2 cap allowed a 1.07 VRSCTEST transaction. It confirmed, and `decryptdata` recovered all 102,400 bytes with an exact SHA-256 match. The transaction had 18 evidence outputs totaling 105,968 script bytes.
   - **Fee model confirmed from daemon source:** `GetMinRelayFeeForBuilder` adds a storage charge based on serialized `EVAL_NOTARY_EVIDENCE` output bytes, `STORAGE_FEE_FACTOR`, and the chain's `transactionExportFee`, in addition to identity/output fees. This VRSCTEST reports `transactionExportFee = 0.01`; the default storage factor is 6 and the PBaaS script element size is 6,000 bytes, giving a 1.05968 VRSCTEST storage component for the 100 KiB transaction before other fees. The older wiki per-megabyte estimate is not a safe fee quote for this daemon/configuration.
   - Larger payload limits, multi-transaction behavior, and upper-bound multipart retrieval remain to be verified before publishing size/cost guarantees.
   - Build testnet conformance fixtures for CMM inline values, `DataDescriptor`, `CrossChainDataRef` / `URLRef`, and supported native multipart data flows. Record real RPC request/response shapes, size boundaries, fee behavior, confirmation requirements, and retrieval/reassembly results.
   - Only after those tests, specify a storage-class API for IPFS references versus native Verus data. Keep encrypted flows opaque by default and do not promise cross-chain support until verified per chain.

3. **Phase 3 — Developer Ergonomics (`contentmultimap` Fragment & Webhooks)**
   - **Canonical CMM payload in `/v1/pin/upload`:** Return the Verus-standard `contentmultimap` value keyed by the resolved VDXF i-address, using the serialized VDXF object form (`{ [vdxfKey]: [{ serializedhex }] }`) consumed by the chain and existing Verus application tooling.
   - **Block-Triggered Sync & Signed Webhooks:** Add `/v1/internal/blocknotify` (for instant block-driven watcher syncs) and signed webhook dispatch when watched identities change on-chain.

4. **Phase 4 — Production Hardening & End-to-End VREAL Proof**
   - **Secrets & Config Hygiene:** Move all signing WIFs and API secrets strictly to `.env` (never hardcoded fallbacks).
   - **Live End-to-End VREAL Proof:** Execute a real upload/mint flow from VREAL into SovPin, commit or sync on `VRSCTEST`, and verify the full write → chain → resolve loop live.
