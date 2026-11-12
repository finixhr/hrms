#!/usr/bin/env bun
// ============ M3a remediation report (R-27) — mc-remediation-report.mjs =======
// AUTHORED in the M3a-preparation session (2026-11-04/05 UTC). READ-ONLY —
// this script never writes any business row. It emits the report sections
// specified by the authoritative documents (DMS §5.3, PRODUCTION DATA
// READINESS PDR-1/2/5/6/7/8/9, PERMISSION COMPATIBILITY REPORT §9):
//
//   §roleCohort   PDR-1 (C1–C5 per row + per-vendor summary) and PDR-2
//                 (effective-permission diffs before/after W3, computed with
//                 the SAME resolution chain as the runtime — roleTemplate +
//                 COMPANY_SCOPED_MODULES × ACTIONS), plus the sign-off sheet
//                 (the written record the R3 hard gate requires: zero
//                 unreviewed C2–C5 rows with PDR-1/PDR-2 attached).
//   §deltaRegister  deliberate grants/exclusions per user+company (expected
//                 empty at M3a; becomes the ongoing divergence view).
//   §classA       preserved-NULL Shift/Holiday rows (tenant-wide by design),
//                 with reference counts and the operator action template
//                 (assign or accept-as-tenant-wide, in writing, before R5).
//   §classB       dangling-assignee Tasks — reference-free, remediated only
//                 via tasks.orphans.assign (never a raw guess).
//   §unattributable  PDR-7: NULL-company journals by refType/status, NULL-
//                 company payroll runs by runType, dead-ref journals, dead-
//                 source adjustment runs (the manual list).
//   §duplicateSurvey PDR-8 pattern over the 11 M4 conversions (read-only).
//   §wildcards    stored tenant-level "*" holders (advisory conversion list).
//   §orphanUsers  the R-ORP cohort (users with no access row — auto-repaired
//                 by the backfill, listed for record).
//   §workflowFallback  vendors × processTypes missing the NULL-fallback
//                 workflow (the SEC-04 functional DoS the R-WFS phase seeds).
//   §singleCompanyVendors  the only vendors where default-company stamping
//                 was ever unambiguous (the honesty rule's carve-out).
//   §journal      the _mc_backfill_journal tail (run audit trail).
//
// The PDR-1/PDR-2 evidence produced here is the read-only measurement the
// R3 hard gate consumes: W3 may not deploy until a reviewed re-run shows
// ZERO unreviewed C2–C5 rows.
//
// Usage:
//   DATABASE_URL=… bun run scripts/mc-remediation-report.mjs [--json] [--vendor <id>]
//   bun run scripts/mc-remediation-report.mjs --json > report.json

import { db } from "../src/lib/db.ts"
import { roleTemplate } from "../src/hrm-server/auth.ts"
import { ACTIONS } from "../src/hrm-server/types.ts"
import { COMPANY_SCOPED_MODULES } from "../src/app/api/hrm/route.ts"
import { journalAnchor } from "./mc-backfill-core.mjs"

// NOTE (hardening session): journalAnchor now takes the client as its FIRST
// argument (journalAnchor(db, vendorId, refType, refId)) so mc-backfill-core
// can keep its Prisma import lazy; the anchor MAP is unchanged — the report's
// dead-ref list still cannot drift from the repair's anchor rules.

const nowIso = () => new Date().toISOString() // explicit UTC, F-02 policy

// PDR-2's expandLegacy = the reports.pii split rule of auth.ts:341-345,
// applied identically here so measurement and enforcement cannot diverge.
function expandLegacy(perms) {
  const out = new Set(perms)
  if (out.has("reports.pii")) {
    out.add("reports.pii.view")
    out.add("reports.pii.export")
    out.add("reports.pii.schedule")
  }
  return out
}

// COMPANY_SCOPED_KEYS = the 33-module set × the ACTIONS catalog
// (FINAL PERMISSION MODEL §1.2: "the 33-module set at route.ts:140-146 × the
// ACTIONS catalog (types.ts:29-67)").
const COMPANY_SCOPED_KEYS = new Set()
for (const m of COMPANY_SCOPED_MODULES) for (const a of ACTIONS) COMPANY_SCOPED_KEYS.add(`${m}.${a}`)

const BUILTIN_ROLES = ["HR_ADMIN", "HR_MANAGER", "PAYROLL_OFFICER", "BRANCH_MANAGER", "DEPT_MANAGER", "EMPLOYEE", "VENDOR_OWNER", "SUPPORT"]

// ---------- §roleCohort (PDR-1 + PDR-2 + sign-off sheet) ----------
async function roleCohort(vendorFilter, deliberateSet) {
  const rows = await db.$queryRawUnsafe(`
    SELECT a."vendorId", a."id" AS access_id, u."email", a."companyId",
           u."role" AS user_role, a."role" AS access_role, a."active",
           u."permissions" AS user_permissions,
           a."permissions" AS access_permissions,
           a."excludedPermissions" AS access_excluded,
           CASE
             WHEN a."role" = u."role" THEN 'C1'
             WHEN a."role" = 'SUPPORT' THEN 'C5'
             WHEN a."role" = ANY($1) THEN 'C2'
             WHEN r."id" IS NOT NULL THEN 'C3'
             ELSE 'C4'
           END AS category
    FROM "UserCompanyAccess" a
    JOIN "User" u ON u."id" = a."userId"
    LEFT JOIN "Role" r ON r."vendorId" = a."vendorId" AND r."key" = a."role"
    ${vendorFilter ? 'WHERE a."vendorId" = $2' : ''}
    ORDER BY category, a."vendorId", u."email"`,
    BUILTIN_ROLES, ...(vendorFilter ? [vendorFilter] : []))
  // Completed resets: access rows this script's R-ROL pass has already reset
  // (journaled UPDATE with new_value == the current role). Distinguishes a
  // PROPOSED reset (C2–C5 in the pre-repair population) from a COMPLETED
  // one and from a REVIEWED RETENTION (the --deliberate sign-off).
  let completedResets = new Set()
  try {
    const j = await db.$queryRawUnsafe(
      `SELECT DISTINCT target_id FROM _mc_backfill_journal WHERE phase = 'R-ROL' AND action = 'UPDATE' AND dry_run = false`)
    completedResets = new Set(j.map((r) => r.target_id))
  } catch { /* journal table not created yet (no run has happened) */ }

  // PDR-2 per-row effective diffs — computed with the DOCUMENTED permission
  // formula (authorization §3 R-ROL; PERMISSION COMPATIBILITY REPORT §9):
  //
  //   before (tenant inheritance today):
  //     roleTemplate(vendorId, User.role) ∪ inheritedExplicit
  //   after (W3 company-scope semantics):
  //     companyPermissions = roleTemplate(vendorId, access.role)
  //                          ∪ (inheritedExplicit − access.excludedPermissions)
  //                          ∪ access.permissions
  //
  // inheritedExplicit = User.permissions ONLY (the explicit grant list) —
  // NEVER the full tenant ctx.permissions, which already folds in the
  // tenant role-template permissions (the authorization's explicit warning).
  // C1 with empty deltas → empty diff by construction; C2/C3 → template-swap
  // diffs; C4/C5 → removals = the entire company-scoped baseline.
  /** @type {any[]} */
  const out = []
  for (const row of rows) {
    const Tuser = await roleTemplate(row.vendorId, row.user_role)
    const Tacc = await roleTemplate(row.vendorId, row.access_role)
    const explicit = expandLegacy(JSON.parse(row.user_permissions || "[]"))
    const accessGrants = expandLegacy(JSON.parse(row.access_permissions || "[]"))
    const accessExclusions = new Set(JSON.parse(row.access_excluded || "[]"))
    const inheritedUser = new Set([...Tuser, ...explicit])
    if (inheritedUser.has("*")) for (const k of COMPANY_SCOPED_KEYS) inheritedUser.add(k)
    const inheritedAcc = new Set([...Tacc])
    for (const k of explicit) if (!accessExclusions.has(k)) inheritedAcc.add(k)
    for (const k of accessGrants) inheritedAcc.add(k)
    if (inheritedAcc.has("*")) for (const k of COMPANY_SCOPED_KEYS) inheritedAcc.add(k)
    const before = [...inheritedUser].filter((k) => COMPANY_SCOPED_KEYS.has(k))
    const after = [...inheritedAcc].filter((k) => COMPANY_SCOPED_KEYS.has(k))
    const additions = after.filter((k) => !before.includes(k))
    const removals = before.filter((k) => !after.includes(k))
    out.push({
      vendorId: row.vendorId, accessId: row.access_id, email: row.email, companyId: row.companyId,
      userRole: row.user_role, accessRole: row.access_role, active: row.active, category: row.category,
      additions, removals, unreviewed: (row.category === "C2" || row.category === "C3" || row.category === "C4" || row.category === "C5"),
      // proposed / completed / retained — the three states the authorization
      // requires the report to distinguish:
      proposedReset: (row.category === "C2" || row.category === "C3" || row.category === "C4" || row.category === "C5") && !completedResets.has(row.access_id),
      completedReset: completedResets.has(row.access_id),
      reviewedRetention: deliberateSet.has(row.access_id) ? true : null,
      // the sign-off sheet column: the operator's reviewed --deliberate list is
      // the written record (C2/C3 only); C4/C5 are mandatory resets per the
      // approved policy — never sign-off-able
      signoffDeliberate: deliberateSet.has(row.access_id) ? true : null,
      signoffBy: deliberateSet.has(row.access_id) ? "operator (reviewed report)" : null,
      signoffAt: deliberateSet.has(row.access_id) ? nowIso() + " UTC" : null,
    })
  }
  // per-vendor summary
  const byVendor = new Map()
  for (const r of out) {
    if (!byVendor.has(r.vendorId)) byVendor.set(r.vendorId, { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, rowsWithDiff: 0, sumAdditions: 0, sumRemovals: 0, proposedResets: 0, completedResets: 0, reviewedRetentions: 0 })
    const s = byVendor.get(r.vendorId)
    s[r.category]++
    if (r.additions.length || r.removals.length) s.rowsWithDiff++
    s.sumAdditions += r.additions.length
    s.sumRemovals += r.removals.length
    if (r.proposedReset) s.proposedResets++
    if (r.completedReset) s.completedResets++
    if (r.reviewedRetention) s.reviewedRetentions++
  }
  // Sign-off VALIDATION (the hard gate can never be manufactured by an
  // incomplete or wrong sign-off list): every deliberate id must belong to a
  // CURRENT C2/C3 row. Unknown ids and C1/C4/C5 ids are invalid — the gate
  // stays OPEN while any invalid sign-off is present.
  const byId = new Map(out.map((r) => [r.accessId, r]))
  const invalidSignoffs = [...deliberateSet].filter((id) => {
    const r = byId.get(id)
    return !r || r.category !== "C2" && r.category !== "C3"
  }).map((id) => {
    const r = byId.get(id)
    return { accessId: id, reason: !r ? "unknown access-row id (not in the current population)" : `category ${r.category} is not sign-off-able (C2/C3 only; C4/C5 are mandatory resets)` }
  })
  return { rows: out, invalidSignoffs, summary: [...byVendor.entries()].map(([vendorId, s]) => ({ vendorId, ...s })) }
}

// ---------- §deltaRegister ----------
async function deltaRegister(vendorFilter) {
  const rows = await db.userCompanyAccess.findMany({
    where: {
      OR: [{ permissions: { not: "[]" } }, { excludedPermissions: { not: "[]" } }],
      ...(vendorFilter ? { vendorId: vendorFilter } : {}),
    },
    select: { id: true, vendorId: true, userId: true, companyId: true, role: true, permissions: true, excludedPermissions: true },
  })
  const users = await db.user.findMany({ select: { id: true, email: true } })
  const emailOf = new Map(users.map((u) => [u.id, u.email]))
  return rows.map((r) => ({
    vendorId: r.vendorId, accessId: r.id, email: emailOf.get(r.userId) ?? r.userId,
    companyId: r.companyId, role: r.role,
    permissions: JSON.parse(r.permissions || "[]"),
    excludedPermissions: JSON.parse(r.excludedPermissions || "[]"),
  }))
}

// ---------- §classA (preserved-NULL Shift/Holiday — tenant-wide by design) ----------
// Only rows the repair will PRESERVE as NULL: branchId IS NULL ("null = all
// branches") AND companyId IS NULL. Branch-anchored NULL rows are REPAIRED
// (they leave this list); default-stamped rows join it after the honesty-rule
// reset. Listing sh1-style anchored rows here would be wrong — they are not
// preserved-NULL, they are pending repairs.
async function classASection(vendorFilter) {
  const shifts = await db.shift.findMany({
    where: { companyId: null, branchId: null, ...(vendorFilter ? { vendorId: vendorFilter } : {}) },
    select: { id: true, vendorId: true, name: true, branchId: true },
  })
  const holidays = await db.holiday.findMany({
    where: { companyId: null, branchId: null, ...(vendorFilter ? { vendorId: vendorFilter } : {}) },
    select: { id: true, vendorId: true, name: true, date: true, branchId: true },
  })
  const rows = []
  for (const s of shifts) {
    const [empRefs, assignRefs] = await Promise.all([
      db.employee.count({ where: { shiftId: s.id } }),
      db.shiftAssignment.count({ where: { shiftId: s.id } }),
    ])
    rows.push({
      kind: "Shift", id: s.id, vendorId: s.vendorId, name: s.name, branchId: s.branchId,
      referenceCounts: { employees: empRefs, shiftAssignments: assignRefs },
      operatorAction: "assign (via the audited branch-anchor template) OR accept-as-tenant-wide — in writing, before R5",
    })
  }
  for (const h of holidays) {
    rows.push({
      kind: "Holiday", id: h.id, vendorId: h.vendorId, name: h.name, date: h.date, branchId: h.branchId,
      referenceCounts: {}, // holidays are consumed by date math (leave/payroll/sweeps), not by row references
      operatorAction: "assign (via the audited branch-anchor template) OR accept-as-tenant-wide — in writing, before R5",
    })
  }
  return rows
}

// ---------- §classB (unattributable Tasks — dangling assignee OR dead anchor) ----------
async function classBSection(vendorFilter) {
  const tasks = await db.task.findMany({
    where: { companyId: null, ...(vendorFilter ? { vendorId: vendorFilter } : {}) },
    select: { id: true, vendorId: true, title: true, status: true, assigneeId: true, createdBy: true, createdAt: true, updatedAt: true },
  })
  const rows = []
  for (const t of tasks) {
    const emp = await db.employee.findFirst({ where: { id: t.assigneeId, vendorId: t.vendorId }, select: { companyId: true } })
    const reason = !emp
      ? "dangling assignee (no Employee row)"
      : !emp.companyId
        ? "assignee exists but employment is NULL-company (dead anchor)"
        : null
    if (!reason) continue // anchored — not class B
    rows.push({
      id: t.id, vendorId: t.vendorId, title: t.title, status: t.status, reason,
      danglingAssigneeId: t.assigneeId, createdBy: t.createdBy,
      createdAt: t.createdAt?.toISOString?.() ?? null, updatedAt: t.updatedAt?.toISOString?.() ?? null,
      remediation: "tasks.orphans.assign (the supported path — never a raw guess)",
    })
  }
  return rows
}

// ---------- §unattributable (PDR-7) ----------
async function unattributableSection(vendorFilter) {
  const where = vendorFilter ? { vendorId: vendorFilter } : undefined
  const [journals, runs] = await Promise.all([
    db.accountJournal.findMany({ where: { companyId: null, ...where }, select: { id: true, vendorId: true, refType: true, refId: true, status: true } }),
    db.payrollRun.findMany({ where: { companyId: null, ...where }, select: { id: true, vendorId: true, runType: true, adjustRunId: true } }),
  ])
  // (a) by refType/status; (b) by runType; (c) dead refs — resolved with the
  // SAME anchor map the repair uses (imported from mc-backfill-core.mjs)
  const byRefType = new Map()
  const deadRefs = []
  for (const j of journals) {
    const k = `${j.vendorId}|${j.refType}|${j.status}`
    byRefType.set(k, (byRefType.get(k) || 0) + 1)
    const { target, reason } = await journalAnchor(db, j.vendorId, j.refType, j.refId)
    if (!target) deadRefs.push({ table: "AccountJournal", id: j.id, reason, refType: j.refType, refId: j.refId })
  }
  const byRunType = new Map()
  const deadSource = []
  for (const r of runs) {
    byRunType.set(`${r.vendorId}|${r.runType}`, (byRunType.get(`${r.vendorId}|${r.runType}`) || 0) + 1)
    if (r.runType === "ADJUSTMENT") {
      if (!r.adjustRunId) deadSource.push({ table: "PayrollRun", id: r.id, reason: "ADJUSTMENT run with no source run" })
      else {
        const src = await db.payrollRun.findFirst({ where: { id: r.adjustRunId, vendorId: r.vendorId }, select: { companyId: true } })
        if (!src?.companyId) deadSource.push({ table: "PayrollRun", id: r.id, reason: "dead or NULL-company source run", adjustRunId: r.adjustRunId })
      }
    }
  }
  return {
    journalsByRefTypeStatus: [...byRefType.entries()].map(([k, n]) => { const [vendorId, refType, status] = k.split("|"); return { vendorId, refType, status, count: n } }),
    runsByRunType: [...byRunType.entries()].map(([k, n]) => { const [vendorId, runType] = k.split("|"); return { vendorId, runType, count: n } }),
    deadRefs,
    deadSourceAdjustmentRuns: deadSource,
  }
}

// ---------- §duplicateSurvey (PDR-8 — read-only) ----------
async function duplicateSurvey(vendorFilter) {
  const specs = [
    ["ApprovalWorkflow", '"processType"', '"processType"'],
    ["Branch", '"code"', '"code"'],
    ["Department", '"code"', '"code"'],
    ["Designation", '"code"', '"code"'],
    ["Employee", '"code"', '"code"'],
    ["LeaveType", '"code"', '"code"'],
    ["CostCenter", '"code"', '"code"'],
    ["AccountingPeriod", '"name"', '"name"'],
    ["ItemCategory", '"name"', '"name"'],
    ["VisitLocation", '"name"', '"name"'],
    ["PayrollRun",
      '("periodYear"::text||\'-\'||"periodMonth"::text||\'-\'||"periodWeek"::text||\'-\'||"runType"||\'-\'||"adjustSeq"::text)',
      '"periodYear","periodMonth","periodWeek","runType","adjustSeq"'],
  ]
  const out = []
  for (const [table, keyExpr, groupCols] of specs) {
    const where = vendorFilter ? `WHERE "vendorId" = '${vendorFilter.replace(/'/g, "''")}'` : ""
    const rows = await db.$queryRawUnsafe(
      `SELECT "vendorId", "companyId", ${keyExpr} AS k, count(*) AS n FROM "${table}" ${where}
       GROUP BY "vendorId", "companyId", ${groupCols} HAVING count(*) > 1 ORDER BY n DESC`)
    for (const r of rows) out.push({ table, vendorId: r.vendorId, companyId: r.companyId, key: r.k, count: Number(r.n) })
  }
  return out
}

// ---------- §wildcards (PDR-3a — advisory) ----------
async function wildcardHolders(vendorFilter) {
  const users = await db.user.findMany({
    where: { permissions: { contains: `"*"` }, ...(vendorFilter ? { vendorId: vendorFilter } : {}) },
    select: { vendorId: true, email: true, role: true },
  })
  return users
}

// ---------- §orphanUsers (PDR-9a — the R-ORP cohort) ----------
async function orphanUsers(vendorFilter) {
  const users = await db.user.findMany({
    where: { companyAccess: { none: {} }, ...(vendorFilter ? { vendorId: vendorFilter } : {}) },
    select: { vendorId: true, email: true, role: true, employeeId: true },
  })
  return users
}

// ---------- §workflowFallback (PDR-9b) ----------
async function workflowFallback(vendorFilter) {
  const wf = await db.approvalWorkflow.findMany({
    where: vendorFilter ? { vendorId: vendorFilter } : undefined,
    select: { vendorId: true, processType: true, companyId: true },
  })
  const groups = new Map()
  for (const w of wf) {
    const k = `${w.vendorId}|${w.processType}`
    if (!groups.has(k)) groups.set(k, { vendorId: w.vendorId, processType: w.processType, hasRows: false, hasNullRow: false, nullRows: 0 })
    const g = groups.get(k)
    g.hasRows = true
    if (w.companyId == null) { g.hasNullRow = true; g.nullRows++ }
  }
  return [...groups.values()].filter((g) => !g.hasNullRow || g.nullRows > 1).map((g) => ({
    vendorId: g.vendorId, processType: g.processType,
    issue: g.nullRows > 1 ? "multiple NULL-fallback rows (operator must merge)" : "no NULL-fallback row (R-WFS seeds one)",
  }))
}

// ---------- §singleCompanyVendors ----------
// The only vendors where default-company stamping was ever unambiguous (the
// honesty rule's carve-out). The detail carries the ACTIVE flag: a vendor
// whose only company is INACTIVE is still single-company for OWNERSHIP
// purposes, but F-01 forbids treating that company as an active default
// (R-APA keeps such rows NULL; R-ORP leaves users row-less).
async function singleCompanyVendors() {
  const companies = await db.company.findMany({ select: { vendorId: true, active: true } })
  const byVendor = new Map()
  for (const c of companies) {
    if (!byVendor.has(c.vendorId)) byVendor.set(c.vendorId, { count: 0, activeCount: 0 })
    const v = byVendor.get(c.vendorId)
    v.count++
    if (c.active) v.activeCount++
  }
  return [...byVendor.entries()].filter(([, v]) => v.count === 1).map(([vendorId, v]) => ({ vendorId, companyActive: v.activeCount === 1 }))
}

// ---------- §journal (audit tail + run-record statuses) ----------
async function journalTail() {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT run_id, phase, dry_run, count(*) AS entries, max(ts) AS last_ts
       FROM _mc_backfill_journal GROUP BY run_id, phase, dry_run ORDER BY last_ts DESC LIMIT 50`)
    const journal = rows.map((r) => ({ runId: r.run_id, phase: r.phase, dryRun: r.dry_run, entries: Number(r.entries), lastTs: r.last_ts?.toISOString?.() + " UTC" }))
    // F-06: the run record must distinguish completed / failed / interrupted
    // / restored runs — surfaced here so the operator sees the full state.
    let runs = []
    try {
      const rr = await db.$queryRawUnsafe(
        `SELECT run_id, status, dry_run, started_at, finished_at, phases, error
         FROM _mc_backfill_runs ORDER BY started_at DESC LIMIT 50`)
      runs = rr.map((r) => ({
        runId: r.run_id, status: r.status, dryRun: r.dry_run, phases: r.phases,
        startedAt: r.started_at?.toISOString?.() + " UTC", finishedAt: r.finished_at?.toISOString?.() + " UTC" ?? null,
        error: r.error ?? null,
      }))
    } catch { /* runs table not created yet */ }
    return { journal, runs }
  } catch {
    return { journal: [], runs: [] } // journal table not created yet (no run has happened)
  }
}

// ---------- orchestration ----------
export async function buildReport(opts = {}) {
  const vendorFilter = opts.vendor || null
  const deliberateSet = new Set(opts.deliberate || [])
  const [cohort, deltas, classA, classB, unattr, dups, wildcards, orphans, wfs, singles, journal] = await Promise.all([
    roleCohort(vendorFilter, deliberateSet), deltaRegister(vendorFilter), classASection(vendorFilter), classBSection(vendorFilter),
    unattributableSection(vendorFilter), duplicateSurvey(vendorFilter), wildcardHolders(vendorFilter),
    orphanUsers(vendorFilter), workflowFallback(vendorFilter), singleCompanyVendors(), journalTail(),
  ])
  const unreviewed = cohort.rows.filter((r) => r.unreviewed && r.signoffDeliberate == null).length
  const invalid = cohort.invalidSignoffs.length
  return {
    generatedAt: nowIso() + " UTC", // explicit UTC label — F-02 policy
    reportType: "M3a remediation report (R-27) — READ-ONLY",
    deliberateSignoffs: deliberateSet.size,
    hardGate: {
      requirement: "W3 does not deploy until this report (reviewed) shows zero unreviewed C2–C5 rows AND a valid sign-off list; PDR-1/PDR-2 must be attached to the sign-off sheet",
      unreviewedC2toC5: unreviewed,
      invalidSignoffs: invalid,
      status: unreviewed === 0 && invalid === 0 ? "PASS (zero unreviewed C2–C5 rows; sign-off list valid)" : `OPEN (${unreviewed} unreviewed C2–C5 rows${invalid ? `; ${invalid} invalid sign-off id(s)` : ""})`,
    },
    sections: {
      roleCohort: cohort,
      deltaRegister: deltas,
      classA,
      classB,
      unattributable: unattr,
      duplicateSurvey: dups,
      wildcards,
      orphanUsers: orphans,
      workflowFallback: wfs,
      singleCompanyVendors: singles,
      journal: journal,
    },
  }
}

// ---------- CLI ----------
if (import.meta.main) {
  const args = process.argv.slice(2)
  const json = args.includes("--json")
  const vendorIdx = args.indexOf("--vendor")
  const vendor = vendorIdx >= 0 ? String(args[vendorIdx + 1]) : null
  const delibIdx = args.indexOf("--deliberate")
  const deliberate = delibIdx >= 0 ? String(args[delibIdx + 1]).split(",").map((s) => s.trim()).filter(Boolean) : []
  console.error(`mc-remediation-report — ${nowIso()} UTC (read-only; no business writes)`)
  const report = await buildReport({ vendor, deliberate })
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const r = report
    console.log(`\nHARD GATE: ${r.hardGate.status}`)
    for (const inv of r.sections.roleCohort.invalidSignoffs) console.log(`  INVALID SIGN-OFF ${inv.accessId}: ${inv.reason}`)
    console.log(`\n== roleCohort (PDR-1/PDR-2) ==`)
    for (const s of r.sections.roleCohort.summary) console.log(`  vendor ${s.vendorId}: C1=${s.C1} C2=${s.C2} C3=${s.C3} C4=${s.C4} C5=${s.C5} rowsWithDiff=${s.rowsWithDiff} +${s.sumAdditions}/-${s.sumRemovals} proposed=${s.proposedResets} completed=${s.completedResets} retained=${s.reviewedRetentions}`)
    for (const row of r.sections.roleCohort.rows.filter((x) => x.unreviewed)) {
      console.log(`  ${row.category} ${row.email} access.role=${row.accessRole} User.role=${row.userRole} +${row.additions.length}/-${row.removals.length}`)
    }
    console.log(`\n== deltaRegister: ${r.sections.deltaRegister.length} row(s) (expected empty at M3a) ==`)
    for (const d of r.sections.deltaRegister) console.log(`  ${d.email} @ ${d.companyId}: +${JSON.stringify(d.permissions)} -${JSON.stringify(d.excludedPermissions)}`)
    console.log(`\n== classA (preserved-NULL tenant-wide): ${r.sections.classA.length} row(s) ==`)
    for (const c of r.sections.classA) console.log(`  ${c.kind} ${c.name} (${c.id}) refs=${JSON.stringify(c.referenceCounts)}`)
    console.log(`\n== classB (dangling-assignee tasks): ${r.sections.classB.length} row(s) ==`)
    for (const c of r.sections.classB) console.log(`  Task ${c.title} (${c.id}) assignee=${c.danglingAssigneeId} status=${c.status}`)
    console.log(`\n== unattributable ==`)
    console.log(`  journals by refType/status: ${JSON.stringify(r.sections.unattributable.journalsByRefTypeStatus)}`)
    console.log(`  runs by runType: ${JSON.stringify(r.sections.unattributable.runsByRunType)}`)
    for (const d of r.sections.unattributable.deadRefs) console.log(`  DEAD-REF ${d.table} ${d.id}: ${d.reason}`)
    for (const d of r.sections.unattributable.deadSourceAdjustmentRuns) console.log(`  DEAD-SOURCE ${d.table} ${d.id}: ${d.reason}`)
    console.log(`\n== duplicateSurvey: ${r.sections.duplicateSurvey.length} group(s) ==`)
    for (const d of r.sections.duplicateSurvey) console.log(`  ${d.table} vendor=${d.vendorId} company=${d.companyId} key=${d.key} n=${d.count}`)
    console.log(`\n== wildcards: ${r.sections.wildcards.length} holder(s) (advisory) ==`)
    console.log(`== orphanUsers (R-ORP cohort): ${r.sections.orphanUsers.length} user(s) ==`)
    console.log(`== workflowFallback gaps: ${r.sections.workflowFallback.length} ==`)
    for (const w of r.sections.workflowFallback) console.log(`  vendor ${w.vendorId} ${w.processType}: ${w.issue}`)
    console.log(`== singleCompanyVendors: ${r.sections.singleCompanyVendors.map((s) => `${s.vendorId}${s.companyActive ? "" : " (ONLY COMPANY INACTIVE — never an active default, F-01)"}`).join(", ") || "(none)"} ==`)
    console.log(`\nrun records: ${JSON.stringify(r.sections.journal.runs.slice(0, 5))}`)
    console.log(`journal tail: ${JSON.stringify(r.sections.journal.journal.slice(0, 5))}`)
  }
}
