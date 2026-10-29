/// <reference types="bun-types" />
// ============ Phase R7 — Feature Gaps (Product Parity) ============
// ESS-02 self-profile edit · ESS-05 review acknowledgment · ESS-06 My Assets
// LTR-01 letter requests · LTR-02 verification codes · COM-02 read receipts
// EMP-08 probation workflow · EXT-04 printable F&F + exit packet
// EXT-05 rehire linkage · LVE-112 approval SLA/auto-cancel · LVE-113 BD seed
// REC-01 my-interviews + PII scoping · PRF-01 multi-reviewer input
// ATT-017 ATTENDANCE_RULES policy type
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"
import { saveSettingsGroup } from "@/hrm-server/settings"
import { probationEndDate } from "@/hrm-server/utils"

const R = (a: string) => getRoute(a)!

beforeAll(async () => {
  // silence sweep logs
})

// ---------------------------------------------------------------------------
describe("ESS-02 — whitelisted self-profile edit", () => {
  test("photo, phones, personal email, present address and emergency contact are self-editable; HR-only fields are ignored", async () => {
    const v = await mkVendor("R7 ESS02")
    const me = await mkEmployee(v.id, { fullName: "Ess02 Self" })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const ctx = makeCtx(empUser)
    const out: any = await R("ess.profile.update").handler(ctx, {
      mobile: "01712345678", altMobile: "01812345678", personalEmail: "self@example.com",
      presentAddress: "12 Gulshan Ave", presentCity: "Dhaka",
      emergencyName: "Wife", emergencyRelation: "Spouse", emergencyMobile: "01912345678",
      photoUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==", photoThumb: "data:image/png;base64,iVBOR",
      // smuggled HR-only fields — the whitelist must drop them
      status: "TERMINATED", grossSalary: 999999, officialEmail: "hack@evil.com", branchId: "x",
    })
    expect(out.ok).toBe(true)
    expect(out.updated).toContain("mobile")
    expect(out.updated).toContain("photo")
    const row = await db.employee.findUniqueOrThrow({ where: { id: me.id } })
    expect(row.mobile).toBe("01712345678")
    expect(row.personalEmail).toBe("self@example.com")
    expect(row.presentAddress).toBe("12 Gulshan Ave")
    expect(row.emergencyName).toBe("Wife")
    expect(row.photoUrl).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")
    // smuggled fields untouched
    expect(row.status).toBe("ACTIVE")
    expect(row.officialEmail).toBeNull()
  })

  test("bad phone/email shapes and oversize photos are rejected", async () => {
    const v = await mkVendor("R7 ESS02 invalid")
    const me = await mkEmployee(v.id)
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const ctx = makeCtx(empUser)
    await expect(R("ess.profile.update").handler(ctx, { mobile: "not a phone!!!" })).rejects.toThrow(/Mobile number format/)
    await expect(R("ess.profile.update").handler(ctx, { personalEmail: "nope" })).rejects.toThrow(/Personal email format/)
    await expect(R("ess.profile.update").handler(ctx, { photoUrl: "javascript:alert(1)" })).rejects.toThrow(/photoUrl/)
    await expect(R("ess.profile.update").handler(ctx, { photoUrl: "x".repeat(2_000_001) })).rejects.toThrow(/Photo too large/)
  })
})

// ---------------------------------------------------------------------------
describe("ESS-05 — review acknowledgment closes the loop", () => {
  test("SUBMITTED → ACKNOWLEDGED with the employee's own comments; DRAFT and FINAL refuse", async () => {
    const v = await mkVendor("R7 ESS05")
    const me = await mkEmployee(v.id, { fullName: "Ess05 Emp" })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const hr = await mkUser(v.id, { role: "HR_ADMIN" })
    const hrCtx = makeCtx(hr, ["performance.create", "employees.view"])
    const cycle = await db.reviewCycle.create({ data: { vendorId: v.id, name: `C ${uniq()}`, year: 2026, startDate: "2026-01-01", endDate: "2026-12-31" } })
    const draft: any = await R("reviews.save").handler(hrCtx, { cycleId: cycle.id, employeeId: me.id, ratings: { attendance: 4 }, status: "DRAFT" })
    const empCtx = makeCtx(empUser)
    // DRAFT invisible + not acknowledgeable
    await expect(R("reviews.acknowledge").handler(empCtx, { id: draft.id })).rejects.toThrow(/not ready/)
    const submitted: any = await R("reviews.save").handler(hrCtx, { cycleId: cycle.id, employeeId: me.id, ratings: { attendance: 4, quality: 5 }, status: "SUBMITTED" })
    // the employee SEES the submitted review now (widened ESS-03 set)
    const perf: any = await R("ess.performance").handler(empCtx, {})
    expect(perf.reviews.some((r: any) => r.id === submitted.id && r.status === "SUBMITTED")).toBe(true)
    expect(perf.reviews.some((r: any) => r.id === draft.id && r.status === "DRAFT")).toBe(false)
    // acknowledge with comments
    const out: any = await R("reviews.acknowledge").handler(empCtx, { id: submitted.id, comments: "Fair assessment — I will work on punctuality" })
    expect(out.acknowledged).toBe(true)
    const row = await db.performanceReview.findUniqueOrThrow({ where: { id: submitted.id } })
    expect(row.status).toBe("ACKNOWLEDGED")
    expect(row.employeeComments).toBe("Fair assessment — I will work on punctuality")
    // FINAL refuses re-acknowledgment
    await R("reviews.finalize").handler(makeCtx(hr, ["performance.approve"]), { id: submitted.id })
    await expect(R("reviews.acknowledge").handler(empCtx, { id: submitted.id })).rejects.toThrow(/already final/)
  })

  test("an employee cannot acknowledge a colleague's review", async () => {
    const v = await mkVendor("R7 ESS05 cross")
    const a = await mkEmployee(v.id, { fullName: "Ess05 A" })
    const b = await mkEmployee(v.id, { fullName: "Ess05 B" })
    const userA = await mkUser(v.id, { role: "EMPLOYEE", employeeId: a.id })
    const hr = await mkUser(v.id, { role: "HR_ADMIN" })
    const cycle = await db.reviewCycle.create({ data: { vendorId: v.id, name: `C ${uniq()}`, year: 2026, startDate: "2026-01-01", endDate: "2026-12-31" } })
    const reviewB: any = await R("reviews.save").handler(makeCtx(hr, ["performance.create", "employees.view"]), { cycleId: cycle.id, employeeId: b.id, ratings: { attendance: 3 }, status: "SUBMITTED" })
    await expect(R("reviews.acknowledge").handler(makeCtx(userA), { id: reviewB.id })).rejects.toThrow(/not found/i)
  })
})

// ---------------------------------------------------------------------------
describe("ESS-06 — My Assets tab surface", () => {
  test("own assignments with outstanding/overdue flags; other employees' assets invisible", async () => {
    const v = await mkVendor("R7 ESS06")
    const me = await mkEmployee(v.id, { fullName: "Ess06 Me" })
    const other = await mkEmployee(v.id, { fullName: "Ess06 Other" })
    const asset = await db.asset.create({ data: { vendorId: v.id, code: uniq("AST"), name: "Dell Latitude 5540", category: "LAPTOP" } })
    await db.assetAssignment.create({ data: { vendorId: v.id, assetId: asset.id, employeeId: me.id, dueAt: new Date(Date.now() - 86_400_000) } })
    await db.assetAssignment.create({ data: { vendorId: v.id, assetId: asset.id, employeeId: other.id } })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const out: any = await R("ess.myAssets").handler(makeCtx(empUser), {})
    expect(out.assignments.length).toBe(1)
    const a = out.assignments[0]
    expect(a.assetName).toBe("Dell Latitude 5540")
    expect(a.outstanding).toBe(true)
    expect(a.overdue).toBe(true) // dueAt in the past
  })
})

// ---------------------------------------------------------------------------
describe("LTR-01 — employee-initiated letter requests", () => {
  test("request → HR approves → draft letter generated (FULFILLED, linked); reject path notifies; duplicate pending guard", async () => {
    const v = await mkVendor("R7 LTR01")
    const me = await mkEmployee(v.id, { fullName: "Ltr01 Emp" })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const empCtx = makeCtx(empUser)
    const hrCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["letters.view", "letters.generate", "employees.view"])
    // an active SALARY_CERT template
    await db.letterTemplate.create({ data: { vendorId: v.id, type: "SALARY_CERT", name: `SC ${uniq()}`, subject: "Salary Certificate", body: "<p>{{employee_name}} earns {{salary}}.</p>", requiresApproval: false, active: true } })

    const req: any = await R("ess.letterRequests").handler(empCtx, { type: "SALARY_CERT", reason: "Home loan application" })
    expect(req.status).toBe("PENDING")
    // duplicate pending guard
    await expect(R("ess.letterRequests").handler(empCtx, { type: "SALARY_CERT" })).rejects.toThrow(/already have a pending/)
    // non-requestable type guard
    await expect(R("ess.letterRequests").handler(empCtx, { type: "TERMINATION" })).rejects.toThrow(/cannot be self-requested/)

    const list = (await R("letters.requests.list").handler(hrCtx, {})) as any[]
    expect(list.some((r) => r.id === req.id && r.employeeName === "Ltr01 Emp")).toBe(true)

    const approved: any = await R("letters.requests.decide").handler(hrCtx, { id: req.id, decision: "APPROVE" })
    expect(approved.status).toBe("FULFILLED")
    expect(approved.letterNumber).toBeTruthy()
    const letter = await db.hrLetter.findUniqueOrThrow({ where: { id: approved.letterId } })
    expect(letter.type).toBe("SALARY_CERT")
    expect(letter.status).toBe("DRAFT") // HR submits/issues it through the normal letters flow
    expect(letter.content).toContain("Ltr01 Emp") // variables RENDERED, not raw
    const row = await db.letterRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(row.letterId).toBe(approved.letterId)
    // ESS list decorates with the letter number
    const mine = (await R("ess.letterRequests").handler(empCtx, {})) as any[]
    expect(mine[0].letterNumber).toBe(approved.letterNumber)

    // reject path
    const req2: any = await R("ess.letterRequests").handler(empCtx, { type: "NOC" })
    const rejected: any = await R("letters.requests.decide").handler(hrCtx, { id: req2.id, decision: "REJECT", note: "Not eligible yet" })
    expect(rejected.status).toBe("REJECTED")
    const row2 = await db.letterRequest.findUniqueOrThrow({ where: { id: req2.id } })
    expect(row2.decisionNote).toBe("Not eligible yet")
  })
})

// ---------------------------------------------------------------------------
describe("LTR-02 — letter verification codes", () => {
  test("issue stamps a stable HMAC code; the code rides the printed HTML; matches are timing-safe", async () => {
    const v = await mkVendor("R7 LTR02")
    const me = await mkEmployee(v.id, { fullName: "Ltr02 Emp" })
    const hrCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["letters.view", "letters.generate", "letters.download", "employees.view"])
    const letter = await db.hrLetter.create({
      data: { vendorId: v.id, employeeId: me.id, type: "EXPERIENCE", letterNumber: `L-2026-${uniq("n")}`, subject: "Experience", content: "<p>Served well.</p>", status: "APPROVED" },
    })
    const out: any = await R("letters.issue").handler(hrCtx, { id: letter.id, deliveryMethod: "PORTAL" })
    expect(out.verificationCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    const row = await db.hrLetter.findUniqueOrThrow({ where: { id: letter.id } })
    expect(row.verificationCode).toBe(out.verificationCode)
    // re-issue of a fresh letter with identical identity derives the same code shape (deterministic HMAC)
    const { letterVerificationCode, letterCodeMatches } = await import("@/hrm-server/routes/letters")
    expect(letterVerificationCode({ vendorId: v.id, id: letter.id, letterNumber: letter.letterNumber })).toBe(out.verificationCode)
    expect(letterCodeMatches(out.verificationCode, out.verificationCode.toLowerCase())).toBe(true)
    expect(letterCodeMatches(out.verificationCode, "0000-0000-0000")).toBe(false)
    expect(letterCodeMatches(null, out.verificationCode)).toBe(false)
    // printed HTML carries the verification footer
    const { buildLetterHtml } = await import("@/hrm-server/routes/letters")
    const html = await buildLetterHtml(v.id, row)
    expect(html).toContain(out.verificationCode)
    expect(html).toContain("Letter Verification")
  })
})

// ---------------------------------------------------------------------------
describe("COM-02 — announcement read receipts", () => {
  test("marking read is idempotent; employees learn readAt; admins get readCount/audienceSize; invisible notices can't be marked", async () => {
    const v = await mkVendor("R7 COM02")
    const branch = await db.branch.create({ data: { vendorId: v.id, name: "COM02 Branch", code: uniq("B") } })
    const inBranch = await mkEmployee(v.id, { fullName: "Com02 In", branchId: branch.id })
    const outsider = await mkEmployee(v.id, { fullName: "Com02 Out" })
    const userIn = await mkUser(v.id, { role: "EMPLOYEE", employeeId: inBranch.id })
    const userOut = await mkUser(v.id, { role: "EMPLOYEE", employeeId: outsider.id })
    const adminCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["announcements.create", "announcements.delete", "employees.view"])
    const a: any = await R("announcements.create").handler(adminCtx, { title: "Town hall Friday", body: "All welcome", audienceType: "BRANCH", audienceIds: [branch.id], pinned: false })
    expect(a.notified).toBe(1)

    // employee feed: unread
    const feedIn = (await R("announcements.list").handler(makeCtx(userIn), {})) as any[]
    expect(feedIn.find((x) => x.id === a.id)?.readAt ?? null).toBeNull()
    // mark read (idempotent)
    await R("announcements.read").handler(makeCtx(userIn), { id: a.id })
    await R("announcements.read").handler(makeCtx(userIn), { id: a.id })
    const feedIn2 = (await R("announcements.list").handler(makeCtx(userIn), {})) as any[]
    expect(feedIn2.find((x) => x.id === a.id)?.readAt).toBeTruthy()
    // audience-size 1 → readCount 1
    const adminFeed = (await R("announcements.list").handler(adminCtx, {})) as any[]
    const adminRow = adminFeed.find((x) => x.id === a.id)
    expect(adminRow.audienceSize).toBe(1)
    expect(adminRow.readCount).toBe(1)
    // an EMPLOYEE outside the audience cannot see or mark it
    const feedOut = (await R("announcements.list").handler(makeCtx(userOut), {})) as any[]
    expect(feedOut.some((x) => x.id === a.id)).toBe(false)
    await expect(R("announcements.read").handler(makeCtx(userOut), { id: a.id })).rejects.toThrow(/not found/i)
  })
})

// ---------------------------------------------------------------------------
describe("PRF-01 — multi-reviewer input (self via ESS + peers recorded by HR)", () => {
  test("self-assessment lands in inputsJson.self without touching the manager's ratings; peer inputs survive edits", async () => {
    const v = await mkVendor("R7 PRF01")
    const me = await mkEmployee(v.id, { fullName: "Prf01 Emp" })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const hrCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["performance.create", "performance.view", "employees.view"])
    const cycle = await db.reviewCycle.create({ data: { vendorId: v.id, name: `C ${uniq()}`, year: 2026, startDate: "2026-01-01", endDate: "2026-12-31" } })
    const review: any = await R("reviews.save").handler(hrCtx, { cycleId: cycle.id, employeeId: me.id, ratings: { attendance: 3, quality: 4 }, status: "SUBMITTED" })

    // self-assessment from ESS
    await R("ess.reviewSelf").handler(makeCtx(empUser), { id: review.id, ratings: { attendance: 4, quality: 5, teamwork: 4 }, comments: "I led the ERP rollout this cycle" })
    let row = await db.performanceReview.findUniqueOrThrow({ where: { id: review.id } })
    expect(row.ratingsJson).toBe(JSON.stringify({ attendance: 3, quality: 4 })) // manager's untouched
    const inputs = JSON.parse((row as any).inputsJson)
    expect(inputs.self.ratings.quality).toBe(5)
    expect(inputs.self.comments).toBe("I led the ERP rollout this cycle")

    // HR records peer input
    await R("reviews.save").handler(hrCtx, {
      cycleId: cycle.id, employeeId: me.id, ratings: { attendance: 3, quality: 4 }, status: "SUBMITTED",
      peerInputs: [
        { name: "Kamal Hossain", ratings: { teamwork: 4, communication: 5 }, comments: "Strong collaborator" },
        { name: "Nusrat Jahan", ratings: { quality: 5 } },
      ],
    })
    row = await db.performanceReview.findUniqueOrThrow({ where: { id: review.id } })
    const inputs2 = JSON.parse((row as any).inputsJson)
    expect(inputs2.peers.length).toBe(2)
    expect(inputs2.peers[0].name).toBe("Kamal Hossain")
    expect(inputs2.self.ratings.teamwork).toBe(4) // self block preserved through HR edits
    // list decoration carries parsed inputs
    const list = (await R("reviews.list").handler(hrCtx, { employeeId: me.id })) as any[]
    const listed = list.find((r) => r.id === review.id)
    expect(listed.inputs.peers.length).toBe(2)
    expect(listed.inputs.self.comments).toContain("ERP rollout")
    // malformed peer input rejected
    await expect(R("reviews.save").handler(hrCtx, { cycleId: cycle.id, employeeId: me.id, ratings: {}, status: "SUBMITTED", peerInputs: [{ ratings: { teamwork: 4 } }] as any })).rejects.toThrow(/colleague name/)
  })
})

// ---------------------------------------------------------------------------
describe("EMP-08 — probation end-of-period workflow", () => {
  test("probationEndDate uses CALENDAR months (the old ×30-day math drifted)", () => {
    expect(probationEndDate("2025-11-30", 3)).toBe("2026-02-28") // 2026 is not a leap year
    expect(probationEndDate("2024-01-31", 1)).toBe("2024-02-29") // leap-year end-of-month clamp
    expect(probationEndDate("2026-01-15", 6)).toBe("2026-07-15")
    expect(probationEndDate(null, 3)).toBeNull()
    expect(probationEndDate("2026-01-15", 0)).toBeNull()
    expect(probationEndDate("2026-01-15", 3, "2026-03-01")).toBeNull() // already confirmed
  })

  test("CONFIRM flips PROBATION → ACTIVE with the confirmation date; EXTEND adds calendar months; non-probation refuses", async () => {
    const v = await mkVendor("R7 EMP08")
    const me = await mkEmployee(v.id, { fullName: "Emp08 Probationer" })
    await db.employee.update({ where: { id: me.id }, data: { status: "PROBATION", probationMonths: 3, joiningDate: "2026-01-01" } })
    const hrCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["employees.edit", "employees.view"])
    const extended: any = await R("employees.probation").handler(hrCtx, { id: me.id, action: "EXTEND", extendMonths: 2, remarks: "Needs improvement on targets" })
    expect(extended.probationMonths).toBe(5)
    expect(extended.probationEndDate).toBe("2026-06-01") // 2026-01-01 + 5 calendar months
    const confirmed: any = await R("employees.probation").handler(hrCtx, { id: me.id, action: "CONFIRM", effectiveDate: "2026-06-10", remarks: "Improved" })
    expect(confirmed.status).toBe("ACTIVE")
    const row = await db.employee.findUniqueOrThrow({ where: { id: me.id } })
    expect(row.confirmationDate).toBe("2026-06-10")
    const history = await db.employeeHistory.findMany({ where: { vendorId: v.id, employeeId: me.id, eventType: "STATUS_CHANGE" } })
    expect(history.some((h) => h.title.includes("extended"))).toBe(true)
    expect(history.some((h) => h.title.includes("confirmed"))).toBe(true)
    // already confirmed → refuse
    await expect(R("employees.probation").handler(hrCtx, { id: me.id, action: "CONFIRM" })).rejects.toThrow(/not on probation/)
  })

  test("the daily sweep notifies HR exactly 7 days before and on the end date", async () => {
    const v = await mkVendor("R7 EMP08 sweep")
    const { probationSweep } = await import("@/hrm-server/jobs")
    await mkEmployee(v.id, { fullName: "Sweep Noise" }) // ACTIVE — never a match
    // end dates: A = 2026-03-10, B = 2026-03-20
    await db.employee.create({ data: { vendorId: v.id, fullName: "Sweep A", code: uniq("E"), status: "PROBATION", joiningDate: "2026-01-10", probationMonths: 2 } })
    await db.employee.create({ data: { vendorId: v.id, fullName: "Sweep B", code: uniq("E"), status: "PROBATION", joiningDate: "2026-01-20", probationMonths: 2 } })
    // 2026-03-03: A is exactly 7 days out; B is 17 → only A notifies
    expect(await probationSweep(v.id, "2026-03-03")).toBe(1)
    // 2026-03-10: A reaches its end date today → exactly one notification
    expect(await probationSweep(v.id, "2026-03-10")).toBe(1)
    // mid-window dates notify nobody
    expect(await probationSweep(v.id, "2026-03-05")).toBe(0)
    expect(await probationSweep(v.id, "2026-03-15")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe("EXT-04 — printable F&F + fixed exit packet", () => {
  test("settlements.html renders the statement for HR and the employee; drafts stay hidden from the employee", async () => {
    const v = await mkVendor("R7 EXT04 fnf")
    const me = await mkEmployee(v.id, { fullName: "Ext04 Emp" })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const hrCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["exit.view", "employees.view"])
    const res = await db.resignation.create({
      data: { vendorId: v.id, employeeId: me.id, submissionDate: "2026-08-01", resignationDate: "2026-08-15", proposedLwd: "2026-09-15", reason: "Relocating", status: "COMPLETED" },
    })
    const draft = await db.finalSettlement.create({ data: { vendorId: v.id, resignationId: res.id, computationJson: JSON.stringify({ finalSalary: 40000, otAmount: 2000, loanDue: 5000, otherDeductions: 0 }), netPayable: 37000, status: "DRAFT" } })
    // employee blocked from the DRAFT
    await expect(R("settlements.html").handler(makeCtx(empUser), { id: draft.id })).rejects.toThrow(/available once it is approved/)
    // approve → both planes render
    await db.finalSettlement.update({ where: { id: draft.id }, data: { status: "APPROVED" } })
    const empOut: any = await R("settlements.html").handler(makeCtx(empUser), { id: draft.id })
    expect(empOut.html).toContain("Full &amp; Final Settlement Statement")
    expect(empOut.html).toContain("Ext04 Emp")
    expect(empOut.html).toContain("40,000")
    expect(empOut.html).toContain("NET PAYABLE")
    expect(empOut.html).toContain("37,000")
    const hrOut: any = await R("settlements.html").handler(hrCtx, { id: draft.id })
    expect(hrOut.html).toContain("37,000")
    // another employee's settlement stays hidden
    const stranger = await mkUser(v.id, { role: "EMPLOYEE", employeeId: (await mkEmployee(v.id, { fullName: "Stranger" })).id })
    await expect(R("settlements.html").handler(makeCtx(stranger), { id: draft.id })).rejects.toThrow(/not found/i)
  })

  test("exitPacket.generate now uses the vocabulary types and renders real content (the old empty-letter bug)", async () => {
    const v = await mkVendor("R7 EXT04 packet")
    const me = await mkEmployee(v.id, { fullName: "Packet Emp" })
    await db.employee.update({ where: { id: me.id }, data: { joiningDate: "2024-03-01" } })
    const hrCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["letters.view", "letters.generate", "employees.view"])
    const res = await db.resignation.create({
      data: { vendorId: v.id, employeeId: me.id, submissionDate: "2026-08-01", resignationDate: "2026-08-15", proposedLwd: "2026-09-15", reason: "New role", status: "ACCEPTED" },
    })
    const out: any = await R("exitPacket.generate").handler(hrCtx, { resignationId: res.id })
    expect(out.letters.length).toBe(3)
    const types = out.letters.map((l: any) => l.type).sort()
    expect(types).toEqual(["EXPERIENCE", "NOC", "RELIEVING"]) // vocabulary types, not the old EXPERIENCE_CERTIFICATE/RELIEVING_LETTER
    for (const l of out.letters) {
      expect(l.html).toContain("Packet Emp") // default bodies render employee_name
      const row = await db.hrLetter.findUniqueOrThrow({ where: { id: l.id } })
      expect(row.content.length).toBeGreaterThan(50) // not the old empty string
      expect(row.status).toBe("APPROVED")
    }
    expect(out.packetHtml).toContain("Packet Emp")
  })
})

// ---------------------------------------------------------------------------
describe("EXT-05 — rehire linkage", () => {
  test("rehireMatches finds former employees by mobile/NID; create links priorEmployeeId; ACTIVE employees can't be linked", async () => {
    const v = await mkVendor("R7 EXT05")
    const former = await db.employee.create({ data: { vendorId: v.id, fullName: "Former Emp", code: uniq("E"), mobile: "01711112222", status: "RESIGNED" } })
    await mkEmployee(v.id, { fullName: "Active Emp" }) // active — never a match
    const hrCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["employees.view", "employees.create"])
    const byMobile: any = await R("employees.rehireMatches").handler(hrCtx, { mobile: "01711112222" })
    expect(byMobile.matches.length).toBe(1)
    expect(byMobile.matches[0].id).toBe(former.id)
    // active employees never surface
    const byActiveMobile: any = await R("employees.rehireMatches").handler(hrCtx, { mobile: "01833334444" })
    expect(byActiveMobile.matches.length).toBe(0)

    // create a rehired employee with the linkage
    const created: any = await R("employees.create").handler(hrCtx, {
      fullName: "Rehired Emp", mobile: "01711113333", officialEmail: `${uniq("rehire")}@t.local`,
      joiningDate: "2026-10-01", priorEmployeeId: former.id,
    })
    const row = await db.employee.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.priorEmployeeId).toBe(former.id)
    // the 360° payload decorates the prior record
    const detail: any = await R("employees.get").handler(hrCtx, { id: created.id })
    expect(detail.priorEmployee?.id).toBe(former.id)
    expect(detail.priorEmployee?.fullName).toBe("Former Emp")
    // linking to an ACTIVE employee is refused
    const active = await db.employee.findFirstOrThrow({ where: { vendorId: v.id, fullName: "Active Emp" } })
    await expect(R("employees.create").handler(hrCtx, {
      fullName: "Bad Link", mobile: "01755556666", officialEmail: `${uniq("bad")}@t.local`,
      priorEmployeeId: active.id,
    })).rejects.toThrow(/former employee/)
  })
})

// ---------------------------------------------------------------------------
describe("LVE-112 — leave approval SLA + auto-cancel sweep", () => {
  test("SLA nudges HR and the requester; auto-cancel releases the reserved balance and cancels the approval request; 0 = off", async () => {
    const v = await mkVendor("R7 LVE112")
    const me = await mkEmployee(v.id, { fullName: "Lve112 Emp" })
    const { leaveSlaSweep } = await import("@/hrm-server/jobs")
    const lt = await db.leaveType.create({ data: { vendorId: v.id, code: `CASUAL-${uniq()}`, name: "Casual", paid: true, defaultDays: 10, active: true } })
    const bal = await db.leaveBalance.create({ data: { vendorId: v.id, employeeId: me.id, leaveTypeId: lt.id, year: 2026, entitled: 10, used: 0, pending: 3, carriedForward: 0 } })
    const ar = await db.approvalRequest.create({ data: { vendorId: v.id, processType: "LEAVE", entityType: "LeaveRequest", entityId: uniq("lr"), entityRef: "L-1", requestedBy: "u1", currentStep: 1, status: "PENDING", payloadJson: "{}", workflowId: "wf1" } as any })
    const req = await db.leaveRequest.create({
      data: { vendorId: v.id, employeeId: me.id, leaveTypeId: lt.id, fromDate: "2026-11-01", toDate: "2026-11-03", days: 3, reason: "Family", status: "PENDING", approvalRequestId: ar.id, createdAt: new Date(Date.now() - 9 * 86_400_000) },
    })

    // both knobs off → no-op
    const none = await leaveSlaSweep(v.id, "2026-10-20", { leave: { approvalSlaDays: 0, autoCancelPendingDays: 0 }, general: { fiscalYearStart: "July" } })
    expect(none).toEqual({ nudged: 0, cancelled: 0 })

    // SLA only → nudge, no cancel
    await db.notification.deleteMany({ where: { vendorId: v.id } })
    const nudged = await leaveSlaSweep(v.id, "2026-10-20", { leave: { approvalSlaDays: 7, autoCancelPendingDays: 0 }, general: { fiscalYearStart: "July" } })
    expect(nudged.nudged).toBe(1)
    expect(nudged.cancelled).toBe(0)
    const reqRow = await db.leaveRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(reqRow.status).toBe("PENDING")

    // auto-cancel window (7) — the 9-day-old request is cancelled
    const cancelled = await leaveSlaSweep(v.id, "2026-10-20", { leave: { approvalSlaDays: 7, autoCancelPendingDays: 7 }, general: { fiscalYearStart: "July" } })
    expect(cancelled.cancelled).toBe(1)
    const after = await db.leaveRequest.findUniqueOrThrow({ where: { id: req.id } })
    expect(after.status).toBe("CANCELLED")
    expect(after.actedBy).toBe("system:sla-sweep")
    const balAfter = await db.leaveBalance.findUniqueOrThrow({ where: { id: bal.id } })
    expect(balAfter.pending).toBe(0) // reserved balance released
    const arAfter = await db.approvalRequest.findUniqueOrThrow({ where: { id: ar.id } })
    expect(arAfter.status).toBe("CANCELLED")
  })
})

// ---------------------------------------------------------------------------
describe("LVE-113 — BD-compliant consecutive-day cap on apply", () => {
  test("a 4-day casual run is rejected at cap 3; 3 days pass; adjacent approved leave stitches into the run", async () => {
    const v = await mkVendor("R7 LVE113")
    const me = await mkEmployee(v.id, { fullName: "Lve113 Emp" })
    await db.employee.update({ where: { id: me.id }, data: { joiningDate: "2025-01-01" } })
    // the apply path submits a LEAVE approval request — the workflow must exist
    const wf = await db.approvalWorkflow.create({ data: { vendorId: v.id, processType: "LEAVE", name: `WF ${uniq()}`, active: true } })
    await db.approvalStep.create({ data: { vendorId: v.id, workflowId: wf.id, sequence: 1, name: "HR", approverRole: "HR_ADMIN", required: true } })
    const lt = await db.leaveType.create({ data: { vendorId: v.id, code: `CAS-${uniq()}`, name: "Casual", paid: true, defaultDays: 10, waitingPeriodDays: 0, maxConsecutiveDays: 3, active: true } })
    await db.leaveBalance.create({ data: { vendorId: v.id, employeeId: me.id, leaveTypeId: lt.id, year: 2026, entitled: 10, used: 0, pending: 0, carriedForward: 0 } })
    const empUser = await mkUser(v.id, { role: "EMPLOYEE", employeeId: me.id })
    const empCtx = makeCtx(empUser, ["ess.create", "leave.view"])

    // 4 consecutive days → rejected
    await expect(R("leaveRequests.apply").handler(empCtx, {
      employeeId: me.id, leaveTypeId: lt.id, fromDate: "2026-11-02", toDate: "2026-11-05", reason: "Trip",
    })).rejects.toThrow(/capped at 3 consecutive day/)

    // 3 days → passes validation (goes on to overlap/balance checks and is created)
    const okReq: any = await R("leaveRequests.apply").handler(empCtx, {
      employeeId: me.id, leaveTypeId: lt.id, fromDate: "2026-11-02", toDate: "2026-11-04", reason: "Trip",
    })
    expect(okReq.status).toBe("PENDING")

    // adjacent request (11-05 → 11-06) would form a 5-day run with the PENDING one → rejected
    await expect(R("leaveRequests.apply").handler(empCtx, {
      employeeId: me.id, leaveTypeId: lt.id, fromDate: "2026-11-05", toDate: "2026-11-06", reason: "More",
    })).rejects.toThrow(/capped at 3 consecutive day/)
  })

  test("the provisioned statutory policy is BD-compliant (no EARNED duplicate, sick attachments, casual cap, encash on ANNUAL only)", async () => {
    const v = await mkVendor("R7 LVE113 seeds")
    // all three definition sites agree (provision + seeds ship the same defs)
    const provisionSrc = await Bun.file("src/hrm-server/saas/provision.ts").text()
    expect(provisionSrc.includes('["EARNED",')).toBe(false)
    expect(provisionSrc.includes('["CASUAL", "Casual Leave", true, 10, false, false]')).toBe(true)
    expect(provisionSrc.includes('["SICK", "Sick Leave", true, 14, false, false]')).toBe(true)
    expect(provisionSrc.includes('["ANNUAL", "Annual Leave", true, 20, true, true]')).toBe(true)
    const seedSrc = await Bun.file("src/hrm-server/seed.ts").text()
    expect(seedSrc.includes('["EARNED",')).toBe(false)
    // seed-owner defs agree
    const ownerSrc = await Bun.file("src/hrm-server/seed-owner.ts").text()
    expect(ownerSrc).toContain('requiresAttachment: code === "SICK"')
    expect(ownerSrc).toContain('maxConsecutiveDays: code === "CASUAL" ? 3 : 0')
    expect(ownerSrc).toContain("BD_HOLIDAY_TEMPLATE")
  })
})

// ---------------------------------------------------------------------------
describe("REC-01 — my-interviews + candidate PII scoping", () => {
  test("interviewers see their own interviews with masked contacts; applications.list masks email/phone for viewers", async () => {
    const v = await mkVendor("R7 REC01")
    const interviewer = await mkUser(v.id, { role: "HR_MANAGER", name: "Tech Lead" }) // recruitment.view only (no edit)
    const editor = await mkUser(v.id, { role: "HR_ADMIN" })
    const opening = await db.jobOpening.create({ data: { vendorId: v.id, title: "Senior Engineer", branchId: "Dhaka HQ", employmentType: "FULL_TIME", openings: 1, status: "OPEN" } })
    const app = await db.jobApplication.create({ data: { vendorId: v.id, openingId: opening.id, name: "Candidate X", email: "candidate.x@example.com", phone: "01712345678", status: "INTERVIEW" } as any })
    await db.jobInterview.create({ data: { vendorId: v.id, applicationId: app.id, round: "R1", mode: "ONSITE", scheduledAt: "2026-11-05T10:00", interviewerId: interviewer.id, interviewerName: "Tech Lead", location: "HQ" } })
    await db.jobInterview.create({ data: { vendorId: v.id, applicationId: app.id, round: "R2", mode: "VIDEO", scheduledAt: "2026-11-12T10:00", interviewerId: editor.id, interviewerName: "HR" } })

    // my interviews — only the interviewer's row, contacts masked
    const mine = (await R("ats.interviews.mine").handler(makeCtx(interviewer), {})) as any[]
    expect(mine.length).toBe(1)
    expect(mine[0].round).toBe("R1")
    expect(mine[0].applicantName).toBe("Candidate X")
    expect(mine[0].applicantEmailMasked).not.toBe("candidate.x@example.com")
    expect(mine[0].applicantEmailMasked).toContain("•")
    expect(mine[0].openingTitle).toBe("Senior Engineer")

    // applications.list — viewer sees masked, editor sees clear
    const viewerFeed = (await R("recruitment.applications.list").handler(makeCtx(interviewer, ["recruitment.view"]), {})) as any[]
    expect(viewerFeed.find((a) => a.id === app.id)?.email).not.toBe("candidate.x@example.com")
    const editorFeed = (await R("recruitment.applications.list").handler(makeCtx(editor, ["recruitment.view", "recruitment.edit"]), {})) as any[]
    expect(editorFeed.find((a) => a.id === app.id)?.email).toBe("candidate.x@example.com")
  })
})

// ---------------------------------------------------------------------------
describe("ATT-017 — ATTENDANCE_RULES policy type (per-group day rules)", () => {
  test("the policy saves with a typed config and the engine bundle merges it over settings", async () => {
    const v = await mkVendor("R7 ATT017")
    const branch = await db.branch.create({ data: { vendorId: v.id, name: "Factory Line", code: uniq("B") } })
    const me = await mkEmployee(v.id, { fullName: "Att017 Emp", branchId: branch.id })
    const adminCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["attendance.edit", "attendance.view", "employees.view"])

    // save an ATTENDANCE_RULES policy scoped to the branch with a 30-min grace
    const saved: any = await R("attendance.policy.save").handler(adminCtx, {
      name: "Factory leniency rules", policyType: "ATTENDANCE_RULES", priority: 10, active: true,
      daysOfWeek: ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"],
      config: { graceMinutes: 30, earlyLeaveThresholdMinutes: 30, halfDayHours: 5, maxOtHoursPerDay: 1 },
      assignments: [{ scopeType: "BRANCH", scopeId: branch.id }],
    })
    expect(saved.id).toBeTruthy()
    const policy = await db.attendancePolicy.findUniqueOrThrow({ where: { id: saved.id } })
    expect(policy.policyType).toBe("ATTENDANCE_RULES")
    expect(JSON.parse(policy.configJson).graceMinutes).toBe(30)

    // the bundle resolves the override for the branch employee…
    const { dayRulesBundle } = await import("@/hrm-server/attendance-policy")
    const bundle = await dayRulesBundle(v.id, me, { latePolicy: { graceMinutes: 10 }, earlyLeavePolicy: { thresholdMinutes: 15 }, attendance: { halfDayHours: 4 }, shift: { maxOtHoursPerDay: 2 } })
    expect(bundle.graceMinutes).toBe(30)
    expect(bundle.earlyLeaveThresholdMinutes).toBe(30)
    expect(bundle.halfDayHours).toBe(5)
    expect(bundle.maxOtMinutesPerDay).toBe(60)
    // …while an employee OUTSIDE the branch inherits the settings
    const other = await mkEmployee(v.id, { fullName: "Att017 Other" })
    const bundle2 = await dayRulesBundle(v.id, other, { latePolicy: { graceMinutes: 10 }, earlyLeavePolicy: { thresholdMinutes: 15 }, attendance: { halfDayHours: 4 }, shift: { maxOtHoursPerDay: 2 } })
    expect(bundle2.graceMinutes).toBe(10)
    expect(bundle2.halfDayHours).toBe(4)
    expect(bundle2.maxOtMinutesPerDay).toBe(120)

    // the effective-policy resolution surfaces it for the UI
    const effective: any = await R("attendance.policy.effective").handler(adminCtx, { employeeId: me.id, policyType: "ATTENDANCE_RULES" })
    expect(effective.ATTENDANCE_RULES?.source).toBe("Branch")
    expect(effective.ATTENDANCE_RULES?.config?.graceMinutes).toBe(30)
  })

  test("the marking engine honors the per-employee grace (30-min policy → 09:25 punch is NOT late)", async () => {
    const v = await mkVendor("R7 ATT017 engine")
    const branch = await db.branch.create({ data: { vendorId: v.id, name: "Plant", code: uniq("B") } })
    const me = await mkEmployee(v.id, { fullName: "Att017 Mark", branchId: branch.id })
    const shift = await db.shift.create({ data: { vendorId: v.id, name: `Day ${uniq()}`, startTime: "09:00", endTime: "17:00", graceMinutes: 5, breakMinutes: 60 } as any })
    await db.employee.update({ where: { id: me.id }, data: { shiftId: shift.id } })
    const adminCtx = makeCtx(await mkUser(v.id, { role: "HR_ADMIN" }), ["attendance.edit", "attendance.view", "employees.view"])
    await R("attendance.policy.save").handler(adminCtx, {
      name: "Plant grace", policyType: "ATTENDANCE_RULES", priority: 5, active: true,
      daysOfWeek: ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"],
      config: { graceMinutes: 30 },
      assignments: [{ scopeType: "BRANCH", scopeId: branch.id }],
    })
    const { today } = await import("@/hrm-server/utils")
    const markDate = today() // never a future date
    const rec: any = await R("attendance.mark").handler(adminCtx, { employeeId: me.id, date: markDate, checkIn: "09:25", checkOut: "17:30" })
    expect(rec.status).toBe("PRESENT") // 25-min lateness is INSIDE the 30-min policy grace
    expect(rec.lateMinutes).toBe(0)
  })
})
