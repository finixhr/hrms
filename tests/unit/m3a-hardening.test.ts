/// <reference types="bun-types" />
// ============ M3a HARDENING — F-03/F-04/F-05/F-06/F-07 regression + failure injection ============
// The M3a EXECUTION gate (B-7 decision → W1-AC-08 PASS → R1 deploy → R2
// deploy → M3a run) is NOT satisfied — nothing here touches production. This
// suite validates the HARDENED mc-backfill-core.mjs against SYNTHETIC
// fixtures in the disposable scratch database only:
//   F-03 · R-APA reads companyId from the query; an unexpected existing
//          assignment is never silently overwritten; dry-run and real-run
//          plans are consistent
//   F-04 · guarded updates are compare-and-set on the expected old value +
//          vendor ownership + the original repair predicate; zero-row
//          results are classified (unchanged / concurrent / missing /
//          wrongVendor / predicateMismatch), never assumed harmless
//   F-05 · restore deletes only the EXACT script-created UserCompanyAccess
//          row (journaled PK + evidence); duplicates/concurrent changes/
//          wrong-vendor rows are never deleted; restore is idempotent
//   F-06 · mutation + journal commit atomically (journal-failure and
//          step-failure triggers, client-exception injection); R-WFS
//          workflow+steps never partially created; the run record
//          distinguishes running/completed/failed/interrupted/restored;
//          retries never duplicate
//   F-07 · an inactive default company is never the active default:
//          R-ORP follows the F-01 rule (inactive default → active
//          alternative; none → row-less), R-WFS templates come from ACTIVE
//          companies only, duplicate defaults are surfaced, single-company
//          vendors with an INACTIVE company keep NULL (listed)
//   CLI  · safety refusals happen before any database work (missing
//          DATABASE_URL, no --confirm, --confirm without the gate ack,
//          unknown args/phases); --dry-run needs no ack
// All runs are vendor-scoped to this suite's fixtures so the shared
// test database of other suites is never mutated.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { PrismaClient } from "@prisma/client"
import os from "node:os"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { runBackfill, restoreRun, guardedUpdate, RunCtx, GUARDED_TARGET_TABLES, journalAnchor } from "../../scripts/mc-backfill-core.mjs"

// a SECOND, independent client — the "concurrent process"
const db2 = new PrismaClient()

// ---------------------------------------------------------------------------
// interposing client — wraps a Prisma client and can THROW or RUN an async
// action immediately before a chosen method call (matched by method key and
// argument predicate). $transaction callbacks receive a wrapped tx so
// in-transaction calls are interceptable too. This is the failure-injection
// harness for F-06 (client-side "disconnects" and concurrent writers).
// ---------------------------------------------------------------------------
type Injection = {
  key: string // e.g. "$executeRawUnsafe" or "employee.findFirst"
  when?: (args: any[]) => boolean // match on the call arguments (default: always)
  nth?: number // fire on the nth MATCHING call (default 1)
  mode: "throw" | "run"
  run?: (args: any[]) => Promise<void>
  message?: string
}
function wrapClient(real: any, injections: Injection[], counts?: Map<string, number>, prefix = ""): any {
  const seen = counts ?? new Map<string, number>()
  const fire = (key: string, args: any[]): Injection | null => {
    const inj = injections.find((i) => i.key === key && (!i.when || i.when(args)))
    if (!inj) return null
    const n = (seen.get(key) || 0) + 1
    seen.set(key, n)
    if (n !== (inj.nth ?? 1)) return null
    injections.splice(injections.indexOf(inj), 1) // one-shot
    return inj
  }
  const cache = new Map<string, any>()
  return new Proxy(real, {
    get(target: any, prop: string | symbol) {
      if (typeof prop !== "string") return (target as any)[prop]
      if (prop === "$transaction") {
        const cached = cache.get(prop)
        if (cached) return cached
        const wrappedTx = function (fn: any, opts: any) {
          return target.$transaction((tx: any) => fn(wrapClient(tx, injections, seen, prefix)), opts)
        }
        cache.set(prop, wrappedTx)
        return wrappedTx
      }
      const t = (target as any)[prop]
      if (t && typeof t === "object") {
        // model delegate (db.user, db.userCompanyAccess, …) — wrap recursively
        const cached = cache.get(prop)
        if (cached) return cached
        const wrapped = wrapClient(t, injections, seen, `${prefix}${prop}.`)
        cache.set(prop, wrapped)
        return wrapped
      }
      if (typeof t !== "function") return t
      const key = `${prefix}${prop}`
      const cachedFn = cache.get(prop)
      if (cachedFn) return cachedFn
      const wrappedFn = async function (...args: any[]) {
        const inj = fire(key, args)
        if (inj) {
          if (inj.mode === "throw") throw new Error(inj.message || "INJECTED-CLIENT-FAILURE")
          if (inj.run) await inj.run(args)
        }
        return t.apply(target, args)
      }
      cache.set(prop, wrappedFn)
      return wrappedFn
    },
  })
}

// real-database failure injection: a trigger that raises on INSERT
async function withInsertTrigger(table: string, message: string, cb: () => Promise<void>) {
  const fn = "__m3a_inject_boom"
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$ LANGUAGE plpgsql`)
  await db.$executeRawUnsafe(`CREATE TRIGGER __m3a_inject_tr BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
  try { await cb() } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS __m3a_inject_tr ON "${table}"`)
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`)
  }
}

// ---------------------------------------------------------------------------
// fixtures — vendor H (multi), D (inactive DEFAULT + active alt), P (two
// active default flags), X (single INACTIVE company), S2 (single ACTIVE
// company), plus their rows. Everything is tracked for afterAll cleanup.
// ---------------------------------------------------------------------------
let vH: any, vD: any, vP: any, vX: any, vS2: any
let cHA: any, cHB: any, cHI: any, cDA: any, cDI: any, cP1: any, cP2: any, cXI: any, cS2: any
let brHB: any, brH2: any
let eHB: any, eX1: any, eD1: any
let oH1: any, oD1: any, oP1: any, oX1: any
let rC2: any, rC4: any, c2H: any, c4H: any
let runH1: any, runAdjD: any, jhPayroll: any, jhDeadRef: any, jAdjD: any
let shH1: any
let apaH1: any, apaH2: any, apaH3: any, apaD1: any, apaX1: any, apaS2: any, apaCross: any
let wfDI: any, wfDA: any, wfP1: any, wfP2: any, wfXI: any
const myVendors: string[] = []
const myRunIds: string[] = []

async function trackRun(p: Promise<any>) {
  const out = await p
  myRunIds.push(out.runId)
  return out
}

beforeAll(async () => {
  vH = await mkVendor(uniq("M3aH Vendor H"), { company: false })
  vD = await mkVendor(uniq("M3aH Vendor D"), { company: false })
  vP = await mkVendor(uniq("M3aH Vendor P"), { company: false })
  vX = await mkVendor(uniq("M3aH Vendor X"), { company: false })
  vS2 = await mkVendor(uniq("M3aH Vendor S2"), { company: false })
  myVendors.push(vH.id, vD.id, vP.id, vX.id, vS2.id)

  // vH: A = active default, B = active, I = inactive
  cHA = await db.company.create({ data: { vendorId: vH.id, code: uniq("M3aHA"), name: "H Co A (active default)", active: true, isDefault: true } })
  cHB = await db.company.create({ data: { vendorId: vH.id, code: uniq("M3aHB"), name: "H Co B (active)", active: true } })
  cHI = await db.company.create({ data: { vendorId: vH.id, code: uniq("M3aHI"), name: "H Co I (inactive)", active: false } })
  // vD: the F-07 inactive-DEFAULT case — default flag on the INACTIVE company
  cDI = await db.company.create({ data: { vendorId: vD.id, code: uniq("M3aHDI"), name: "D Co I (inactive DEFAULT)", active: false, isDefault: true } })
  cDA = await db.company.create({ data: { vendorId: vD.id, code: uniq("M3aHDA"), name: "D Co A (active, not default)", active: true } })
  // vP: TWO active default-flagged companies (duplicate defaults — data defect)
  // FORENSIC AUDIT 2026-11-10 (Phase 1, test engineering — the FIN-025/026
  // determinism class): cP1's createdAt is set EXPLICITLY one minute older
  // than cP2. Back-to-back db.company.create calls can land in the same
  // millisecond, and the F-01 runtime ordering (isDefault DESC, createdAt
  // ASC) then degenerates to an arbitrary physical order — the assertion
  // below flaked exactly that way in the full-suite run. An explicit gap
  // makes "the OLDEST default-flagged active company" deterministic.
  cP1 = await db.company.create({ data: { vendorId: vP.id, code: uniq("M3aHP1"), name: "P Co 1 (older default)", active: true, isDefault: true, createdAt: new Date(Date.now() - 60_000) } })
  cP2 = await db.company.create({ data: { vendorId: vP.id, code: uniq("M3aHP2"), name: "P Co 2 (newer default)", active: true, isDefault: true } })
  // vX: single company, INACTIVE
  cXI = await db.company.create({ data: { vendorId: vX.id, code: uniq("M3aHXI"), name: "X Co (single, inactive)", active: false, isDefault: true } })
  // vS2: single company, ACTIVE (the honest single-company stamping case)
  cS2 = await db.company.create({ data: { vendorId: vS2.id, code: uniq("M3aHS2"), name: "S2 Co (single, active)", active: true, isDefault: true } })

  brHB = await db.branch.create({ data: { vendorId: vH.id, companyId: cHB.id, name: "H Branch B", code: uniq("M3aHBR") } })
  brH2 = await db.branch.create({ data: { vendorId: vH.id, companyId: cHB.id, name: "H Branch B2", code: uniq("M3aHBR") } })
  const mkEmp = async (vId: string, company: any | null, name: string) =>
    db.employee.create({ data: { vendorId: vId, code: uniq("M3aHE"), fullName: name, companyId: company?.id ?? null, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })
  eHB = await mkEmp(vH.id, cHB, "H Emp B")
  eD1 = await mkEmp(vD.id, null, "D Emp (NULL company)")
  eX1 = await mkEmp(vX.id, cXI, "X Emp (inactive company)")

  // orphan users (zero access rows)
  oH1 = await mkUser(vH.id, { role: "EMPLOYEE", permissions: [], name: uniq("M3aH oH1"), employeeId: eHB.id, email: `m3ah-oh1-${uniq("u")}@test.local` })
  oD1 = await mkUser(vD.id, { role: "HR_MANAGER", permissions: [], name: uniq("M3aH oD1"), employeeId: eD1.id, email: `m3ah-od1-${uniq("u")}@test.local` })
  oP1 = await mkUser(vP.id, { role: "EMPLOYEE", permissions: [], name: uniq("M3aH oP1"), email: `m3ah-op1-${uniq("u")}@test.local` })
  oX1 = await mkUser(vX.id, { role: "EMPLOYEE", permissions: [], name: uniq("M3aH oX1"), employeeId: eX1.id, email: `m3ah-ox1-${uniq("u")}@test.local` })

  // R-ROL cohort on vH: one C2 (deliberate candidate) + one C4 (mandatory)
  c2H = await mkUser(vH.id, { role: "HR_MANAGER", permissions: [], name: uniq("M3aH c2"), email: `m3ah-c2-${uniq("u")}@test.local` })
  rC2 = await db.userCompanyAccess.create({ data: { vendorId: vH.id, userId: c2H.id, companyId: cHB.id, role: "PAYROLL_OFFICER", active: true, isDefault: false } })
  c4H = await mkUser(vH.id, { role: "HR_ADMIN", permissions: [], name: uniq("M3aH c4"), email: `m3ah-c4-${uniq("u")}@test.local` })
  rC4 = await db.userCompanyAccess.create({ data: { vendorId: vH.id, userId: c4H.id, companyId: cHB.id, role: "GARBAGE_KEY", active: true, isDefault: false } })

  // financial refs — vH payroll journal + dead ref; a cross-vendor
  // adjustment (vD run pointing at vH's source run) must be a dead ref
  runH1 = await db.payrollRun.create({ data: { vendorId: vH.id, companyId: cHB.id, periodMonth: 1, periodYear: 2026, frequency: "MONTHLY", runType: "REGULAR", status: "PAID" } })
  jhPayroll = await db.accountJournal.create({ data: { vendorId: vH.id, companyId: null, refType: "PAYROLL", refId: runH1.id, date: "2026-02-01", memo: "H payroll journal", linesJson: "[]", amount: 10, source: "HRM", status: "POSTED" } })
  jhDeadRef = await db.accountJournal.create({ data: { vendorId: vH.id, companyId: null, refType: "PAYROLL", refId: "ghost-run-id", date: "2026-02-01", memo: "H dead ref", linesJson: "[]", amount: 10, source: "HRM", status: "POSTED" } })
  runAdjD = await db.payrollRun.create({ data: { vendorId: vD.id, companyId: null, periodMonth: 1, periodYear: 2026, frequency: "MONTHLY", runType: "ADJUSTMENT", adjustRunId: runH1.id, adjustSeq: 1, status: "DRAFT" } })
  jAdjD = await db.accountJournal.create({ data: { vendorId: vD.id, companyId: null, refType: "PAYROLL", refId: runH1.id, date: "2026-02-01", memo: "D journal pointing at H run (cross-vendor)", linesJson: "[]", amount: 10, source: "HRM", status: "POSTED" } })

  // class A shift on vH (branch-anchored, NULL company)
  shH1 = await db.shift.create({ data: { vendorId: vH.id, companyId: null, branchId: brHB.id, name: "H sh1 (branch-anchored)", startTime: "09:00", endTime: "17:00" } })

  // APA rows
  const polH = await db.attendancePolicy.create({ data: { vendorId: vH.id, name: "H policy", policyType: "OFFICE" } })
  const polX = await db.attendancePolicy.create({ data: { vendorId: vX.id, name: "X policy", policyType: "OFFICE" } })
  const polS2 = await db.attendancePolicy.create({ data: { vendorId: vS2.id, name: "S2 policy", policyType: "OFFICE" } })
  const polD = await db.attendancePolicy.create({ data: { vendorId: vD.id, name: "D policy", policyType: "OFFICE" } })
  apaH1 = await db.attendancePolicyAssignment.create({ data: { vendorId: vH.id, companyId: null, policyId: polH.id, scopeType: "BRANCH", scopeId: brHB.id } })
  apaH2 = await db.attendancePolicyAssignment.create({ data: { vendorId: vH.id, companyId: null, policyId: polH.id, scopeType: "ALL_EMPLOYEES", scopeId: null } })
  apaH3 = await db.attendancePolicyAssignment.create({ data: { vendorId: vH.id, companyId: cHA.id, policyId: polH.id, scopeType: "ALL_EMPLOYEES", scopeId: null } }) // UNEXPECTED existing assignment
  apaD1 = await db.attendancePolicyAssignment.create({ data: { vendorId: vX.id, companyId: null, policyId: polX.id, scopeType: "ALL_EMPLOYEES", scopeId: null } }) // single-INACTIVE vendor
  apaX1 = apaD1
  apaS2 = await db.attendancePolicyAssignment.create({ data: { vendorId: vS2.id, companyId: cHA.id, policyId: polS2.id, scopeType: "ALL_EMPLOYEES", scopeId: null } }) // unexpected existing on single-ACTIVE vendor
  apaCross = await db.attendancePolicyAssignment.create({ data: { vendorId: vD.id, companyId: null, policyId: polD.id, scopeType: "BRANCH", scopeId: brH2.id } }) // cross-vendor scope (vD assignment → vH branch)

  // approval workflows for the R-WFS template tests
  wfDI = await db.approvalWorkflow.create({ data: { vendorId: vD.id, companyId: cDI.id, processType: "LEAVE", name: "D Leave (INACTIVE default company)", active: true } })
  await db.approvalStep.create({ data: { vendorId: vD.id, workflowId: wfDI.id, sequence: 1, name: "D inactive step", approverRole: "HR_ADMIN" } })
  wfDA = await db.approvalWorkflow.create({ data: { vendorId: vD.id, companyId: cDA.id, processType: "LEAVE", name: "D Leave (ACTIVE company)", active: true } })
  await db.approvalStep.create({ data: { vendorId: vD.id, workflowId: wfDA.id, sequence: 1, name: "D active step", approverRole: "HR_MANAGER" } })
  wfP1 = await db.approvalWorkflow.create({ data: { vendorId: vP.id, companyId: cP1.id, processType: "LEAVE", name: "P Leave 1 (older company, default)", active: true } })
  await db.approvalStep.create({ data: { vendorId: vP.id, workflowId: wfP1.id, sequence: 1, name: "P1 step", approverRole: "HR_ADMIN" } })
  wfP2 = await db.approvalWorkflow.create({ data: { vendorId: vP.id, companyId: cP2.id, processType: "LEAVE", name: "P Leave 2 (newer company, default)", active: true } })
  await db.approvalStep.create({ data: { vendorId: vP.id, workflowId: wfP2.id, sequence: 1, name: "P2 step", approverRole: "HR_ADMIN" } })
  wfXI = await db.approvalWorkflow.create({ data: { vendorId: vX.id, companyId: cXI.id, processType: "LEAVE", name: "X Leave (only company, INACTIVE)", active: true } })
  await db.approvalStep.create({ data: { vendorId: vX.id, workflowId: wfXI.id, sequence: 1, name: "X step", approverRole: "HR_ADMIN" } })
})

afterAll(async () => {
  // suite isolation: remove every fixture this suite created so the shared
  // test database is exactly as other suites expect it (belt and braces for
  // single-process full-suite runs; per-file runs are unaffected).
  try {
    for (const runId of myRunIds) {
      await db.$executeRawUnsafe(`DELETE FROM _mc_backfill_journal WHERE run_id = $1`, runId)
      await db.$executeRawUnsafe(`DELETE FROM _mc_backfill_runs WHERE run_id = $1`, runId)
    }
    for (const v of myVendors) {
      try {
        await db.approvalStep.deleteMany({ where: { vendorId: v } })
        await db.approvalWorkflow.deleteMany({ where: { vendorId: v } })
        await db.attendancePolicyAssignment.deleteMany({ where: { vendorId: v } })
        await db.attendancePolicy.deleteMany({ where: { vendorId: v } })
        await db.task.deleteMany({ where: { vendorId: v } })
        await db.shift.deleteMany({ where: { vendorId: v } })
        await db.holiday.deleteMany({ where: { vendorId: v } })
        await db.accountJournal.deleteMany({ where: { vendorId: v } })
        await db.payrollRun.deleteMany({ where: { vendorId: v } })
        await db.userCompanyAccess.deleteMany({ where: { vendorId: v } })
        await db.user.deleteMany({ where: { vendorId: v } })
        await db.employee.deleteMany({ where: { vendorId: v } })
        await db.branch.deleteMany({ where: { vendorId: v } })
        await db.department.deleteMany({ where: { vendorId: v } })
        await db.role.deleteMany({ where: { vendorId: v } })
        await db.company.deleteMany({ where: { vendorId: v } })
        await db.vendor.deleteMany({ where: { id: v } })
      } catch { /* best-effort per vendor — never break the suite here */ }
    }
  } finally {
    await db2.$disconnect()
  }
})

const cidOf = async (table: string, id: string) => {
  const rows: any[] = await db.$queryRawUnsafe(`SELECT "companyId" FROM "${table}" WHERE "id" = $1`, id)
  return rows.length ? rows[0].companyId : "MISSING"
}

function testCtx(client: any = db) {
  const ctx = new RunCtx(`test-${uniq("run")}`, { dryRun: false, phases: [], resetRoles: false, deliberate: [], vendor: null, json: false }, client)
  myRunIds.push(ctx.runId) // journal hygiene — afterAll removes the direct-CAS entries
  return ctx
}

describe("M3a hardening · F-03 R-APA companyId semantics", () => {
  test("F-03 · dry-run plan and real-run outcome agree; unexpected assignments are never overwritten", async () => {
    // dry-run on vH: apaH1 (BRANCH-anchored NULL) is a planned change;
    // apaH2 (multi-company ALL_EMPLOYEES) is manual; apaH3 (unexpected
    // existing companyId) is manual — NEVER a planned overwrite.
    const dry = await trackRun(runBackfill({ dryRun: true, vendor: vH.id, phases: ["R-APA"] }))
    expect(dry.counts["R-APA"].changed).toBe(1) // apaH1 only
    expect(dry.counts["R-APA"].manual).toBe(2) // apaH2 + apaH3
    expect(dry.manual.some((m: any) => m.id === apaH3.id && m.reason.includes("unexpected existing companyId"))).toBe(true)
    expect(await cidOf("AttendancePolicyAssignment", apaH3.id)).toBe(cHA.id) // dry-run wrote nothing

    // real run: same plan
    const out = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-APA"] }))
    expect(out.counts["R-APA"].changed).toBe(1)
    expect(out.counts["R-APA"].manual).toBe(2)
    expect(await cidOf("AttendancePolicyAssignment", apaH1.id)).toBe(cHB.id) // anchor repair
    expect(await cidOf("AttendancePolicyAssignment", apaH2.id)).toBe(null) // multi-company → kept NULL
    expect(await cidOf("AttendancePolicyAssignment", apaH3.id)).toBe(cHA.id) // NOT overwritten
    // journal old_value records the TRUE pre-state (null — not a missing property)
    const j: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE run_id = $1 AND target_id = $2`, out.runId, apaH1.id)
    expect(j).toHaveLength(1)
    expect(j[0].old_value).toBe(null)
    expect(j[0].new_value).toBe(cHB.id)
    // a re-run is a no-op (already at target → unchanged, no new journal)
    const rerun = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-APA"] }))
    expect(rerun.counts["R-APA"].changed).toBe(0)
    expect(rerun.counts["R-APA"].unchanged).toBe(1)
  })

  test("F-03/F-07 · single-ACTIVE-company vendor stamps the only company; single-INACTIVE vendor keeps NULL; scoped anchors are vendor-scoped", async () => {
    // vS2: single ACTIVE company — a NULL ALL_EMPLOYEES row would stamp it;
    // the fixture instead carries an UNEXPECTED existing assignment → manual.
    const s2 = await trackRun(runBackfill({ confirm: true, vendor: vS2.id, phases: ["R-APA"] }))
    expect(await cidOf("AttendancePolicyAssignment", apaS2.id)).toBe(cHA.id) // not overwritten
    expect(s2.manual.some((m: any) => m.id === apaS2.id && m.reason.includes("unexpected existing companyId"))).toBe(true)

    // vX: the ONLY company is INACTIVE — never the active default (F-01/F-07)
    const x = await trackRun(runBackfill({ confirm: true, vendor: vX.id, phases: ["R-APA"] }))
    expect(await cidOf("AttendancePolicyAssignment", apaX1.id)).toBe(null) // kept NULL
    expect(x.manual.some((m: any) => m.id === apaX1.id && m.reason.includes("INACTIVE"))).toBe(true)
    expect(x.counts["R-APA"].skipped).toBe(1)

    // vD: cross-vendor scope (vD assignment pointing at vH's branch) = dead ref
    const d = await trackRun(runBackfill({ confirm: true, vendor: vD.id, phases: ["R-APA"] }))
    expect(await cidOf("AttendancePolicyAssignment", apaCross.id)).toBe(null)
    expect(d.manual.some((m: any) => m.id === apaCross.id && m.reason.includes("dead anchor"))).toBe(true)
  })
})

describe("M3a hardening · F-04 compare-and-set guarded updates", () => {
  test("F-04 · direct CAS semantics: change / stale / already-at-target / wrong vendor / predicate mismatch / missing", async () => {
    // (a) a correct expected-old value changes the row (and journals it)
    const ctxA = testCtx()
    const resA = await guardedUpdate(ctxA, "T", "Shift", shH1.id, "companyId", null, cHB.id, "test CAS ok", { vendorId: vH.id, predicate: { branchId: brHB.id } })
    expect(resA).toBe("changed")
    expect(await cidOf("Shift", shH1.id)).toBe(cHB.id)

    // (b) a STALE expected-old value (row already repaired) → classified,
    // never overwritten, recorded in the manual list
    const ctxB = testCtx()
    const resB = await guardedUpdate(ctxB, "T", "Shift", shH1.id, "companyId", null, cHA.id, "test stale CAS", { vendorId: vH.id, predicate: { branchId: brHB.id } })
    expect(resB).toBe("conflict")
    expect(ctxB.manual.some((m: any) => m.reason.includes("concurrently modified"))).toBe(true)
    expect(await cidOf("Shift", shH1.id)).toBe(cHB.id) // NOT overwritten

    // (c) already-at-target → idempotent unchanged
    const ctxC = testCtx()
    const resC = await guardedUpdate(ctxC, "T", "Shift", shH1.id, "companyId", cHA.id, cHB.id, "test already", { vendorId: vH.id, predicate: { branchId: brHB.id } })
    expect(resC).toBe("unchanged")
    expect((ctxC.counts as any)["T"].unchanged).toBe(1)

    // (d) WRONG VENDOR → conflict, no write
    const ctxD = testCtx()
    const resD = await guardedUpdate(ctxD, "T", "Shift", shH1.id, "companyId", cHB.id, cHA.id, "test wrong vendor", { vendorId: vD.id, predicate: { branchId: brHB.id } })
    expect(resD).toBe("conflict")
    expect(ctxD.manual.some((m: any) => m.reason.includes("wrong vendor"))).toBe(true)
    expect(await cidOf("Shift", shH1.id)).toBe(cHB.id)

    // (e) PREDICATE MISMATCH (branch re-pointed concurrently) → conflict
    const ctxE = testCtx()
    const resE = await guardedUpdate(ctxE, "T", "Shift", shH1.id, "companyId", cHB.id, cHA.id, "test predicate", { vendorId: vH.id, predicate: { branchId: brH2.id } })
    expect(resE).toBe("conflict")
    expect(ctxE.manual.some((m: any) => m.reason.includes("predicate mismatch"))).toBe(true)
    expect(await cidOf("Shift", shH1.id)).toBe(cHB.id)

    // (f) MISSING row → conflict
    const ctxF = testCtx()
    const resF = await guardedUpdate(ctxF, "T", "Shift", "no-such-shift-id", "companyId", null, cHB.id, "test missing", { vendorId: vH.id })
    expect(resF).toBe("conflict")
    expect(ctxF.manual.some((m: any) => m.reason.includes("missing"))).toBe(true)

    // restore the fixture for later suites of this file
    await db.shift.update({ where: { id: shH1.id }, data: { companyId: null } })
  })

  test("F-04 · every guarded target table carries the vendor-scoping column", async () => {
    for (const table of Object.keys(GUARDED_TARGET_TABLES)) {
      const rows: any[] = await db.$queryRawUnsafe(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'vendorId'`, table)
      expect(rows.length, `${table} must carry vendorId for F-04 vendor-scoped CAS`).toBe(1)
    }
  })

  test("F-04 · a concurrent companyId update between read and write is a conflict, not an overwrite", async () => {
    // fresh NULL-company journal for this test
    const j = await db.accountJournal.create({ data: { vendorId: vH.id, companyId: null, refType: "PAYROLL", refId: runH1.id, date: "2026-02-02", memo: "H concurrent test", linesJson: "[]", amount: 5, source: "HRM", status: "POSTED" } })
    try {
      // the interposed client fires a REAL concurrent write (second
      // connection, committed) immediately before the script's CAS UPDATE —
      // matched on the EXACT row id (CAS args: [sql, newValue, id, …])
      const intruder = wrapClient(db, [{
        key: "$executeRawUnsafe",
        when: (args) => typeof args[0] === "string" && args[0].includes(`UPDATE "AccountJournal" SET "companyId"`) && args[2] === j.id,
        mode: "run",
        run: async () => {
          await db2.$executeRawUnsafe(`UPDATE "AccountJournal" SET "companyId" = $1 WHERE "id" = $2`, cHI.id, j.id)
        },
      }])
      const out = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-JRN"], client: intruder }))
      // the CAS matched nothing: the row's company is now cHI (the
      // intruder's value), which is neither the expected old (NULL) nor the
      // proposed new (cHB) → CONCURRENT, recorded in the manual list
      expect(out.counts["R-JRN"].conflict).toBeGreaterThanOrEqual(1)
      expect(out.manual.some((m: any) => m.id === j.id && m.reason.includes("concurrently modified"))).toBe(true)
      expect(await cidOf("AccountJournal", j.id)).toBe(cHI.id) // the concurrent value survives — never overwritten
    } finally {
      await db.accountJournal.delete({ where: { id: j.id } })
    }
  })
})

describe("M3a hardening · F-05 exact-PK restore of created access rows", () => {
  test("F-05 · restore deletes only the exact script-created row; duplicates, changed rows, foreign rows and legacy entries survive", async () => {
    // create the script's row (real R-ORP run on vH)
    const out = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-ORP"] }))
    const rowsAfterRun = await db.userCompanyAccess.findMany({ where: { userId: oH1.id } })
    expect(rowsAfterRun).toHaveLength(1)
    const scriptRowId = rowsAfterRun[0].id
    // the journal carries the EXACT primary key + full evidence (F-05)
    const j: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE run_id = $1 AND target_table = 'UserCompanyAccess'`, out.runId)
    expect(j).toHaveLength(1)
    expect(j[0].target_id).toBe(`uca:${scriptRowId}`)
    expect(j[0].new_value).toMatchObject({ id: scriptRowId, vendorId: vH.id, userId: oH1.id, companyId: cHB.id, role: "EMPLOYEE" })

    // a DUPLICATE row with the SAME (userId, companyId, role) — the old,
    // imprecise restore would have deleted BOTH; the exact-PK restore must
    // delete only the script's row
    const duplicate = await db.userCompanyAccess.create({ data: { vendorId: vH.id, userId: oH1.id, companyId: cHB.id, role: "EMPLOYEE", active: true, isDefault: false, grantedByName: "someone else" } })

    const rep = await restoreRun(out.runId, db as any)
    expect(rep.deletedAccessRows).toBe(1)
    const after = await db.userCompanyAccess.findMany({ where: { userId: oH1.id } })
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(duplicate.id) // the OTHER row survived

    // idempotent repeat: the exact row is gone → alreadyDeleted, no error
    const rep2 = await restoreRun(out.runId, db as any)
    expect(rep2.deletedAccessRows).toBe(0)
    expect(rep2.alreadyDeletedAccessRows).toBe(1)
    expect(await db.userCompanyAccess.count({ where: { userId: oH1.id } })).toBe(1)
    await db.userCompanyAccess.deleteMany({ where: { userId: oH1.id } }) // back to zero rows → a fresh R-ORP run sees the cohort again

    // a CHANGED script-created row (concurrent modification) is never deleted
    const out2 = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-ORP"] }))
    expect(await db.userCompanyAccess.count({ where: { userId: oH1.id } })).toBe(1) // the fresh script row
    const newRow = (await db.userCompanyAccess.findMany({ where: { userId: oH1.id, grantedByName: "M3a/R-ORP auto-backfill" } }))[0]
    await db.userCompanyAccess.update({ where: { id: newRow.id }, data: { role: "HR_ADMIN" } }) // changed after creation
    const rep3 = await restoreRun(out2.runId, db as any)
    expect(rep3.accessConflicts).toHaveLength(1)
    expect(rep3.deletedAccessRows).toBe(0)
    expect(await db.userCompanyAccess.count({ where: { id: newRow.id } })).toBe(1) // still there

    // WRONG-VENDOR evidence: a journal entry whose evidence points at
    // another vendor must never delete the row
    const foreign = await db.userCompanyAccess.create({ data: { vendorId: vD.id, userId: oD1.id, companyId: cDA.id, role: "HR_MANAGER", active: true, isDefault: true } })
    const fakeRunId = `fake-${uniq("run")}`
    await db.$executeRawUnsafe(
      `INSERT INTO _mc_backfill_journal (id, run_id, phase, dry_run, target_table, target_id, action, new_value, note)
       VALUES ($1,$2,'R-ORP',false,'UserCompanyAccess',$3,'INSERT',$4::jsonb,'tampered evidence')`,
      `fakej-${uniq("id")}`, fakeRunId, `uca:${foreign.id}`,
      JSON.stringify({ id: foreign.id, vendorId: vH.id, userId: oD1.id, companyId: cDA.id, role: "HR_MANAGER" }))
    const rep4 = await restoreRun(fakeRunId, db as any)
    expect(rep4.accessConflicts).toHaveLength(1)
    expect(await db.userCompanyAccess.count({ where: { id: foreign.id } })).toBe(1) // survived

    // LEGACY-format entry (pre-hardening journal, no exact PK) → manual only
    const legacyRunId = `legacy-${uniq("run")}`
    await db.$executeRawUnsafe(
      `INSERT INTO _mc_backfill_journal (id, run_id, phase, dry_run, target_table, target_id, action, new_value, note)
       VALUES ($1,$2,'R-ORP',false,'UserCompanyAccess',$3,'INSERT',$4::jsonb,'legacy entry')`,
      `fakej-${uniq("id")}`, legacyRunId, `user:${oD1.id}`,
      JSON.stringify({ vendorId: vD.id, userId: oD1.id, companyId: cDA.id, role: "HR_MANAGER" }))
    const rep5 = await restoreRun(legacyRunId, db as any)
    expect(rep5.deletedAccessRows).toBe(0)
    expect(rep5.manualRemoval.some((m: any) => m.reason?.includes("legacy journal entry"))).toBe(true)
    expect(await db.userCompanyAccess.count({ where: { id: foreign.id } })).toBe(1)

    // cleanup the extra rows so later tests start clean
    await db.userCompanyAccess.deleteMany({ where: { userId: oH1.id } })
    await db.userCompanyAccess.delete({ where: { id: foreign.id } })
    await db.$executeRawUnsafe(`DELETE FROM _mc_backfill_journal WHERE run_id IN ($1,$2)`, fakeRunId, legacyRunId)
    await db.$executeRawUnsafe(`DELETE FROM _mc_backfill_runs WHERE run_id IN ($1,$2)`, fakeRunId, legacyRunId)
  })
})

describe("M3a hardening · F-06 atomicity, run lifecycle and failure injection", () => {
  test("F-06 · journal write failure rolls the business mutation back; the run is recorded 'failed'; the retry repairs once", async () => {
    // a FRESH NULL-company journal (jhPayroll was already repaired by the
    // earlier F-04 concurrent test — this test needs its own pending row)
    const jFail = await db.accountJournal.create({ data: { vendorId: vH.id, companyId: null, refType: "PAYROLL", refId: runH1.id, date: "2026-02-04", memo: "H journal-failure test", linesJson: "[]", amount: 5, source: "HRM", status: "POSTED" } })
    await withInsertTrigger("_mc_backfill_journal", "INJECTED journal failure", async () => {
      // the journal INSERT fails INSIDE the mutation transaction → the
      // AccountJournal UPDATE must roll back with it
      await expect(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-JRN"] })).rejects.toThrow("INJECTED journal failure")
    })
    // the business row is untouched and nothing was journaled for it
    expect(await cidOf("AccountJournal", jFail.id)).toBe(null)
    const j: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE target_id = $1`, jFail.id)
    expect(j).toHaveLength(0)
    // the run record says FAILED with the error
    const runs: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`)
    expect(runs).toHaveLength(1)
    expect(runs[0].error).toContain("INJECTED journal failure")
    myRunIds.push(runs[0].run_id)
    // the retry (trigger gone) completes the repair exactly once
    const retry = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-JRN"] }))
    expect(retry.counts["R-JRN"].changed).toBe(1)
    expect(await cidOf("AccountJournal", jFail.id)).toBe(cHB.id)
    const j2: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE target_id = $1 AND dry_run = false`, jFail.id)
    expect(j2).toHaveLength(1) // no duplicate journal events from the retry
  })

  test("F-06 · a partial workflow-step creation is impossible (R-WFS rolls back atomically)", async () => {
    await withInsertTrigger("ApprovalStep", "INJECTED step failure", async () => {
      await expect(runBackfill({ confirm: true, vendor: vD.id, phases: ["R-WFS"] })).rejects.toThrow("INJECTED step failure")
    })
    // NO workflow row was left behind (the workflow INSERT rolled back too)
    expect(await db.approvalWorkflow.count({ where: { vendorId: vD.id, processType: "LEAVE", companyId: null } })).toBe(0)
    const runs: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`)
    expect(runs[0].error).toContain("INJECTED step failure")
    myRunIds.push(runs[0].run_id)
    // retry completes: workflow + steps seeded consistently
    const retry = await trackRun(runBackfill({ confirm: true, vendor: vD.id, phases: ["R-WFS"] }))
    expect(retry.counts["R-WFS"].inserted).toBe(1)
    const seeded = await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vD.id, processType: "LEAVE", companyId: null } })
    expect(seeded.name).toBe(wfDA.name) // template = the ACTIVE company's row (F-07)
    expect(await db.approvalStep.count({ where: { workflowId: seeded.id } })).toBe(1)
  })

  test("F-06 · a client-side failure (simulated disconnect) inside the mutation transaction rolls back and fails the run", async () => {
    const j = await db.accountJournal.create({ data: { vendorId: vH.id, companyId: null, refType: "PAYROLL", refId: runH1.id, date: "2026-02-03", memo: "H disconnect test", linesJson: "[]", amount: 5, source: "HRM", status: "POSTED" } })
    try {
      const failing = wrapClient(db, [{
        key: "$executeRawUnsafe",
        when: (args) => typeof args[0] === "string" && args[0].includes(`UPDATE "AccountJournal" SET "companyId"`) && args[2] === j.id,
        mode: "throw",
        message: "INJECTED-CLIENT-DISCONNECT",
      }])
      await expect(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-JRN"], client: failing })).rejects.toThrow("INJECTED-CLIENT-DISCONNECT")
      expect(await cidOf("AccountJournal", j.id)).toBe(null) // rolled back
      const runs: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`)
      expect(runs[0].error).toContain("INJECTED-CLIENT-DISCONNECT")
      myRunIds.push(runs[0].run_id)
      // no journal event was committed for the rolled-back mutation
      const je: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE target_id = $1`, j.id)
      expect(je).toHaveLength(0)
    } finally {
      await db.accountJournal.delete({ where: { id: j.id } })
    }
  })

  test("F-06 · concurrent access-row creation never duplicates (re-check and post-verify paths)", async () => {
    // (a) the concurrent row commits AFTER the cohort read but BEFORE the
    // script's transaction (injected at the per-user employee lookup, which
    // sits between the two) → the in-transaction re-check sees it (READ
    // COMMITTED sees the latest committed state) → the script classifies
    // unchanged and creates nothing
    const pre = await db.userCompanyAccess.findMany({ where: { userId: oD1.id } })
    expect(pre).toHaveLength(0)
    const interposedA = wrapClient(db, [{
      key: "employee.findFirst",
      mode: "run",
      run: async () => {
        // a "concurrent process" grants the row after the cohort read
        await db2.userCompanyAccess.create({ data: { vendorId: vD.id, userId: oD1.id, companyId: cDA.id, role: "HR_MANAGER", active: true, isDefault: true, grantedByName: "concurrent grant" } })
      },
    }])
    const outA = await trackRun(runBackfill({ confirm: true, vendor: vD.id, phases: ["R-ORP"], client: interposedA }))
    expect(outA.counts["R-ORP"].inserted).toBe(0)
    expect(outA.counts["R-ORP"].unchanged).toBe(1)
    expect(await db.userCompanyAccess.count({ where: { userId: oD1.id } })).toBe(1) // no duplicate

    // (b) the concurrent row lands BETWEEN the re-check and the create →
    // the post-create verification rolls the script's insert back → conflict
    await db.userCompanyAccess.deleteMany({ where: { userId: oD1.id } })
    const interposedB = wrapClient(db, [{
      key: "userCompanyAccess.create",
      mode: "run",
      run: async () => {
        await db2.userCompanyAccess.create({ data: { vendorId: vD.id, userId: oD1.id, companyId: cDA.id, role: "HR_MANAGER", active: true, isDefault: true, grantedByName: "concurrent grant 2" } })
      },
    }])
    const outB = await trackRun(runBackfill({ confirm: true, vendor: vD.id, phases: ["R-ORP"], client: interposedB }))
    expect(outB.counts["R-ORP"].conflict).toBe(1)
    expect(outB.manual.some((m: any) => m.reason.includes("concurrent access-row creation"))).toBe(true)
    expect(await db.userCompanyAccess.count({ where: { userId: oD1.id } })).toBe(1) // the concurrent row only — the script's insert was rolled back
    await db.userCompanyAccess.deleteMany({ where: { userId: oD1.id } })
  })

  test("F-06 · a concurrent role modification is a classified conflict, never an overwrite (R-ROL)", async () => {
    // interpose a REAL concurrent role change (second connection) right
    // before the script's role CAS on the C4 row (matched on the exact row id)
    const interposed = wrapClient(db, [{
      key: "$executeRawUnsafe",
      when: (args) => typeof args[0] === "string" && args[0].includes(`UPDATE "UserCompanyAccess" SET "role"`) && args[2] === rC4.id,
      mode: "run",
      run: async () => {
        await db2.userCompanyAccess.update({ where: { id: rC4.id }, data: { role: "HR_MANAGER" } })
      },
    }])
    const out = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: [], resetRoles: true, client: interposed }))
    // the C4 row's role was concurrently changed to HR_MANAGER: neither the
    // expected old (GARBAGE_KEY) nor the proposed new (HR_ADMIN) → conflict
    expect(out.counts["R-ROL"].conflict).toBe(1)
    expect(out.manual.some((m: any) => m.id === rC4.id && m.reason.includes("concurrently modified"))).toBe(true)
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: rC4.id } })).role).toBe("HR_MANAGER") // the concurrent value survives
    // the C2 row (not touched concurrently) still resets normally (C2 + no
    // deliberate list → reset to User.role = HR_MANAGER)
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: rC2.id } })).role).toBe("HR_MANAGER")
  })

  test("F-06 · a stale 'running' run (dead process) is auto-marked 'interrupted'; a live 'running' run refuses restore", async () => {
    // a run record left behind by a killed process (pid 999999 is dead)
    const staleRunId = `stale-${uniq("run")}`
    await db.$executeRawUnsafe(
      `INSERT INTO _mc_backfill_runs (run_id, dry_run, phases, status, pid, host) VALUES ($1, false, 'R-ORP', 'running', 999999, $2)`,
      staleRunId, os.hostname())
    const out = await trackRun(runBackfill({ confirm: true, vendor: vH.id, phases: ["R-APA"] }))
    const stale: any[] = await db.$queryRawUnsafe(`SELECT status FROM _mc_backfill_runs WHERE run_id = $1`, staleRunId)
    expect(stale[0].status).toBe("interrupted")
    // the new run itself completed
    const mine: any[] = await db.$queryRawUnsafe(`SELECT status FROM _mc_backfill_runs WHERE run_id = $1`, out.runId)
    expect(mine[0].status).toBe("completed")
    // a run still marked 'running' (live) cannot be restored underneath itself
    const liveRunId = `live-${uniq("run")}`
    await db.$executeRawUnsafe(
      `INSERT INTO _mc_backfill_runs (run_id, dry_run, phases, status, pid, host) VALUES ($1, false, 'R-ORP', 'running', $2, $3)`,
      liveRunId, process.pid, os.hostname())
    await expect(restoreRun(liveRunId, db as any)).rejects.toThrow(/still marked 'running'/)
    // cleanup
    await db.$executeRawUnsafe(`DELETE FROM _mc_backfill_runs WHERE run_id IN ($1,$2)`, staleRunId, liveRunId)
  })

  test("F-06 · repeated dry-runs produce identical plans and write no business rows", async () => {
    const snap = await cidOf("AttendancePolicyAssignment", apaH1.id) // already repaired to cHB by the F-03 test
    const d1 = await trackRun(runBackfill({ dryRun: true, vendor: vH.id }))
    const d2 = await trackRun(runBackfill({ dryRun: true, vendor: vH.id }))
    // identical plans: same counts object (R-APA now sees unchanged=1;
    // nothing new to change), and no business mutation either time
    expect(JSON.stringify(d1.counts)).toBe(JSON.stringify(d2.counts))
    expect(await cidOf("AttendancePolicyAssignment", apaH1.id)).toBe(snap)
    expect(d1.counts["R-APA"].changed).toBe(0)
    expect(d1.counts["R-APA"].unchanged).toBe(1)
    // journal rows for both dry runs are flagged dry_run=true
    const dryRows: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE run_id IN ($1,$2)`, d1.runId, d2.runId)
    expect(dryRows.every((r) => r.dry_run === true)).toBe(true)
  })
})

describe("M3a hardening · F-07 active default company consistency", () => {
  test("F-07 · R-ORP follows the F-01 rule: inactive default → active alternative; duplicate defaults → F-01 ordering; no active company → row-less", async () => {
    // vendor D: the DEFAULT-FLAGGED company is INACTIVE; the active
    // alternative receives the row (never the inactive default)
    await trackRun(runBackfill({ confirm: true, vendor: vD.id, phases: ["R-ORP"] }))
    const rowsD = await db.userCompanyAccess.findMany({ where: { userId: oD1.id } })
    expect(rowsD).toHaveLength(1)
    expect(rowsD[0].companyId).toBe(cDA.id) // the ACTIVE alternative — not cDI
    expect(rowsD[0].companyId).not.toBe(cDI.id)

    // vendor P: two ACTIVE default-flagged companies — the F-01 runtime
    // ordering (isDefault DESC, createdAt ASC) resolves deterministically to
    // the OLDEST default-flagged active company
    await trackRun(runBackfill({ confirm: true, vendor: vP.id, phases: ["R-ORP"] }))
    const rowsP = await db.userCompanyAccess.findMany({ where: { userId: oP1.id } })
    expect(rowsP).toHaveLength(1)
    expect(rowsP[0].companyId).toBe(cP1.id)

    // vendor X: the only company is INACTIVE → NO row, listed for the operator
    const outX = await trackRun(runBackfill({ confirm: true, vendor: vX.id, phases: ["R-ORP"] }))
    expect(await db.userCompanyAccess.count({ where: { userId: oX1.id } })).toBe(0)
    expect(outX.manual.some((m: any) => m.id === oX1.id && m.reason.includes("no active company"))).toBe(true)

    // consistency: the R-ORP target equals resolveProvisioningCompanyId for
    // every fixture vendor (the runtime rule, by construction)
    const { resolveProvisioningCompanyId } = await import("@/hrm-server/company")
    expect(await resolveProvisioningCompanyId(vD.id, null)).toBe(cDA.id)
    expect(await resolveProvisioningCompanyId(vP.id, null)).toBe(cP1.id)
    expect(await resolveProvisioningCompanyId(vX.id, null)).toBe(null)
  })

  test("F-07 · R-WFS never copies from an inactive default: template = the ACTIVE company's row; duplicate defaults surface an advisory; inactive-only vendors are listed", async () => {
    // vD: seeded in the F-06 test — the template must have been wfDA (the
    // ACTIVE company's workflow), NOT wfDI (the inactive DEFAULT company's)
    const seeded = await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vD.id, processType: "LEAVE", companyId: null } })
    expect(seeded.name).toBe(wfDA.name)
    expect(seeded.name).not.toBe(wfDI.name)
    const steps = await db.approvalStep.findMany({ where: { workflowId: seeded.id } })
    expect(steps.map((s: any) => s.name)).toEqual(["D active step"]) // copied from the ACTIVE template

    // vP: duplicate active default flags → deterministic F-01 template (the
    // older default company's row) + an operator advisory, never a silent pick
    const outP = await trackRun(runBackfill({ confirm: true, vendor: vP.id, phases: ["R-WFS"] }))
    const seededP = await db.approvalWorkflow.findFirstOrThrow({ where: { vendorId: vP.id, processType: "LEAVE", companyId: null } })
    expect(seededP.name).toBe(wfP1.name) // F-01 ordering: both default-flagged → earliest workflow
    expect(outP.manual.some((m: any) => m.reason.includes("duplicate default flags"))).toBe(true)

    // vX: the ONLY workflow rows live on the INACTIVE company → listed for
    // the operator, never silently copied
    const outX = await trackRun(runBackfill({ confirm: true, vendor: vX.id, phases: ["R-WFS"] }))
    expect(await db.approvalWorkflow.count({ where: { vendorId: vX.id, processType: "LEAVE", companyId: null } })).toBe(0)
    expect(outX.manual.some((m: any) => m.reason.includes("ACTIVE company"))).toBe(true)
  })

  test("F-07 · wrong-vendor references are dead refs (journalAnchor + R-ADJ cross-vendor)", async () => {
    // a vD journal whose refId points at vH's payroll run → dead ref
    const r1 = await journalAnchor(db as any, vD.id, "PAYROLL", runH1.id)
    expect(r1.target).toBe(null)
    expect(r1.reason).toContain("dead ref")
    // the R-ADJ pass on vD: the adjustment run pointing at vH's source run
    // stays NULL and is listed (cross-vendor references are never anchors)
    const out = await trackRun(runBackfill({ confirm: true, vendor: vD.id, phases: ["R-ADJ", "R-JRN"] }))
    expect(await cidOf("PayrollRun", runAdjD.id)).toBe(null)
    expect(out.manual.some((m: any) => m.id === runAdjD.id && m.reason.includes("another vendor"))).toBe(true)
    expect(await cidOf("AccountJournal", jAdjD.id)).toBe(null)
    expect(out.manual.some((m: any) => m.id === jAdjD.id && m.reason.includes("another vendor"))).toBe(true)
  })
})

describe("M3a hardening · script CLI safety checks", () => {
  const REPO = import.meta.dir + "/../.."
  const ENV = { ...process.env } as Record<string, string>

  async function cli(args: string[], env: Record<string, string>) {
    // --no-env-file: only the environment passed here counts. Otherwise the "missing
    // DATABASE_URL" case silently picks up a developer's .env and points this repair
    // script at their real database.
    const proc = Bun.spawn(["bun", "--no-env-file", "run", "scripts/mc-backfill-core.mjs", ...args], {
      cwd: REPO, env, stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  }

  test("CLI · refuses before any database work: missing DATABASE_URL, no --confirm, --confirm without the gate ack, unknown arg/phase", async () => {
    // (1) missing DATABASE_URL — refused with the script's OWN message (the
    // lazy Prisma import means no constructor crash)
    const noUrl = { ...ENV }
    delete noUrl.DATABASE_URL
    const r1 = await cli([], noUrl)
    expect(r1.code).toBe(2)
    expect(r1.stderr).toContain("DATABASE_URL is required")

    // (2) DATABASE_URL present but no mode → refuses to write
    const r2 = await cli([], ENV)
    expect(r2.code).toBe(2)
    expect(r2.stderr).toContain("Refusing to write")

    // (3) --confirm WITHOUT the gate acknowledgment → the documented M3a
    // execution gate refusal (--confirm is not a substitute for the gate)
    const r3 = await cli(["--confirm"], ENV)
    expect(r3.code).toBe(2)
    expect(r3.stderr).toContain("M3a execution gate")
    expect(r3.stderr).toContain("M3A_EXECUTION_GATE_ACK=R2-LIVE-ON-ALL-INSTANCES")

    // (4) unknown argument → exit 2
    const r4 = await cli(["--nonsense"], ENV)
    expect(r4.code).toBe(2)
    expect(r4.stderr).toContain("Unknown argument")

    // (5) unknown phase → exit 2 (before any run)
    const r5 = await cli(["--dry-run", "--phase", "NOPE"], ENV)
    expect(r5.code).toBe(2)
    expect(r5.stderr).toContain("Unknown phase")

    // (6) --dry-run needs NO gate ack and completes cleanly (read-only)
    // FORENSIC AUDIT 2026-11-10 (Phase 1, test engineering — same class as the
    // register's FIN-025/FIN-026): r6 used to dry-run the WHOLE shared test
    // database. Late in the suite that is thousands of rows from every other
    // file — the plan JSON alone ran to megabytes and the subprocess's stdout
    // outran the pipe in memory-constrained CI (exit 0, truncated stdout,
    // flaky failure). The dry-run is now VENDOR-SCOPED to this suite's own
    // fixture vendor: the CLI contract (no gate ack, clean exit, run journal)
    // is identical, the output is small and deterministic, and other suites'
    // data cannot influence it.
    const r6 = await cli(["--dry-run", "--json", "--vendor", vD.id], ENV)
    expect(r6.code).toBe(0)
    expect(r6.stdout).toContain("dry-run — no business writes")
    const runIdMatch = /"runId"\s*:\s*"([^"]+)"/.exec(r6.stdout)
    expect(runIdMatch).toBeTruthy()
    if (runIdMatch) myRunIds.push(runIdMatch[1]) // cleanup
  })
})
