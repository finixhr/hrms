/// <reference types="bun-types" />
// ============ BC regression: bonus Policy Rules save + Workforce Eligibility Auditor ============
// Reported bug: "The bonus Policy Rules couldn't be saved." The Bonus
// Eligibility Rules dialog in the Bonuses & Commission workspace saved through
// the generic settings.save route, which demands settings.edit — a permission
// bonus managers never carry (the dialog was reachable with settings.view /
// bonus.view). Every save died with
// "Permission denied: settings.edit is not granted to your role".
//
// Fix under test (BC-FIX):
//   1. bonuses.savePolicy — dedicated route scoped to the bonusPolicy group,
//      gated on bonus.edit OR settings.edit (RBAC-105 alt-perm convention).
//   2. bonuses.eligibilityAudit — server-side workforce evaluation. The old
//      client-side evaluation ran over the directory refList
//      (id/code/fullName/status ONLY): joiningDate and employmentType were
//      never present, so tenure always read "0 mo(s)" and every employee
//      showed INELIGIBLE; the notice-period exclusion compared Employee.status
//      to "NOTICE_PERIOD" — a value that only exists on the Resignation
//      record, so it never fired either.
//   3. minServiceMonths = 0 (immediate eligibility) survives the save — the
//      old Number(x) || 6 coercion silently rewrote 0 → 6.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { getRoute } from "@/hrm-server/routes/router"

const R = (a: string) => getRoute(a)!

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

let vendorId: string
let bonusManagerToken: string // bonus.view + bonus.edit, NO settings.* at all
let viewerToken: string // bonus.view only
let adminToken: string // full tenant admin (settings.edit)

beforeAll(async () => {
  const vendor = await mkVendor("BC Bonus Policy Vendor")
  vendorId = vendor.id
  const manager = await mkUser(vendor.id, { role: "HR_MANAGER", name: "Bonus Manager", permissions: ["bonus.view", "bonus.edit", "employees.view"] })
  bonusManagerToken = await mkSession(manager.id)
  const viewer = await mkUser(vendor.id, { role: "HR_MANAGER", name: "Bonus Viewer", permissions: ["bonus.view"] })
  viewerToken = await mkSession(viewer.id)
  const admin = await mkUser(vendor.id, { role: "HR_ADMIN", name: "BC Admin" })
  adminToken = await mkSession(admin.id)
})

// ---------------------------------------------------------------------------
describe("BC-1 — bonus manager can save Policy Rules (the reported 403)", () => {
  test("bonuses.savePolicy succeeds for a bonus.edit holder without settings.edit", async () => {
    const res = await postHrm("bonuses.savePolicy", {
      group: "bonusPolicy",
      values: {
        minServiceMonths: 3, allowProbation: true, allowContract: false,
        festivalBasis: "GROSS", festivalPercent: 70, festivalsPerYear: 2,
        prorateFirstYear: true, performanceBasis: "BASIC", autoExcludeNoticePeriod: true,
      },
    }, { bearer: bonusManagerToken })
    expect(res.status).toBe(200) // ← the reported bug: this used to 403 via settings.save
    expect(res.body.ok).toBe(true)

    const get = await postHrm("settings.get", {}, { bearer: adminToken })
    const policy = get.body.data.bonusPolicy
    expect(policy.minServiceMonths).toBe(3)
    expect(policy.festivalBasis).toBe("GROSS")
    expect(policy.festivalPercent).toBe(70)
    expect(policy.allowProbation).toBe(true)
    expect(policy.allowContract).toBe(false)
  })

  test("the OLD path still (correctly) denies the bonus manager — proves the root cause", async () => {
    const res = await postHrm("settings.save", {
      group: "bonusPolicy",
      values: { minServiceMonths: 12 },
    }, { bearer: bonusManagerToken })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("settings.edit")
  })

  test("a bonus.edit holder still cannot touch OTHER settings groups through the new route", async () => {
    const res = await postHrm("bonuses.savePolicy", {
      group: "general",
      values: { legalName: "Evil Co" },
    }, { bearer: bonusManagerToken })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain("bonusPolicy")
  })

  test("view-only users cannot save; settings.edit holders still can", async () => {
    const denied = await postHrm("bonuses.savePolicy", {
      group: "bonusPolicy",
      values: { minServiceMonths: 6 },
    }, { bearer: viewerToken })
    expect(denied.status).toBe(403)

    const allowed = await postHrm("bonuses.savePolicy", {
      group: "bonusPolicy",
      values: { minServiceMonths: 6 },
    }, { bearer: adminToken })
    expect(allowed.status).toBe(200)
    expect(allowed.body.ok).toBe(true)
  })

  test("minServiceMonths = 0 (immediate eligibility) survives — no 0→6 rewrite", async () => {
    const res = await postHrm("bonuses.savePolicy", {
      group: "bonusPolicy",
      values: { minServiceMonths: 0, minServiceDays: 0 },
    }, { bearer: adminToken })
    expect(res.status).toBe(200)
    const get = await postHrm("settings.get", {}, { bearer: adminToken })
    expect(get.body.data.bonusPolicy.minServiceMonths).toBe(0)
    // minServiceDays derives from the month threshold when unsent
    expect(get.body.data.bonusPolicy.minServiceDays).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe("BC-2 — Workforce Eligibility Auditor evaluates real data", () => {
  test("joiningDate / employmentType / noticePeriod drive the evaluation", async () => {
    // reset policy to a known state for the assertions
    await R("bonuses.savePolicy").handler(makeCtx(await mkUser(vendorId, { role: "HR_ADMIN" }), ["settings.edit"]), {
      values: { minServiceMonths: 6, allowProbation: false, allowContract: false, autoExcludeNoticePeriod: true },
    })

    const senior = await mkEmployee(vendorId, { fullName: "BC Senior", code: "BC-001" })
    await db.employee.update({ where: { id: senior.id }, data: { joiningDate: isoDaysAgo(365 * 2) } }) // 2y tenure

    const fresh = await mkEmployee(vendorId, { fullName: "BC Fresh", code: "BC-002" })
    await db.employee.update({ where: { id: fresh.id }, data: { joiningDate: isoDaysAgo(20) } }) // 20d tenure

    const probationer = await mkEmployee(vendorId, { fullName: "BC Probation", code: "BC-003" })
    await db.employee.update({ where: { id: probationer.id }, data: { joiningDate: isoDaysAgo(400), status: "PROBATION" } })

    const contractor = await mkEmployee(vendorId, { fullName: "BC Contractor", code: "BC-004" })
    await db.employee.update({ where: { id: contractor.id }, data: { joiningDate: isoDaysAgo(400), employmentType: "CONTRACTUAL" } })

    const leaving = await mkEmployee(vendorId, { fullName: "BC Leaving", code: "BC-005" })
    await db.employee.update({ where: { id: leaving.id }, data: { joiningDate: isoDaysAgo(365 * 3) } })
    await db.resignation.create({
      data: {
        vendorId, employeeId: leaving.id,
        submissionDate: isoDaysAgo(10), resignationDate: isoDaysAgo(10), proposedLwd: isoDaysAgo(-20),
        reason: "Moving on", status: "NOTICE_PERIOD",
      },
    })

    const out: any = await R("bonuses.eligibilityAudit").handler(
      makeCtx(await mkUser(vendorId, { role: "HR_ADMIN" }), ["bonus.view"]),
      {},
    )
    const rows = out.employees.filter((e: any) => String(e.code).startsWith("BC-"))
    const by = (code: string) => rows.find((e: any) => e.code === code)

    // the auditor carries the fields the old refList never did
    expect(by("BC-001").joiningDate).toBeTruthy()
    expect(by("BC-001").employmentType).toBeTruthy()

    // 2y tenure ACTIVE → eligible (the old bug: everyone read 0 months → ineligible)
    expect(by("BC-001").eval.eligible).toBe(true)
    expect(by("BC-001").eval.tenureMonths).toBeGreaterThanOrEqual(23)
    expect(by("BC-001").noticePeriod).toBe(false)

    // 20d tenure → ineligible on service duration
    expect(by("BC-002").eval.eligible).toBe(false)
    expect(by("BC-002").eval.reason).toContain("Service duration")

    // probation excluded by policy
    expect(by("BC-003").eval.eligible).toBe(false)
    expect(by("BC-003").eval.reason).toContain("Probationary")

    // contractual excluded by policy
    expect(by("BC-004").eval.eligible).toBe(false)
    expect(by("BC-004").eval.reason).toContain("Contractual")

    // notice period — the flag the old emp.status === "NOTICE_PERIOD" check
    // could never see (it only exists on the Resignation row)
    expect(by("BC-005").noticePeriod).toBe(true)
    expect(by("BC-005").eval.eligible).toBe(false)
    expect(by("BC-005").eval.reason).toContain("notice period")

    // response contract: policy echo + audit timestamp
    expect(out.policy.minServiceMonths).toBe(6)
    expect(typeof out.auditedAt).toBe("string")
  })

  test("allowProbation / allowContract / autoExcludeNoticePeriod flips re-evaluate", async () => {
    await R("bonuses.savePolicy").handler(makeCtx(await mkUser(vendorId, { role: "HR_ADMIN" }), ["settings.edit"]), {
      values: { minServiceMonths: 6, allowProbation: true, allowContract: true, autoExcludeNoticePeriod: false },
    })
    const out: any = await R("bonuses.eligibilityAudit").handler(
      makeCtx(await mkUser(vendorId, { role: "HR_ADMIN" }), ["bonus.view"]),
      {},
    )
    const rows = out.employees.filter((e: any) => String(e.code).startsWith("BC-"))
    const by = (code: string) => rows.find((e: any) => e.code === code)
    expect(by("BC-003").eval.eligible).toBe(true) // probation now allowed
    expect(by("BC-004").eval.eligible).toBe(true) // contractual now allowed
    expect(by("BC-005").eval.eligible).toBe(true) // notice-period exclusion off

    // BC-FIX (evaluation side): minServiceMonths = 0 = immediate eligibility —
    // the old `Number(x) || 6` in the EVALUATOR rewrote 0 → 6 even when the
    // save path had stored it correctly, so the day-one joiner stayed
    // ineligible. 0 must survive end-to-end.
    await R("bonuses.savePolicy").handler(makeCtx(await mkUser(vendorId, { role: "HR_ADMIN" }), ["settings.edit"]), {
      values: { minServiceMonths: 0, allowProbation: false, allowContract: false, autoExcludeNoticePeriod: true },
    })
    const zeroOut: any = await R("bonuses.eligibilityAudit").handler(
      makeCtx(await mkUser(vendorId, { role: "HR_ADMIN" }), ["bonus.view"]),
      {},
    )
    const zeroRows = zeroOut.employees.filter((e: any) => String(e.code).startsWith("BC-"))
    const zeroBy = (code: string) => zeroRows.find((e: any) => e.code === code)
    expect(zeroBy("BC-002").eval.eligible).toBe(true) // 20d joiner now eligible
    expect(zeroBy("BC-005").eval.eligible).toBe(false) // notice period still excluded

    // restore defaults for other suites
    await R("bonuses.savePolicy").handler(makeCtx(await mkUser(vendorId, { role: "HR_ADMIN" }), ["settings.edit"]), {
      values: { minServiceMonths: 6, allowProbation: false, allowContract: true, autoExcludeNoticePeriod: true },
    })
  })
})

// ---------------------------------------------------------------------------
describe("BC-3 — the auditor endpoint is permission-gated at the dispatcher", () => {
  test("bonus.view alone can read the audit", async () => {
    const res = await postHrm("bonuses.eligibilityAudit", {}, { bearer: viewerToken })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(Array.isArray(res.body.data.employees)).toBe(true)
  })
})
