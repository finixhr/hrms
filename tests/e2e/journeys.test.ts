/// <reference types="bun-types" />
// ============ TEST-01 (R7) — HTTP-level E2E coverage of the critical journeys ============
// Runs against a LIVE Next.js server (scripts/e2e.sh boots one on a scratch
// database). Journeys: login → auth.me → ESS profile → leave apply →
// approval → payroll run → calculate → approve → pay → ESS payslip.
// These complement the handler-level unit suite: they exercise the REAL
// HTTP surface (dispatcher, cookies, zod schemas, entitlement gates).
import { describe, test, expect, beforeAll } from "bun:test"

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:3111"
const PASSWORD = process.env.E2E_PASSWORD || "E2ePass@123"

// per-plane sessions: httpOnly cookie + the memory-style CSRF echo (C-4:
// cookie-authenticated calls must carry X-CSRF-Token — exactly what the SPA does)
const sessions: Record<"hr" | "ess", { cookie: string; csrf: string }> = { hr: { cookie: "", csrf: "" }, ess: { cookie: "", csrf: "" } }
let employeeId = ""
let leaveTypeId = ""

async function rpc(action: string, payload: unknown, as: "hr" | "ess" = "hr") {
  const s = sessions[as]
  const res = await fetch(`${BASE}/api/hrm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(s.cookie ? { cookie: s.cookie } : {}),
      ...(s.csrf ? { "x-csrf-token": s.csrf } : {}),
    },
    body: JSON.stringify({ action, payload }),
  })
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0]
    if (kv.startsWith("hrm_session=")) s.cookie = kv
  }
  let body: any = null
  try { body = await res.json() } catch { /* non-JSON */ }
  // the login payload hands the SPA its CSRF token — capture it like the client
  if (action === "auth.login" && body?.data?.csrfToken) s.csrf = body.data.csrfToken
  if (action === "auth.login" && body?.data?.token) {
    // token mirrors the cookie value; the CSRF echo uses the payload token
  }
  return { status: res.status, body }
}

async function login(email: string, as: "hr" | "ess" = "hr") {
  return rpc("auth.login", { email, password: PASSWORD }, as)
}

beforeAll(async () => {
  // health gate — the lane refuses to run against a dead server
  const health = await fetch(`${BASE}/api/health`)
  expect(health.status).toBe(200)
})

describe("TEST-01 — login & session journey", () => {
  test("wrong credentials get a generic 401 (no account oracle)", async () => {
    const r = await login("hr@e2e.local") // placeholder replaced below
    void r
    const bad = await rpc("auth.login", { email: "owner@e2e.local", password: "wrong-password" })
    expect(bad.status).toBe(401)
  })

  test("owner logs in and auth.me resolves the session", async () => {
    const r = await login("hr@e2e.local")
    expect(r.status).toBe(200)
    expect(r.body?.data?.user?.email).toBe("hr@e2e.local")
    expect(r.body?.data?.vendor?.name || r.body?.data?.user?.email).toBeTruthy()
    const me = await rpc("auth.me", {})
    expect(me.status).toBe(200)
    expect(me.body?.data?.user?.role).toBe("HR_ADMIN")
  })

  test("unauthenticated RPC is rejected", async () => {
    const saved = { ...sessions.hr }
    sessions.hr = { cookie: "", csrf: "" }
    const r = await rpc("employees.list", {})
    sessions.hr = saved
    expect([401, 403]).toContain(r.status)
  })
})

describe("TEST-01 — ESS journey (profile → leave apply → decision visible)", () => {
  test("the employee logs in, reads their profile and dashboard", async () => {
    const r = await login("employee@e2e.local", "ess")
    expect(r.status).toBe(200)
    expect(r.body?.data?.user?.role).toBe("EMPLOYEE")
    const profile = await rpc("ess.profile", {}, "ess")
    expect(profile.status).toBe(200)
    expect(profile.body?.data?.employee?.fullName).toBe("Journey Employee")
    employeeId = profile.body.data.employee.id
    const dash = await rpc("ess.dashboard", {}, "ess")
    expect(dash.status).toBe(200)
    expect(typeof dash.body?.data?.casualRemaining).toBe("number")
  })

  test("leave apply through the real HTTP surface → PENDING → HR approves → employee sees APPROVED", async () => {
    const types: any = await rpc("ess.leave", {}, "ess")
    expect(types.status).toBe(200)
    leaveTypeId = types.body?.data?.types?.[0]?.id || ""
    expect(leaveTypeId).toBeTruthy()

    // apply a 2-day casual leave (well under the 3-day consecutive cap)
    const now = new Date()
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 3)
    const from = nextMonth.toISOString().slice(0, 10)
    const to = new Date(nextMonth.getTime() + 86_400_000).toISOString().slice(0, 10)
    const applied = await rpc("leaveRequests.apply", { leaveTypeId, fromDate: from, toDate: to, reason: "E2E journey leave" }, "ess")
    expect(applied.status).toBe(200)
    expect(applied.body?.data?.status).toBe("PENDING")

    // HR sees the request in the queue and approves it
    const queue: any = await rpc("approvals.queue", { status: "PENDING" })
    expect(queue.status).toBe(200)
    const req = (queue.body?.data?.items || queue.body?.data || []).find?.((x: any) => x.processType === "LEAVE" && x.status === "PENDING")
    expect(req).toBeTruthy()
    const acted = await rpc("approvals.act", { requestId: req.id, decision: "APPROVE", comment: "E2E approve" })
    expect(acted.status).toBe(200)

    // the employee's list reflects the decision
    const mine: any = await rpc("ess.leave", {}, "ess")
    const approved = (mine.body?.data?.requests || []).find((x: any) => x.id === applied.body.data.id)
    expect(approved?.status).toBe("APPROVED")
  })
})

describe("TEST-01 — payroll journey (create → calculate → approve → pay → payslip)", () => {
  test("the full money path runs over HTTP", async () => {
    const now = new Date()
    const month = now.getMonth() + 1
    const year = now.getFullYear()

    const created = await rpc("payroll.runs.create", { periodMonth: month, periodYear: year })
    expect(created.status).toBe(200)
    const runId = created.body?.data?.id
    expect(runId).toBeTruthy()

    const calc = await rpc("payroll.calculate", { runId })
    expect(calc.status).toBe(200)
    expect(calc.body?.data?.count).toBeGreaterThanOrEqual(1)

    const submitted = await rpc("payroll.submitApproval", { runId })
    expect(submitted.status).toBe(200)

    // the OWNER approves the PAYROLL request (SoD: the HR submitter cannot
    // approve their own request — a different human/role acts)
    await login("owner@e2e.local")
    const queue: any = await rpc("approvals.queue", { status: "PENDING" })
    const req = (queue.body?.data?.items || queue.body?.data || []).find?.((x: any) => x.processType === "PAYROLL" && x.status === "PENDING")
    expect(req).toBeTruthy()
    const acted = await rpc("approvals.act", { requestId: req.id, decision: "APPROVE" })
    expect(acted.status).toBe(200)

    const paid = await rpc("payroll.pay", { runId })
    expect(paid.status).toBe(200)

    // the ESS payslip inbox carries the paid run
    const payslips: any = await rpc("ess.payroll", {}, "ess")
    expect(payslips.status).toBe(200)
    const slip = (payslips.body?.data?.payslips || []).find?.((p: any) => p.payslipNumber)
    expect(slip).toBeTruthy()
    expect(slip.gross).toBeGreaterThan(0)
  })
})

describe("TEST-01 — R7 feature surfaces over HTTP", () => {
  test("ESS self-profile edit + My Assets + letter requests ride the same pipe", async () => {
    const upd = await rpc("ess.profile.update", { mobile: "01700000001" }, "ess")
    expect(upd.status).toBe(200)
    const assets = await rpc("ess.myAssets", {}, "ess")
    expect(assets.status).toBe(200)
    const req = await rpc("ess.letterRequests", { type: "SALARY_CERT" }, "ess")
    expect(req.status).toBe(200)
  })
})
