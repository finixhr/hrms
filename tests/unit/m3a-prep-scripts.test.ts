/// <reference types="bun-types" />
// ============ M3a preparation — synthetic validation of the authored scripts ============
// The M3a EXECUTION gate (B-7 decision → W1-AC-08 PASS → R1 deploy → R2
// deploy → M3a run) is NOT satisfied — nothing here touches production. This
// suite validates mc-backfill-core.mjs + mc-remediation-report.mjs against
// SYNTHETIC fixtures in the disposable scratch database only:
//   A0 · report on the PRE-repair population (PDR-1/PDR-2, class A/B,
//        unattributable, orphan cohort, workflow gaps, duplicates)
//   A  · dry-run previews every repair and writes NOTHING to business tables
//   B  · the real run repairs the full documented population (anchors,
//        preserved-NULL class A/B, honesty-rule default-stamp resets, R-ORP
//        rows, R-WFS seeds) + journal integrity (old_value == pre-state)
//   C  · idempotency: a full re-run is a no-op (guards, no duplicate journal)
//   D  · vendor/company isolation (vendor M repairs never touch vendors S/N)
//   E  · --reset-roles: C4/C5 always, C2/C3 unless --deliberate; journaled
//   F  · report hard gate: zero unreviewed C2–C5 after reset + sign-off
//   G  · read-only sections: duplicate survey, delta register, wildcards
//   H  · --restore reverts the journaled run (UPDATEs rolled back, access
//        rows deleted, workflow inserts listed for manual removal)
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { runBackfill } from "../../scripts/mc-backfill-core.mjs"
import { buildReport } from "../../scripts/mc-remediation-report.mjs"

// ---------------------------------------------------------------------------
// fixtures — vendor M (multi-company), S (single-company), N (no active company)
// ---------------------------------------------------------------------------
let vM: any, vS: any, vN: any
let cMA: any, cMB: any, cMI: any, cS: any, cNI: any
let brB: any, dptB: any
let eB: any, eNull: any, eS: any, eNI: any
let uOrp1: any, uOrp2: any, uOrp3: any, uOrp4: any, uOrp5: any, nonOrphan: any
let c1U: any, c1Row: any, c2U: any, c2Row: any, c3U: any, c3Row: any
let c4U: any, c4Row: any, c5U: any, c5Row: any
let deltaU: any, deltaRow: any, wildU: any
let rSrc: any, ar1: any, ar2: any, runRegNull: any
let L1: any, L2: any, LI1: any, A1: any, EC1: any, R1: any, FS1: any
let jPayroll: any, jVoucher: any, jDeadRef: any, jLoanDisb: any, jEmpNullAnchor: any
let jLoanRec: any, jAdvPay: any, jExpense: any, jSettle: any, jAlready: any
let sh1: any, sh2: any, sh3: any, sh4: any, sh5: any, sh6: any
let hol1: any, hol2: any, hol3: any, hol4: any
let t1: any, t2: any, t3: any, t4: any, t5: any
let apa1: any, apa2: any, apa3: any, apa4: any, apa5: any, apa6: any
let wfLeaveC: any, wfLoanNull: any, wfSPurchase: any, wfExpNullA: any, wfExpNullB: any

// id → table (for companyId lookups across tests)
const TABLE_OF: Record<string, string> = {}
const CID: Record<string, any> = {} // pre-state snapshot
let tracked: any[] = []

async function cidOf(id: string) {
  const rows: any[] = await db.$queryRawUnsafe(`SELECT "companyId" FROM "${TABLE_OF[id]}" WHERE "id" = $1`, id)
  return rows.length ? rows[0].companyId : "MISSING" // NULL value ≠ missing row
}

beforeAll(async () => {
  vM = await mkVendor(uniq("M3a Vendor M"), { company: false })
  cMA = await db.company.create({ data: { vendorId: vM.id, code: uniq("M3aA"), name: "M3a Co A (default)", active: true, isDefault: true } })
  cMB = await db.company.create({ data: { vendorId: vM.id, code: uniq("M3aB"), name: "M3a Co B", active: true } })
  cMI = await db.company.create({ data: { vendorId: vM.id, code: uniq("M3aI"), name: "M3a Co I (inactive)", active: false } })
  vS = await mkVendor(uniq("M3a Vendor S"), { company: false })
  cS = await db.company.create({ data: { vendorId: vS.id, code: uniq("M3aS"), name: "M3a Co S (single)", active: true, isDefault: true } })
  vN = await mkVendor(uniq("M3a Vendor N"), { company: false })
  cNI = await db.company.create({ data: { vendorId: vN.id, code: uniq("M3aN"), name: "M3a Co N (inactive only)", active: false, isDefault: true } })

  brB = await db.branch.create({ data: { vendorId: vM.id, companyId: cMB.id, name: "M3a Branch B", code: uniq("M3aBR") } })
  dptB = await db.department.create({ data: { vendorId: vM.id, companyId: cMB.id, name: "M3a Dept B", code: uniq("M3aDP") } })
  const mkEmp = async (vId: string, company: any | null, name: string) =>
    db.employee.create({ data: { vendorId: vId, code: uniq("M3aE"), fullName: name, companyId: company?.id ?? null, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })
  eB = await mkEmp(vM.id, cMB, "M3a Emp B")
  eNull = await mkEmp(vM.id, null, "M3a Emp Null")
  eS = await mkEmp(vS.id, cS, "M3a Emp S")
  eNI = await mkEmp(vN.id, cNI, "M3a Emp N")

  // ---- orphan users (zero access rows) + a non-orphan control
  uOrp1 = await mkUser(vM.id, { role: "EMPLOYEE", permissions: [], name: uniq("M3a uOrp1"), employeeId: eB.id, email: `m3a-orp1-${uniq("u")}@test.local` })
  uOrp2 = await mkUser(vM.id, { role: "HR_MANAGER", permissions: [], name: uniq("M3a uOrp2"), email: `m3a-orp2-${uniq("u")}@test.local` })
  uOrp3 = await mkUser(vM.id, { role: "EMPLOYEE", permissions: [], name: uniq("M3a uOrp3"), employeeId: eNull.id, email: `m3a-orp3-${uniq("u")}@test.local` })
  uOrp4 = await mkUser(vN.id, { role: "EMPLOYEE", permissions: [], name: uniq("M3a uOrp4"), employeeId: eNI.id, email: `m3a-orp4-${uniq("u")}@test.local` })
  uOrp5 = await mkUser(vS.id, { role: "HR_ADMIN", permissions: [], name: uniq("M3a uOrp5"), email: `m3a-orp5-${uniq("u")}@test.local` })
  nonOrphan = await mkUser(vM.id, { role: "HR_ADMIN", name: uniq("M3a nonOrphan"), email: `m3a-nonorp-${uniq("u")}@test.local` })
  await db.userCompanyAccess.create({ data: { vendorId: vM.id, userId: nonOrphan.id, companyId: cMA.id, role: "HR_ADMIN", active: true, isDefault: true } })

  // ---- R-ROL cohort (users carry EMPTY explicit grants so PDR-2 shows the
  //      documented C4/C5 "removals = the entire company-scoped baseline")
  const mkRow = async (u: any, role: string, extra: object = {}) =>
    db.userCompanyAccess.create({ data: { vendorId: u.vendorId, userId: u.id, companyId: cMB.id, role, active: true, isDefault: false, ...extra } })
  c1U = await mkUser(vM.id, { role: "HR_ADMIN", name: uniq("M3a c1"), email: `m3a-c1-${uniq("u")}@test.local` })
  c1Row = await mkRow(c1U, "HR_ADMIN")
  c2U = await mkUser(vM.id, { role: "HR_MANAGER", permissions: [], name: uniq("M3a c2"), email: `m3a-c2-${uniq("u")}@test.local` })
  c2Row = await mkRow(c2U, "PAYROLL_OFFICER")
  await db.role.create({ data: { vendorId: vM.id, key: "TEAM_LEAD", name: "Team Lead", permissions: "[]" } })
  c3U = await mkUser(vM.id, { role: "HR_ADMIN", permissions: [], name: uniq("M3a c3"), email: `m3a-c3-${uniq("u")}@test.local` })
  c3Row = await mkRow(c3U, "TEAM_LEAD")
  c4U = await mkUser(vM.id, { role: "HR_ADMIN", permissions: [], name: uniq("M3a c4"), email: `m3a-c4-${uniq("u")}@test.local` })
  c4Row = await mkRow(c4U, "GARBAGE_KEY")
  c5U = await mkUser(vM.id, { role: "HR_ADMIN", permissions: [], name: uniq("M3a c5"), email: `m3a-c5-${uniq("u")}@test.local` })
  c5Row = await mkRow(c5U, "SUPPORT")
  deltaU = await mkUser(vM.id, { role: "HR_ADMIN", name: uniq("M3a delta"), email: `m3a-delta-${uniq("u")}@test.local` })
  deltaRow = await mkRow(deltaU, "HR_ADMIN", { permissions: "[\"employees.view\"]", excludedPermissions: "[\"payroll.pay\"]" })
  wildU = await mkUser(vM.id, { role: "HR_ADMIN", permissions: ["*"], name: uniq("M3a wild"), email: `m3a-wild-${uniq("u")}@test.local` })
  await db.userCompanyAccess.create({ data: { vendorId: vM.id, userId: wildU.id, companyId: cMB.id, role: "HR_ADMIN", active: true, isDefault: true } })

  // ---- financial refs
  rSrc = await db.payrollRun.create({ data: { vendorId: vM.id, companyId: cMB.id, periodMonth: 1, periodYear: 2026, frequency: "MONTHLY", runType: "REGULAR", status: "PAID" } })
  ar1 = await db.payrollRun.create({ data: { vendorId: vM.id, companyId: null, periodMonth: 1, periodYear: 2026, frequency: "MONTHLY", runType: "ADJUSTMENT", adjustRunId: rSrc.id, adjustSeq: 1, status: "DRAFT" } })
  ar2 = await db.payrollRun.create({ data: { vendorId: vM.id, companyId: null, periodMonth: 2, periodYear: 2026, frequency: "MONTHLY", runType: "ADJUSTMENT", adjustRunId: "ghost-run-id", adjustSeq: 1, status: "DRAFT" } })
  runRegNull = await db.payrollRun.create({ data: { vendorId: vM.id, companyId: null, periodMonth: 3, periodYear: 2026, frequency: "MONTHLY", runType: "REGULAR", status: "DRAFT" } })
  L1 = await db.loan.create({ data: { vendorId: vM.id, employeeId: eB.id, principal: 1000, startDate: "2026-01-01", installments: 2, installmentAmount: 500 } })
  L2 = await db.loan.create({ data: { vendorId: vM.id, employeeId: eNull.id, principal: 100, startDate: "2026-01-01", installments: 1, installmentAmount: 100 } })
  LI1 = await db.loanInstallment.create({ data: { vendorId: vM.id, loanId: L1.id, no: 1, dueDate: "2026-02-01", amount: 500 } })
  A1 = await db.advance.create({ data: { vendorId: vM.id, employeeId: eB.id, amount: 200, requestDate: "2026-01-15" } })
  EC1 = await db.expenseClaim.create({ data: { vendorId: vM.id, employeeId: eB.id, category: "TRAVEL", title: "M3a claim", amount: 50, date: "2026-01-20" } })
  R1 = await db.resignation.create({ data: { vendorId: vM.id, employeeId: eB.id, submissionDate: "2026-02-01", resignationDate: "2026-02-28", proposedLwd: "2026-02-28", reason: "M3a test" } })
  FS1 = await db.finalSettlement.create({ data: { vendorId: vM.id, resignationId: R1.id } })
  const mkJournal = (refType: string, refId: string | null, companyId: string | null) =>
    db.accountJournal.create({ data: { vendorId: vM.id, companyId, refType, refId, date: "2026-02-01", memo: `M3a ${refType}`, linesJson: "[]", amount: 10, source: "HRM", status: "POSTED" } })
  jPayroll = await mkJournal("PAYROLL", rSrc.id, null)
  jVoucher = await mkJournal("JOURNAL_VOUCHER", null, null)
  jDeadRef = await mkJournal("PAYROLL", "ghost-run-id", null)
  jLoanDisb = await mkJournal("LOAN_DISBURSE", L1.id, null)
  jEmpNullAnchor = await mkJournal("LOAN_DISBURSE", L2.id, null)
  jLoanRec = await mkJournal("LOAN_RECOVERY", LI1.id, null)
  jAdvPay = await mkJournal("ADVANCE_PAY", A1.id, null)
  jExpense = await mkJournal("EXPENSE_REIMBURSEMENT", EC1.id, null)
  jSettle = await mkJournal("SETTLEMENT", FS1.id, null)
  jAlready = await mkJournal("PAYROLL", rSrc.id, cMB.id)

  // ---- Shifts / Holidays / Tasks
  const mkShift = (company: any | null, branchId: string | null, name: string) =>
    db.shift.create({ data: { vendorId: vM.id, companyId: company?.id ?? null, branchId, name, startTime: "09:00", endTime: "17:00" } })
  sh1 = await mkShift(null, brB.id, "M3a sh1 (branch-anchored, NULL)")
  sh2 = await mkShift(null, null, "M3a sh2 (class A preserved)")
  sh3 = await mkShift(cMA, null, "M3a sh3 (default-stamped, branchId NULL)")
  sh4 = await mkShift(cMA, brB.id, "M3a sh4 (wrong default stamp, branch-anchored)")
  sh5 = await db.shift.create({ data: { vendorId: vS.id, companyId: cS.id, name: "M3a sh5 (single-company stamp)", startTime: "09:00", endTime: "17:00" } })
  sh6 = await mkShift(null, "ghost-branch-id", "M3a sh6 (dangling branch)")
  const mkHol = (company: any | null, branchId: string | null, name: string) =>
    db.holiday.create({ data: { vendorId: vM.id, companyId: company?.id ?? null, branchId, name, date: "2026-03-17" } })
  hol1 = await mkHol(null, brB.id, "M3a hol1")
  hol2 = await mkHol(null, null, "M3a hol2")
  hol3 = await mkHol(cMA, null, "M3a hol3")
  hol4 = await db.holiday.create({ data: { vendorId: vS.id, companyId: cS.id, name: "M3a hol4", date: "2026-03-18" } })
  const mkTask = (vId: string, company: any | null, assigneeId: string, title: string) =>
    db.task.create({ data: { vendorId: vId, companyId: company?.id ?? null, assigneeId, title, status: "TODO" } })
  t1 = await mkTask(vM.id, null, eB.id, "M3a t1 (assignee-anchored)")
  t2 = await mkTask(vM.id, null, "ghost-emp-id", "M3a t2 (dangling)")
  t3 = await mkTask(vM.id, cMA, "ghost-emp-id", "M3a t3 (stamped dangling)")
  t4 = await mkTask(vM.id, null, eNull.id, "M3a t4 (NULL-company assignee)")
  t5 = await mkTask(vS.id, cS, "ghost-emp-id", "M3a t5 (single-company dangling)")

  // ---- AttendancePolicyAssignment (needs real AttendancePolicy rows for the FK)
  const polM = await db.attendancePolicy.create({ data: { vendorId: vM.id, name: "M3a policy", policyType: "OFFICE" } })
  const polS = await db.attendancePolicy.create({ data: { vendorId: vS.id, name: "M3a policy S", policyType: "OFFICE" } })
  const mkApa = (scopeType: string, scopeId: string | null, policyId = polM.id) =>
    db.attendancePolicyAssignment.create({ data: { vendorId: vM.id, companyId: null, policyId, scopeType, scopeId } })
  apa1 = await mkApa("BRANCH", brB.id)
  apa2 = await mkApa("EMPLOYEE", eB.id)
  apa3 = await mkApa("ALL_EMPLOYEES", null)
  apa4 = await db.attendancePolicyAssignment.create({ data: { vendorId: vS.id, companyId: null, policyId: polS.id, scopeType: "ALL_EMPLOYEES", scopeId: null } })
  apa5 = await mkApa("DEPARTMENT", dptB.id)
  apa6 = await mkApa("BRANCH", "ghost-branch-id")

  // ---- ApprovalWorkflow population (SEC-04 / R-WFS)
  wfLeaveC = await db.approvalWorkflow.create({ data: { vendorId: vM.id, companyId: cMA.id, processType: "LEAVE", name: "M3a Leave (company A)", active: true } })
  await db.approvalStep.create({ data: { vendorId: vM.id, workflowId: wfLeaveC.id, sequence: 1, name: "M3a step 1", approverRole: "HR_MANAGER" } })
  await db.approvalStep.create({ data: { vendorId: vM.id, workflowId: wfLeaveC.id, sequence: 2, name: "M3a step 2", approverRole: "HR_ADMIN" } })
  wfLoanNull = await db.approvalWorkflow.create({ data: { vendorId: vM.id, companyId: null, processType: "LOAN", name: "M3a Loan (NULL fallback)", active: true } })
  wfSPurchase = await db.approvalWorkflow.create({ data: { vendorId: vS.id, companyId: cS.id, processType: "PURCHASE", name: "M3a Purchase (company S)", active: true } })
  await db.approvalStep.create({ data: { vendorId: vS.id, workflowId: wfSPurchase.id, sequence: 1, name: "M3a S step 1", approverRole: "HR_ADMIN" } })
  wfExpNullA = await db.approvalWorkflow.create({ data: { vendorId: vM.id, companyId: null, processType: "EXPENSE", name: "M3a Exp NULL a", active: true } })
  wfExpNullB = await db.approvalWorkflow.create({ data: { vendorId: vM.id, companyId: null, processType: "EXPENSE", name: "M3a Exp NULL b", active: true } })

  // ---- duplicate-survey fixtures: the realistic M4-colliding population is
  // NULL-company pairs (current NULLS DISTINCT uniques permit them; M4's
  // NULLS NOT DISTINCT would raise) — same-company duplicates are already
  // blocked by the existing Branch (companyId, code) unique
  await db.branch.create({ data: { vendorId: vM.id, companyId: null, name: "M3a dup 1", code: "M3ADUP" } })
  await db.branch.create({ data: { vendorId: vM.id, companyId: null, name: "M3a dup 2", code: "M3ADUP" } })

  // ---- id→table map + pre-state snapshot
  tracked = [
    [sh1, "Shift"], [sh2, "Shift"], [sh3, "Shift"], [sh4, "Shift"], [sh5, "Shift"], [sh6, "Shift"],
    [hol1, "Holiday"], [hol2, "Holiday"], [hol3, "Holiday"], [hol4, "Holiday"],
    [t1, "Task"], [t2, "Task"], [t3, "Task"], [t4, "Task"], [t5, "Task"],
    [apa1, "AttendancePolicyAssignment"], [apa2, "AttendancePolicyAssignment"], [apa3, "AttendancePolicyAssignment"],
    [apa4, "AttendancePolicyAssignment"], [apa5, "AttendancePolicyAssignment"], [apa6, "AttendancePolicyAssignment"],
    [jPayroll, "AccountJournal"], [jVoucher, "AccountJournal"], [jDeadRef, "AccountJournal"], [jLoanDisb, "AccountJournal"],
    [jEmpNullAnchor, "AccountJournal"], [jLoanRec, "AccountJournal"], [jAdvPay, "AccountJournal"], [jExpense, "AccountJournal"],
    [jSettle, "AccountJournal"], [jAlready, "AccountJournal"],
    [ar1, "PayrollRun"], [ar2, "PayrollRun"], [runRegNull, "PayrollRun"],
  ]
  for (const [row, table] of tracked) {
    TABLE_OF[row.id] = table
    const r: any[] = await db.$queryRawUnsafe(`SELECT "companyId" FROM "${table}" WHERE "id" = $1`, row.id)
    CID[row.id] = r[0]?.companyId ?? null
  }
})

describe("M3a prep · synthetic validation of the authored scripts", () => {
  test("A0 · report on the PRE-repair population (PDR-1/PDR-2 + sections)", async () => {
    const rep = await buildReport({})
    // suite isolation: population-sensitive assertions are scoped to THIS
    // suite's vendors (other suites' fixtures may share the database when the
    // full suite runs in one process)
    const mine = (r: any) => r.vendorId === vM.id || r.vendorId === vS.id || r.vendorId === vN.id
    // PDR-1 categories
    const cat = (u: any) => rep.sections.roleCohort.rows.find((r: any) => r.email === u.email)?.category
    expect(cat(c1U)).toBe("C1")
    expect(cat(c2U)).toBe("C2")
    expect(cat(c3U)).toBe("C3")
    expect(cat(c4U)).toBe("C4")
    expect(cat(c5U)).toBe("C5")
    expect(rep.sections.roleCohort.rows.filter((r: any) => mine(r) && r.unreviewed && r.signoffDeliberate == null)).toHaveLength(4) // C2+C3+C4+C5 — gate OPEN pre-sign-off
    expect(rep.hardGate.status).toContain("OPEN")
    // PDR-2: C4 (empty explicit grants) → removals = the entire baseline; C2 → template-swap diff
    const c4 = rep.sections.roleCohort.rows.find((r: any) => r.email === c4U.email)
    expect(c4.removals.length).toBeGreaterThan(0)
    expect(c4.additions).toHaveLength(0)
    const c2 = rep.sections.roleCohort.rows.find((r: any) => r.email === c2U.email)
    expect(c2.additions.length + c2.removals.length).toBeGreaterThan(0)
    // C1 (identical) → empty diff
    const c1 = rep.sections.roleCohort.rows.find((r: any) => r.email === c1U.email)
    expect(c1.additions).toHaveLength(0)
    expect(c1.removals).toHaveLength(0)
    // the C1 wildcard holder's before/after both expand to the full catalog → no diff
    const w = rep.sections.roleCohort.rows.find((r: any) => r.email === wildU.email)
    expect(w.category).toBe("C1")
    expect(w.additions).toHaveLength(0)
    // orphan cohort = 5; workflow gaps = LEAVE(vM) + PURCHASE(vS)
    expect(rep.sections.orphanUsers.filter((o: any) => mine(o))).toHaveLength(5)
    expect(rep.sections.workflowFallback.some((x: any) => x.vendorId === vM.id && x.processType === "LEAVE" && x.issue.includes("no NULL-fallback"))).toBe(true)
    expect(rep.sections.workflowFallback.some((x: any) => x.vendorId === vS.id && x.processType === "PURCHASE")).toBe(true)
    expect(rep.sections.workflowFallback.some((x: any) => x.vendorId === vM.id && x.processType === "EXPENSE" && x.issue.includes("multiple NULL-fallback"))).toBe(true)
    // class A / class B members (preserved NULL population, pre-repair)
    expect(rep.sections.classA.some((c: any) => c.id === sh2.id)).toBe(true)
    expect(rep.sections.classA.some((c: any) => c.id === hol2.id)).toBe(true)
    expect(rep.sections.classA.some((c: any) => c.id === sh1.id)).toBe(false) // anchored → repaired, not preserved-NULL
    expect(rep.sections.classB.some((c: any) => c.id === t2.id)).toBe(true)
    expect(rep.sections.classB.some((c: any) => c.id === t4.id)).toBe(true) // dead anchor (NULL-company employee)
    // unattributable: dead refs listed via the SAME anchor map (jVoucher, jDeadRef, jEmpNullAnchor)
    expect(rep.sections.unattributable.deadRefs.some((d: any) => d.id === jVoucher.id)).toBe(true)
    expect(rep.sections.unattributable.deadRefs.some((d: any) => d.id === jDeadRef.id)).toBe(true)
    expect(rep.sections.unattributable.deadRefs.some((d: any) => d.id === jEmpNullAnchor.id)).toBe(true)
    expect(rep.sections.unattributable.deadRefs.some((d: any) => d.id === jPayroll.id)).toBe(false) // live ref
    expect(rep.sections.unattributable.deadSourceAdjustmentRuns.some((d: any) => d.id === ar2.id)).toBe(true)
    expect(rep.sections.unattributable.runsByRunType.some((r: any) => r.runType === "REGULAR")).toBe(true)
    // duplicates + delta register + wildcards + single-company vendors
    expect(rep.sections.duplicateSurvey.some((d: any) => d.table === "Branch" && d.vendorId === vM.id && d.count === 2)).toBe(true)
    expect(rep.sections.deltaRegister.some((d: any) => d.email === deltaU.email)).toBe(true)
    expect(rep.sections.wildcards.some((w: any) => w.email === wildU.email)).toBe(true)
    expect(rep.sections.singleCompanyVendors.some((s: any) => s.vendorId === vS.id && s.companyActive === true)).toBe(true)
    expect(rep.sections.singleCompanyVendors.some((s: any) => s.vendorId === vN.id && s.companyActive === false)).toBe(true) // only company INACTIVE — never an active default (F-01)
  })

  test("A · dry-run previews every repair and writes NOTHING to business tables", async () => {
    // scope the before/after counts to THIS suite's vendors: the script is
    // deployment-wide and bun parallelizes test files against the shared
    // database, so global counts also observe other suites' inserts. A
    // dry-run writes nothing, so the scoped counts must be byte-stable.
    const myVendorIds = { in: [vM.id, vS.id, vN.id] }
    const accessRowsBefore = await db.userCompanyAccess.count({ where: { vendorId: myVendorIds } })
    const wfNullBefore = await db.approvalWorkflow.count({ where: { companyId: null, vendorId: myVendorIds } })
    const out: any = await runBackfill({ dryRun: true })
    expect(out.summary.dryRun).toBe(true)
    // NOTHING changed
    for (const [row] of tracked) expect(await cidOf(row.id)).toBe(CID[row.id])
    expect(await db.userCompanyAccess.count({ where: { vendorId: myVendorIds } })).toBe(accessRowsBefore) // no R-ORP rows
    expect(await db.approvalWorkflow.count({ where: { companyId: null, vendorId: myVendorIds } })).toBe(wfNullBefore) // no R-WFS seeds
    // the preview counts the intended actions. The count is deployment-wide
    // (other suites run against the same database — bun parallelizes test
    // files), so the R-ORP assertion is scoped through the run's OWN journal:
    // exactly this suite's four intended orphans (uOrp1..3+5) are planned,
    // and uOrp4 is planned as MANUAL (vendor N has no active company),
    // never as an INSERT.
    const orpPlan: Array<{ target_id: string; action: string }> = await db.$queryRawUnsafe(
      `SELECT target_id, action FROM _mc_backfill_journal WHERE run_id = $1 AND phase = 'R-ORP'`, out.runId)
    const intended = new Set([`user:${uOrp1.id}`, `user:${uOrp2.id}`, `user:${uOrp3.id}`, `user:${uOrp5.id}`])
    const plannedMine = orpPlan.filter((e) => intended.has(e.target_id))
    expect(plannedMine).toHaveLength(4)
    expect(plannedMine.every((e) => e.action === "INSERT")).toBe(true)
    expect(orpPlan.some((e) => e.target_id === `user:${uOrp4.id}` && e.action === "INSERT")).toBe(false)
    expect(out.counts["R-SHF"].changed).toBeGreaterThan(0)
    // LEAVE(vM) + PURCHASE(vS) — the script is deployment-wide and the full suite
    // shares one database, so other suites' vendors can add to the total.
    expect(out.counts["R-WFS"].inserted).toBeGreaterThanOrEqual(2)
    // journal records the INTENT, flagged dry_run
    const dryEntries: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE run_id = $1 AND dry_run = true`, out.runId)
    expect(dryEntries.length).toBeGreaterThan(0)
    expect(dryEntries.every((e) => e.dry_run === true)).toBe(true)
  })

  let runIdB: string | null = null
  test("B · real run repairs the full documented population + journal integrity", async () => {
    const out = await runBackfill({ confirm: true })
    runIdB = out.runId
    expect(out.runStatus).toBe("completed")
    expect(out.summary.dryRun).toBe(false)
    // --- R-ORP: F-01-consistent rows (employment company when active, else default active)
    const rowsOf = (u: any) => db.userCompanyAccess.findMany({ where: { userId: u.id } })
    const r1 = (await rowsOf(uOrp1))
    expect(r1).toHaveLength(1)
    expect(r1[0]).toMatchObject({ vendorId: vM.id, companyId: cMB.id, role: "EMPLOYEE", permissions: "[]", excludedPermissions: "[]", active: true, isDefault: true })
    expect((await rowsOf(uOrp2))[0].companyId).toBe(cMA.id) // no employee link → default active
    expect((await rowsOf(uOrp3))[0].companyId).toBe(cMA.id) // NULL-company employment → default
    expect(await rowsOf(uOrp4)).toHaveLength(0) // vendor N has NO active company → row-less (listed)
    expect((await rowsOf(uOrp5))[0].companyId).toBe(cS.id)
    expect(await rowsOf(nonOrphan)).toHaveLength(1) // untouched
    // --- R-JRN: anchored journals stamped; dead refs untouched
    expect(await cidOf(jPayroll.id)).toBe(cMB.id)
    expect(await cidOf(jLoanDisb.id)).toBe(cMB.id)
    expect(await cidOf(jLoanRec.id)).toBe(cMB.id)
    expect(await cidOf(jAdvPay.id)).toBe(cMB.id)
    expect(await cidOf(jExpense.id)).toBe(cMB.id)
    expect(await cidOf(jSettle.id)).toBe(cMB.id)
    expect(await cidOf(jVoucher.id)).toBe(null)
    expect(await cidOf(jDeadRef.id)).toBe(null)
    expect(await cidOf(jEmpNullAnchor.id)).toBe(null) // NULL-company employee → dead anchor
    expect(await cidOf(jAlready.id)).toBe(cMB.id) // already stamped → untouched
    // --- R-ADJ
    expect(await cidOf(ar1.id)).toBe(cMB.id)
    expect(await cidOf(ar2.id)).toBe(null)
    expect(await cidOf(runRegNull.id)).toBe(null) // REGULAR runs are outside the documented repair set
    // --- R-SHF / R-HOL: anchors, class A, honesty rule
    expect(await cidOf(sh1.id)).toBe(cMB.id)
    expect(await cidOf(sh2.id)).toBe(null) // preserved class A
    expect(await cidOf(sh3.id)).toBe(null) // default-stamp reset (multi-company vendor)
    expect(await cidOf(sh4.id)).toBe(cMB.id) // anchor fixes the wrong default stamp
    expect(await cidOf(sh5.id)).toBe(cS.id) // single-company vendor keeps the unambiguous stamp
    expect(await cidOf(sh6.id)).toBe(null) // dangling branch → manual
    expect(await cidOf(hol1.id)).toBe(cMB.id)
    expect(await cidOf(hol2.id)).toBe(null)
    expect(await cidOf(hol3.id)).toBe(null)
    expect(await cidOf(hol4.id)).toBe(cS.id)
    // --- R-TSK: assignee anchor + class B
    expect(await cidOf(t1.id)).toBe(cMB.id)
    expect(await cidOf(t2.id)).toBe(null) // preserved class B
    expect(await cidOf(t3.id)).toBe(null) // default-stamp reset to NULL (class B)
    expect(await cidOf(t4.id)).toBe(null) // dead anchor (NULL-company employee)
    expect(await cidOf(t5.id)).toBe(null) // class B even for a single-company vendor (documented decision)
    // --- R-APA
    expect(await cidOf(apa1.id)).toBe(cMB.id)
    expect(await cidOf(apa2.id)).toBe(cMB.id)
    expect(await cidOf(apa3.id)).toBe(null) // multi-company ALL_EMPLOYEES → kept NULL + manual
    expect(await cidOf(apa4.id)).toBe(cS.id) // single-company → unambiguous
    expect(await cidOf(apa5.id)).toBe(cMB.id)
    expect(await cidOf(apa6.id)).toBe(null) // dangling scope → manual
    // --- R-WFS: NULL-fallback workflows seeded with copied steps
    const nullLeave = await db.approvalWorkflow.findFirst({ where: { vendorId: vM.id, processType: "LEAVE", companyId: null } })
    expect(nullLeave).toBeTruthy()
    const steps = await db.approvalStep.findMany({ where: { workflowId: nullLeave!.id }, orderBy: { sequence: "asc" } })
    expect(steps.map((s: any) => s.name)).toEqual(["M3a step 1", "M3a step 2"])
    const nullPurchase = await db.approvalWorkflow.findFirst({ where: { vendorId: vS.id, processType: "PURCHASE", companyId: null } })
    expect(nullPurchase).toBeTruthy()
    expect(await db.approvalStep.count({ where: { workflowId: nullPurchase!.id } })).toBe(1)
    expect(await db.approvalWorkflow.count({ where: { vendorId: vM.id, processType: "LOAN", companyId: null } })).toBe(1) // pre-existing → untouched
    expect(await db.approvalWorkflow.count({ where: { vendorId: vM.id, processType: "EXPENSE", companyId: null } })).toBe(2) // double-NULL → manual, never merged
    // --- journal integrity: every changed row has an UPDATE entry; old_value == pre-state
    const journal: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE run_id = $1 AND dry_run = false`, out.runId)
    const byTarget = new Map(journal.map((e) => [`${e.target_table}:${e.target_id}`, e]))
    for (const id of [sh1.id, sh3.id, sh4.id, hol1.id, hol3.id, t1.id, t3.id, t5.id, apa1.id, apa2.id, apa4.id, apa5.id, jPayroll.id, jLoanDisb.id, jLoanRec.id, jAdvPay.id, jExpense.id, jSettle.id, ar1.id]) {
      const e = byTarget.get(`${TABLE_OF[id]}:${id}`)
      expect(e, `journal entry missing for ${TABLE_OF[id]}:${id}`).toBeTruthy()
      expect(e.old_value).toBe(CID[id]) // old_value == the pre-repair value
    }
    // --- manual lists: the ambiguous population never resolves silently
    const manualIds = new Set(out.manual.map((m) => m.id))
    for (const id of [jVoucher.id, jDeadRef.id, jEmpNullAnchor.id, ar2.id, sh6.id, apa6.id]) expect(manualIds.has(id)).toBe(true)
    expect(out.manual.some((m) => m.table === "ApprovalWorkflow" && m.reason.includes("multiple NULL-fallback"))).toBe(true)
    expect(out.manual.some((m) => m.table === "AttendancePolicyAssignment" && m.reason.includes("ALL_EMPLOYEES on a multi-company"))).toBe(true)
    expect(out.manual.some((m) => m.table === "Task" && m.id === t2.id)).toBe(true)
    expect(out.manual.some((m) => m.table === "Task" && m.id === t4.id)).toBe(true)
    expect(out.manual.some((m) => m.table === "User" && m.reason.includes("no active company"))).toBe(true)
  })

  test("C · idempotency — a full re-run is a no-op with no duplicate journal entries", async () => {
    const before: any[] = await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM _mc_backfill_journal WHERE dry_run = false`)
    const accessRowsBefore = await db.userCompanyAccess.count()
    const wfNullBefore = await db.approvalWorkflow.count({ where: { companyId: null } })
    const snap: Record<string, any> = {}
    for (const [row] of tracked) snap[row.id] = await cidOf(row.id)
    const out = await runBackfill({ confirm: true })
    for (const [phase, c] of Object.entries(out.counts) as [string, any][]) {
      if (phase === "R-ROL") continue
      expect(c.changed ?? 0, `${phase} changed on re-run`).toBe(0)
      expect(c.inserted ?? 0, `${phase} inserted on re-run`).toBe(0)
    }
    for (const [row] of tracked) expect(await cidOf(row.id)).toBe(snap[row.id])
    expect(await db.userCompanyAccess.count()).toBe(accessRowsBefore)
    expect(await db.approvalWorkflow.count({ where: { companyId: null } })).toBe(wfNullBefore)
    const after: any[] = await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM _mc_backfill_journal WHERE dry_run = false`)
    expect(after[0].n).toBe(before[0].n) // no new UPDATE entries for no-op rows
  })

  test("D · vendor/company isolation — vendor M repairs never touch vendors S/N", async () => {
    expect(await cidOf(sh5.id)).toBe(cS.id)
    expect(await cidOf(hol4.id)).toBe(cS.id)
    expect(await cidOf(t5.id)).toBe(null) // vS's own class B decision, never a vM stamp
    expect(await cidOf(apa4.id)).toBe(cS.id)
    const rows4 = await db.userCompanyAccess.findMany({ where: { userId: uOrp4.id } })
    expect(rows4.every((r: any) => r.vendorId === vN.id)).toBe(true)
    const rows1 = await db.userCompanyAccess.findMany({ where: { userId: uOrp1.id } })
    expect(rows1.every((r: any) => r.vendorId === vM.id && r.companyId === cMB.id)).toBe(true)
  })

  test("E · --reset-roles: C4/C5 always, C2/C3 unless --deliberate; journaled + reversible", async () => {
    const out = await runBackfill({ confirm: true, resetRoles: true, deliberate: [c2Row.id] })
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: c2Row.id } })).role).toBe("PAYROLL_OFFICER") // deliberate → KEPT
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: c3Row.id } })).role).toBe("HR_ADMIN") // C3 reset (not deliberate)
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: c4Row.id } })).role).toBe("HR_ADMIN") // C4 mandatory
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: c5Row.id } })).role).toBe("HR_ADMIN") // C5 mandatory
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: c1Row.id } })).role).toBe("HR_ADMIN") // C1 untouched
    const j: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE run_id = $1 AND phase = 'R-ROL'`, out.runId)
    // the reset is deployment-wide (shared database, parallel files), so the
    // exact-count assertion is scoped to THIS suite's access rows: c3 + c4 +
    // c5 were reset (c2 kept via --deliberate, c1 untouched).
    const mineRows = new Set([c1Row.id, c2Row.id, c3Row.id, c4Row.id, c5Row.id, deltaRow.id])
    const jMine = j.filter((e) => mineRows.has(e.target_id))
    expect(jMine).toHaveLength(3) // c3 + c4 + c5 (c2 kept, c1 untouched)
    expect(jMine.every((e) => e.old_value && e.new_value === "HR_ADMIN")).toBe(true)
    // the delta row (deliberate grants) is REPORTED, never rewritten by the reset
    expect((await db.userCompanyAccess.findFirstOrThrow({ where: { id: deltaRow.id } })).permissions).toBe("[\"employees.view\"]")
  })

  test("F · report hard gate: zero unreviewed C2–C5 after reset + sign-off", async () => {
    const mine = (r: any) => r.vendorId === vM.id || r.vendorId === vS.id || r.vendorId === vN.id
    const noSignoff = await buildReport({})
    expect(noSignoff.sections.roleCohort.rows.filter((r: any) => mine(r) && r.unreviewed && r.signoffDeliberate == null)).toHaveLength(1) // the kept C2 row (deliberate but unsigned in THIS run)
    expect(noSignoff.hardGate.status).toContain("OPEN")
    const signed = await buildReport({ deliberate: [c2Row.id] })
    expect(signed.sections.roleCohort.rows.filter((r: any) => mine(r) && r.unreviewed && r.signoffDeliberate == null)).toHaveLength(0)
    expect(signed.sections.roleCohort.invalidSignoffs).toHaveLength(0) // a valid sign-off list — the gate cannot be manufactured by an invalid one
    expect(signed.hardGate.status).toContain("PASS")
    // an INVALID sign-off (a C4/C5 id — mandatory resets are never sign-off-able)
    // keeps the gate OPEN even when every row is otherwise accounted for
    const bogus = await buildReport({ deliberate: [c2Row.id, "totally-unknown-access-id"] })
    expect(bogus.sections.roleCohort.invalidSignoffs).toHaveLength(1)
    expect(bogus.hardGate.status).toContain("OPEN")
    // post-reset the C4 row re-categorizes to C1 (identical by construction)
    const c4post = signed.sections.roleCohort.rows.find((r: any) => r.email === c4U.email)
    expect(c4post.category).toBe("C1")
    expect(c4post.additions).toHaveLength(0)
    expect(c4post.removals).toHaveLength(0)
  })

  test("G · read-only sections never merge or delete duplicates; registers stay complete", async () => {
    const rep = await buildReport({})
    expect(rep.sections.duplicateSurvey.some((d: any) => d.table === "Branch" && d.vendorId === vM.id && d.count === 2)).toBe(true)
    expect(await db.branch.count({ where: { vendorId: vM.id, code: "M3ADUP" } })).toBe(2) // never deleted/merged
    expect(rep.sections.deltaRegister.some((d: any) => d.email === deltaU.email)).toBe(true)
    expect(rep.sections.wildcards.some((w: any) => w.email === wildU.email)).toBe(true)
    expect(rep.sections.singleCompanyVendors.some((s: any) => s.vendorId === vS.id)).toBe(true)
    expect(rep.sections.journal.journal.length).toBeGreaterThan(0)
    expect(rep.sections.journal.runs.some((r: any) => r.status === "completed")).toBe(true) // F-06: run records distinguish statuses
    // post-repair: only uOrp4 remains row-less among THIS suite's vendors
    // (vendor N has no active company — the documented no-row behavior;
    // auto-repair cannot invent a company). The orphan register is
    // deployment-wide (shared database, parallel files), so scope to the
    // fixture vendors — same discipline as test F's `mine()` filter.
    const myVendors = new Set([vM.id, vS.id, vN.id])
    const myOrphans = rep.sections.orphanUsers.filter((o: any) => myVendors.has(o.vendorId))
    expect(myOrphans).toHaveLength(1)
    expect(myOrphans[0].email).toBe(uOrp4.email)
    expect(rep.sections.classA.some((c: any) => c.id === sh2.id)).toBe(true) // preserved rows stay listed until the operator decides
  })

  test("H · --restore reverts the journaled run; access rows deleted; workflow inserts manual", async () => {
    const { restoreRun } = await import("../../scripts/mc-backfill-core.mjs")
    expect(runIdB).toBeTruthy() // test B's run — restore targets the exact run
    const rep: any = await restoreRun(runIdB!)
    expect(rep.reverted).toBeGreaterThan(0)
    expect(rep.diverged).toHaveLength(0) // nothing diverged since the run
    expect(rep.alreadyReverted).toBe(0) // first restore — everything reverts cleanly
    // UPDATEs back to the pre-state
    expect(await cidOf(sh1.id)).toBe(null)
    expect(await cidOf(sh3.id)).toBe(cMA.id)
    expect(await cidOf(sh4.id)).toBe(cMA.id)
    expect(await cidOf(jPayroll.id)).toBe(null)
    expect(await cidOf(ar1.id)).toBe(null)
    expect(await cidOf(t3.id)).toBe(cMA.id)
    expect(await cidOf(apa4.id)).toBe(null)
    // script-created access rows deleted (derived grants — reconstructible)
    expect(await db.userCompanyAccess.count({ where: { userId: uOrp1.id } })).toBe(0)
    expect(await db.userCompanyAccess.count({ where: { userId: uOrp5.id } })).toBe(0)
    // R-WFS inserts listed for MANUAL removal — business records are never auto-deleted
    expect(rep.manualRemoval.some((m: any) => m.table === "ApprovalWorkflow")).toBe(true)
    const nullLeave2 = await db.approvalWorkflow.findFirst({ where: { vendorId: vM.id, processType: "LEAVE", companyId: null } })
    expect(nullLeave2).toBeTruthy() // still present until the operator removes it
    // F-05: the run record is marked restored, and the restore is journaled
    const runRow: any[] = await db.$queryRawUnsafe(`SELECT status FROM _mc_backfill_runs WHERE run_id = $1`, runIdB)
    expect(runRow[0].status).toBe("restored")
    const restoreEntries: any[] = await db.$queryRawUnsafe(`SELECT * FROM _mc_backfill_journal WHERE run_id = $1 AND phase = 'RESTORE'`, runIdB)
    expect(restoreEntries.length).toBeGreaterThan(0)
  })
})
