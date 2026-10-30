# CHANGES — 2026-10-17 · Wave R3-5 (SaaS Capacity/Feature Gates, Tenant RBAC & Field-Level Permissions)

Round-3 full-system audit → implementation plan Wave **R3-5**: the SaaS-layer
capacity/feature contract gaps, the tenant RBAC vocabulary drift, and the
field-level permission system the user asked for from the start. 8 findings
closed (SUB-105 verified + SUB-106/107 + SUB-108 same-class early closure,
RBAC-102/103/105, FLD-103) + the BTN-103 half of RBAC-105 folded in. Evidence
and file:line citations live in `the audit working papers (round-3 SaaS/RBAC findings)`.

**NO schema/migration changes.** 14 files modified, 2 new source files
(`src/hrm-server/field-permissions.ts`, the R3-5 test suite) + the
`tests/unit/r3-5-wave-saas-rbac-fieldperms.test.ts` sandbox harness (outside the tree).

---

## SUB-105 (Medium) — devices re-enable DEVICES capacity — VERIFIED (re-ported R3-2)

The R3-2 re-port wave already landed `requireCapacity(vendorId, "DEVICES", 1)`
inside `devices.setEnabled` when `enabled === true && !d.enabled`
(src/hrm-server/routes/devices.ts:207-219). This wave adds the pin to the regression suites
(route-registration perm assertion in `verify-r35` + the R3-5 test file) so the
re-enable cap cannot silently disappear again. **Closed by verification.**

## SUB-106 (Medium) — selfie/photo proofs are no longer the unmetered STORAGE inflow

**Was:** the capacity registry advertised `"selfie.checkin"` under STORAGE
(`MODULE_CAPACITY_ON_CREATE.documents`) and counted `AttendanceProof.data` in
the usage snapshot, but **no route enforced it** — a tenant at quota kept
uploading punch selfies (the fastest-growing storage consumer), making the
storage cap advisory.

**Now** (new `requireSelfieStorage(vendorId, photoDataUrl)` in
`src/hrm-server/saas/entitlements.ts` — counts the incoming base64 payload length as
`extraUsed` against the plan quota, no-ops on empty payloads, LEGACY tenants
pass):
- `attendance.selfie.checkin` — metered **before any DB write** (same
  no-orphan-punch ordering guarantee as the L-29 byte-sniff);
- `attendance.geofence.checkin` / `.checkout` — metered when a selfie rides
  the geo punch, before the fence pipeline writes anything;
- `attendance.periodicCheck` (tracking.ts) — the selfie branch is metered
  before the proof + event writes;
- `fieldforce.storeVisitPhoto` — visit photos are AttendanceProof rows too;
  metered inside the writer after the M-37-style byte-sniff.

Mirrors the leave-attachment pattern (`leave.ts` REQUIRE_CAPACITY with
`extraUsed`). The placement (early, pre-write) is pinned by source-scan
assertions in the harness; the quota math itself is exercised by the DB suite
on the user environment.

## SUB-107 (Medium) — ESS / GEOFENCE / TRACKING plan gates no longer bypassable via prefix gaps

**Was:** the dispatcher's feature gate only sees routes through `def.perm`'s
module or the `SAAS_ACTION_PREFIX_MODULE` prefix map (`ess`/`tracking`/
`geofences`). Self-scoped routes under other prefixes were invisible to it: on
a plan with `essEnabled=false` employees could still self-file leave
(`leaveRequests.apply` checks `ess.create || leave.create` in-handler but the
ESS feature gate never ran), geofence punches kept working without GEOFENCE,
and the periodic check-in (a tracking-policy feature) worked without TRACKING.

**Now**:
- `SAAS_ACTION_PREFIX_MODULE.leaveRequests = "leave"` — the Owner Console's
  per-tenant **Leave Management override** now controls the whole self-service
  leave surface (leave itself stays core — no plan flag gates the HR plane).
- `leaveRequests.apply`: the **EMPLOYEE self-application path** runs
  `requireFeature(vendorId, "ESS")` after the identity checks (HR users with
  `leave.create` keep applying — leave is core for HR).
- `attendance.geofence.checkin` / `.checkout`: in-handler
  `requireFeature(vendorId, "GEOFENCE")` — mirrors the
  `requireFieldForceFeature` pattern the audit called "the model done right".
- `attendance.periodicCheck`: in-handler `requireFeature(vendorId, "TRACKING")`.

## SUB-108 (Low, closed with the SUB-107 class) — guarantor consent no longer bypasses the PAYROLL gate

`loans.guarantorRespond` is self-scoped (no `def.perm`) under the unmapped
`loans` prefix, so a PAYROLL-less plan could still decide loan guarantees
created before the downgrade. In-handler `requireFeature(vendorId, "PAYROLL")`
(src/hrm-server/routes/finance.ts). The finding was not in the R3-5 deferred list but is the
identical one-line class — closed early rather than left for a future wave.

## RBAC-102 (Medium) — the bankInfo.* vocabulary is now REAL

**Was:** the Roles & Permissions matrix showed a Bank Information module whose
`edit`/`verify` toggles gated nothing — bank CRUD rode `employees.edit`, bank
verification rode `employeeDocs.verify` (a different module's family), and
`employees.banks.list` returned **raw account numbers** to any `employees.view`
holder (a C-05 violation on an RPC-only surface no client view calls).

**Now** (src/hrm-server/routes/employees.ts):
- `employees.banks.verify` → `perm: ["bankInfo", "verify"]`;
- `employees.banks.create / .update / .delete` → `perm: ["bankInfo", "edit"]`
  (the SECTION macro gained an optional per-section perm override — no other
  section changed: family/education/references/prevEmployment stay on
  `employees.*`, pinned by tests);
- `employees.banks.list` → `perm: ["bankInfo", "view"]` **and** rows are
  masked to last-4 (account + MFS numbers) exactly like the employees.get
  payload — raw numbers never leave the server on any surface;
- HR_MANAGER's template now carries `bankInfo.edit` (it legitimately maintains
  the payout section — and now revoking it actually locks the section).

## RBAC-103 (Medium) — per-user grants are ADDITIVE, normalized and audit-visible

**Was:** an explicit per-user permission set **replaced** the role template
wholesale (auth.ts), freezing that user out of every future template update —
the exact stripping bug documented at `types.ts` §ACTIONS; `users.save`
persisted arbitrary garbage strings without `normalizePermissions()`; there
was no UI; no audit diff.

**Now**:
- **auth.ts**: effective permissions = `role template ∪ explicit grants`.
  A saved grant list can only WIDEN a user, never narrow it — role-template
  updates keep flowing through. Restricting a user below their role is what
  custom roles are for (roles.save ships full-template editing).
- **users.save**: the explicit list is normalized against MODULES×ACTIONS
  exactly like role templates (deduped, validated, sorted); an explicit `[]`
  clears the overrides.
- **Audit**: users.update rows now carry `oldValue.permissions` /
  `newValue.permissions` (the diff), users.create notes the grant count.
- **UI** (Settings → Users & Security): a per-user **Additional Permissions**
  dialog (person icon per row) — the same MODULES×ACTIONS matrix as the role
  editor, showing the baseline template count, the additional grants and the
  resulting **effective** count.

*Migration note:* existing users with explicit sets intended as restrictions
will now also carry their role template. That is the audit's recommended
direction (it fixes the freeze-out class); convert any intentional
below-role restriction into a custom role.

## RBAC-105 (Low) + BTN-103 — the "dead verb" class is wired to real routes

**Was:** `employees.export`/`employees.assign` were granted by every default
template but gated nothing server-side (and the directory's DataTable CSV
button had **no permission check at all**); `audit.export` gated a client-side
CSV of the loaded page only — revoking it hid a button, nothing more.

**Now**:
- **`audit.export`** (reports.ts): a REAL route — perm `["audit","export"]`,
  zod-validated filters (entity/user/q/from), 50k-row cap,
  formula-injection-safe CSV (utils `csv`), and it writes its **own audit row**
  (exporting the trail is a trail event). The Audit view's Export button calls
  it and downloads the blob; the decorative client-side `csvName` is gone.
- **`employees.exportCsv`** (employees.ts): perm `["employees","export"]`,
  scope-filtered (employeeScopeFilter), **non-PII directory columns only**
  (code/name/designation/department/branch/type/grade/joined/status — no
  contact, no identity numbers, no salary; the bulk-PII biodata export keeps
  its own `reports.pii` gate from R3-3), 10k-row cap, audited. The directory
  header gains an "Export CSV" button for holders; the visible-page DataTable
  CSV is now gated on `employees.export` too.
- **`employees.changeShift`** now accepts `employees.assign` **or**
  `employees.edit` (every existing grant keeps working; tenants can delegate
  roster assignment without profile-edit rights).
- **tasks.\***: kept in-handler by design — the self-service fallback (users
  without `tasks.view` see only their own assigned tasks) is stricter than a
  static perm and is what the ESS plane depends on; documented here as the
  audit's alignment decision.

## FLD-103 (Medium, design gap) — the field-level permission system

**Was:** no field-level permission model existed — field control was 3 ad-hoc
spots (C-05 bank masking, the client-only payroll.view salary mask, the
audited doc/payslip downloads). There was no way to say "role X may edit the
bank section but not the salary section", "role Y sees NID masked", or "role Z
edits contact but not grade".

**Now** — a tenant-editable, **server-side** field-permission engine:

- **New `src/hrm-server/field-permissions.ts`**: 5 field groups
  (`salary`, `bank`, `identity`, `contact`, `employment`) × 3 access modes
  (`full` / `mask` / `none`). Storage: the new `fieldPermissions` **hrSettings
  group** (`{ roles: { [role]: { [group]: mode } }, default: {...} }`) — no
  schema change; validated at save time (unknown keys, bad modes, bad shapes
  are rejected with the offending key in the message). Unlisted role/group =
  `full` → **an untouched tenant behaves exactly as before**.
- **Combination rule**: the field layer can only **NARROW** what the
  module-perm layer granted (`combineFieldAccess`: a denied route permission
  collapses to none; the stricter of the two layers wins). A role without
  `payroll.view` never sees salary whatever the field rules say.
- **Read side** (`employees.get`): salary/structure + revisions load only for
  effective `full`; bank rows only when not `none` (always last-4-masked —
  C-05); identity numbers `full`/`mask`/`none` map to raw / last-4 / hidden
  (combining with `employeeDocs.reveal`); **contact + employment are projected
  on the employee object** (`projectRecord`: none → nulled, mask →
  phones/emails masked) and on **`employees.list` rows**. The payload carries
  `fieldAccess` + the existing `salaryVisible`/`identityNumberVisible` markers
  so views need no per-field logic.
- **Write side**: `employees.update` / `prepareEmployeeCreate` run
  `stripDeniedWriteFields` — groups the caller's role may not edit are
  **stripped** (never rejected: a full-form save still lands for the allowed
  fields), the withheld keys are listed in the **audit row**
  ("field permissions withheld: …"); the identity-document upsert and the
  payout-method change are gated on their groups; `salaryStructures.save`
  denies when salary is `none` **even with payroll.edit**;
  `employees.banks.*` deny when bank is `none`.
- **auth.me** exposes `user.fieldAccess` for client affordances; the employee
  edit dialog renders restricted sections read-only via a native
  `fieldset[disabled]` + a "Read-only — field permissions" badge.
- **UI** (Settings → Security & Access → **Field Permissions**): role selector
  (incl. custom roles + a tenant-default row) × the 5 groups × access mode,
  with per-group effect text; saves through the standard
  `settings.save` group flow.

**Semantics notes** (documented in the UI): `mask` behaves as `none` for
salary (no meaningful partial form for amounts) and for employment org
columns; `mask` on bank reads identically to `full` (numbers are last-4-masked
for everyone by C-05) but still blocks writes only at `none`; the ESS
self-service plane (own data) is never restricted — these rules govern the HR
plane.

---

## Verification

- `tsc --noEmit`: 0 errors · `prisma validate`: OK (no schema changes) ·
  `check-migrations.mjs`: OK (23 migrations, no new ones).
- ESLint: **0 new errors** on all changed files (byte-identical error count
  vs the git HEAD baseline — pre-existing unused-vars/non-null/react-hooks
  baseline unchanged).
- Sandbox harness `tests/unit/r3-5-wave-saas-rbac-fieldperms.test.ts`: **80/80 PASS** (pure
  field-permission engine: parse/resolve/combine/project/strip/mask + save
  validation + route-registration truth for RBAC-102/105 + SUB-105/107 +
  source-scan pins for the SUB-106/107/108 gate placements).
- Regression: verify-r31 54/54 · verify-r32 37/37 · verify-r33 66/66 ·
  verify-r34 44/44 — all green after this wave's edits.
- DB-integration suite shipped: `tests/unit/r3-5-wave-saas-rbac-fieldperms.test.ts`
  (PART A pure + PART B dispatcher scenarios: per-user grant union + normalize +
  audit diff, banks vocabulary/masking, audit.export + employees.exportCsv
  permission gates + audit rows, changeShift assign-only holder, field-permission
  end-to-end — projected reads, stripped writes with audit note,
  salaryStructures.save denial, auth.me fieldAccess — and the SUB-107/108
  plan-feature gates incl. HR-vs-ESS path split). Needs the unit-test
  PostgreSQL (`bun test` on the user environment).

## Files

| File | Change |
|---|---|
| `src/hrm-server/field-permissions.ts` | NEW — the field-permission engine (pure) |
| `src/hrm-server/settings.ts` | `fieldPermissions` group (type + default + save validation) |
| `src/hrm-server/saas/entitlements.ts` | `requireSelfieStorage` (SUB-106) |
| `src/hrm-server/routes/employees.ts` | banks SECTION re-gate + masking (RBAC-102), `employees.exportCsv` (RBAC-105), changeShift assign gate, FLD-103 projection/whitelist on get/list/update/create |
| `src/hrm-server/routes/attendance.ts` | SUB-106 storage guards ×3 + SUB-107 GEOFENCE gates ×2 |
| `src/hrm-server/routes/tracking.ts` | SUB-106 guard + SUB-107 TRACKING gate on periodicCheck |
| `src/hrm-server/routes/fieldforce.ts` | SUB-106 guard inside storeVisitPhoto |
| `src/hrm-server/routes/leave.ts` | SUB-107 ESS gate on the employee apply path |
| `src/hrm-server/routes/finance.ts` | SUB-108 PAYROLL gate on guarantorRespond |
| `src/hrm-server/routes/reports.ts` | `audit.export` route (RBAC-105/BTN-103) |
| `src/hrm-server/routes/payroll.ts` | FLD-103 salary-group gate on salaryStructures.save |
| `src/hrm-server/routes/admin.ts` | RBAC-103 normalize + audit diff in users.save |
| `src/hrm-server/auth.ts` | RBAC-103 union semantics |
| `src/hrm-server/routes/auth.ts` | auth.me / userPayload expose `fieldAccess` |
| `src/hrm-server/types.ts` | HR_MANAGER carries bankInfo.edit |
| `src/app/api/hrm/route.ts` | SUB-107 `leaveRequests` prefix map (exported for tests) |
| `src/hrm/views/settings.tsx` | Field Permissions tab + per-user Additional Permissions dialog |
| `src/hrm/views/audit.tsx` | server-side Export CSV button |
| `src/hrm/views/employees.tsx` | Export CSV button + gated page CSV + banks section button perms |
| `src/hrm/views/employee-edit-dialog.tsx` | per-section read-only lock on restricted field groups |
| `tests/unit/r3-5-wave-saas-rbac-fieldperms.test.ts` | NEW — the R3-5 suite |
