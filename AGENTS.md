# AGENTS.md — SovPin contributor guide

## Verus Primitives — Always Use Them (Do Not Reinvent)

Verus ships a maintained primitive stack. **Always use it instead of hand-rolling serialization, VDXF objects, or RPC clients.** Inventing parallel implementations drifts from the daemon and breaks interoperability with other Verus apps (including VerusGame1).

- Foundational library: `verus-typescript-primitives` (npm; `require('verus-typescript-primitives')`). Covers `DataDescriptor`, `CrossChainDataRef`, `URLRef`, `ContentMultiMap`, VDXF objects/keys, typed RPC request/response classes, address/hash utils.
- RPC transport: `verusd-rpc-ts-client`.
- Identity operations: `verusid-ts-client`.

Catalog: see `verus-dev/references/libraries.md` in the VerusGame1 checkout (`/home/demon/Documents/VerusGame1/verus-dev/references/libraries.md`). If a needed primitive is missing upstream, extend the shared fork — never create a parallel hand-rolled version in this repo.

SovPin is a sovereign IPFS + VDXF storage engine for Verus developers.
Public gateway `https://ipfs.sovpin.com`, console + API `https://dashboard.sovpin.com`
(local: `http://127.0.0.1:3001`). UK commercial product (SovPin Technologies Ltd,
GBP £ + VRSC VerusPay billing, 20% UK VAT).

## 1. Read the canonical docs first

- [`docs/ARCHITECTURE_AND_API.md`](docs/ARCHITECTURE_AND_API.md) — system topology,
  upload modes, every REST endpoint, SQLite schema, env vars, ops commands.
- [`docs/FOUNDATION.md`](docs/FOUNDATION.md) — product charter, Verus VDXF rules,
  storage benchmarks.
- [`dashboard/README.md`](dashboard/README.md) — backend commands.

**Anti-drift rule (enforced by tests):** `dashboard/test/docs-reality.test.js` fails
`npm test` if any route, table, env var, or README file path drifts from those
docs. Changing `dashboard/src/saas-routes.js`, `dashboard/src/db.js`,
`dashboard/.env.example`, or the repo layout means updating the docs in the same
change.

## 2. Layout

```text
dashboard/          Express API (server.js, :3001), SQLite WAL ledger, tests
  src/config.js     Plans (£/VRSC), VAT, limits, Verus RPC + Kubo endpoints
  src/db.js         SQLite schema, quotas, reference counting, audit logs
  src/verus-rpc.js  verusd JSON-RPC client (getvdxfid/getidentitycontent/…)
  src/verus-storage.js  URLRef / CrossChainDataRef / DataDescriptor codec
  src/kubo-service.js   Kubo RPC client (stream add, pin/rm, verify, GC)
  src/saas-routes.js    ALL /v1/* routes (keep docs in sync, see §1)
  test/             saas.test.js (live), verus-storage.test.js, docs-reality.test.js
web/                React 19 + Vite + TS + Tailwind v4 developer console
  src/App.tsx       Shell, sidebar, Cmd+K palette, Protected routes, lazy() routes
  src/lib/api.ts    API client (ApiError), auto single/chunked uploader
  src/lib/auth-context.tsx  Session provider (memory-only secrets, 401/refresh)
  src/lib/useAuth.ts        Session hook (separate file: fast-refresh rule)
  src/lib/queryClient.ts    TanStack Query defaults (no retry on 401/403)
  src/hooks/useLedger.ts    Queries + mutations for pins/keys/webhooks/etc.
  src/components/Dialog.tsx Shared accessible modal (focus, Escape, scroll lock)
  src/components/Field.tsx  Labeled field wrapper + inline validation errors
  src/components/Kbd.tsx    Keyboard-hint chip
  src/pages/        Landing, SignIn, Dashboard, PinStudio, Watchers, Billing, Compliance
  dist/             Production build, served by Express at / (gitignored)
scripts/            systemd unit, Kubo deploy, Cloudflare tunnel + cache setup
docs/               Canonical architecture + foundation documents
.github/workflows/ci.yml  Web gates + hermetic docs-reality check
```

## 3. Commands

```bash
cd /home/demon/sovpin/dashboard
npm run build:web   # build web/ → web/dist (served at /)
npm test            # full suite: live integration + VDXF + docs-reality
npm start           # serve API + SPA on http://127.0.0.1:3001

cd /home/demon/sovpin/web
npm run dev         # Vite on :5174, /v1 + /api proxied to :3001
npm test            # vitest suite (format, api contract, Dialog)
npm run lint        # eslint, zero-warning gate
npm run typecheck   # strict tsc (fails closed — no `|| true`)
npm run build       # production build (lazy per-route chunks)
```

`npm test` needs **live services**: LAN verusd (`192.168.86.110:25779`, VRSCTEST)
and Tailscale Kubo (`100.66.85.86:5001`). Tests boot the app on an ephemeral port
with a temp SQLite file, so they never touch production data — but they fail
without those daemons. `docs-reality.test.js` is the only hermetic test file.

## 4. Backend conventions (`dashboard/`, plain Node, no TS)

- Express 4, `server.js` wires `/v1` (saas-routes), `/healthz`, `/metrics`,
  `/api/kubo|verus|cloudflare` status, static `web/dist` (`/ops` removed).
- Auth: HttpOnly cookie sessions and `svp_live_…` API keys; tenants are keyed by
  canonical Verus `i-address`, never email/password. Scope errors are 403 —
  the UI distinguishes them from 401 (see §5).
- Upload limits: JSON `~35 MiB`, single stream `100 MiB`
  (`MAX_SINGLE_UPLOAD_BYTES`), chunked parts `≤ 50 MiB`. These mirror the
  Cloudflare 100 MB per-request cap — do not raise them without also changing
  the edge configuration in `scripts/configure-*.sh`.
- Money: all billing in GBP pence + VRSC with 20% VAT math in one place
  (`src/config.js`); record spot GBP valuation at invoice time.

## 5. Frontend conventions (`web/`, strict TS)

- API client: `api()` throws `ApiError` with `.status` (`0` = network
  unreachable). Catch `.message` for display; branch on `.status` for control
  flow. `uploadFileWithAutoChunking()` auto-switches at `80 MiB` and reports
  per-part progress via `onProgress(done, total)`.
- Data layer is TanStack Query (`src/hooks/useLedger.ts` + `lib/queryClient.ts`):
  pages consume `usePins()`/`useInvoices()`/… and mutations, never hand-rolled
  fetch effects. Queries do not retry 401/403; `useLedgerAuthGuard()` re-checks
  the session on 401 (provider clears the token → redirect) and surfaces 403
  scope messages. Invalidate, don't refetch manually (`useInvalidateLedger()`).
- Auth provider owns 401/403: minted API key **secrets** stay in React memory
  and are never persisted — **never `localStorage`**. The browser session rides
  the HttpOnly `svp_session` cookie (`SameSite=Strict`, `Secure` on edge
  traffic; `verify` and login-consent `poll` set it, `logout` clears it).
  No token material lives in JS or storage. API keys (`svp_live_…`) still use
  the `Authorization` header. Keep `useAuth` in
  `lib/useAuth.ts` and context in `lib/auth-state.ts` (fast-refresh rule).
- Shared primitives live in `src/components/`: `Dialog` (focus, Escape, scroll
  lock — use for all modals), `Field` (labels, hints, inline `role="alert"`
  errors — mirror backend validation rules, e.g. webhook `^https?://`), `Kbd`,
  `CopyInline`. Do not invent one-off modals or unlabeled inputs.
- Selection state: reconcile against query data in one effect per view with a
  documented `eslint-disable` (external-store sync); prune dead ids on reload.
- Accessibility baseline (do not regress): every input has a `<label>`/`aria-label`,
  table headers use `scope="col"`, modals use `role="dialog|alertdialog"` +
  `aria-modal` with Escape-to-dismiss and an autofocused labeled close button,
  status text uses `role="status"`/`alert`.
- Style: keep the dark mono/emerald ledger aesthetic (`bg-[#090A0C]`,
  `#10B981` accents). No purple/blue gradients, no glow/bento restyles. Mobile
  works via `md:` breakpoints — test tables at 375px (`overflow-x-auto`
  wrappers, `min-w-[640px+]` tables).
- Routes are `React.lazy()` + `Suspense` in `App.tsx`; keep page chunks small.
- Tests: colocated `*.test.ts(x)` run by `vitest` (`npm test`); cover contracts
  (API errors, formatting) and primitives (Dialog behavior). Backend `npm test`
  still needs live verusd + Kubo; keep `docs-reality.test.js` hermetic.

## 6. Safety rules

- **Never commit secrets.** `dashboard/.env`, WIFs, `svp_live_…` keys, and
  `dashboard/data/` are gitignored — keep it that way. `.env.example` holds
  placeholders only.
- Destructive ops (`DELETE /v1/account`, unpin, 451 takedown, GC) need explicit
  user confirmation and must surface the backend's refcount/result message.
- Do not edit `docker-compose.yml` storage mounts or tunnel/cache scripts
  without verifying against the live MacBook node first.
- Do not run the review CLIs (`claude`, `agy`, `codex`) with write-capable
  modes against this tree — past runs edited files despite read-only flags.
  Verify with `npx tsc -b --noEmit`, `npm run build`, and `npm test` instead.
