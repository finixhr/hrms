# CHANGES — 2026-10-17 · Wave R3-3 (Security, Privacy & Entitlements)

Round-3 full-system audit → implementation plan Wave **R3-3**: every PII leak,
the dead `apiAccess` entitlement, the AI scope bypass, and the escalation keys
in the tenant permission model. 12 findings closed: 7 High (SUB-101/102/103,
FLD-101, RPT-001/002, AI-001) and 5 Medium (FLD-102, RBAC-101/104, AI-002,
RDM-001). Evidence and file:line citations live in
`the audit working papers (round-3 SaaS/RBAC findings)` and `3-f-reports-ai-others.md`;
the plan is in `FinixHR_Full_System_Audit_Report.pdf` (Wave R3-3).

No schema/migration changes. 19 files modified, 2 new source files
(`src/hrm/pii.ts`, the R3-3 test suite).

---

## SUB-103 (High) — jobs.get no longer leaks the salary export to any tenant user

**Was:** `jobs.get` was `public: true` (unauthenticated calls crashed with 500
on `ctx.vendorId`) and returned `resultJson` verbatim — the SALARY_EXPORT job
stores the rendered bank-transfer salary sheet (base64 XLSX incl. full account
numbers), so any authenticated user — including ESS accounts — who learned a
job id could fetch the payroll export.

**Now** (src/hrm-server/routes/admin.ts):
- `public: true` removed → unauthenticated → clean **401**; route perm
  `["jobs", "view"]` (every role that can SUBMIT a job holds it).
- New `JOB_RESULT_PERM_GATE` + `jobResultPermFor()`: job types whose resultJson
  carries bulk sensitive data have their `result` **redacted server-side**
  unless the caller holds the type's permission —
  SALARY_EXPORT → `payroll.view`; BACKUP_EXPORT / BACKUP_PG_DUMP / RESTORE_DRILL
  → `settings.edit`. Redacted callers get
  `{ result: null, resultRedacted: true, resultPermRequired }` while
  status/progress/counts still flow (job-creator progress bars keep working,
  and the read-only-lockout exemption stays meaningful: expired tenants may
  poll progress, not results).

## FLD-101 (High) — salary structure & revision history withheld server-side

**Was:** `employees.get` fetched and returned the full salary structure and
every historical revision to ANY `employees.view` holder; the client's
"Confidential" mask was cosmetic and its own sub-line leaked
`Basic: ৳X` (src/hrm/views/employees.tsx:2039 was not perm-gated).

**Now** (src/hrm-server/routes/employees.ts + src/hrm/views/employees.tsx):
- Server-side projection: without `payroll.view` the structure/revisions are
  **not even loaded** (`structure: null, revisions: []`), and the response
  carries `employee.salaryVisible` so the UI renders the right affordance.
- The KPI card sub-line is now gated on `can("payroll","view")`; both the
  Overview "Compensation Snapshot" and the Compensation tab distinguish
  "confidential (payroll.view required)" from "no structure set".

## FLD-102 (Medium) — NID / identity document numbers masked to last-4

**Was:** every doc row's `docNumber` (NID/passport/birth-reg/driving licence)
and `employee.nid`/`identityNumber` were returned unmasked to anyone who could
open a profile.

**Now:**
- New shared pure module `src/hrm/pii.ts`: `maskDocNumber()` ("•••• 1234",
  ≤4-char values fully masked) + `isMaskedDocNumber()` — imported by both the
  server routes and the client dialogs, one masking vocabulary for the
  product (mirrors the C-05 bank convention).
- `employees.get` masks every doc `docNumber` + the employee identity fields
  unless the caller holds the new **`employeeDocs.reveal`** verb (granted to
  HR_ADMIN / VENDOR_OWNER / HR_MANAGER; branch & department managers and ESS
  see the mask). `employee.identityNumberVisible` marker included.
- **Write-path guard:** a masked value round-tripped from a redacted read is
  treated as UNCHANGED by `employees.update` (a profile edit by a non-reveal
  viewer can never overwrite the stored number with bullets), and create
  paths reject masked input with a clear message. The edit dialog prefills
  the identity field EMPTY when the server value is masked and omits the key
  on save — no accidental clears, no masked-value saves.

## SUB-101 (High) — apiAccess plan flag is a real entitlement

**Was:** the `apiAccess` plan column was sold in the plan catalog and resolved
into `features.API` — and read by NOTHING. A Starter-plan tenant could create
API keys and use the entire public REST surface.

**Now:**
- `MODULE_FEATURE_GATES.integrations = "API"` — the dispatcher feature-gates
  the whole `integrations.*` module family (key/webhook administration) with
  the standard upgrade message; LEGACY tenants pass untouched.
- `TENANT_MODULES` gains an `integrations` entry (feature: API) — the SaaS
  Owner Console can now toggle the REST API per tenant (it was not
  overridable at all).

## SUB-102 (High) — /api/v1 write scopes honor the read-only lockout

**Was:** EXPIRED/SUSPENDED tenants were supposed to be fully read-only, but
`authenticateApiKey()` never consulted entitlements — a suspended tenant's
keys kept mutating attendance and leave data indefinitely.

**Now** (src/app/api/v1/_auth.ts): after the scope check,
`resolveEntitlements(vendorId)` + pure `apiEntitlementError(ent, scope)`:
- plan without apiAccess → **403 `API_NOT_INCLUDED`**
- read-only tenant + `*:write` scope → **423 `SUBSCRIPTION_READONLY`**
  (read scopes still work — the workspace is read-only, not bricked).
Both decision helpers exported for the test suite.

## RPT-001 (High) — scheduled delivery of PII reports gated

**Was:** `reports.templates.save` validated only the report key; any
`reports.schedule` holder could schedule `employeesBiodata` to be e-mailed
DAILY to up to 10 **arbitrary external addresses**, bypassing the HIGH-11
bulk-PII gate entirely.

**Now** (src/hrm-server/routes/reports.ts + scheduled-reports.ts):
- PII classification is a first-class registry concept: `reportPiiKeys` +
  exported `isPiiReportKey()` (the flag used to live only inside the CSV
  twin's closure — invisible to the scheduler and the client).
- `templates.save` on a PII-class key additionally requires **`reports.pii`**
  (see the vocabulary fix below) and validates every recipient against tenant
  membership (user logins + employee e-mails) — outsiders are refused with the
  address named.
- **Run-time defense:** `runReportTemplate` re-verifies membership before every
  send; a departed member's PII template is recorded SKIPPED with the reason —
  never SENT. Covers templates saved before this wave existed.

## RPT-002 (High) — the bulk-PII export gate works from the UI now

**Was:** the server required `payload.confirm === "EXPORT"` for the biodata CSV
but no client ever sent it — a legit `reports.pii` holder's CSV export always
400'd; and the client-side .xlsx path (SheetJS from the RENDERED rows)
bypassed the gate entirely for anyone with `reports.view` + `reports.export`.

**Now** (src/hrm/views/reports.tsx + src/hrm/shared/report-print.tsx):
- PII-class reports (`pii: true` on the client registry, in sync with the
  server registry) get a **typed-confirmation dialog** (type `EXPORT` to
  enable the button) that injects `confirm: "EXPORT"` into the CSV payload.
- `ExportAsMenu` accepts `xlsxHidden` — the client-side .xlsx item is removed
  for PII-class reports when the caller lacks `can("reports","pii")`.
- **The dead-verb fix:** `reports.pii` was never in the ACTIONS catalog, so
  `normalizePermissions()` stripped it from every role — nobody in the system
  could hold the permission the CSV route demanded. `"pii"` (and `"reveal"`)
  are now catalog verbs, and the admin templates grant them.

## AI-001 (High) — ai.reportAsk renders as the caller, not as HR_ADMIN

**Was:** the NL report path rendered through `renderReportForVendor()` — a
synthetic `{ role: "HR_ADMIN", permissions: {reports.view, reports.schedule} }`
context. A branch/department manager got tenant-wide rows, and any user with
`ai.generate` could pull the payroll register without `reports.view`/

`payroll.view`.

**Now** (src/hrm-server/routes/reports.ts + src/hrm-server/routes/ai.ts):
- New `renderReportAsCaller(ctx, key, filters)` — same registry, same handlers,
  same filter validation, but the REAL caller ctx flows through so
  `employeeScopeFilter()` applies branch/department scope exactly like the
  Reports view. Both the deterministic and the LLM-routed branches use it.
- `ai.reportAsk` additionally requires `reports.view` (in-handler, clear 403).
  The synthetic HR_ADMIN ctx remains reserved for the SYSTEM scheduler.

## AI-002 (Medium) — LLM endpoint configuration is an admin action

**Was:** `ai.settings.save` was gated only by `ai.generate` — any AI-enabled
user could repoint `baseUrl` to an arbitrary https host, and resume screening
would then POST candidate PII there with the stored API key as Bearer.

**Now:** `ai.settings.save` → `settings.edit` (tenant administrators);
`ai.settings.get` → `ai.view`. The AI Assist provider form renders read-only
(inputs disabled, save/clear hidden, explanatory notice) for users without
`settings.edit`.

## RBAC-104 (Medium) — settings.edit is no longer a full-escalation key

**Was:** `users.save` / `roles.save` / `users.delete` all required only
`settings.edit` — one permission away from minting VENDOR_OWNERs, resetting
any password, or deleting the tenant's only owner (the last-HR_ADMIN guard
existed; the last-VENDOR_OWNER guard did not).

**Now:**
- New **`users` module** (`users.view/create/edit/delete`) in the permission
  catalog. `users.save` → `users.edit`; `users.delete` → `users.delete`;
  `roles.save|delete` → `users.edit` (`roles.list` stays `settings.view`).
  Granted to HR_ADMIN/VENDOR_OWNER; HR_MANAGER keeps read visibility
  (`users.view`) of the Settings → Users tab only. The Settings UI gates its
  buttons accordingly.
- **Owner-lockout guards:** demoting, suspending or deleting the last active
  VENDOR_OWNER is refused with an actionable message (mirrors the
  last-HR_ADMIN guard, in both `users.save` and `users.delete`).

## RBAC-101 (Medium) — delegations carry the promised permission (+ cap)

`delegations.save` / `delegations.end` now actually require
`approvals.view` — the in-code comment claimed it had been added in the M-02
round; it never was (an ESS account could silently delegate approval
authority). Self-scope logic preserved; concurrent ACTIVE delegations per
delegator capped at 10 (auditable cover chains).

## RDM-001 (Medium) — audit purge is owner-only, confirmed, floored, money-safe

**Was:** `auditRetention.purge` needed only `settings.edit`, no confirmation:
set retention to 1 day, purge, and the forensic trail of your own prior
actions is gone (the single purge audit row survives).

**Now** (src/hrm-server/routes/roadmap.ts): four gates —
1. **VENDOR_OWNER role** (tenant admins can no longer erase the trail that
   audits them);
2. **typed confirmation** `confirm: "PURGE"` + `reason` (≥ 10 chars, zod);
3. **365-day floor**: the cutoff is `max(settings days, 365)` — a shortened
   setting can never delete younger rows;
4. **money-action protection**: payroll/payout/settlement/loans/advances/
   bonus/commissions/accounting/backups/auditRetention audit rows are exempt
   from every purge (permanent financial evidence). Pure helpers
   `effectiveRetentionDays()` + `isProtectedAuditAction()` exported for tests.

---

## Verification

- `npx tsc --noEmit` — **0 errors**.
- `npx prisma validate` — valid (no schema changes; `DATABASE_URL` must be set).
- `node scripts/check-migrations.mjs` — only the 3 pre-existing naming FAILs
  on the user's own `10_/11_/12_*` migrations (documented in R3-2; no
  migrations added).
- ESLint — **0 new errors** on every changed file (remaining findings are the
  pre-existing react-hooks/unused-vars baseline).
- Pure-function suite **66/66 PASS** — `bun run tests/unit/r3-3-wave-security-privacy.test.ts`
  (sandbox; no PostgreSQL required).
- Regression harnesses re-run: **R3-1 54/54**, **R3-2 37/37** PASS.
- DB-integration tests shipped in
  `tests/unit/r3-3-wave-security-privacy.test.ts` (PART B needs the
  unit-test PostgreSQL): jobs.get 401/403/redaction matrix, employees.get
  projection matrix (masked / payroll / reveal) + masked-echo no-corruption,
  users split + both owner-lockout guards, delegations 403, ai.reportAsk
  403 + branch-scoped render, ai.settings perms, purge owner gate +
  floor + money-row survival, PII template save/run gates, biodata CSV typed
  confirm, and live `authenticateApiKey` 403/423/read-pass scenarios.
- **Test-suite repair (latent defect):** the R3-1/R3-2 dispatcher tests
  accessed `r.body.<field>` but the dispatcher envelope is `{ ok, data }` —
  21 success-path accesses rewritten to `r.body.data.<field>` (the suites
  were never DB-run in the sandbox, so the defect was invisible; it would
  have failed every dispatcher test on first run in a real environment).

## Files touched

**Server:** src/hrm-server/routes/admin.ts (jobs.get, users/roles split, owner lockouts,
delegations), src/hrm-server/routes/employees.ts (FLD-101/102 projection + write guards),
src/hrm-server/routes/reports.ts (PII registry, member recipients, renderReportAsCaller,
templates.save gate), src/hrm-server/routes/ai.ts (AI-001/002), src/hrm-server/routes/roadmap.ts (RDM-001),
scheduled-reports.ts (run-time member re-check), src/hrm-server/saas/entitlements.ts
(integrations gate), src/hrm-server/saas/constants.ts (TENANT_MODULES entry),
src/app/api/v1/_auth.ts (SUB-101/102 gate), src/hrm-server/types.ts (vocabulary),
**new** src/hrm/pii.ts.
**Client:** src/hrm/views/reports.tsx (typed confirm + XLSX gate), src/hrm/shared/report-print.tsx
(ExportAsMenu xlsxHidden), src/hrm/views/employees.tsx (sub-line + affordances),
src/hrm/views/employee-edit-dialog.tsx (masked-value handling), src/hrm/views/ai-assist.tsx
(provider form read-only), src/hrm/views/settings.tsx (users/roles tab gating),
src/hrm/views/cameras.tsx (gate vocabulary alignment).
**Tests:** tests/unit/r3-3-wave-security-privacy.test.ts (new),
r3-1/r3-2 suites (body-envelope fix).
