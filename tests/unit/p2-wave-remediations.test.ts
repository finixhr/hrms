/// <reference types="bun-types" />
// ============ P2 wave (audit report Ch.16 Table 8, 2026-11-09) ============
// Source-invariant + functional regressions for the P2 remediations that are
// not already covered by their own dedicated suites:
//   · SEC-9  — static pre-paint script (public/prepaint.js) pinned to the
//              PREPAINT_SCRIPT constant; the layout loads the FILE, not an
//              inline blob; the shipped CSP comment matches the shipped policy
//   · DBD-2  — the six FK indexes exist in the live schema
//   · UXD-*  — source invariants for the frontend trust/a11y fixes (see the
//              individual describe blocks; behavior tests where testable)
//   · PRF-11/13 — caching + code-splitting wiring invariants
// UI findings are verified the same way the L-3 totp invariant is: the
// regression class is "the fix silently reverts", which a source invariant
// catches exactly.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { db } from "@/lib/db"
import { PREPAINT_SCRIPT } from "@/lib/prepaint-script"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8")

// ---------------------------------------------------------------------------
describe("SEC-9 — pre-paint script ships as a static self-hosted file", () => {
  test("public/prepaint.js exists and is byte-pinned to PREPAINT_SCRIPT", () => {
    const file = read("public/prepaint.js").trim()
    expect(file).toBe(PREPAINT_SCRIPT)
  })

  test("the root layout loads the FILE from <head>, not an inline blob", () => {
    const layout = read("src/app/layout.tsx")
    expect(layout).toContain('<script src="/prepaint.js" />')
    // the inline-injection pattern must be gone (the PREPAINT constant is no
    // longer interpolated into the document)
    expect(layout).not.toContain("__html: PREPAINT_SCRIPT")
    expect(layout).not.toMatch(/dangerouslySetInnerHTML=\{\{/)  
  })

  test("the prepaint constant documents the regeneration command", () => {
    const src = read("src/lib/prepaint-script.ts")
    expect(src).toContain("public/prepaint.js")
    expect(src).toContain("writeFileSync")
  })

  test("next.config.ts no longer claims a nonce-based CSP", () => {
    const cfg = read("next.config.ts")
    // the stale claim was "it is now NONCE-BASED (no more 'unsafe-inline')"
    expect(cfg).not.toMatch(/NONCE-BASED/i)
    // the corrected comment points at the real policy location
    expect(cfg).toContain("src/proxy.ts")
    expect(cfg).toContain("'unsafe-inline'")
  })
})

// ---------------------------------------------------------------------------
describe("DBD-2 — the six FK indexes exist on the live schema", () => {
  test("SaaSPayment.invoiceId / SaaSInvoice.subscriptionId / Employee.designationId", async () => {
    const rows = await db.$queryRawUnsafe(`
      SELECT indexname FROM pg_indexes WHERE indexname IN (
        'SaaSPayment_invoiceId_idx', 'SaaSInvoice_subscriptionId_idx', 'Employee_designationId_idx'
      )`)
    const names = (rows as any[]).map((r) => r.indexname)
    expect(names).toContain("SaaSPayment_invoiceId_idx")
    expect(names).toContain("SaaSInvoice_subscriptionId_idx")
    expect(names).toContain("Employee_designationId_idx")
  })

  test("SaaSSubscription.vendorId / SaaSRegistration.planId / CommissionThreshold.importId", async () => {
    const rows = await db.$queryRawUnsafe(`
      SELECT indexname FROM pg_indexes WHERE indexname IN (
        'SaaSSubscription_vendorId_idx', 'SaaSRegistration_planId_idx', 'CommissionThreshold_importId_idx'
      )`)
    const names = (rows as any[]).map((r) => r.indexname)
    expect(names).toContain("SaaSSubscription_vendorId_idx")
    expect(names).toContain("SaaSRegistration_planId_idx")
    expect(names).toContain("CommissionThreshold_importId_idx")
  })

  test("the additive migration exists and is idempotent (IF NOT EXISTS)", () => {
    const mig = "prisma/migrations/9_wave9zzai_fk_index_coverage_20261109/migration.sql"
    expect(existsSync(join(REPO_ROOT, mig))).toBe(true)
    const sql = read(mig)
    expect(sql.match(/^CREATE INDEX IF NOT EXISTS/gm)?.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
describe("DBD-1 — paisa migration completion (lint + backfill)", () => {
  test("the money-column lint runs clean on the current schema", () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "lint-money-columns.mjs")], { encoding: "utf8", timeout: 30_000 })
    expect(r.status).toBe(0)
    expect(String(r.stdout)).toContain("no new Float money columns")
  })

  test("the lint REJECTS a new Float money column (the guard actually guards)", () => {
    const schemaPath = join(REPO_ROOT, "prisma", "schema.prisma")
    const original = readFileSync(schemaPath, "utf8")
    try {
      // plant an un-reviewed Float money column and expect the lint to fail
      const poisoned = original.replace(
        "  thresholdAmount Float    @default(0) // Minimum target revenue in BDT",
        "  thresholdAmount Float    @default(0) // Minimum target revenue in BDT\n  lintProbeMoney Float @default(0)",
      )
      expect(poisoned).not.toBe(original) // the anchor matched
      writeFileSync(schemaPath, poisoned)
      const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "lint-money-columns.mjs")], { encoding: "utf8", timeout: 30_000 })
      expect(r.status).toBe(1)
      expect(String(r.stderr)).toContain("CommissionThreshold.lintProbeMoney")
    } finally {
      writeFileSync(schemaPath, original)
    }
  })

  test("the lint ACCEPTS a reviewed float-ok opt-out", () => {
    const schemaPath = join(REPO_ROOT, "prisma", "schema.prisma")
    const original = readFileSync(schemaPath, "utf8")
    try {
      const poisoned = original.replace(
        "  thresholdAmount Float    @default(0) // Minimum target revenue in BDT",
        "  thresholdAmount Float    @default(0) // Minimum target revenue in BDT\n  lintProbeRatio Float @default(0) // float-ok: a ratio, not money",
      )
      writeFileSync(schemaPath, poisoned)
      const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "lint-money-columns.mjs")], { encoding: "utf8", timeout: 30_000 })
      expect(r.status).toBe(0)
      expect(String(r.stdout)).toContain("1 float-ok opt-out")
    } finally {
      writeFileSync(schemaPath, original)
    }
  })

  test("the backfill migration covers all 28 paisa pairs and is idempotent", () => {
    const sql = read("prisma/migrations/9_wave9zzaj_paisa_backfill_20261109/migration.sql")
    const updates = sql.match(/^UPDATE /gm)?.length ?? 0
    expect(updates).toBe(28) // 10 structure + 6 run + 12 entry
    // every statement is guarded (WHERE paisa IS NULL) → replay-safe
    expect(sql.match(/Paisa" IS NULL/gm)?.length).toBe(28)
  })

  test("existing paisa data survives the backfill untouched (idempotent replay on a seeded row)", async () => {
    // a row written by the engine carries paisa; re-running the backfill's
    // rule must not overwrite it (the WHERE guard)
    const { mkVendor, mkUser, mkEmployee, defaultCompanyId } = await import("./_fixtures")
    const v = await mkVendor("DBD1 Backfill", { company: false })
    const u = await mkUser(v.id, { role: "HR_ADMIN" })
    const e = await mkEmployee(v.id, {})
    const { toPaisa } = await import("@/hrm-server/money")
    await db.salaryStructure.create({
      data: {
        vendorId: v.id, employeeId: e.id, effectiveFrom: "2026-01-01",
        basic: 50000, gross: 50000, status: "ACTIVE",
        basicPaisa: toPaisa(50000), grossPaisa: toPaisa(50000),
      } as any,
    })
    // apply the migration's rule manually: paisa stays authoritative
    await db.$executeRawUnsafe(`UPDATE "SalaryStructure" SET "basicPaisa" = ROUND("basic" * 100) WHERE "basicPaisa" IS NULL AND "basic" IS NOT NULL`)
    const row = await db.salaryStructure.findFirst({ where: { vendorId: v.id } })
    expect(row?.basicPaisa).toBe(toPaisa(50000))
  })
})

// ---------------------------------------------------------------------------
describe("PRF-11 — marketing-site caching with tag invalidation", () => {
  test("the CMS loaders read through unstable_cache with tags + a revalidate floor", () => {
    const cms = read("src/hrm-server/saas/cms.ts")
    expect(cms).toContain('unstable_cache, revalidateTag')
    // five loaders wrapped (settings, pages, features, clients, testimonials)
    expect(cms.match(/reactCache\(unstable_cache\(/g)?.length).toBe(5)
    // tags + the 300s staleness floor
    expect(cms).toContain('export const CMS_SETTINGS_TAG = "cms-site-settings"')
    expect(cms).toContain('export const CMS_CONTENT_TAG = "cms-content"')
    expect(cms.match(/revalidate: 300/g)?.length).toBe(5)
  })

  test("invalidateCmsCache revalidates both tags (the save-path choke point)", () => {
    const cms = read("src/hrm-server/saas/cms.ts")
    expect(cms).toContain('export function invalidateCmsCache()')
    expect(cms.match(/revalidateTag\((tag|CMS_SETTINGS_TAG|SAAS_PLANS_TAG), "max"\)/g)?.length).toBe(3)
  })

  test("the owner CMS routes still route saves through invalidateCmsCache", () => {
    const routes = read("src/hrm-server/saas/cms-routes.ts")
    expect(routes.match(/invalidateCmsCache\(\)/g)?.length).toBeGreaterThanOrEqual(10)
  })

  test("owner general-settings and plan changes bust their public caches", () => {
    const routes = read("src/hrm-server/saas/owner-routes.ts")
    expect(routes).toContain('invalidateSiteSettingsCache()')
    expect((routes.match(/invalidatePlansCache\(\)/g) || []).length).toBeGreaterThanOrEqual(3)
  })

  test("no (public) page forces per-request rendering anymore (static + tag revalidation)", () => {
    const { globSync } = require("node:fs") as typeof import("node:fs")
    const pages = globSync("src/app/(public)/**/*.tsx")
    expect(pages.length).toBeGreaterThan(10)
    for (const p of pages) {
      expect(read(p)).not.toContain('export const dynamic = "force-dynamic"')
    }
  })

  test("the pricing page reads plans through unstable_cache under the plans tag", () => {
    const pricing = read("src/app/(public)/pricing/page.tsx")
    expect(pricing).toContain("unstable_cache(")
    expect(pricing).toContain("SAAS_PLANS_TAG")
  })
})

// ---------------------------------------------------------------------------
describe("PRF-13 — owner console code-splitting", () => {
  test("the owner dashboard no longer statically imports recharts", () => {
    const page = read("src/app/owner/(console)/page.tsx")
    expect(page).not.toMatch(/from "recharts"/)
    expect(page).toContain('import("./dashboard-charts")')
    expect(page).toContain("ssr: false")
    // the chart cards moved to their own chunk
    const charts = read("src/app/owner/(console)/dashboard-charts.tsx")
    expect(charts).toContain('from "recharts"')
    expect(charts).toContain("export function DashboardCharts")
  })

  test("the storage console chart is dynamically imported", () => {
    const page = read("src/app/owner/(console)/storage/page.tsx")
    expect(page).not.toMatch(/from "recharts"/)
    expect(page).toContain('import("./storage-trend-chart")')
    expect(read("src/app/owner/(console)/storage/storage-trend-chart.tsx")).toContain("StorageTrendChart")
  })

  test("owner settings code-splits the heavy tabs (studio, integrations, WebAuthn)", () => {
    const page = read("src/app/owner/(console)/settings/page.tsx")
    // no static imports of the heavy modules
    expect(page).not.toContain('import { WebsiteStudio } from "@/saas/owner/website-studio"')
    expect(page).not.toContain('import { PaymentsTab, StorageTab } from "@/saas/owner/integrations-panel"')
    expect(page).not.toContain('from "@simplewebauthn/browser"')
    // all four ride next/dynamic
    expect(page.match(/dynamic\(\(\) => import\(/g)?.length).toBe(4)
    // the passkey card (with the WebAuthn lib) lives in its own chunk
    const card = read("src/app/owner/(console)/settings/account-passkeys-card.tsx")
    expect(card).toContain('from "@simplewebauthn/browser"')
    expect(card).toContain("MyAccountPasskeysCard")
  })
})

// ---------------------------------------------------------------------------
describe("UXD-1..10 — frontend trust, a11y and delivery fixes", () => {
  test("UXD-1 — ESS navigation is grouped (five sections, not sixteen peer chips)", () => {
    const ess = read("src/hrm/views/ess.tsx")
    expect(ess).toContain("TAB_GROUPS")
    expect(ess).toContain('label: "Me"')
    expect(ess).toContain('label: "Time"')
    expect(ess).toContain('label: "Money"')
    expect(ess).toContain('label: "Work"')
    expect(ess).toContain('label: "Records"')
    expect(ess).toContain('role="tablist"')
    expect(ess).toContain("aria-controls={`ess-tabpanel-")
    // the old flat strip is gone
    expect(ess).not.toContain("const TABS: { key: string; label: string }[] = [")
  })

  test("UXD-2 — photo affordances are touch-visible; the instant-change badge is 44px", () => {
    const emp = read("src/hrm/views/employees.tsx")
    // overlays: always visible below lg, hover-reveal from lg up
    expect(emp).toContain("opacity-100 lg:opacity-0 lg:group-hover:opacity-100")
    // the fallback badge grew from h-6 w-6 (24px) to h-11 w-11 (44px)
    expect(emp).not.toContain("h-6 w-6 rounded-full shadow-xs")
    expect(emp).toContain("h-11 w-11 rounded-full shadow-xs")
    // the shell's icon controls are 44px below md
    const shell = read("src/hrm/app-shell.tsx")
    expect(shell).toContain("h-11 w-11 md:h-8 md:w-8")
  })

  test("UXD-3 — payslips are served as PDFs (routes + client downloads)", () => {
    const payroll = read("src/hrm-server/routes/payroll.ts")
    expect(payroll).toContain('route("payslips.pdf"')
    const ess = read("src/hrm-server/routes/ess.ts")
    expect(ess).toContain('route("ess.payroll.pdf"')
    // the renderer exists and uses the shared corporate PDF kit
    const pdf = read("src/hrm-server/payslip-pdf.ts")
    expect(pdf).toContain("renderPayslipPdf")
    expect(pdf).toContain("drawFinixHeader")
    // both client surfaces offer the download
    expect(read("src/hrm/views/ess.tsx")).toContain('downloadPdf("ess.payroll.pdf"')
    expect(read("src/hrm/views/payroll.tsx")).toContain('"payslips.pdf"')
  })

  test("UXD-4 — the Bangla dictionary covers the admin money screens", () => {
    const i18n = read("src/hrm/i18n.tsx")
    expect(i18n).toContain('"Deductions": "কর্তন"')
    expect(i18n).toContain('"Net Pay": "নিট বেতন"')
    expect(i18n).toContain('"Installment": "কিস্তি"')
    expect(i18n).toContain('"Journal": "জার্নাল"')
    expect(i18n).toContain('"VAT": "ভ্যাট"')
    expect(i18n).toContain("UXD-4 (P2 wave, 2026-11-09) — ADMIN MONEY SCREENS")
  })

  test("UXD-5 — SelfieViewer is a Radix Dialog; tab strips have tablist semantics; settings fields are labeled", () => {
    const kit = read("src/hrm/shared/ui-kit.tsx")
    expect(kit).toContain("<Dialog open={!!selfie}")
    expect(kit).toContain("DialogTitle")
    expect(kit).not.toMatch(/fixed inset-0 z-50 bg-black\/60/)
    // SectionTabs grouped mode: tablist + aria-controls + tabpanel ids
    expect(kit).toContain('aria-controls={`tabpanel-${t.value}`}')
    expect(kit).toContain('id={`tabpanel-${t.value}`}')
    // owner settings: the F wrapper wires label→htmlFor
    const settings = read("src/app/owner/(console)/settings/page.tsx")
    expect(settings).toContain("htmlFor={id}")
  })

  test("UXD-6 — owner settings reports failures through the inline toast, not alert()", () => {
    const settings = read("src/app/owner/(console)/settings/page.tsx")
    expect(settings).not.toMatch(/\balert\(/)
    expect(settings).toContain("useConsoleToast")
    expect(settings).toContain("{toast.node}")
    // the hook itself is shared (not copy-pasted per page)
    expect(read("src/saas/owner/console-toast.tsx")).toContain("export function useConsoleToast()")
  })

  test("UXD-7 — lookup retry re-runs the RPCs instead of reloading the SPA", () => {
    const emp = read("src/hrm/views/employees.tsx")
    expect(emp).not.toContain("window.location.reload()")
    expect(emp).toContain("setLookupNonce((n) => n + 1)")
    expect(emp).toContain("[lookupNonce]")
  })

  test("UXD-8 — DataTable supports responsive column priority and the dense views use it", () => {
    const table = read("src/hrm/shared/data-table.tsx")
    expect(table).toContain('hideBelow?: "sm" | "md" | "lg" | "xl"')
    expect(table).toContain('md: "hidden md:table-cell"')
    for (const [f, marker] of [
      ["src/hrm/views/accounting.tsx", 'hideBelow: "lg", label: "Memo"'],
      ["src/hrm/views/ait.tsx", 'hideBelow: "md", label: "Annual gross"'],
      ["src/hrm/views/billing.tsx", 'hideBelow: "md", label: "Period"'],
      ["src/hrm/views/bonuses.tsx", 'hideBelow: "lg",'],
      ["src/hrm/views/inventory.tsx", 'hideBelow: "lg", label: "Warehouse Stock"'],
    ] as [string, string][]) {
      expect(read(f)).toContain(marker)
    }
  })

  test("UXD-9 — the dirty-form guard uses ConfirmDialog; money columns pin paisa precision", () => {
    const fd = read("src/hrm/shared/form-dialog.tsx")
    expect(fd).not.toContain("window.confirm(")
    expect(fd).toContain("discardOpen")
    // fmtMoneyPaise exists and the money views use it
    const kit = read("src/hrm/shared/ui-kit.tsx")
    expect(kit).toContain("export function fmtMoneyPaise")
    for (const f of ["src/hrm/views/payroll.tsx", "src/hrm/views/ess.tsx", "src/hrm/views/loans.tsx", "src/hrm/views/accounting.tsx"]) {
      expect(read(f)).toContain("fmtMoneyPaise(")
    }
  })

  test("UXD-10 — the owner auth screens brand from settings, not a hardcoded string", () => {
    const authUi = read("src/saas/owner/auth-ui.tsx")
    expect(authUi).toContain("owner.auth.branding")
    expect(authUi).toContain('{brand?.platformName || "Finix HR"}')
    // a public pre-auth action serves it (no session required)
    const route = read("src/app/api/owner/route.ts")
    expect(route).toContain('"owner.auth.branding"')
  })
})

// ---------------------------------------------------------------------------
describe("TST-1 + OPS-5/6/7 — the UI lane, production e2e, thresholds and pins", () => {
  test("TST-1 — the Playwright login-to-punch smoke exists and rides the e2e lane", () => {
    const spec = read("tests/e2e-ui/smoke.spec.ts")
    expect(spec).toContain("Geo Check-In records a punch")
    expect(spec).toContain('includes("geofence"))')
    expect(spec).toContain("geolocation")
    const cfg = read("playwright.config.ts")
    expect(cfg).toContain("testDir: \"./tests/e2e-ui\"")
    expect(cfg).toContain("geolocation: { latitude: 23.7808")
    // the dependency is a devDependency (browsers are an install-time concern)
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.devDependencies["@playwright/test"]).toBeTruthy()
  })

  test("TST-1 — the e2e bootstrap provisions a geofenced branch + company context", () => {
    const bs = read("tests/e2e/_bootstrap.ts")
    // OPS-5 — the multi-company gate fix (company + access rows)
    expect(bs).toContain("No active company")
    expect(bs).toContain("userCompanyAccess.create")
    // the punch fence
    expect(bs).toContain("geofenceRadius: 300")
    expect(bs).toContain("latitude: 23.7808")
  })

  test("OPS-5 — e2e.sh boots the standalone PRODUCTION build on demand; the UI smoke precedes the journeys", () => {
    const sh = read("scripts/e2e.sh")
    expect(sh).toContain('E2E_BUILD="${E2E_BUILD:-dev}"')
    expect(sh).toContain("bun run build")
    expect(sh).toContain("bun .next/standalone/server.js")
    // the paid-period lock (FIN-005) means the punch must happen before the
    // payroll journey pays — the UI smoke runs FIRST
    expect(sh.indexOf("playwright test")).toBeLessThan(sh.indexOf("journeys.test.ts"))
    // the legacy dead-account lane is a wrapper around the maintained one
    const legacy = read("scripts/e2e-test.sh")
    expect(legacy).toContain("e2e.sh")
    expect(legacy).not.toContain("finixhr.com")
  })

  test("OPS-5 — ci.sh runs the e2e lane against the production build", () => {
    const ci = read("scripts/ci.sh")
    expect(ci).toContain('E2E_BUILD="${E2E_BUILD:-prod}" bash scripts/e2e.sh')
  })

  test("OPS-7 — the coverage threshold gate runs inside stage 3", () => {
    const ci = read("scripts/ci.sh")
    expect(ci).toContain("coverage-gate.mjs")
    expect(ci).toContain("--coverage-reporter=text")
    const gate = read("scripts/coverage-gate.mjs")
    expect(gate).toContain("const FLOOR = 60.0")
    expect(gate).toMatch(/65\.73/) // the measured baseline is documented in the header
  })

  test("OPS-7 — the xlsx integrity pin defaults in-file and FAILS on mismatch", () => {
    const deps = read("scripts/audit-deps.sh")
    expect(deps).toContain("PINNED_XLSX_MJS_SHA256=")
    // a mismatch is fatal (the audit found a WARN-only pin): the FAIL branch
    // carries exit 1 before the block closes
    const failAt = deps.indexOf("FAIL: xlsx SHA-256 mismatch")
    expect(failAt).toBeGreaterThan(-1)
    expect(deps.indexOf("exit 1", failAt)).toBeGreaterThan(failAt)
    // env override remains for deliberate version bumps only
    expect(deps).toContain('HRM_XLSX_SHA256:-$PINNED_XLSX_MJS_SHA256')
  })
})

// ---------------------------------------------------------------------------
describe("UXD-3 — the payslip PDF renderer produces a real PDF", () => {
  test("renderPayslipPdf emits a %PDF document with the payslip's money table", async () => {
    const { mkVendor, mkUser, mkEmployee } = await import("./_fixtures")
    const v = await mkVendor("P2 PayslipPDF")
    const u = await mkUser(v.id, { role: "HR_ADMIN" })
    const e = await mkEmployee(v.id, {})
    const run = await db.payrollRun.create({
      data: { companyId: await (await import("./_fixtures")).defaultCompanyId(v.id), vendorId: v.id, periodMonth: 11, periodYear: 2026, frequency: "MONTHLY", runType: "REGULAR", status: "PAID", paymentDate: "2026-11-05" } as any,
    })
    const entry = await db.payrollEntry.create({
      data: {
        vendorId: v.id, runId: run.id, employeeId: e.id, status: "INCLUDED",
        payslipNumber: "PS-202611-0042",
        gross: 47000, otAmount: 0, bonus: 1500, commission: 0,
        absenceDeduction: 0, lateDeduction: 0, loanDeduction: 4000, advanceDeduction: 0,
        otherDeduction: 250, guarantorDeduction: 0, ait: 500, net: 43750,
        breakdownJson: JSON.stringify({
          earnings: [{ label: "Basic", amount: 30000 }, { label: "House Rent", amount: 12000 }],
          deductions: [{ label: "Loan installment", amount: 4000 }],
          attendance: { presentDays: 22, absentDays: 0, leaveDays: 0, otMinutes: 0 },
        }),
      } as any,
    })
    const { getPayslipContext } = await import("@/hrm-server/payslip")
    const { renderPayslipPdf } = await import("@/hrm-server/payslip-pdf")
    const ctx = await getPayslipContext(v.id, entry.id)
    expect(ctx).toBeTruthy()
    const pdf = await renderPayslipPdf(ctx as any)
    const buf = Buffer.from(pdf)
    // a real PDF: header magic + EOF marker + non-trivial size
    expect(buf.slice(0, 5).toString()).toBe("%PDF-")
    expect(buf.slice(-1024).toString()).toContain("%%EOF")
    expect(buf.length).toBeGreaterThan(2500)
    // content streams are Flate-compressed — the text assertions ride the
    // DECOMPRESSED page stream instead (WinAnsi-encoded: the payslip number
    // and the BDT money prefix; the taka glyph cannot ride WinAnsi fonts —
    // same discipline as the invoice/receipt/mushak PDFs)
    const zlib = await import("node:zlib")
    let allText = ""
    const streamRe = /stream\r?\n([\s\S]*?)endstream/g
    let sm: RegExpExecArray | null
    while ((sm = streamRe.exec(buf.toString("latin1"))) !== null) {
      try { allText += zlib.inflateSync(Buffer.from(sm[1], "latin1")).toString("latin1") } catch { /* not a flate stream */ }
    }
    // pdf-lib draws text as hex-encoded strings (<...> Tj) — decode them
    let plain = ""
    const hexRe = /<([0-9A-Fa-f\s]+)>\s*Tj/g
    let hm: RegExpExecArray | null
    while ((hm = hexRe.exec(allText)) !== null) {
      try { plain += Buffer.from(hm[1].replace(/\s+/g, ""), "hex").toString("latin1") + "\n" } catch { /* odd-length run */ }
    }
    expect(plain).toContain("PS-202611-0042")
    expect(plain).toContain("BDT 30,000.00")
    expect(plain).toContain("BDT 43,750.00") // the NET band
    expect(plain).toContain("Loan installment")
    void u
  })
})
