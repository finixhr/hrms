# Finix HR — Production Readiness Checklist

> Honest, evidence-based readiness assessment. Every line cites what was
> actually verified (gate run, test count, commit) on its stated date.
> Nothing here is aspirational: an item is checked only when its proof exists.
> Assessment date: 2026-10-30 (after M4 — GitHub integration + T-14…T-16).

## Overall verdict

| Environment | Verdict | Basis |
|---|---|---|
| **Development** | ✅ READY | Full 14-stage local gate exits 0; unit suite 1742/1742 (twice consecutive); lint 0 errors; mobile typecheck clean; the M4 GitHub integration is committed on top of the user's own `c172f2c` (no history rewritten) |
| **Staging** | ⚠️ READY WITH CAVEATS | Same code + gates, but hosted CI has never executed (§6), desktop builds unverified on Windows/macOS (TD-11), device-dependent features unverified on hardware (TD-26) |
| **Production** | ❌ NOT READY | §1–§6 below: no hosted-CI execution, no release process, no monitoring/alerting wiring verification, no restore drill executed, pending P1/P2 debt |

---

## 1. Code quality gates — ✅ (development), ❌ (hosted)

- [x] TypeScript strict typecheck — root AND mobile (`tsc --noEmit`, gate stage 1; mobile job in workflow)
- [x] ESLint — 0 errors (9 advisory warnings tracked as TD-22)
- [x] Unit suite — **1742 pass / 0 fail** (two consecutive full runs; was 1728 at M3, 1683 at M2 — +14 M4 tests: 12 export-honesty, 2 contract pins)
- [x] Secret scan, scrypt gate, destructive-op guard, docs guard, permission-registry lint (602 actions gated or annotated), dependency audit, fresh-DB migration smoke, schema-drift gate, perf budget — all green in `scripts/ci.sh`
- [ ] **Hosted CI execution** — BLOCKED (see §6). The workflow file is the honest hard-fail pipeline (T-01/T-08) and its stage-identical local gate passes, but no GitHub-hosted runner has ever executed it.

## 2. Database & migrations — ✅

- [x] Migration chain applies cleanly to a fresh database (stage 11, throwaway DB each run)
- [x] Zero drift between migration chain and `schema.prisma` (stage 12)
- [x] M3 changed no schema (the outbox is device-side; server replay reuses the existing `unique(vendorId, clientEventId)`)
- [x] Destructive-operation guard + migration naming policy maintained
- [ ] Production `migrate deploy` execution — by policy, no production deployment from this environment (needs release process, §5)

## 3. Security & multi-tenancy — ✅ code-level

- [x] Tenant isolation pinned by tests (M3 replay lookup is vendor-scoped; cross-tenant same-`clientEventId` = new event, never a replay)
- [x] Selfie proofs: authenticated upload, byte-sniffed mime (JPEG/PNG/WebP ≤ 2 MB), sha-256 hash, private DB storage, retention (`tracking.retentionDays`), storage-quota metering, no public URLs
- [x] Offline queue carries no secrets (no tokens/passwords/biometrics; auth token read live from secure store at submission)
- [x] Permission registry: 602 actions gated or annotated (stage 9 — `auth.supportExit` marker added this cycle)
- [x] CSP hardened in the desktop config (T-09) — build verification still owed (TD-11)
- [ ] Penetration test / external security audit — never performed

## 4. Functional readiness (mobile M3+M4 scope) — ✅ code-level

- [x] Offline attendance punches: enqueue offline → survive restart → replay with the same `clientEventId` → exactly one attendance row/event/proof/notification server-side (12 server contract tests)
- [x] Honest offline UX: success shown only after server confirmation; 401 pauses the queue and resumes post-login; permanent rejections keep the server's message
- [x] Selfie capture: permission flow → preview → capture → downscale ≤640px → explicit confirm → upload; retry reuses the idempotency key (no double punch, photo stored once)
- [x] Native MFA enrollment wizard (M4/T-14): 3-step QR → code → recovery-codes-once; contract-pinned against the existing H-1 server suite; no success before the server accepts
- [x] Push registration honesty (M4/T-15): fail-closed registration, projectId resolved from the linked EAS project, no dead tokens, no startup breakage
- [x] Export honesty (M4/T-16): 12 boundary tests pin failure/delivery paths of the money-critical exports; the one silent-no-op client path fixed
- [x] No fabricated data: GPS/time captured at punch time, replayed verbatim; delayed deliveries flagged for HR review, not silently accepted
- [ ] Device-level field testing (real airplane-mode toggle, real camera, QR scan, real Expo push received) — the react-native wiring layers are typecheck/contract-verified only (TD-26)

## 5. Operations — ❌ (the production blocker set)

- [ ] Release process (tags `v*`/`mobile-v*`, draft releases, smoke checklist) — T-29, not started
- [ ] Monitoring & alerting wiring (metrics endpoint + `deploy/hrm-alerts.rules.yml` → Prometheus/alertmanager) — T-26, unverified end-to-end
- [ ] Backup cadence + a full restore drill executed and witnessed — T-27 (scripts/timers exist, no executed drill on record)
- [ ] Dependency/provenance audit cadence — T-28 (single audit passes; cadence unowned)
- [ ] Term-invoice partial unique index (TD-21) — deliberately deferred pending dirty-data review
- [ ] Hosted CI (§6) — must be green on real runners before any production claim

## 6. Exact blocker: hosted CI (M3-E → M4, re-scoped)

The directive requires a first hosted GitHub Actions run on a GitHub-hosted
runner. **This environment cannot perform it**, and the blocker is now
precisely scoped (M4 re-audit):

- `origin` **is** configured (`https://github.com/finixhr/hrms.git`) and read-fetches work — the repo was fetched and its history compared during the M4 integration.
- The M4 integration (the repaired tree, honest CI workflow, T-14…T-16) sits as **local commits on `main` on top of `origin/main` (`c172f2c`)** — a plain fast-forward push, no force needed.
- What is missing: **any push credential** — no `gh` CLI installed, no credential helper, no `GH_TOKEN`/`GITHUB_TOKEN` env; and the unauthenticated REST API is rate-limited from this sandbox network, so existing workflow runs cannot even be inspected from here.

**Exact setup to unblock** (choose one, then re-run this session's verification):
1. GitHub CLI: `gh auth login` (interactive) on a machine with repo access, or provide a runner where `gh` is pre-authenticated;
2. Git Credential Manager / `git config credential.helper` with a stored PAT having `repo` scope;
3. Any approved secure credential mechanism of your choice — **never paste a token into chat or a file in the repo**.

Then: `git push origin main` — the committed workflow
(`.github/workflows/ci.yml`: `web` → typecheck/lint/secret-scan/`scripts/ci.sh`/build,
`mobile` → `npm ci` + `tsc` + advisory expo-doctor, `docker-build` on main pushes)
triggers on the push itself. Tracked as TD-24.

**Status distinction (per the directive)**: the workflow is *implemented* and
*verified locally* (stage-identical gate) — it has NOT run on GitHub-hosted
runners, and no claim of hosted-CI success is made anywhere in these docs.

## 7. Known residual risks (top, honest)

1. **Hosted-CI execution unverified** (§6) — the strongest single caveat on every "green" claim above; the push itself is the only missing step.
2. **Device-dependent features unverified on hardware** (TD-26) — T-14 wizard, T-15 real push, M3 selfie + NetInfo/AppState are code/contract/unit-verified only.
3. **React-native outbox wiring untested on devices** — all queue logic is unit-tested in the dependency-free engine, but NetInfo/AppState behavior is verified by typecheck + reasoning only.
4. **Background/terminated sync depends on OS scheduling** — no headless background task is implemented (TD-27; documented limitation, `OFFLINE_OUTBOX.md` §10).
5. **Offline punch official time = server receipt time** — delayed punches land as REVIEW_REQUIRED with the device timestamp preserved; reviewers must act on the queue (by design, but it is an operational dependency).
6. **Mobile eslint lane crashes** (TD-23, pre-existing) — mobile lint is not gated; typecheck is.
7. **Selfie ≠ identity verification** — no face detection/liveness is claimed or implemented; policy text must never market it as biometric identity proof.
8. **GitHub `main` was briefly broken** (`c172f2c` botched merge) — repaired by the M4 integration (TD-28); anyone who cloned in that window should `git pull` after the M4 push.
