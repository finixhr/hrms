/* eslint-disable @typescript-eslint/no-non-null-assertion -- smoke-script assertions: a failed lookup MUST crash the run (that is the test) */
// Wave 3 smoke test — exercises every new RPC against the scratch PostgreSQL.
// Not a unit test (no vitest semantics): a straight end-to-end script that
// FAILS LOUDLY on any assertion. Run:
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/hrm_test bun run scripts/wave3-smoke.ts
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/registry"
import "@/hrm-server/routes/router"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
import type { Ctx } from "@/hrm-server/types"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let failures = 0
const ok = (label: string, cond: boolean, detail?: any) => {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.error(`  ✗ ${label}${detail !== undefined ? " — " + JSON.stringify(detail)?.slice(0, 300) : ""}`) }
}

async function main() {
  const vendor = await db.vendor.findFirst({ orderBy: { createdAt: "asc" } })
  if (!vendor) throw new Error("no vendor — run the seed first")
  const admin: Ctx = {
    userId: "smoke-admin", userName: "Smoke Admin", vendorId: vendor.id, role: "HR_ADMIN",
    permissions: new Set(["accounting.view", "accounting.create", "accounting.approve", "reports.view", "reports.export", "billing.view"]),
  }
  const viewer: Ctx = { ...admin, permissions: new Set(["billing.view"]) }
  const owner: OwnerCtx = {
    ownerId: "smoke-owner", name: "Smoke Owner", email: "owner@smoke.test", roleKey: "OWNER",
    permissions: new Set(["subscriptions.view", "subscriptions.manage"]),
  }

  // ---------- WP-B: voucher approval workflow ----------
  console.log("WP-B — voucher approval workflow")
  // 2026-10-08 harness fix: residue-tolerant baseline. The trial-balance
  // assertion below previously required cash == exactly 700.00, which only
  // holds on a FRESHLY seeded DB — any re-run (or a prior wave4-smoke cash-flow
  // post, or seeded payroll journals) accumulates posted cash and failed the
  // check. Capture the pre-run balance and assert on the DELTA this run posts.
  const tbBaseline = await getRoute("accounting.trialBalance")!.handler(admin, {}) as any
  const cashBaseline = Math.round(Number(tbBaseline.rows.find((r: any) => r.code === "1010")?.balanceDr || 0) * 100)
  const lines = [
    { account: "1010", debit: 500, credit: undefined },
    { account: "5300", debit: undefined, credit: 500 },
  ]
  const saved = await getRoute("accounting.voucher.save")!.handler(admin, { date: "2026-10-01", memo: "Smoke draft — supplies", lines }) as any
  ok("voucher.save creates a DRAFT", saved.status === "DRAFT" && Number(saved.amount) === 500, saved)

  const updated = await getRoute("accounting.voucher.save")!.handler(admin, { id: saved.journalId, date: "2026-10-02", memo: "Smoke draft — supplies v2", lines: [
    { account: "1010", debit: 700 }, { account: "5300", credit: 700 },
  ] }) as any
  ok("voucher.save updates the DRAFT (amount re-computed)", Number(updated.amount) === 700, updated)

  // H-9 must refuse an unbalanced draft
  let refused = false
  try { await getRoute("accounting.voucher.save")!.handler(admin, { date: "2026-10-01", memo: "Unbalanced", lines: [{ account: "1010", debit: 100 }, { account: "5300", debit: 50 }] }) }
  catch { refused = true }
  ok("H-9 refuses an unbalanced DRAFT", refused)

  const submitted = await getRoute("accounting.voucher.submit")!.handler(admin, { id: saved.journalId }) as any
  ok("voucher.submit → PENDING_APPROVAL", submitted.status === "PENDING_APPROVAL", submitted)

  // a DRAFT-only action must refuse a pending voucher
  let stateRefused = false
  try { await getRoute("accounting.voucher.submit")!.handler(admin, { id: saved.journalId }) } catch { stateRefused = true }
  ok("double-submit refused by state assertion", stateRefused)

  const approved = await getRoute("accounting.voucher.approve")!.handler(admin, { id: saved.journalId }) as any
  ok("voucher.approve → POSTED with amount", approved.status === "POSTED" && Number(approved.amount) === 700, approved)

  // second workflow: reject path
  const d2 = await getRoute("accounting.voucher.save")!.handler(admin, { date: "2026-10-03", memo: "Smoke reject", lines: [{ account: "1200", debit: 90 }, { account: "2100", credit: 90 }] }) as any
  await getRoute("accounting.voucher.submit")!.handler(admin, { id: d2.journalId })
  const rejected = await getRoute("accounting.voucher.reject")!.handler(admin, { id: d2.journalId, reason: "Wrong memo format — fix and resubmit" }) as any
  ok("voucher.reject → REJECTED with reason", rejected.status === "REJECTED", rejected)

  const list = await getRoute("accounting.vouchers.list")!.handler(admin, { limit: 50 }) as any
  ok("vouchers.list returns statusCounts", (list.statusCounts.PENDING_APPROVAL ?? 0) >= 0 && (list.statusCounts.POSTED ?? 0) >= 1, list.statusCounts)
  const listDraft = await getRoute("accounting.vouchers.list")!.handler(admin, { status: "REJECTED", limit: 50 }) as any
  ok("vouchers.list status filter works", listDraft.journals.every((j: any) => j.status === "REJECTED") && listDraft.journals.length >= 1, listDraft.total)

  // ledger/trial balance must count ONLY posted money (+700 this run, not +90 or +drafts)
  const tb = await getRoute("accounting.trialBalance")!.handler(admin, {}) as any
  const cashRow = tb.rows.find((r: any) => r.code === "1010")
  ok("trial balance counts POSTED money only", tb.balanced === true && Math.round(Number(cashRow?.balanceDr || 0) * 100) - cashBaseline === 70000, { cash: cashRow, cashBaseline })

  // ---------- WP-F: balance sheet ----------
  console.log("WP-F — balance sheet")
  const bs = await getRoute("accounting.balanceSheet")!.handler(admin, { asOf: "2026-12-31" }) as any
  ok("balance sheet balances (A = L + E)", bs.balanced === true && Number(bs.difference) === 0, { diff: bs.difference, A: bs.totalAssets, L: bs.totalLiabilities, E: bs.totalEquity })
  ok("balance sheet sections populated", bs.assets.length >= 1 && bs.liabilities.length >= 1, { assets: bs.assets?.length, liab: bs.liabilities?.length })

  // ---------- WP-E: the nine new reports ----------
  console.log("WP-E — new reports")
  const reportsToTest: [string, Record<string, unknown>, (r: any) => boolean][] = [
    ["reports.headcount", { dimension: "branch" }, (r) => Array.isArray(r.columns) && r.rows.length >= 1],
    ["reports.headcount", { dimension: "status" }, (r) => r.rows.some((x: any[]) => String(x[0]).toUpperCase().includes("ACTIVE"))],
    ["reports.demographics", { dimension: "gender" }, (r) => r.rows.length >= 1],
    ["reports.demographics", { dimension: "bloodGroup" }, (r) => Array.isArray(r.rows)],
    ["reports.salaryBands", {}, (r) => r.rows.length >= 1 && r.meta.totalStructured >= 1],
    ["reports.probationExpiry", { withinDays: 366 }, (r) => Array.isArray(r.rows)],
    ["reports.birthdays", { month: 10, year: 2026 }, (r) => Array.isArray(r.rows)],
    ["reports.headcountMovement", { year: 2026 }, (r) => r.rows.length === 12],
    ["reports.recruitmentFunnel", {}, (r) => r.rows.some((x: any[]) => String(x[0]).includes("Openings"))],
    ["reports.assetAssignments", {}, (r) => Array.isArray(r.rows)],
    ["reports.fieldforceVisits", { month: 10, year: 2026 }, (r) => Array.isArray(r.rows)],
  ]
  for (const [action, payload, check] of reportsToTest) {
    try {
      const res = await getRoute(action)!.handler(admin, payload) as any
      ok(`${action} ${payload.dimension || payload.month ? `(${payload.dimension || payload.month})` : ""}`, check(res), { rows: res.rows?.length, columns: res.columns })
      const csvRes = await getRoute(`${action}Csv`)!.handler({ ...admin, permissions: new Set(["reports.export"]) }, payload) as any
      ok(`${action}Csv`, typeof csvRes.csv === "string" && csvRes.csv.includes(","), csvRes.csv?.slice(0, 60))
    } catch (e: any) {
      failures++; console.error(`  ✗ ${action} THREW: ${e.message}`)
    }
  }

  // ---------- WP-C: plan-change requests ----------
  console.log("WP-C — plan-change requests")
  const sub = await db.saasSubscription.findFirst({ where: { vendorId: vendor.id } })
  ok("tenant has a subscription (seeded)", !!sub)
  const plans = await db.saasPlan.findMany({ where: { active: true, isPublic: true, isTrialPlan: false }, orderBy: { sortOrder: "asc" } })
  ok("public plans exist (seeded)", plans.length >= 2, plans.length)
  // 2026-10-08 harness fix: the handler compares CYCLE-CONSISTENT prices
  // (yearly snapshot vs yearly candidate when billingCycle=YEARLY), while this
  // harness previously computed mode from MONTHLY prices against a possibly-
  // yearly snapshot AND relied on unordered findMany — Professional (monthly
  // 15,000 < 65,000 → DOWNGRADE) then failed the yearly check (150,000 ≥
  // 65,000) and crashed the smoke. Deterministic order + cycle-consistent
  // comparison makes the pick stable and the mode always agree with the route.
  const cyclePrice = (p: any) => Number(sub!.billingCycle === "YEARLY" ? p.yearlyPrice : p.monthlyPrice)
  const snapshot = Number(sub!.priceAtCreation)
  const target = plans.find((p) => p.id !== sub!.planId && cyclePrice(p) !== snapshot)
  const mode = cyclePrice(target!) > snapshot ? "UPGRADE" : "DOWNGRADE"

  const req = await getRoute("billing.planChangeRequest")!.handler(viewer, { planId: target!.id, mode, note: "Smoke request — growing team" }) as any
  ok("billing.planChangeRequest creates a PENDING request", req.status === "PENDING" && !!req.requestId, req)

  let dupRefused = false
  try { await getRoute("billing.planChangeRequest")!.handler(viewer, { planId: target!.id, mode }) } catch { dupRefused = true }
  ok("duplicate open request refused (409 path)", dupRefused)

  const myList = await getRoute("billing.planChangeRequests")!.handler(viewer, {}) as any
  ok("billing.planChangeRequests lists own requests", myList.rows.length >= 1 && myList.pending === true, myList)

  // viewer (billing.view only) must NOT pass the dispatcher's permission gate
  // for billing.changePlan (perm: ["billing","manage"]) — enforced in the
  // /api/hrm dispatcher BEFORE the handler; simulated here identically.
  const { require } = await import("@/hrm-server/rbac")
  let permRefused = false
  try { require(viewer, "billing", "manage") } catch { permRefused = true }
  ok("billing.changePlan still requires billing.manage", permRefused && getRoute("billing.changePlan")!.perm?.[1] === "manage")

  // owner console decides the request
  const ownerList = await ownerRoutes["owner.planchangerequests.list"].handler(owner, { status: "PENDING", page: 1, pageSize: 10 }) as any
  ok("owner.planchangerequests.list sees the request", ownerList.rows.length >= 1 && ownerList.rows[0].vendorId === vendor.id, ownerList.rows?.[0])
  const decision = await ownerRoutes["owner.planchangerequests.approve"].handler(owner, { id: req.requestId, note: "Smoke approval" }) as any
  ok("owner.planchangerequests.approve applies the plan change", decision.status === "APPROVED" && !!decision.planName, decision)
  const after = await db.saasSubscription.findFirst({ where: { vendorId: vendor.id } })
  ok("subscription actually changed after approval", after!.planId === target!.id, { from: sub!.planId, to: after!.planId })
  const events = await db.saasSubscriptionEvent.count({ where: { subscriptionId: after!.id } })
  ok("subscription event recorded (billing.events)", events >= 1, events)

  let doubleApprove = false
  try { await ownerRoutes["owner.planchangerequests.approve"].handler(owner, { id: req.requestId }) } catch { doubleApprove = true }
  ok("double approval refused", doubleApprove)

  console.log(failures === 0 ? "\nALL WAVE-3 SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error("SMOKE CRASHED:", e); process.exit(1) })
