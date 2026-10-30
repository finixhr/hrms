# Finix HR — Security Audit

> Scope: verified observations from the 2026-10-30 engineering audit (Task A) plus targeted verification runs. This is an architecture/process audit from source — not a penetration test.
> Positive findings are listed first because they define what must NOT be regressed by upcoming work.

---

## 1. Verified security strengths (do not weaken)

| Control | Evidence |
|---|---|
| Layered RPC dispatcher | `src/app/api/hrm/route.ts`: content-type check → origin allowlist → session → CSRF (cookie plane, `X-CSRF-Token`) → vendor scoping → module-gate + RBAC perm → Zod payload validation before handler. Bearer plane exempt from CSRF by construction (custom header + unreadable token — documented rationale in-file). |
| Session hardening | Sessions stored as `tokenHash` (migration `9_wave9zm`), PREAUTH rows cannot mint a Ctx (`src/hrm-server/auth.ts:296`), 5-min MFA challenge TTL, concurrent-session cap policy (S6). |
| Server-side RBAC + scoping | `src/hrm-server/rbac.ts` (`employeeScopeFilter`, `scopedEmployeeWhere`, `assertEmployeeVisible`); negative tests: `scope-bypass.test.ts`, `camera-tenant-isolation.test.ts`, `phase-r5-security-isolation.test.ts`, `ungated-actions.test.ts`, `master-prompt-security.test.ts`. |
| ESS self-scope | `requireSelf(ctx)` on every `ess.*` route (`src/hrm-server/routes/ess.ts:12`); reviews leak prevention (ESS-03: DRAFT reviews invisible to employees). |
| Field-level PII | `crypto-field.ts` + `pii-field.ts`; bank/MFS numbers encrypted at rest with legacy passthrough; `fieldAccess` in `auth.me`; tests `phase5-p6-pii-encryption.test.ts`, `crypto-field-mfa-backcompat.test.ts`. |
| Auth hardening | Login throttling (`auth-throttle.test.ts`), MFA guess throttle per challenge token, login audit rows (R16), spoof-proof IP resolution behind trusted proxy, generic 401 (no account oracle). |
| Secrets | `scripts/scan-secrets.ts` — **clean run 2026-10-30**; `.env` untracked (gitignore); secret rotation scripts exist. |
| Uploads & SSRF | `m37-doc-upload-validation.test.ts`, `phase3-wse-ssrf-campaign.test.ts`; attachment bytes kept out of list payloads (R3). |
| Rate limiting | `rate-limit.ts` + per-surface tests (login, MFA, selfie `guardSelfieRate`, ticket creation 10/min). |
| SaaS entitlements | `saas/entitlements.ts` module gates enforced in the dispatcher (UI hiding explicitly documented as convenience only). |
| Destructive-op discipline | `scripts/ci.sh` stage 7 (unguarded `deleteMany({})` / bare DELETE guard). |

---

## 2. Findings requiring action

| ID | Severity | Finding | Evidence | Disposition |
|---|---|---|---|---|
| SEC-1 | **P1** | Desktop webview CSP disabled | `desktop/src-tauri/tauri.conf.json:25` `"csp": null`; webview navigates to tenant-configured remote URLs (`desktop/ui/app.js:105`) | **Fixed (config) in first cycle** — restrictive CSP set; platform build verification still owed (T-22). |
| SEC-2 | **P0-process** | CI cannot fail — security regressions (and everything else) ship invisibly | `ci.yml:59` (`\|\| true`), `ci.yml:65` (pipe masks exit code) | **Fixed in first cycle** (T-01) — hard-fail gates incl. secret scan + `scripts/ci.sh` stages. |
| SEC-3 | P2 | Mobile session restore bypasses RPC client — stale token survives 401; network errors conflated with auth failures | `mobile/app/_layout.tsx:24-39` | **Fixed in first cycle** (T-02) — routed through `rpc()`. |
| SEC-4 | P2 | Mobile token storage | `expo-secure-store` used correctly (`mobile/src/lib/api.ts`); Bearer + `X-Requested-With` exemption is design-intended | OK — document the exemption as accepted. |
| SEC-5 | P2 | `support.ticket.create` is `.strict()` but `leaveRequests.apply` is `.passthrough()` — inconsistent strictness lets clients ship junk fields silently | `validation.ts:225-236` | Backlog (careful: web SPA may rely on passthrough). |
| SEC-6 | P2 | Unprefixed route modules bypass prefix-based feature gating (own `perm` still enforced) | contract audit §5.1 | Backlog T-20. |
| SEC-7 | P3 | Windows `certificateThumbprint` hardcoded in repo | `tauri.conf.json:49` | Move to build secret/CI variable when desktop release pipeline is owned (T-29). |
| SEC-8 | P3 | `bun pm untrusted` blocked postinstall — unvetted postinstall script risk surface | root install log 2026-10-30 | Review + pin trust decisions in T-28. |
| SEC-9 | P1 | 13 failing unit tests include security-relevant guarantees (protocol isolation H-10, ISAPI freshness H-3, billing idempotency) | health report §4 | Backlog T-10 — these tests failing means the guarantees are currently UNPROVEN, not necessarily broken. |

---

## 3. Authentication & session flow (verified end-to-end for the employee plane)

- `auth.login` → throttle → audit → password verify → MFA branch (`mfaToken`, 5-min PREAUTH) or forced-enrollment branch (`enrollToken`, 15-min) or full session (`createSession` honors concurrent-session cap).
- `auth.mfa.verify` → per-token throttle → PREAUTH promotion → full session.
- Session resolution refuses PREAUTH rows (C-1 fix verified in source).
- Logout revokes the session server-side (`doLogout` imported by the dispatcher) — mobile calls `push.unregisterDevice` first, then clears the token.
- **Mobile gaps fixed in first cycle**: MFA field names, enrollment state, 401 clearing (see changelog). Remaining: native enrollment wizard (T-14).

---

## 4. Multi-tenant isolation (verified design + test corpus)

- Every query observed in audited handlers filters `vendorId: ctx.vendorId`; cross-tenant id probes get 404 (e.g. `recruitment.applications.list` opening check).
- `assertEmployeeVisible` blocks cross-branch/department manager access (H-04/H-05 comments + tests).
- Suggested additions: ESS-plane negative tests (T-19) — the family mobile now depends on.
- Support-access third session plane (Wave 10) has its own resolver + banner contract (`auth.me` rides session facts).

---

## 5. Recommendation order

1. Keep CI truth-telling green (SEC-2 fix must not regress — workflow is now the enforcement point).
2. T-10 to restore proof of the security-relevant guarantees.
3. Desktop build verification of the CSP change (T-22) before any desktop release.
4. ESS-plane negative tests (T-19) before broadening mobile usage.
