/// <reference types="bun-types" />
// ============ FIN-016/017 (Phase 2) — field-force location integrity + review queue ============
// The audit's finding: the visit route consulted NO anti-spoofing signals —
// any client posting the location's coordinates (or any coordinates + a
// 1-char note) checked in "successfully" from anywhere. Now the SAME
// analyzeLocationIntegrity pipeline as attendance geo punches runs on visit
// check-ins, and flagged visits surface in fieldforce.visits.flagged.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { DEFAULT_TRACKING_CONFIG, DEFAULT_ATTENDANCE_METHOD_CONFIG, trackingConfig, attendanceMethodConfig } from "@/hrm-server/attendance-policy"

let v: any
let ownerToken: string
let emp: any
let loc: any

beforeAll(async () => {
  v = await mkVendor(uniq("fin0216"))
  const owner = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-016 Owner" })
  ownerToken = await mkSession(owner.id)
  emp = await mkEmployee(v.id, { fullName: "FIN-016 Field Rep" })
  // visit check-ins are self-scoped: the acting user needs the linked profile
  await db.user.update({ where: { id: owner.id }, data: { employeeId: emp.id } })
  // an active visit location around Dhaka with a 150m radius
  loc = await db.visitLocation.create({
    data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: uniq("FIN-016 Client Site"), lat: 23.7925, lng: 90.4078, radiusM: 150, active: true },
  })
})

// ---------------------------------------------------------------- FIN-017 ---
describe("FIN-017 — hardened spoof-policy defaults", () => {
  test("the default suspiciousAction is now REJECT (hard fraud signals block)", () => {
    expect(DEFAULT_TRACKING_CONFIG.suspiciousAction).toBe("REJECT")
    expect(trackingConfig(null).suspiciousAction).toBe("REJECT")
    // explicit REVIEW is still available for lenient tenants
    expect(trackingConfig({ suspiciousAction: "REVIEW" }).suspiciousAction).toBe("REVIEW")
  })
  test("the default device binding is ADVISORY (foreign devices flag, don't vanish)", () => {
    expect(DEFAULT_ATTENDANCE_METHOD_CONFIG.deviceBinding).toBe("ADVISORY")
    expect(attendanceMethodConfig(null).deviceBinding).toBe("ADVISORY")
    expect(attendanceMethodConfig({ deviceBinding: "STRICT" }).deviceBinding).toBe("STRICT")
  })
})

// ---------------------------------------------------------------- FIN-016 ---
describe("FIN-016 — visit check-in runs the location-integrity pipeline", () => {
  test("a client-declared MOCK LOCATION check-in is REJECTED under the default policy", async () => {
    const r = await postHrm("fieldforce.visit.checkin", {
      locationId: loc.id, lat: 23.7925, lng: 90.4078, isMockLocation: true,
    }, { bearer: ownerToken })
    expect(r.status).toBe(400)
    expect(String(r.body.error || "")).toContain("integrity")
    // nothing landed
    expect(await db.visit.count({ where: { vendorId: v.id } })).toBe(0)
  })

  test("a clean in-radius check-in passes with verdict VERIFIED on the response", async () => {
    const r = await postHrm("fieldforce.visit.checkin", {
      locationId: loc.id, lat: 23.7925, lng: 90.4078, accuracy: 20,
    }, { bearer: ownerToken })
    expect(r.status).toBe(200)
    expect(r.body.data.integrity.status).toBe("VERIFIED")
    expect(r.body.data.integrity.decision).toBe("ALLOW")
    expect(r.body.data.visit.remarks).toBeNull()
    // close it so the next test can check in again
    await postHrm("fieldforce.visit.checkout", { visitId: r.body.data.visit.id, lat: 23.7925, lng: 90.4078 }, { bearer: ownerToken })
  })

  test("a REVIEW-policy tenant lands mock-location visits durably flagged (remarks + queue)", async () => {
    // switch the tenant's tracking policy to REVIEW (lenient) — the verdict
    // must then FLAG instead of reject
    const save = await postHrm("settings.save", {
      group: "tracking",
      values: { suspiciousAction: "REVIEW", maxAccuracyM: 150 },
    }, { bearer: ownerToken })
    expect(save.status).toBe(200)

    const r = await postHrm("fieldforce.visit.checkin", {
      locationId: loc.id, lat: 23.7925, lng: 90.4078, isMockLocation: true, remarks: "client meeting",
    }, { bearer: ownerToken })
    expect(r.status).toBe(200)
    expect(r.body.data.integrity.status).toBe("MOCK_LOCATION")
    expect(r.body.data.integrity.decision).toBe("REVIEW")
    expect(String(r.body.data.visit.remarks)).toContain("[INTEGRITY MOCK_LOCATION]")

    // the flagged queue surfaces it with the parsed verdict
    const q = await postHrm("fieldforce.visits.flagged", {}, { bearer: ownerToken })
    expect(q.status).toBe(200)
    expect(q.body.data.summary.integrity).toBe(1)
    expect(q.body.data.rows[0].integrityStatus).toBe("MOCK_LOCATION")
    expect(q.body.data.rows[0].employeeName).toBe("FIN-016 Field Rep")
    // close the flagged visit so later check-ins are not blocked by the
    // one-open-visit rule
    await postHrm("fieldforce.visit.checkout", { visitId: r.body.data.visit.id, lat: 23.7925, lng: 90.4078 }, { bearer: ownerToken })
    // restore the hardened default for later suites
    await postHrm("settings.save", { group: "tracking", values: { suspiciousAction: "REJECT" } }, { bearer: ownerToken })
  })

  test("an out-of-radius check-in with a note lands flagged and joins the review queue", async () => {
    // ~1.1km away from the site center (outside the 150m radius)
    const r = await postHrm("fieldforce.visit.checkin", {
      locationId: loc.id, lat: 23.8025, lng: 90.4078, remarks: "traffic — parked a block away",
    }, { bearer: ownerToken })
    expect(r.status).toBe(200)
    expect(r.body.data.outOfRadius).toBe(true)
    expect(String(r.body.data.visit.remarks)).toContain("[OUT-OF-RADIUS")

    const q = await postHrm("fieldforce.visits.flagged", {}, { bearer: ownerToken })
    expect(q.status).toBe(200)
    const row = (q.body.data.rows as any[]).find((x) => x.id === r.body.data.visit.id)!
    expect(row.outOfRadius).toBe(true)
    expect(row.distanceM!).toBeGreaterThan(150)
    expect(row.radiusM).toBe(150)
    // close it so the branch-scope test below can act
    await postHrm("fieldforce.visit.checkout", { visitId: r.body.data.visit.id, lat: 23.8025, lng: 90.4078 }, { bearer: ownerToken })
  })

  test("out-of-radius WITHOUT a note is still hard-rejected (the strict path survives)", async () => {
    const r = await postHrm("fieldforce.visit.checkin", {
      locationId: loc.id, lat: 23.8125, lng: 90.4078,
    }, { bearer: ownerToken })
    expect(r.status).toBe(400)
    expect(String(r.body.error || "")).toMatch(/radius|from/)
    // nothing landed for this attempt
    expect(await db.visit.count({ where: { vendorId: v.id, remarks: { startsWith: "[OUT-OF-RADIUS 2" } } })).toBe(0)
  })

  test("the flagged queue is branch-scoped for a branch manager (visibility parity)", async () => {
    const branch = await db.branch.create({ data: { companyId: await defaultCompanyId(v.id), vendorId: v.id, name: "FIN-016 Branch", code: uniq("B") } })
    const mgr = await mkUser(v.id, { role: "BRANCH_MANAGER", name: "FIN-016 Mgr", branchId: branch.id })
    const mgrToken = await mkSession(mgr.id)
    const q = await postHrm("fieldforce.visits.flagged", {}, { bearer: mgrToken })
    expect(q.status).toBe(200)
    // the manager's branch has no employees → no rows (the flagged visits
    // belong to the unassigned FIN-016 Field Rep)
    expect(q.body.data.rows.length).toBe(0)
    // while the owner sees them all
    const owner = await postHrm("fieldforce.visits.flagged", {}, { bearer: ownerToken })
    expect((owner.body.data.rows as any[]).length).toBeGreaterThanOrEqual(2)
  })
})
