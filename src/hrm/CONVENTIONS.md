# Finix HR — View Implementation Conventions (MANDATORY READ)

You are implementing UI module views for a multi-tenant HRM ERP (Next.js 16 App Router,
TypeScript, Tailwind 4, shadcn/ui). The backend is COMPLETE — you only build view files.

## Golden rules
1. **Only modify the view files assigned to you.** Do NOT touch schema, API routes, shared kit, store, nav, or other views. If something seems missing in shared code, work around it locally in your file.
2. Every view file starts with `"use client"` and has a **default export** named `<Module>View`.
3. **Permission-gate every action button** with `can(module, action)` from the store. The server re-checks anyway (never rely on UI hiding alone, but never show buttons users can't use).
4. Use `rpc(action, payload)` / `useApi(action, payload)` for ALL data. No direct DB/browser storage access.
5. Money format: `fmtMoney(n)` → `৳12,345`. Dates: `fmtDate(iso)`. Status chips: `<StatusBadge status={...} />`.
6. Design system: emerald-600 primary buttons (`bg-emerald-600 hover:bg-emerald-700 text-white`), white cards with `rounded-xl border`, slate text scale, `text-xs` secondary text. NO indigo/blue backgrounds. Icons from `lucide-react`.
7. Every table = `DataTable` with `csvName` for export when data is list-like and permission `*.export` might exist.
8. Every create/edit form = `FormDialog` with typed `FieldDef[]`. Delete/danger = `ConfirmDialog`.
9. Handle loading/error/empty states — the components already do; just pass `loading`/`error`.
10. After a successful mutation call `reload()` from the `useApi` hook. Toasts are handled inside FormDialog/ConfirmDialog; for custom actions use `useHrm((s) => s.toast)`.

## Imports you will use
```tsx
"use client"
import { useState } from "react"
import { /* icons */ } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useHrm } from "../store"                     // { user, can, navigate, view, toast, refreshUnread }
import { useApi, rpc } from "../api"                  // useApi<T>(action, payload) → { data, loading, error, reload }
import { PageHeader, StatCard, StatusBadge, fmtMoney, fmtDate, fmtDateTime, titleCase,
         SectionCard, SectionTabs, KV, EmptyState, RatingStars, minutesHHMM } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"
```

## Component APIs

### DataTable
```tsx
<DataTable
  columns={columns}          // Column<T>[]: { key, label, render?(row), align?, sortValue?(row), className? }
  rows={data}                // T[] | undefined
  loading={loading} error={error}
  csvName="leave-requests"   // adds CSV export button
  searchPlaceholder="Search…"
  pageSize={15}
  toolbar={<Button…/>}       // extra buttons left of CSV
  onRowClick={(row) => …}    // optional
  emptyTitle="No records" emptyHint="…"
/>
```

### FormDialog
```tsx
const fields: FieldDef[] = [
  { name: "title", label: "Title", required: true, span: 2 },        // span:2 = full width
  { name: "amount", label: "Amount (৳)", type: "number", min: 0 },
  { name: "date", label: "Date", type: "date" },
  { name: "status", label: "Status", type: "select", options: ST.map(s => ({ value: s, label: titleCase(s) })) },
  { name: "note", label: "Note", type: "textarea", rows: 2, span: 2 },
  { name: "flag", label: "Enable", type: "switch" },
]
<FormDialog open={open} onOpenChange={setOpen} title="Add X" description="…" wide
  fields={fields} initial={editRec}          // initial for edit mode
  onSubmit={async (v) => { await rpc("x.create", v) }}   // throw e to show error inline
/>
```
It auto-toasts "Saved successfully" and closes on success.

### ConfirmDialog
```tsx
<ConfirmDialog open={!!del} onOpenChange={setDel…} title="Delete" message="…"
  danger confirmLabel="Delete" requireReason?      // reason is audit-logged server-side
  onConfirm={async (reason) => { await rpc("x.delete", { id: del.id }) }} />
```

### Store
```tsx
const { user, can, navigate, view } = useHrm()
can("payroll", "approve")            // boolean — action-level permission
navigate("employees", { employeeId })// SPA navigation
view.params                          // current params (e.g. employeeId)
user.role                            // HR_ADMIN | HR_MANAGER | PAYROLL_OFFICER | BRANCH_MANAGER | DEPT_MANAGER | EMPLOYEE | VENDOR_OWNER
```

### SectionTabs (tabbed module pages)
```tsx
<SectionTabs tabs={[
  { value: "runs", label: "Payroll Runs", content: <RunsTab/> },
  { value: "ait", label: "AIT / Tax", content: <AitTab/> },
]} />
```

## Reference views (READ THESE FILES FIRST)
- `src/hrm/views/employees.tsx` — directory + 360 profile + sections + dialogs (the full pattern)
- `src/hrm/views/organization.tsx` — CRUD tabs pattern
- `src/hrm/views/dashboard.tsx` — stats/charts pattern (recharts is available)

## Worklog protocol
After finishing, APPEND (do not overwrite) a section to the repo-root `worklog.md`:
```
---
Task ID: <your task id>
Agent: <name>
Task: <what you built>
Work Log:
- <steps>
Stage Summary:
- <files created/updated>
```

## Verification
Run `bunx eslint src/hrm/views/<your-files>.tsx` — must pass with zero errors (warnings ok).
Do NOT run `bun run build` or start dev servers (the dev server is already running on port 3000; your files hot-reload).

## Camera Manager (Phase 6+)

**View path:** `src/hrm/views/cameras.tsx` (default export `CamerasView`)
**Nav key:** `cameras` (under "Attendance" group, icon: `Cctv` from lucide-react)
**Dashboard widget:** `CameraWidget` in `src/hrm/views/dashboard.tsx` (lazy-loaded charts in `camera-dashboard-charts.tsx`)

**Permissions** (module key: `camera` — singular):
| Permission | Audit verb | Helper |
|---|---|---|
| `camera.view` | — (read-only) | — |
| `camera.create` | `camera.create` | `audit()` |
| `camera.edit` | `camera.update` (verb split) | `audit()` |
| `camera.edit` (for restore) | `camera.restore` | `audit()` |
| `camera.delete` | `camera.delete` | `auditStrict()` |
| `camera.launch` | `camera.launch` | `auditStrict()` |
| `camera.manage` | `camera.credential.create` / `camera.credential.rotate` / `camera.credential.delete` | `auditStrict()` |

**Provider pattern:** Each brand implements `CameraProvider` in `src/hrm-server/cameras/providers/<brand>.ts` + registers in `src/hrm-server/cameras/providers/registry.ts`. See `src/hrm-server/cameras/providers/README.md` for how to add a 5th brand.

**Launch UX:** Option A (deep link + web portal + copy details, no SDK). Embedded H5 player (Option B) is Phase 6b if users request it.

**Key conventions specific to cameras:**
- `verificationCode` is WRITE-ONLY — stripped from every API response via `publicCamera()`. UI shows `hasVerificationCode: boolean` only.
- `encryptedPayload` never appears in audit rows (in `AUDIT_PII_EXCLUDE` set).
- Cross-tenant point lookups return 404 (not 403) — prevents ID enumeration.
- Soft-deleted cameras (`enabled=false`) are excluded from `listCameras` by default; `camera.launch` + `camera.status` on soft-deleted → 404.
- Credential/token failures return `status: "UNKNOWN"` (not `"OFFLINE"`) — the camera may be fine, we just can't see it.
- `accessToken` is a separate field in `LaunchTarget`, never embedded in the URL (prevents referrer/history/log leakage).

## Lessons from Camera Manager (for the next module)

These design decisions emerged across 7 phases of building the Camera Manager. Copy them as a starting checklist for any new multi-tenant module in this codebase.

### 1. Confirm-before-building checklist (Phase 1)
Before writing any code, inspect the live repo and report findings on:
- **vendorId scoping:** Prisma middleware/extension or manual per-route? (This codebase: manual — `assertTenant(rec, ctx)` + `scopeFilter(ctx)` on every query.)
- **Permission check pattern:** wrapper, decorator, or manual `if`? (This codebase: registry decorator — `perm: ["module", "action"]` on `route()` defs; dispatcher auto-calls `require()`.)
- **Folder structure:** mirror the closest existing module end-to-end. (Attendance Devices was the analog for Camera Manager.)
- **DTO/Zod convention:** does the module use `schema: ZodType` on routes, or `cleanForm()` + `safePayload()`? (This codebase: legacy convention dominant; registry-native Zod is the future direction but not yet adopted.)
- **Encryption utility:** where does it live, can it be reused? (Extracted `crypto-field.ts` with context-parameterized salt.)
- **Database provider:** SQLite or Postgres? (Confirmed SQLite — no enums, no jsonb, plain String columns with comments.)
- **Role-permission backfill:** is there a migration script pattern? (Yes — `scripts/migrate-role-perms-*.ts`, additive + idempotent.)
- **Master spec doc:** does it exist? (No — use local `// section` comments, don't invent `// spec §X` references.)

### 2. H-10 composite unique `[vendorId, id]` on every FK-targeted table
Every table that other tables foreign-key to MUST have `@@unique([vendorId, id])`. This is the structural tenant-scoping convention (see `Employee:412`, `LeaveRequest:843`, `PayrollRun:922`, `PayrollEntry:976` in schema.prisma). `AttendanceDevice` omits it only because nothing FKs to it — new tables that will be FK targets should include it from the start.

### 3. String for user-entered dates, DateTime for machine timestamps
User-entered dates (`Employee.dob`, `Employee.joiningDate`, `Holiday.date`, `Promotion.effectiveDate`, `Camera.installDate`) are `String` (ISO date). Machine timestamps (`Camera.lastSeenAt`, `Camera.lastStatusCheckAt`, `AuditLog.createdAt`) are `DateTime`. Never mix — the codebase convention is consistent across 13+ date fields.

### 4. `@@unique` scoping rules
- **Vendor-scoped, not global:** `@@unique([vendorId, serialNumber, channel])` — two tenants CAN have the same serial number. (AttendanceDevice's `deviceIdentifier` is globally unique ONLY because the ZKTeco webhook has no tenant context — cameras have no inbound webhook.)
- **NULL in SQLite unique indexes:** NULL ≠ NULL — SQLite treats NULLs as distinct. This means `serialNumber String?` with `@@unique([vendorId, serialNumber, channel])` allows N cameras with `serialNumber=null` per vendor. If this is undesirable, add a DTO-layer guard (we did: `validateCameraCreate` rejects pure-null cameras).
- **Composite unique with nullable cameraId is a trap:** `@@unique([vendorId, brand, cameraId])` with `cameraId String?` does NOT prevent two account-level rows for the same vendor+brand (NULL ≠ NULL). Use one row per vendor+brand with a JSON payload instead.

### 5. Audit verb split (permission ≠ audit action)
The codebase convention: permission `module.edit` → audit action `module.update` (see `devices.ts:178`). Other verbs match 1:1. The split exists because auditors query by action string — `camera.update` (metadata change) is a different event class than `camera.restore` (lifecycle event) even though both are gated by `camera.edit`.

### 6. `audit()` vs `auditStrict()` decision matrix
| Action type | Helper | Rationale |
|---|---|---|
| create, update, restore | `audit()` (best-effort) | Recoverable — the mutation is reversible; a missing audit row is visible in the DB state itself. |
| delete, launch, credential.* | `auditStrict()` (throws on failure) | Forensic-weight — a missing audit row for "who launched this camera" or "who deleted this camera" is unacceptable. A malicious actor could cover tracks by inducing audit-write failures. |

The distinction is verified by runtime tests: `tests/unit/camera-audit-strict.test.ts` mocks `auditStrict` to throw and asserts the route handlers propagate the error (auditStrict behavior — NOT swallowed like `audit()` would).

### 7. Crypto-field context derivation from DB column (never hardcode version strings)
Two version markers (a DB column + a code-side string) WILL drift. The DB column is the source of truth — derive the crypto context from it:
```ts
const CAMERAS_CONTEXT_BASE = "cameras"
export function camerasContext(encryptionKeyVersion: number): string {
  return `${CAMERAS_CONTEXT_BASE}::v${encryptionKeyVersion}`
}
```
At encrypt time: `camerasContext(newVersion)`. At decrypt time: `camerasContext(row.encryptionKeyVersion)`. The column is the single source of truth; the code never holds a hardcoded version string. (MFA's `"v2:"` string prefix is separate — `TODO(crypto-unification)` notes this as future cleanup.)

### 8. Provider pattern for future multi-brand integrations
- Each brand implements `CameraProvider` in `providers/<brand>.ts` + registers in `src/hrm-server/cameras/providers/registry.ts`. No other file changes.
- The registry is the single source of truth: `isRegisteredBrand()`, `getProvider()`, `listRegisteredBrands()`.
- `validateCameraCreate` uses `isRegisteredBrand` to reject unknown brands at the DTO layer (before the DB write).
- Unknown-brand tests: `validateCameraCreate` rejects `"ONVIF"` with a clear 400 listing all registered brands.
- **When in doubt, web URL wins:** unverified deep-link schemes (`hikconnect://`, `dahua://`, `imoulife://`) must NOT ship — use the brand's web portal as the primary launch target with a `// TODO(verify)` marker. The `ezopen://` scheme was confirmed by the user (not independently verified) — documented with `TODO(verify)`.

### 9. The "deviations must be surfaced" rule
Every phase report MUST start with a "Deviations from confirmed decisions" section. Even if the deviation is defensible, it belongs in the summary — not buried in deliverables. The two deviations in this module:
- **Phase 4:** `restoreCamera` used `audit()` instead of `auditStrict()` (accepted: "restore is recoverable, delete/launch are not").
- **Phase 6:** Used `FormDialog` + `FieldDef[]` instead of react-hook-form + zodResolver (accepted: CONVENTIONS.md compliance + sibling-view consistency).

Both were surfaced, justified, and accepted by the user. The rule: if you deviate, say so explicitly — don't let the user discover it by reading code.
