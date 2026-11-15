# SovPin Security Audit Report

Date: 2026-11-15
Scope: `dashboard/` (Express API + SQLite) and `web/` (React SPA), plus `server.js` infra endpoints.

## Summary

Overall posture is reasonable: parameterized SQL, scoped API keys, SSRF guard on webhooks, loopback-only infra endpoints, security headers, rate limits, and a content-length/size quota. The main gaps are in the legacy ops dashboard (XSS via `innerHTML`), incomplete SSRF/IP validation, shell-command construction via `exec`, and auth-abuse hardening.

## Findings

### High

1. **Stored XSS in legacy ops dashboard (`dashboard/public/index.html`)**
   - Multiple `container.innerHTML = ...map(...)` interpolations render tenant-controlled names (plans, pins, keys, watchers, invoices) without escaping.
   - Impact: any tenant with a crafted name could execute script in an operator's browser, potentially stealing session tokens.
   - Fix: escape HTML or use `textContent`/DOM construction; apply DOMPurify.

2. **Shell command injection surface (`server.js`)**
   - `runCmd` uses `child_process.exec` with interpolated `method`, `TAILSCALE_IP`, `endpoint`, `TUNNEL_ID`, etc. Values are currently internal constants, but `kuboRpc(endpoint, method)` accepts arbitrary strings and `method` is interpolated unquoted into the curl command.
   - Fix: use `execFile`/`spawn` with argument arrays; validate `method` against an allow-list (`GET`/`POST`).

3. **Incomplete SSRF protection (`saas-routes.js` webhook validator)**
   - Blocks a small host set and RFC1918 literals, but misses IPv6 (`::ffff:127.0.0.1`, `::`), decimal/octal IP encodings, and DNS rebinding (hostname resolves to private IP at request time).
   - Fix: resolve the hostname and reject any private/loopback/link-local/metadata IP before dispatch; block IPv6 loopback; use a robust IP-classification library.

### Medium

4. **No account-level lockout / challenge abuse**
   - `/auth/challenge` and `/auth/verify` rate-limited only by IP; distributed attempts and challenge flooding possible. Challenge rows accumulate.
   - Fix: per-identity rate limiting and challenge cleanup/expiry sweep (already partial via poller); add CAPTCHA or proof-of-work for public flows.

5. **Session token in `localStorage` (documented tradeoff)**
   - XSS in the SPA would exfiltrate the bearer token. Moving to HttpOnly cookies requires backend changes.
   - Fix: prioritize eliminating XSS (finding 1) and consider cookie migration.

6. **Error messages leak internals**
   - Several 500 responses include `err.message` (e.g. pin upload, auth). Could expose stack/paths.
   - Fix: return generic messages in production; log details server-side.

7. **Missing Content-Security-Policy**
   - Security headers set but no CSP. With inline scripts in the legacy dashboard this is especially risky.
   - Fix: add a strict CSP (and remove inline scripts).

8. **Webhook secret returned once but stored plaintext**
   - `secret` stored in DB as plaintext. If DB leaked, attackers can forge webhook signatures.
   - Fix: store only a hash; verify via HMAC comparison is impossible with hash-only — alternatively encrypt at rest with a server key.

### Low

9. **Rate-limit buckets are in-memory and unbounded-ish**
   - `Map` keyed by IP grows; pruning is probabilistic (1% per request). Memory exhaustion possible under spoofed IPs (but req.ip behind proxy needs trust proxy config).
   - Fix: trust-proxy configuration review; use a bounded LRU or external store.

10. **`express.json` 50mb + urlencoded 50mb** exceeds single-upload 100mb claim? Actually JSON cap 50mb; consistent with docs. Fine but verify Cloudflare edge.

11. **Admin wildcard scope (`*`)** only for configured admin identities; ensure `config.adminIdentities` is env-driven and not empty-default.

12. **No CSRF protection** on cookie-less Bearer auth (not applicable to Bearer, but session token in localStorage + Bearer header means CSRF-resistant; OK).

## Recommendations

- Adopt `execFile` everywhere; remove `exec`.
- Add CSP and HTML escaping in legacy dashboard (or retire `/ops`).
- Harden SSRF validator with DNS resolution + IP classification.
- Add per-identity auth rate limits and challenge expiry cleanup.
- Genericize 500 error responses.
- Encrypt or hash webhook secrets at rest.

## Dependency audit (npm audit)

- `dashboard/`: 6 high (transitive `base-x`/`bs58` via `wif`/`@bitgo/utxo-lib`). `npm audit fix` could not resolve (nested duplicate); affects address validation homograph risk in wallet libs. Low runtime exposure (only receipt signing uses utxo-lib).
- `web/`: 10 (8 moderate, 2 critical in dev-only `tinypool`/vitest). Criticals are dev-dependency only; not shipped to production. `npm audit fix --force` would upgrade vitest to v5 (breaking) — defer.

## Not audited (out of scope / needs live services)

- Verus RPC auth, Kubo RPC exposure, Cloudflare tunnel config, systemd units, and the React frontend type-safety (run `npm run lint`/`typecheck`/`build` separately).
- Live integration tests (`saas.test.js`) require verusd on 192.168.86.110:25779 (currently unreachable from this host) + Kubo on 100.66.85.86:5001 (reachable). Run `npm test` in `dashboard/` once verusd is available; only `docs-reality` and `verus-storage` suites are hermetic and currently passing.
- Dependency CVEs: run `npm audit` in both `dashboard/` and `web/`.