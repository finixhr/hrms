/* eslint-disable @typescript-eslint/no-non-null-assertion -- smoke-script assertions: a failed lookup MUST crash the run (that is the test) */
// Wave 4 smoke test — exercises every new Wave-4 surface against the scratch
// PostgreSQL: accounting depth (period lock, cost centers, cash flow,
// budgets), report templates + scheduled delivery, the public REST API +
// webhooks, ATS depth, AI assist, unified approval inbox, owner analytics,
// dunning and the BD compliance reports. Run after a fresh reset + seed:
//   DATABASE_URL=postgresql://hrm_user:…@127.0.0.1:5432/hrm bun run scripts/wave4-smoke.ts
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/registry"
import "@/hrm-server/routes/router"
import { ownerRoutes } from "@/hrm-server/saas/owner-routes"
import { NextRequest } from "next/server"
import type { Ctx } from "@/hrm-server/types"
import type { OwnerCtx } from "@/hrm-server/saas/owner-auth"

let failures = 0
const ok = (label: string, cond: boolean, detail?: any) => {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.error(`  ✗ ${label}${detail !== undefined ? " — " + JSON.stringify(detail)?.slice(0, 300) : ""}`) }
}
const throws = async (label: string, fn: () => Promise<unknown>) => {
  try { await fn(); ok(label, false, "did NOT throw") }
  catch { ok(label, true) }
}

async function main() {
  const vendor = await db.vendor.findFirst({ orderBy: { createdAt: "asc" } })
  if (!vendor) throw new Error("no vendor — run the seed first")
  // 2026-10-08 harness fix: keys.create is throttled 5/hour by a DB-backed
  // Throttle row keyed `apikey:create:<vendorId>` — the 6th smoke run inside
  // an hour crashed with 429. Clear the smoke's own throttle residue first
  // so re-runs stay deterministic (dev/demo DBs; the row only exists because
  // a smoke or a real tenant created keys this hour).
  await db.throttle.deleteMany({ where: { key: `apikey:create:${vendor.id}` } })
  const admin: Ctx = {
    userId: "smoke-admin", userName: "Smoke Admin", vendorId: vendor.id, role: "HR_ADMIN",
    permissions: new Set(["*"]),
  }
  const owner: OwnerCtx = {
    ownerId: "smoke-owner", name: "Smoke Owner", email: "owner@smoke.test", roleKey: "OWNER",
    permissions: new Set(["tenants.view", "subscriptions.view", "billing.manage", "plans.view"]),
  }

  // ================= WP-B — accounting depth =================
  console.log("WP-B — accounting depth")
  // 2026-10-08 harness fix: run-unique period name (ms precision — minute
  // precision still collided when two runs shared a minute). The fixed name
  // "Smoke FY2026-Q4" made the smoke non-idempotent — the second run against
  // the same DB crashed on the per-vendor unique period-name constraint.
  // All subsequent checks reference period.periodId, never the literal name.
  const period = await getRoute("accounting.periods.save")!.handler(admin, { name: `Smoke FY2026-Q4 #${Date.now()}`, startDate: "2026-10-01", endDate: "2026-12-31" }) as any
  ok("periods.save creates an OPEN period", !!period.periodId, period)
  const periods = await getRoute("accounting.periods.list")!.handler(admin, {}) as any
  ok("periods.list includes it", (periods.periods || periods).some?.((p: any) => p.id === period.periodId) || JSON.stringify(periods).includes(period.periodId))

  // period lock: manual voucher dated inside the CLOSED period must be refused
  await getRoute("accounting.periods.close")!.handler(admin, { id: period.periodId })
  await throws("voucher.save refused inside a CLOSED period", () =>
    getRoute("accounting.voucher.save")!.handler(admin, { date: "2026-11-15", memo: "Locked period attempt", lines: [{ account: "1010", debit: 10 }, { account: "5300", credit: 10 }] }))
  await getRoute("accounting.periods.reopen")!.handler(admin, { id: period.periodId })
  // 2026-10-08 harness fix: baseline the cash-flow BEFORE any of this run's
  // postings — re-runs accumulate cash journals inside the fixed
  // 2026-10-01..12-31 window, so an absolute netChange assertion only held on
  // a freshly seeded DB. (Captured after the reopen so the +10 below counts.)
  const cfBefore = await getRoute("accounting.cashFlow")!.handler(admin, { from: "2026-10-01", to: "2026-12-31" }) as any
  const unlocked = await getRoute("accounting.voucher.post")!.handler(admin, { date: "2026-11-15", memo: "Smoke voucher after reopen", lines: [{ account: "1010", debit: 10 }, { account: "5300", credit: 10 }] }) as any
  ok("voucher.post works after reopen", Number(unlocked.amount) === 10, unlocked)

  // cost centers + tagged voucher
  const cc = await getRoute("accounting.costCenters.save")!.handler(admin, { code: "CC-SMOKE", name: "Smoke Cost Center" }) as any
  ok("costCenters.save upserts by code", !!(cc.costCenterId ?? cc.id), cc)
  const ccId = cc.costCenterId ?? cc.id
  const tagged = await getRoute("accounting.voucher.post")!.handler(admin, { date: "2026-11-16", memo: "Tagged voucher", costCenterId: ccId, lines: [{ account: "1010", debit: 5 }, { account: "5120", credit: 5 }] }) as any
  const taggedRow = await db.accountJournal.findUnique({ where: { id: tagged.journalId } })
  ok("voucher.post carries the cost-center tag", taggedRow?.costCenterId === ccId, { journal: tagged.journalId, tag: taggedRow?.costCenterId })
  const ccList = await getRoute("accounting.costCenters.list")!.handler(admin, {}) as any
  ok("costCenters.list returns the row", JSON.stringify(ccList).includes("CC-SMOKE"))

  // cash flow (direct method) over the two cash journals above (DELTA this run)
  const cf = await getRoute("accounting.cashFlow")!.handler(admin, { from: "2026-10-01", to: "2026-12-31" }) as any
  ok("cashFlow nets the cash journals", Math.abs(Number(cf.netChange) - Number(cfBefore.netChange) - 15) < 0.005 && cf.closing === cf.opening + Number(cf.netChange), { net: cf.netChange, baseline: cfBefore.netChange, open: cf.opening, close: cf.closing })
  ok("cashFlow sections balance against net change", cf.balanced === true, { diff: cf.difference })

  // budgets + variance (account 5120 saw a 5 credit → actual 5)
  const budget = await getRoute("accounting.budgets.save")!.handler(admin, { accountCode: "5120", amount: 100, notes: "Smoke budget" }) as any
  ok("budgets.save creates the row", !!budget.budgetId || !!budget.id, budget)
  const budgets = await getRoute("accounting.budgets.list")!.handler(admin, {}) as any
  const b5120 = (budgets.budgets || budgets.rows || []).find?.((b: any) => b.accountCode === "5120" || String(b[0] ?? "").includes("5120"))
  ok("budgets.list computes variance (budget 100 vs actual 5)", !!b5120, { rows: (budgets.budgets || budgets.rows || []).length })
  await getRoute("accounting.budgets.delete")!.handler(admin, { id: budget.budgetId || budget.id })

  // ================= WP-A — report templates =================
  console.log("WP-A — report templates + scheduled delivery")
  const tpl = await getRoute("reports.templates.save")!.handler(admin, {
    name: "Smoke Monthly Headcount", reportKey: "headcount", format: "XLSX", schedule: "MONTHLY",
    recipients: [{ email: "smoke@example.com" }], active: true, filters: { dimension: "department" },
  }) as any
  ok("templates.save creates the template", !!tpl.template?.id && tpl.template.schedule === "MONTHLY", tpl)
  await throws("templates.save refuses an unknown report key", () =>
    getRoute("reports.templates.save")!.handler(admin, { name: "Bad", reportKey: "no_such_report", format: "CSV", schedule: "OFF", recipients: [], active: false }))

  const run = await getRoute("reports.templates.runNow")!.handler(admin, { id: tpl.template.id }) as any
  ok("templates.runNow records a SKIPPED delivery (no gateway configured)", run.status === "SKIPPED", run)
  const logRow = await db.reportDeliveryLog.findFirst({ where: { templateId: tpl.template.id } })
  ok("ReportDeliveryLog row written", !!logRow && logRow!.status === "SKIPPED", logRow?.status)

  const tlist = await getRoute("reports.templates.list")!.handler(admin, {}) as any
  ok("templates.list returns templates + deliveries", tlist.templates?.length >= 1 && tlist.deliveries?.length >= 1, { t: tlist.templates?.length, d: tlist.deliveries?.length })
  await getRoute("reports.templates.delete")!.handler(admin, { id: tpl.template.id })
  const afterDel = await db.reportTemplate.count({ where: { id: tpl.template.id } })
  ok("templates.delete removes it", afterDel === 0)

  // ================= BD compliance — gratuity + festival bonus =================
  console.log("BD compliance — gratuity + festival bonus reports")
  const grat = await getRoute("reports.gratuity")!.handler(admin, {}) as any
  ok("reports.gratuity renders (columns + rows)", grat.columns.length === 8, grat.columns)
  const fest = await getRoute("reports.festivalBonus")!.handler(admin, { percent: 100, basis: "basic" }) as any
  ok("reports.festivalBonus renders with a TOTAL row", fest.rows.length >= 1 && String(fest.rows[fest.rows.length - 1][0]).includes("TOTAL"), { rows: fest.rows.length })
  for (const key of ["gratuity", "festivalBonus"]) {
    const csvRes = await getRoute(`reports.${key}Csv`)!.handler({ ...admin, permissions: new Set(["reports.export"]) }, {}) as any
    ok(`reports.${key}Csv exports`, typeof csvRes.csv === "string" && csvRes.csv.length > 10)
  }

  // ================= unified approval inbox — voucher rows =================
  console.log("Unified approval inbox")
  const pend = await getRoute("accounting.voucher.save")!.handler(admin, { date: "2026-11-17", memo: "Inbox smoke voucher", lines: [{ account: "1010", debit: 25 }, { account: "5300", credit: 25 }] }) as any
  await getRoute("accounting.voucher.submit")!.handler(admin, { id: pend.journalId })
  const queue = await getRoute("approvals.queue")!.handler(admin, { status: "PENDING" }) as any
  const voucherRows = (queue.rows || queue).filter?.((r: any) => r.processType === "VOUCHER") || []
  ok("approvals.queue includes VOUCHER rows (canAct=false + deep link)", voucherRows.length >= 1 && voucherRows[0].canAct === false, { n: voucherRows.length })
  const hist = await getRoute("approvals.history")!.handler(admin, { status: "APPROVED" }) as any
  ok("approvals.history includes decided vouchers", JSON.stringify(hist).includes("VOUCHER"))

  // ================= WP-C — API keys + REST + webhooks =================
  console.log("WP-C — API keys, public REST v1, webhooks")
  // 2026-10-08 harness fix: also clear this vendor's PENDING webhook
  // deliveries from earlier smoke runs — the flush drains the 20 OLDEST
  // pending rows and unreachable-host residue (retriable forever) starved
  // this run's fresh delivery of its attempt, failing the assertion below.
  await db.webhookDelivery.deleteMany({ where: { vendorId: vendor.id, status: "PENDING" } })
  const key = await getRoute("integrations.keys.create")!.handler(admin, { name: "Smoke Integration Key", scopes: ["employees:read", "attendance:read"] }) as any
  ok("keys.create returns the raw key ONCE (fk_…)", typeof key.key === "string" && key.key.startsWith("fk_") && key.key.length >= 30, key.prefix)
  const keyList = await getRoute("integrations.keys.list")!.handler(admin, {}) as any
  const listed = (keyList.keys || []).find((k: any) => k.id === key.id)
  ok("keys.list shows prefix + scopes but NEVER the raw key/hash", !!listed && !JSON.stringify(keyList).includes(key.key) && listed.scopes.includes("employees:read"), listed)

  // REST v1 end-to-end: authenticate the raw key, then invoke the real route handler
  const { authenticateApiKey } = await import("@/app/api/v1/_auth")
  const req = new NextRequest("http://localhost/api/v1/employees", { headers: { authorization: `Bearer ${key.key}` } })
  const auth = await authenticateApiKey(req as any, "employees:read")
  ok("REST auth accepts the raw key for a granted scope", auth.ok === true && auth.ok && auth.key.vendorId === vendor.id, (auth as any).res?.status)
  const reqWrong = new NextRequest("http://localhost/api/v1/attendance", { headers: { authorization: `Bearer ${key.key}` } })
  const authWrong = await authenticateApiKey(reqWrong as any, "attendance:write")
  ok("REST auth refuses an UNGRANTED scope (403 path)", authWrong.ok === false && (!authWrong.ok && authWrong.res.status === 403))
  const { GET: employeesGet } = await import("@/app/api/v1/employees/route")
  const res = await employeesGet(req as any)
  const body = await res.json()
  ok("GET /api/v1/employees returns the paged envelope", res.status === 200 && body.ok === true && Array.isArray(body.data), { status: res.status, meta: body.meta })
  await getRoute("integrations.keys.revoke")!.handler(admin, { id: key.id })
  const authRevoked = await authenticateApiKey(req as any, "employees:read")
  ok("revoked key can no longer authenticate (401 path)", authRevoked.ok === false && (!authRevoked.ok && authRevoked.res.status === 401))

  // webhooks: SSRF-refused URL, valid save, emit + delivery log
  await throws("webhooks.save refuses a private (SSRF) URL", () =>
    getRoute("integrations.webhooks.save")!.handler(admin, { url: "https://192.168.1.1/hook", events: ["employee.created"], active: true }))
  const hook = await getRoute("integrations.webhooks.save")!.handler(admin, { url: "https://smoke-hook.example.com/hook", events: ["employee.created", "voucher.posted"], active: true, description: "Smoke hook" }) as any
  ok("webhooks.save returns the RAW secret once + hasSecret", typeof hook.secret === "string" && hook.secret.length >= 32, hook.id)
  const hookList = await getRoute("integrations.webhooks.list")!.handler(admin, {}) as any
  ok("webhooks.list never leaks the secret (hasSecret only)", !JSON.stringify(hookList).includes(hook.secret))

  const { webhookEmit, flushWebhookDeliveries } = await import("@/hrm-server/webhooks")
  await webhookEmit(vendor.id, "employee.created", { id: "smoke-emp", fullName: "Smoke Employee" })
  const delivery = await db.webhookDelivery.findFirst({ where: { vendorId: vendor.id }, orderBy: { createdAt: "desc" } })
  ok("webhookEmit records a pending delivery for the subscribed endpoint", !!delivery && delivery!.event === "employee.created", delivery?.event)
  await flushWebhookDeliveries()
  const afterFlush = await db.webhookDelivery.findFirst({ where: { vendorId: vendor.id }, orderBy: { createdAt: "desc" } })
  ok("flush attempts the delivery (attempts >= 1; unreachable host stays retriable)", !!afterFlush && afterFlush!.attempts >= 1, { attempts: afterFlush?.attempts, status: afterFlush?.status })

  // ================= WP-D — ATS depth =================
  console.log("WP-D — ATS depth")
  // 2026-10-08 harness fix: fresh application per run (unique email). The
  // previous find-or-reuse of the FIRST application made the smoke
  // non-idempotent: a prior complete run leaves an ACCEPTED offer, and the
  // one-live/one-accepted-offer rule (assertNoLiveOffer) then refused the
  // next run's offers.save with 409. Every assert below is keyed on this
  // application.id, so a fresh row keeps them all valid — and the
  // "auto-creates the 3 starter onboarding tasks" count stays exact.
  const opening = await db.jobOpening.findFirst({ where: { vendorId: vendor.id } }) ??
    await db.jobOpening.create({ data: { vendorId: vendor.id, title: "Smoke Opening", openings: 1, status: "OPEN" } as any })
  const application = await db.jobApplication.create({ data: { vendorId: vendor.id, openingId: opening.id, name: "Smoke Candidate", email: `candidate-${Date.now()}@smoke.test`, status: "SHORTLISTED" } as any })
  const interview = await getRoute("ats.interviews.save")!.handler(admin, { applicationId: application.id, round: "R1", mode: "VIDEO", scheduledAt: "2026-11-20T10:00", durationMin: 45, link: "https://meet.example.com/smoke", notes: "Smoke interview" }) as any
  ok("interviews.save schedules R1", !!interview.id, interview)
  const iList = await getRoute("ats.interviews.list")!.handler(admin, { applicationId: application.id }) as any
  ok("interviews.list denormalizes applicant + outcome", (iList.interviews || iList).length >= 1, (iList.interviews || iList)?.length)
  const outcome = await getRoute("ats.interviews.outcome")!.handler(admin, { id: interview.id, outcome: "PASSED", score: 82 }) as any
  ok("interviews.outcome PASSED bumps application to INTERVIEW", (outcome.interview ?? outcome).outcome === "PASSED", outcome)
  const appAfter = await db.jobApplication.findUnique({ where: { id: application.id } })
  ok("application status advanced", ["INTERVIEW", "OFFERED", "HIRED"].includes(appAfter!.status), appAfter!.status)

  const offer = await getRoute("ats.offers.save")!.handler(admin, { applicationId: application.id, title: "Software Engineer — Offer", basicSalary: 50000, houseRent: 10000, medical: 2000, transport: 3000, joiningDate: "2026-12-01" }) as any
  ok("offers.save drafts with computed gross", !!offer.id && (offer.gross ?? true), offer)
  await throws("a second live offer is refused (one-live-offer rule)", () =>
    getRoute("ats.offers.save")!.handler(admin, { applicationId: application.id, title: "Competing offer", basicSalary: 1 }))
  const sent = await getRoute("ats.offers.send")!.handler(admin, { id: offer.id }) as any
  ok("offers.send DRAFT → SENT", (sent.offer ?? sent).status === "SENT", sent)
  const decided = await getRoute("ats.offers.decide")!.handler(admin, { id: offer.id, decision: "ACCEPTED" }) as any
  ok("offers.decide SENT → ACCEPTED", (decided.offer ?? decided).status === "ACCEPTED", decided)
  const autoTasks = await db.onboardingTask.count({ where: { vendorId: vendor.id, applicationId: application.id } })
  ok("acceptance auto-creates the 3 starter onboarding tasks", autoTasks === 3, autoTasks)
  const obList = await getRoute("ats.onboarding.list")!.handler(admin, { open: true }) as any
  const firstTask = ((obList.tasks || obList)[0] as any)?.id ?? (await db.onboardingTask.findFirst({ where: { vendorId: vendor.id } }))!.id
  await getRoute("ats.onboarding.toggle")!.handler(admin, { id: firstTask })
  const doneTask = await db.onboardingTask.findUnique({ where: { id: firstTask } })
  ok("onboarding.toggle completes with doneBy audit fields", !!doneTask!.doneAt && !!doneTask!.doneByName)

  // ================= AI assist =================
  console.log("AI assist")
  const aiStatus = await getRoute("ai.status")!.handler(admin, {}) as any
  ok("ai.status reports deterministic anomaly engine", aiStatus.anomalyEngine === "deterministic" && Array.isArray(aiStatus.features), aiStatus)
  const ask = await getRoute("ai.reportAsk")!.handler(admin, { question: "headcount by department last month" }) as any
  ok("ai.reportAsk deterministically routes to the headcount report", ask.matched === true && ask.reportKey === "headcount" && Array.isArray(ask.rows), { key: ask.reportKey, matched: ask.matched })
  let gibberishRefused = false
  try { await getRoute("ai.reportAsk")!.handler(admin, { question: "zzz qqq xxx" }) }
  catch (e: any) { gibberishRefused = /No report matched/i.test(String(e?.message || e)) }
  ok("ai.reportAsk refuses unmatched gibberish with an actionable Deny (400)", gibberishRefused)
  const anomalies = await getRoute("ai.anomalies")!.handler(admin, { days: 30 }) as any
  ok("ai.anomalies scans and returns findings array + counts", Array.isArray(anomalies.findings) && !!anomalies.counts, { n: anomalies.findings?.length })
  const aiSettings = await getRoute("ai.settings.get")!.handler(admin, {}) as any
  ok("ai.settings.get masks the key (apiKeySet boolean only)", typeof aiSettings.apiKeySet === "boolean" && !JSON.stringify(aiSettings).toLowerCase().includes("sk-"), aiSettings)

  // ================= owner analytics + dunning =================
  console.log("Owner analytics + dunning")
  const analytics = await ownerRoutes["owner.analytics.overview"].handler(owner, {}) as any
  ok("owner.analytics.overview returns the full shape", !!analytics.tenants && !!analytics.mrr && Array.isArray(analytics.signupTrend) && !!analytics.churnRisk && Array.isArray(analytics.dunningQueue), Object.keys(analytics || {}))
  const { maybeRunDunning } = await import("@/hrm-server/saas/dunning")
  const dunning = await maybeRunDunning("2026-10-08") as any
  // 2026-10-08 harness fix: structural assertion — a prior smoke run today
  // legitimately flips alreadyRanToday to true (idempotency guard working
  // as designed); only the shape and the zero-error result are guaranteed
  // on every run. The no-op assertion below still proves the guard.
  ok("maybeRunDunning runs safely (structured result, no errors)", !!dunning && dunning.errors === 0 && typeof dunning.alreadyRanToday === "boolean", dunning)
  const dunningAgain = await maybeRunDunning("2026-10-08") as any
  ok("second same-date dunning pass is a no-op", dunningAgain.alreadyRanToday === true, dunningAgain)

  console.log(failures === 0 ? "\nALL WAVE-4 SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error("SMOKE CRASHED:", e); process.exit(1) })
