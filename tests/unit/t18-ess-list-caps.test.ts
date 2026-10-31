/// <reference types="bun-types" />
// ============ T-18 (2026-10-31) — ess.leave payload bound + ESS list caps ============
// The master plan (P1, T-18): "ess.leave returns the employee's full request
// history unbounded (ESS-07 capped siblings at 200). Solution: take: 200 +
// optional month filter; audit remaining ESS actions for unbounded reads."
//
// What this suite pins:
//   1. BEHAVIORAL — ess.leave's request history is capped at the 200 most
//      recent (newest first), with the OPTIONAL month/year filter narrowing
//      by the leave START date (fromDate prefix — same shape as
//      ess.attendance's month/year params).
//   2. BEHAVIORAL — the substitute queue (requests naming the caller as
//      PENDING substitute) is capped at 200 too.
//   3. BEHAVIORAL — the response shape is UNCHANGED (balances / types /
//      requests / substituteRequests keys) so the web SPA (leave.tsx,
//      ess.tsx) and the mobile app keep working untouched.
//   4. STRUCTURAL — the audit half of T-18: every multi-row findMany LIST
//      read in routes/ess.ts must carry an explicit `take:` bound. The
//      natural bounds (month-prefix filters, findFirst, counts) are
//      allowlisted by line. A new unbounded list read fails this file.
//
// All behavioral tests drive the REAL dispatcher boundary (POST /api/hrm)
// with an EMPLOYEE-role session — the same path production traffic takes.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let emp: { id: string }
let token: string

beforeAll(async () => {
  vendor = await mkVendor("T18 Caps Vendor")
  emp = await mkEmployee(vendor.id, { fullName: "T18 Caps Employee" })
  const user = await mkUser(vendor.id, { role: "EMPLOYEE", name: "T18 Caps Employee", employeeId: emp.id })
  token = await mkSession(user.id, "FULL")
})

afterAll(async () => {
  await db.leaveRequest.deleteMany({ where: { vendorId: vendor.id } })
  await db.employee.deleteMany({ where: { vendorId: vendor.id } })
  await db.user.deleteMany({ where: { vendorId: vendor.id } })
  await db.vendor.deleteMany({ where: { id: vendor.id } }).catch(() => {})
  await db.$disconnect()
})

async function seedRequests(n: number, opts: { fromDate?: string; substituteFor?: string } = {}) {
  const rows = []
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(Date.now() - (n - i) * 60_000) // strictly increasing → deterministic order
    rows.push(await db.leaveRequest.create({
      data: {
        vendorId: vendor.id,
        employeeId: opts.substituteFor ?? emp.id,
        leaveTypeId: "none",
        fromDate: opts.fromDate ?? "2026-01-10",
        toDate: "2026-01-11",
        days: 1,
        reason: `t18-${i}`,
        status: "PENDING",
        ...(opts.substituteFor ? { substituteEmployeeId: emp.id, substituteStatus: "PENDING" } : {}),
        createdAt,
      } as any,
    }))
  }
  return rows
}

describe("T-18 · ess.leave request history is bounded at 200 (newest first)", () => {
  test("230 seeded requests → exactly 200 returned, newest first", async () => {
    const rows = await seedRequests(230)
    const res = await postHrm("ess.leave", {}, { bearer: token })
    expect(res.status).toBe(200)
    const requests = res.body.data.requests as any[]
    expect(requests.length).toBe(200)
    // newest first: the newest 200 of 230 — the oldest 30 are dropped
    const seededNewest = rows.slice(-200).reverse().map((r) => r.id)
    expect(requests.map((r) => r.id)).toEqual(seededNewest)
    // createdAt desc within the returned window
    const times = requests.map((r) => new Date(r.createdAt).getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })
})

describe("T-18 · ess.leave optional month filter (fromDate prefix)", () => {
  test("month+year filters to that month's leave START dates only", async () => {
    await db.leaveRequest.deleteMany({ where: { vendorId: vendor.id } })
    await seedRequests(3, { fromDate: "2026-03-05" })
    await seedRequests(2, { fromDate: "2026-04-05" })
    await seedRequests(1, { fromDate: "2025-03-05" }) // same month, different year

    const march = await postHrm("ess.leave", { month: 3, year: 2026 }, { bearer: token })
    expect(march.status).toBe(200)
    expect((march.body.data.requests as any[]).length).toBe(3)
    expect((march.body.data.requests as any[]).every((r) => r.fromDate.startsWith("2026-03"))).toBe(true)

    const april = await postHrm("ess.leave", { month: 4, year: 2026 }, { bearer: token })
    expect((april.body.data.requests as any[]).length).toBe(2)

    const march25 = await postHrm("ess.leave", { month: 3, year: 2025 }, { bearer: token })
    expect((march25.body.data.requests as any[]).length).toBe(1)

    // no filter → all six (under the cap)
    const all = await postHrm("ess.leave", {}, { bearer: token })
    expect((all.body.data.requests as any[]).length).toBe(6)
  })
})

describe("T-18 · substitute queue is bounded too", () => {
  test("250 PENDING substitute requests → exactly 200 returned", async () => {
    await db.leaveRequest.deleteMany({ where: { vendorId: vendor.id } })
    const other = await mkEmployee(vendor.id, { fullName: "T18 Other Requester" })
    await seedRequests(250, { substituteFor: other.id })

    const res = await postHrm("ess.leave", {}, { bearer: token })
    expect(res.status).toBe(200)
    expect((res.body.data.substituteRequests as any[]).length).toBe(200)
  })
})

describe("T-18 · response shape is unchanged (web + mobile contract)", () => {
  test("ess.leave still returns balances / types / requests / substituteRequests", async () => {
    const res = await postHrm("ess.leave", {}, { bearer: token })
    expect(res.status).toBe(200)
    for (const key of ["balances", "types", "requests", "substituteRequests"]) {
      expect(Array.isArray(res.body.data[key]), `response key "${key}" must stay an array`).toBe(true)
    }
  })
})

describe("T-18 · audit pin — every ESS list read carries an explicit bound", () => {
  // The audit half of the task: the caps on ess.profile docs, ess.loans,
  // ess.performance, ess.documents and ess.myAssets are pinned structurally
  // (same technique as camera-tenant-isolation's scope-comment pin). Every
  // `findMany(` in routes/ess.ts that returns a LIST must declare `take:`.
  // findFirst/count and the month-prefix-bounded ess.attendance/ess.dashboard
  // reads are naturally bounded — allowlisted below.
  test("every findMany in routes/ess.ts is either take-bounded or naturally bounded", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/hrm-server/routes/ess.ts"), "utf8")
    const lines = src.split("\n")

    // Locate each route block so an allowlist entry can name its action.
    const actions: { name: string; start: number }[] = []
    lines.forEach((line, i) => {
      const m = line.match(/^route\("([^"]+)"/)
      if (m) actions.push({ name: m[1], start: i })
    })
    const actionAt = (i: number) => {
      let cur = "(module)"
      for (const a of actions) if (a.start <= i) cur = a.name
      return cur
    }

    // Reads that do NOT need a take: (verified naturally bounded):
    //   ess.attendance / ess.dashboard — month-prefix WHERE (≤ 31 days of rows)
    //   ess.wishes — date-matched today rows only (payload = wishes array)
    //   ess.leave balances — year-scoped (≤ #leave types for that year)
    //   decoration `in:`-set reads — bounded by their CAPPED source sets:
    //     ess.payroll payrollRun (≤ the 60 capped entries),
    //     ess.loans employee names (≤ capped loans + guarantees),
    //     ess.loans loanInstallment (per-loan term schedules of the 100 capped loans),
    //     ess.myAssets asset names (≤ the 200 capped assignments).
    // A future edit that widens one of these sources without its cap fails
    // this same pin (the source line loses its take:).
    const NATURALLY_BOUNDED = new Set([
      "ess.attendance", "ess.dashboard", "ess.wishes",
    ])
    const TRANSITIVELY_BOUNDED_IN_READS = /\bin:\s*[a-zA-Z\[]/

    const violations: string[] = []
    lines.forEach((line, i) => {
      if (!line.includes("findMany(")) return
      const action = actionAt(i)
      if (NATURALLY_BOUNDED.has(action)) return
      // decoration reads over a bounded id set (see classification above)
      if (TRANSITIVELY_BOUNDED_IN_READS.test(line)) return
      // year-scoped balance read (≤ #leave types for the year)
      if (/leaveBalance\.findMany/.test(line) && /year/.test(line)) return
      // multi-row list read inside a bounded action — must carry take:
      if (!/take:\s*\d/.test(line) && !/,\s*take:\s*\d/.test(lines.slice(i, i + 8).join("\n"))) {
        violations.push(`${action} · line ${i + 1}: ${line.trim().slice(0, 90)}`)
      }
    })

    expect(violations, `unbounded ESS list reads:\n  ${violations.join("\n  ")}`).toEqual([])
  })

  test("the caps are the documented values (200 leave/substitutes/assets, 100 the rest)", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/hrm-server/routes/ess.ts"), "utf8")
    expect(src).toContain('route("ess.leave"')
    // leave requests + substitutes + myAssets at 200; profile docs, loans,
    // advances, guarantees, reviews, kpis, cycles, documents, letters at 100;
    // bank accounts at 20; org catalogs at 200 (name decoration)
    const counts = src.match(/take:\s*(\d+)/g) || []
    const values = counts.map((c) => Number(c.replace(/take:\s*/, "")))
    expect(values.filter((v) => v === 200).length).toBeGreaterThanOrEqual(4) // + expenses/tasks pre-existing
    expect(values.every((v) => [20, 30, 60, 100, 200, 1000].includes(v))).toBe(true) // no odd/unbounded-ish value sneaks in
  })
})
