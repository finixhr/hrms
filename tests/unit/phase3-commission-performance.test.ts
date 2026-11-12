/// <reference types="bun-types" />
// ============ Phase 3 performance regressions (FIN-048 / FIN-049) ============
// FIN-048 — KPI scoring: achievement clamped to the configured max (default
//   100%), totalScore normalized by the total CONFIGURED weight (legacy
//   templates drifting off Σweight=100 used to make perfect achievement score
//   40 → rating 2/5), and the overall rating stored at ASSIGNMENT level (the
//   old per-item `rating` field carried the assignment rating on every item —
//   mis-read by downstream analytics).
// FIN-049 — reviews.finalize is a state machine: DRAFT reviews can no longer
//   be finalized directly with performance.approve (the whole review workflow
//   was skippable, notifying the employee of an arbitrary rating nobody had
//   seen); the from-status is recorded in the audit row.
// Driven through the real POST /api/hrm dispatcher.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

describe("FIN-048 — KPI scoring is clamped, normalized and assignment-level", () => {
  async function kpiWorld(weights: number[]) {
    const v = await mkVendor(uniq("fin048"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-048 Owner" })
    const emp = await mkEmployee(v.id, { fullName: "FIN-048 KPI Staff" })
    const token = await mkSession(u.id, "FULL")
    const template = await db.kpiTemplate.create({
      data: { companyId: await defaultCompanyId(v.id),
        vendorId: v.id, name: `Legacy weights ${uniq()}`,
        itemsJson: JSON.stringify(weights.map((w, i) => ({ name: `KPI ${i + 1}`, target: 100, unit: "sales", weight: w }))),
      },
    })
    const assignment = await db.kpiAssignment.create({
      data: {
        vendorId: v.id, employeeId: emp.id, templateId: template.id, periodLabel: "2026-Q4",
        resultsJson: JSON.stringify(weights.map((w, i) => ({ name: `KPI ${i + 1}`, target: 100, unit: "sales", weight: w, actual: null, achievementPct: null, score: null }))),
      },
    })
    return { v, emp, token, assignment }
  }

  test("legacy Σweight=40 with perfect achievement scores 100 (normalized), rating 5, basis recorded", async () => {
    // two KPIs at 20 each — the OLD code: totalScore 40 → rating 2/5 for a
    // perfect quarter.
    const { v, token, assignment } = await kpiWorld([20, 20])
    const r = await postHrm("kpiAssignments.submitResults", {
      id: assignment.id,
      results: { "KPI 1": 100, "KPI 2": 100 },
    }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.totalScore).toBe(100)   // ← was 40
    expect(r.body.data.rating).toBe(5)         // ← was 2
    const row = await db.kpiAssignment.findUnique({ where: { id: assignment.id } })
    expect(row!.totalScore).toBe(100)
    expect(row!.rating).toBe(5)
    expect(JSON.parse(row!.scoreBasisJson!)).toEqual({ totalWeight: 40, achievementMaxPct: 100 })
    // per-item rating field is GONE from resultsJson
    const items = JSON.parse(row!.resultsJson)
    expect(items.every((i: any) => !("rating" in i))).toBe(true)
    // scope check: the audit row exists for this vendor
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "kpiAssignments.submitResults" } })
    expect(auditRow?.summary).toContain("normalized from Σweight 40")
  })

  test("over-achievement clamps at 100% by default (250% actual cannot dominate the score)", async () => {
    const { token, assignment } = await kpiWorld([50, 50])
    const r = await postHrm("kpiAssignments.submitResults", {
      id: assignment.id,
      results: { "KPI 1": 250, "KPI 2": 100 }, // 250% and 100% of target
    }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.totalScore).toBe(100) // clamped: (100 + 100) / 2, not (250+100)/2
    const row = await db.kpiAssignment.findUnique({ where: { id: assignment.id } })
    const items = JSON.parse(row!.resultsJson)
    expect(items[0].achievementPct).toBe(100) // ← was 250
  })

  test("a configurable achievementMaxPct (HrSetting performance.achievementMaxPct) raises the clamp", async () => {
    const { v, token, assignment } = await kpiWorld([50, 50])
    await db.hrSetting.create({ data: { vendorId: v.id, group: "performance", key: "achievementMaxPct", value: "150" } })
    const r = await postHrm("kpiAssignments.submitResults", {
      id: assignment.id,
      results: { "KPI 1": 250, "KPI 2": 100 },
    }, { bearer: token })
    expect(r.status).toBe(200)
    const row = await db.kpiAssignment.findUnique({ where: { id: assignment.id } })
    const items = JSON.parse(row!.resultsJson)
    expect(items[0].achievementPct).toBe(150) // tenant-configured ceiling
    expect(row!.totalScore).toBe(125)         // (150 + 100) / 2
  })

  test("well-formed Σweight=100 templates are unaffected (the normal path)", async () => {
    const { token, assignment } = await kpiWorld([60, 40])
    const r = await postHrm("kpiAssignments.submitResults", {
      id: assignment.id,
      results: { "KPI 1": 90, "KPI 2": 60 },
    }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.totalScore).toBe(78) // 90×0.6 + 60×0.4
    expect(r.body.data.rating).toBe(4)     // 78 ≥ 75 → 4/5
    const row = await db.kpiAssignment.findUnique({ where: { id: assignment.id } })
    expect(row!.scoreBasisJson).toBeNull()  // no basis note when Σweight = 100
  })
})

describe("FIN-049 — reviews.finalize enforces the review state machine", () => {
  async function reviewWorld(status: string) {
    const v = await mkVendor(uniq("fin049"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-049 Owner" })
    const emp = await mkEmployee(v.id, { fullName: "FIN-049 Reviewed Staff" })
    const token = await mkSession(u.id, "FULL")
    const cycle = await db.reviewCycle.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: `Cycle ${uniq()}`, year: 2026, startDate: "2026-01-01", endDate: "2026-12-31" } })
    const review = await db.performanceReview.create({
      data: {
        vendorId: v.id, cycleId: cycle.id, employeeId: emp.id,
        ratingsJson: JSON.stringify(status === "DRAFT" ? {} : { attendance: 4, quality: 5 }),
        overallRating: status === "DRAFT" ? 0 : 4.5,
        status,
      },
    })
    return { v, emp, token, review }
  }

  test("a DRAFT review cannot be finalized directly — the workflow is not skippable", async () => {
    const { v, token, review } = await reviewWorld("DRAFT")
    const r = await postHrm("reviews.finalize", { id: review.id }, { bearer: token })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain("draft review cannot be finalized")
    const row = await db.performanceReview.findUnique({ where: { id: review.id } })
    expect(row!.status).toBe("DRAFT") // untouched
  })

  test("a SUBMITTED review finalizes, and the audit row records the from-status", async () => {
    const { v, token, review } = await reviewWorld("SUBMITTED")
    const r = await postHrm("reviews.finalize", { id: review.id }, { bearer: token })
    expect(r.status).toBe(200)
    expect(r.body.data.finalized).toBe(true)
    const auditRow = await db.auditLog.findFirst({ where: { vendorId: v.id, action: "reviews.finalize" }, orderBy: { createdAt: "desc" } })
    expect(auditRow?.summary).toContain("from SUBMITTED")
    expect(JSON.parse(auditRow!.oldValue || "{}").status).toBe("SUBMITTED")
  })

  test("an ACKNOWLEDGED review finalizes too (the acknowledged path is the ideal one)", async () => {
    const { token, review } = await reviewWorld("ACKNOWLEDGED")
    const r = await postHrm("reviews.finalize", { id: review.id }, { bearer: token })
    expect(r.status).toBe(200)
    const row = await db.performanceReview.findUnique({ where: { id: review.id } })
    expect(row!.status).toBe("FINAL")
  })
})
