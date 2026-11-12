/// <reference types="bun-types" />
// ============ Phase 4 — HR Reports & Analytics overhaul: GATING regressions ============
// Companion to phase4-hr-reports-exports.test.ts (filters / file contents /
// generation lane). This file pins the three access-control layers the
// overhaul added or changed:
//   G1 — catalog & metadata hygiene (business titles, categories, tiers,
//        internal defs never on the wire, AI catalogue title parity)
//   G2 — subscription tier gating (ADVANCED_REPORTS): LEGACY tenants keep
//        everything; a plan without the feature locks the advanced tier out
//        of the catalog, every render/export/generate lane, template saves,
//        the AI catalogue AND the scheduler's native structured lane (the
//        assertReportEntitlement export from routes/reports.ts)
//   G3 — export permissions: analytics.report.generate / renderCsv decide on
//        the definition's EXPORT pair (reports.view alone is not enough),
//        reports.attendanceOverviewCsv requires attendance.export, and the
//        PII report's generate lane requires reports.pii.export
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq, defaultCompanyId } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { listReportDefinitions } from "@/hrm-server/analytics-report"
import { REPORT_META, REPORT_CATEGORIES } from "@/hrm-server/report-meta"
import { AI_REPORT_CATALOGUE } from "@/hrm-server/routes/ai"
import { runReportTemplate, maybeRunScheduledReports } from "@/hrm-server/scheduled-reports"
import { invalidateEntitlements } from "@/hrm-server/saas/entitlements"

/** A vendor with an ACTIVE SaasSubscription on a plan whose advancedReports
 *  flag is set by the caller (the r3-5 wave pattern, including the
 *  entitlement-memo invalidation the existing suites perform). */
async function subscribedWorld(advancedReports: boolean) {
  const v = await mkVendor(uniq(advancedReports ? "finP4adv" : "finP4core"))
  const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P4 Owner" })
  const token = await mkSession(u.id, "FULL")
  const plan = await db.saasPlan.create({
    data: {
      name: uniq("P4 Plan"), monthlyPrice: 1, yearlyPrice: 12,
      employeeLimit: 50, userLimit: 10, branchLimit: 5, departmentLimit: 10,
      deviceLimit: 5, storageGb: 5, trackingEmployeeLimit: 10,
      payrollEnabled: true, aitEnabled: false, inventoryEnabled: false, procurementEnabled: false,
      performanceEnabled: false, essEnabled: true, cameraEnabled: false, trackingEnabled: false,
      geofenceEnabled: false, apiAccess: false, advancedReports, fieldForceEnabled: false,
    } as any,
  })
  await db.saasSubscription.create({
    data: {
      vendorId: v.id, planId: plan.id, planName: plan.name, billingCycle: "MONTHLY",
      status: "ACTIVE", startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000),
      priceAtCreation: 1,
    } as any,
  })
  invalidateEntitlements(v.id)
  return { v, u, token, plan }
}

// ---------------------------------------------------------------------- G1 ---
describe("G1 — catalog & metadata hygiene", () => {
  test("REPORT_META is the 51-entry business vocabulary (48 legacy keys + 3 natives), categories/tiers valid, internal only for paidPeriodRewrites", () => {
    const keys = Object.keys(REPORT_META)
    expect(keys.length).toBe(51)
    for (const [key, meta] of Object.entries(REPORT_META)) {
      expect(meta.title.length, `title of ${key}`).toBeGreaterThan(2)
      expect(meta.description.length, `description of ${key}`).toBeGreaterThan(10)
      expect(REPORT_CATEGORIES).toContain(meta.category)
      expect(["core", "advanced"]).toContain(meta.tier)
      expect(Array.isArray(meta.filters)).toBe(true)
      // no internal identifiers leaked into business-facing titles
      expect(meta.title.startsWith("Legacy report —")).toBe(false)
      expect(meta.title.includes(key)).toBe(false)
    }
    const internal = Object.entries(REPORT_META).filter(([, m]) => m.internal).map(([k]) => k)
    expect(internal).toEqual(["paidPeriodRewrites"])
    // the three natives the unified Reports surface is built on
    for (const k of ["workforce.headcount", "attendance.overview", "workforce.dashboard"]) {
      expect(keys).toContain(k)
    }
  })

  test("every registered definition carries the business metadata (title without the raw key, category, tier)", () => {
    const defs = listReportDefinitions()
    // 48 legacy adapter defs + the 3 native definitions
    expect(defs.length).toBe(51)
    expect(defs.filter((d) => d.reportId.startsWith("legacy.")).length).toBe(48)
    for (const d of defs) {
      expect(d.title.length, `title of ${d.reportId}`).toBeGreaterThan(2)
      expect(d.title.startsWith("Legacy report —"), `title of ${d.reportId}`).toBe(false)
      // the title must not echo the raw reportId / handler key back at the user
      expect(d.title.includes(d.reportId), `title of ${d.reportId}`).toBe(false)
      const bareKey = d.reportId.replace(/^legacy\./, "")
      expect(d.title.includes(bareKey), `title of ${d.reportId}`).toBe(false)
      expect(REPORT_CATEGORIES).toContain(d.category)
      expect(["core", "advanced"]).toContain(d.tier)
    }
    // the internal def is registered (scheduler/AI/templates only) and flagged
    const pii = defs.find((d) => d.reportId === "legacy.paidPeriodRewrites")
    expect(pii?.internal).toBe(true)
    expect(defs.filter((d) => d.internal).map((d) => d.reportId)).toEqual(["legacy.paidPeriodRewrites"])
  })

  test("analytics.report.catalog (LEGACY tenant): natives present, internal excluded, business titles, category/tier/filters on the wire", async () => {
    const v = await mkVendor(uniq("finP4cat"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P4 Cat Owner" })
    const token = await mkSession(u.id, "FULL")
    const r = await postHrm("analytics.report.catalog", {}, { bearer: token })
    expect(r.status).toBe(200)
    const defs = r.body.data.definitions as any[]
    const ids = defs.map((d) => d.reportId)
    // the 3 natives
    for (const id of ["workforce.headcount", "attendance.overview", "workforce.dashboard"]) {
      expect(ids).toContain(id)
    }
    // internal defs NEVER appear (nor as locked entries)
    expect(ids).not.toContain("legacy.paidPeriodRewrites")
    expect((r.body.data.lockedDefinitions as any[]).map((d) => d.reportId)).not.toContain("legacy.paidPeriodRewrites")
    // sample business titles
    expect(defs.find((d) => d.reportId === "legacy.employees")?.title).toBe("Employee Master List")
    expect(defs.find((d) => d.reportId === "legacy.attritionRate")?.title).toBe("Attrition Rate")
    expect(defs.find((d) => d.reportId === "workforce.dashboard")?.title).toBe("Workforce Dashboard")
    // the metadata rides the payload (category + tier + filter vocabulary)
    const employees = defs.find((d) => d.reportId === "legacy.employees")
    expect(employees.category).toBe("Employees")
    expect(employees.tier).toBe("core")
    expect(employees.filterFields).toContain("branchId")
    expect(employees.filters.branchId).toEqual({ type: "ref" })
    // a LEGACY tenant sees everything — nothing locked
    expect(r.body.data.lockedDefinitions).toEqual([])
  })

  test("the AI catalogue's titles are DERIVED from REPORT_META (spot-check)", () => {
    // employeesBiodata's AI literal was "Employee Biodata" — the derivation
    // upgrades it to the meta title, proving the two surfaces cannot disagree
    for (const key of ["employees", "attritionRate", "employeesBiodata", "payroll", "attendanceOvertime"]) {
      const entry = AI_REPORT_CATALOGUE.find((e) => e.key === key)
      expect(entry, `AI catalogue entry ${key}`).toBeTruthy()
      expect(entry!.title).toBe(REPORT_META[key]!.title)
    }
    expect(AI_REPORT_CATALOGUE.length).toBe(48)
  })
})

// ---------------------------------------------------------------------- G2 ---
describe("G2 — subscription tier gating (ADVANCED_REPORTS)", () => {
  test("LEGACY tenant (no SaasSubscription): advanced defs in the catalog, render + generate of an advanced report work", async () => {
    const v = await mkVendor(uniq("finP4leg"))
    const u = await mkUser(v.id, { role: "VENDOR_OWNER", name: "P4 Legacy Owner" })
    const token = await mkSession(u.id, "FULL")
    await mkEmployee2(v.id, "P4 Legacy Staff")

    const cat = await postHrm("analytics.report.catalog", {}, { bearer: token })
    expect(cat.status).toBe(200)
    const ids = (cat.body.data.definitions as any[]).map((d) => d.reportId)
    expect(ids).toContain("workforce.dashboard")
    expect(ids).toContain("legacy.attritionRate")
    expect(cat.body.data.lockedDefinitions).toEqual([])

    const renderLegacy = await postHrm("analytics.report.render", { reportId: "legacy.attritionRate", year: 2026 }, { bearer: token })
    expect(renderLegacy.status).toBe(200)
    expect(renderLegacy.body.data.title).toBe("Attrition Rate")

    const renderNative = await postHrm("analytics.report.render", { reportId: "workforce.dashboard" }, { bearer: token })
    expect(renderNative.status).toBe(200)
    expect(renderNative.body.data.reportId).toBe("workforce.dashboard")

    const gen = await postHrm("analytics.report.generate", { reportId: "workforce.headcount", format: "CSV" }, { bearer: token })
    expect(gen.status).toBe(200)
    expect(gen.body.data.jobId).toBeTruthy()

    // the AI catalogue is unfiltered for a LEGACY tenant: "attrition rate"
    // deterministically matches the advanced attritionRate report
    const ask = await postHrm("ai.reportAsk", { question: "attrition rate for 2026" }, { bearer: token })
    expect(ask.status).toBe(200)
    expect(ask.body.data.matched).toBe(true)
    expect(ask.body.data.reportKey).toBe("attritionRate")
  })

  test("ACTIVE plan with advancedReports=false: catalog EXCLUDES every advanced def and lists them in lockedDefinitions (title+category only)", async () => {
    const { token } = await subscribedWorld(false)
    const r = await postHrm("analytics.report.catalog", {}, { bearer: token })
    expect(r.status).toBe(200)
    const defs = r.body.data.definitions as any[]
    expect(defs.length).toBeGreaterThanOrEqual(30)
    expect(defs.every((d) => d.tier === "core")).toBe(true)
    expect(defs.map((d) => d.reportId)).toContain("legacy.employees")
    for (const id of ["workforce.dashboard", "workforce.headcount", "attendance.overview", "legacy.attritionRate"]) {
      expect(defs.map((d) => d.reportId)).not.toContain(id)
    }
    const locked = r.body.data.lockedDefinitions as any[]
    const lockedIds = locked.map((d) => d.reportId)
    expect(lockedIds).toContain("workforce.dashboard")
    expect(lockedIds).toContain("legacy.attritionRate")
    const dash = locked.find((d) => d.reportId === "workforce.dashboard")
    expect(dash.title).toBe("Workforce Dashboard")
    expect(dash.category).toBe("Workforce")
    // locked entries carry no descriptions — no product detail for what the
    // caller cannot use
    expect(Object.keys(dash).sort()).toEqual(["category", "reportId", "title"])
    // internal defs never appear on either side
    expect(lockedIds).not.toContain("legacy.paidPeriodRewrites")
  })

  test("same tenant: every advanced render/export/generate lane is DENIED with the upgrade message", async () => {
    const { token } = await subscribedWorld(false)
    const lanes: [string, any][] = [
      ["analytics.report.render", { reportId: "workforce.dashboard" }],
      ["analytics.report.renderCsv", { reportId: "workforce.dashboard" }],
      ["analytics.report.generate", { reportId: "workforce.dashboard", format: "PDF" }],
      ["reports.attritionRate", { year: 2026 }],
      ["reports.attritionRateCsv", { year: 2026 }],
    ]
    for (const [action, payload] of lanes) {
      const r = await postHrm(action, payload, { bearer: token })
      expect(r.status, `${action} → ${r.status}`).toBe(403)
      expect(String(r.body.error || "")).toContain("ADVANCED_REPORTS")
      expect(String(r.body.error || "")).toContain("not included in your")
    }
    // the AI catalogue is filtered too: with both attrition entries dropped
    // the question matches nothing and there is no LLM to fall back on
    const ask = await postHrm("ai.reportAsk", { question: "attrition rate for 2026" }, { bearer: token })
    expect(ask.status).toBe(400)
    expect(String(ask.body.error || "")).toContain("No report matched")
  })

  test("same tenant: CORE reports stay fully available (view + export)", async () => {
    const { token } = await subscribedWorld(false)
    const screen = await postHrm("reports.employees", {}, { bearer: token })
    expect(screen.status).toBe(200)
    expect(Array.isArray(screen.body.data.rows)).toBe(true)
    const render = await postHrm("analytics.report.render", { reportId: "legacy.employees" }, { bearer: token })
    expect(render.status).toBe(200)
    expect(render.body.data.title).toBe("Employee Master List")
    const csv = await postHrm("analytics.report.renderCsv", { reportId: "legacy.employees" }, { bearer: token })
    expect(csv.status).toBe(200)
    expect(String(csv.body.data.csv).startsWith("# Employee Master List")).toBe(true)
  })

  test("same tenant: reports.templates.save with an ADVANCED reportKey is denied", async () => {
    const { u, token } = await subscribedWorld(false)
    // the recipient is a tenant member, so the ONLY possible refusal is the tier
    for (const reportKey of ["workforce.dashboard", "attritionRate"]) {
      const r = await postHrm("reports.templates.save", {
        name: `P4 locked ${uniq()}`, reportKey, format: "PDF", schedule: "MONTHLY",
        recipients: [{ email: u.email }], active: true,
      }, { bearer: token })
      expect(r.status, `${reportKey} → ${r.status}`).toBe(403)
      expect(String(r.body.error || "")).toContain("ADVANCED_REPORTS")
    }
  })

  test("plan with advancedReports=true: advanced reports available again (catalog, render, generate, template save)", async () => {
    const { u, token } = await subscribedWorld(true)
    const cat = await postHrm("analytics.report.catalog", {}, { bearer: token })
    expect(cat.status).toBe(200)
    expect((cat.body.data.definitions as any[]).map((d) => d.reportId)).toContain("workforce.dashboard")
    expect(cat.body.data.lockedDefinitions).toEqual([])
    const render = await postHrm("analytics.report.render", { reportId: "workforce.dashboard" }, { bearer: token })
    expect(render.status).toBe(200)
    const gen = await postHrm("analytics.report.generate", { reportId: "workforce.headcount", format: "PDF" }, { bearer: token })
    expect(gen.status).toBe(200)
    expect(gen.body.data.jobId).toBeTruthy()
    const save = await postHrm("reports.templates.save", {
      name: `P4 unlocked ${uniq()}`, reportKey: "workforce.dashboard", format: "XLSX", schedule: "MONTHLY",
      recipients: [{ email: u.email }], active: true,
    }, { bearer: token })
    expect(save.status).toBe(200)
    expect(save.body.data.template.reportKey).toBe("workforce.dashboard")
  })

  test("scheduler gate (Task A): a scheduled NATIVE advanced report FAILS when the tenant lost ADVANCED_REPORTS — no silent legacy fallback", async () => {
    const { v, u } = await subscribedWorld(false)
    // saved BEFORE the plan downgrade (templates.save is gated now, so the row
    // is written directly — the realistic legacy of an entitled save)
    const t = await db.reportTemplate.create({
      data: { companyId: await defaultCompanyId(v.id),
        vendorId: v.id, reportKey: "workforce.dashboard", name: `P4 sched gate ${uniq()}`,
        filtersJson: "{}", format: "PDF", schedule: "MONTHLY",
        recipientsJson: JSON.stringify([{ email: u.email }]), active: true,
      },
    })
    // the structured lane throws the upgrade error instead of rendering
    await expect(runReportTemplate(v.id, t.id)).rejects.toThrow("ADVANCED_REPORTS")

    // the scheduler pass records the run through its FAILED outcome path
    // (a throwing run is not counted in the pass's return value — the
    // delivery log row below is the auditable outcome)
    await maybeRunScheduledReports(v.id, new Date().toISOString().slice(0, 10))
    const row = await db.reportTemplate.findUnique({ where: { id: t.id } })
    expect(row!.lastStatus).toBe("FAILED")
    expect(row!.retryCount).toBe(1) // bounded retry scheduled, not a month of silence
    const log = await db.reportDeliveryLog.findFirst({ where: { templateId: t.id }, orderBy: { startedAt: "desc" } })
    expect(log!.status).toBe("FAILED")
    expect(log!.format).toBe("PDF")
    expect(String(log!.detail)).toContain("ADVANCED_REPORTS")
    // the failure is the entitlement, NOT a bogus "unknown report key" from a
    // legacy-lane fallback that would mask the real cause
    expect(String(log!.detail)).not.toContain("unknown report key")
  })

  test("scheduler control (advancedReports=true): the same native template RENDERS and reaches the delivery stage", async () => {
    const { v, u } = await subscribedWorld(true)
    const t = await db.reportTemplate.create({
      data: { companyId: await defaultCompanyId(v.id),
        vendorId: v.id, reportKey: "workforce.dashboard", name: `P4 sched ok ${uniq()}`,
        filtersJson: "{}", format: "PDF", schedule: "MONTHLY",
        recipientsJson: JSON.stringify([{ email: u.email }]), active: true,
      },
    })
    const out = await runReportTemplate(v.id, t.id)
    // the render succeeded; the run stops at the (unconfigured) email gateway
    expect(out.status).toBe("SKIPPED")
    expect(String(out.detail)).toContain("email gateway")
    expect(String(out.detail)).not.toContain("ADVANCED_REPORTS")
    const log = await db.reportDeliveryLog.findFirst({ where: { templateId: t.id }, orderBy: { startedAt: "desc" } })
    expect(log!.format).toBe("PDF")
  })
})

// ---------------------------------------------------------------------- G3 ---
describe("G3 — export permissions (dedicated pair, not reports.view)", () => {
  test("analytics.report.generate: reports.view alone is DENIED; reports.export is accepted (job queued)", async () => {
    const v = await mkVendor(uniq("finP4exp"))
    await mkEmployee2(v.id, "P4 Export Staff")
    const viewer = await mkUser(v.id, { role: "HR_MANAGER", name: "P4 ViewOnly", permissions: ["reports.view"] })
    const viewerToken = await mkSession(viewer.id, "FULL")
    const exporter = await mkUser(v.id, { role: "HR_MANAGER", name: "P4 Exporter", permissions: ["reports.view", "reports.export"] })
    const exporterToken = await mkSession(exporter.id, "FULL")

    // the viewer can still RENDER on screen (view pair)…
    const screen = await postHrm("analytics.report.render", { reportId: "legacy.employees" }, { bearer: viewerToken })
    expect(screen.status).toBe(200)
    // …but generation is an EXPORT lane: reports.view must not produce a file
    const denied = await postHrm("analytics.report.generate", { reportId: "legacy.employees", format: "CSV" }, { bearer: viewerToken })
    expect(denied.status).toBe(403)
    expect(String(denied.body.error || "")).toContain("reports.export")

    const ok = await postHrm("analytics.report.generate", { reportId: "legacy.employees", format: "CSV" }, { bearer: exporterToken })
    expect(ok.status).toBe(200)
    expect(ok.body.data.jobId).toBeTruthy()
  })

  test("analytics.report.renderCsv: gated on the export pair (view-only caller denied, exporter served)", async () => {
    const v = await mkVendor(uniq("finP4csv"))
    await mkEmployee2(v.id, "P4 Csv Staff")
    const viewer = await mkUser(v.id, { role: "HR_MANAGER", name: "P4 Csv ViewOnly", permissions: ["reports.view"] })
    const viewerToken = await mkSession(viewer.id, "FULL")
    const exporter = await mkUser(v.id, { role: "HR_MANAGER", name: "P4 Csv Exporter", permissions: ["reports.view", "reports.export"] })
    const exporterToken = await mkSession(exporter.id, "FULL")

    const denied = await postHrm("analytics.report.renderCsv", { reportId: "legacy.employees" }, { bearer: viewerToken })
    expect(denied.status).toBe(403)
    expect(String(denied.body.error || "")).toContain("reports.export")

    const ok = await postHrm("analytics.report.renderCsv", { reportId: "legacy.employees" }, { bearer: exporterToken })
    expect(ok.status).toBe(200)
    expect(String(ok.body.data.csv).startsWith("# Employee Master List")).toBe(true)
  })

  test("reports.attendanceOverviewCsv now requires attendance.export (view-only caller denied, view twin intact)", async () => {
    const v = await mkVendor(uniq("finP4att"))
    await mkEmployee2(v.id, "P4 Attendance Staff")
    const viewer = await mkUser(v.id, { role: "EMPLOYEE", name: "P4 Att Viewer", permissions: ["attendance.view"] })
    const viewerToken = await mkSession(viewer.id, "FULL")
    const exporter = await mkUser(v.id, { role: "EMPLOYEE", name: "P4 Att Exporter", permissions: ["attendance.view", "attendance.export"] })
    const exporterToken = await mkSession(exporter.id, "FULL")

    // the on-screen overview still works for the view-only caller
    const screen = await postHrm("reports.attendanceOverview", {}, { bearer: viewerToken })
    expect(screen.status).toBe(200)
    // the CSV twin is export-gated now
    const denied = await postHrm("reports.attendanceOverviewCsv", {}, { bearer: viewerToken })
    expect(denied.status).toBe(403)
    expect(String(denied.body.error || "")).toContain("attendance.export")

    const ok = await postHrm("reports.attendanceOverviewCsv", {}, { bearer: exporterToken })
    expect(ok.status).toBe(200)
    expect(typeof ok.body.data.csv).toBe("string")
  })

  test("PII report generate lane: reports.pii.export decides (reports.export alone is not enough)", async () => {
    const v = await mkVendor(uniq("finP4pii"))
    await mkEmployee2(v.id, "P4 Pii Subject")
    const plainExporter = await mkUser(v.id, { role: "HR_MANAGER", name: "P4 NoPii", permissions: ["reports.view", "reports.export"] })
    const plainToken = await mkSession(plainExporter.id, "FULL")
    const piiViewer = await mkUser(v.id, { role: "HR_MANAGER", name: "P4 PiiViewer", permissions: ["reports.view", "reports.pii.view"] })
    const piiViewerToken = await mkSession(piiViewer.id, "FULL")
    const piiExporter = await mkUser(v.id, { role: "HR_MANAGER", name: "P4 PiiExporter", permissions: ["reports.view", "reports.export", "reports.pii.export"] })
    const piiExporterToken = await mkSession(piiExporter.id, "FULL")

    // generate: plain export permission cannot take bulk PII off the wire
    const denied = await postHrm("analytics.report.generate", { reportId: "legacy.employeesBiodata", format: "PDF" }, { bearer: plainToken })
    expect(denied.status).toBe(403)
    expect(String(denied.body.error || "")).toContain("reports.pii.export")
    // renderCsv: the pii.view holder can see it on screen but not export
    const deniedCsv = await postHrm("analytics.report.renderCsv", { reportId: "legacy.employeesBiodata" }, { bearer: piiViewerToken })
    expect(deniedCsv.status).toBe(403)
    expect(String(deniedCsv.body.error || "")).toContain("reports.pii.export")

    // the pii.export pair carries both lanes
    const ok = await postHrm("analytics.report.generate", { reportId: "legacy.employeesBiodata", format: "CSV" }, { bearer: piiExporterToken })
    expect(ok.status).toBe(200)
    expect(ok.body.data.jobId).toBeTruthy()
    const okCsv = await postHrm("analytics.report.renderCsv", { reportId: "legacy.employeesBiodata" }, { bearer: piiExporterToken })
    expect(okCsv.status).toBe(200)
    expect(String(okCsv.body.data.csv).startsWith("# Employee Biodata (Confidential)")).toBe(true)
  })
})

/** A minimal employee row (mkEmployee without the fixture's fixed defaults). */
async function mkEmployee2(vendorId: string, fullName: string) {
  return db.employee.create({
    data: { companyId: await defaultCompanyId(vendorId),
      vendorId, fullName, code: uniq("E"),
      joiningDate: "2025-01-01", employmentType: "PERMANENT", status: "ACTIVE",
    },
  })
}
