/// <reference types="bun-types" />
// ============ Unit tests — Global Search (static index, matchers, ranking) ============
// Covers the pure pieces: query normalization, relevance scoring, category
// ranking, permission/module/ESS gating of navigation results, and the
// deep-link payloads (view + tab) that palette selections navigate to.
import { test, expect, describe } from "bun:test"
import { searchStatic, targetVisible, NAV_INDEX, TAB_INDEX, type SearchTarget } from "@/hrm/search-index"
import { normalizeQuery, scoreText, rankByRelevance, MIN_QUERY, MAX_QUERY } from "@/hrm-server/search-rank"

// a permissive context (admin-like) and restricted contexts for gating tests
const allowAll = { can: () => true, hasEmployeeId: true, isEmployeeOnly: false, hiddenModules: new Set<string>() }
const allowNone = { can: () => false, hasEmployeeId: false, isEmployeeOnly: false, hiddenModules: new Set<string>() }
const noPayroll = { ...allowAll, can: (m: string, a: string) => !(m === "payroll" || m === "ait" || m === "bonus" || m === "payslip") && !(m === "employees") }

describe("normalizeQuery", () => {
  test("trims and collapses inner whitespace", () => {
    expect(normalizeQuery("  rahim   uddin  ")).toBe("rahim uddin")
  })
  test("caps at MAX_QUERY characters", () => {
    expect(normalizeQuery("a".repeat(500)).length).toBe(MAX_QUERY)
  })
  test("nullish and non-string input becomes empty", () => {
    expect(normalizeQuery(null)).toBe("")
    expect(normalizeQuery(undefined)).toBe("")
    expect(normalizeQuery(42 as any)).toBe("42")
  })
  test("empty result is shorter than the minimum search length", () => {
    expect(normalizeQuery(" ").length).toBeLessThan(MIN_QUERY)
  })
})

describe("scoreText (relevance ladder)", () => {
  test("exact match scores highest", () => {
    expect(scoreText("payroll", "payroll")).toBe(100)
  })
  test("starts-with beats word-boundary beats partial", () => {
    const starts = scoreText("pay", "payroll runs")
    const boundary = scoreText("runs", "payroll runs")
    const partial = scoreText("roll", "payroll runs")
    expect(starts).toBe(80)
    expect(boundary).toBe(65)
    expect(partial).toBe(50)
    expect(starts).toBeGreaterThan(boundary)
    expect(boundary).toBeGreaterThan(partial)
  })
  test("case-insensitive", () => {
    expect(scoreText("rahim", "Rahim Uddin")).toBe(80)
    expect(scoreText("RAHIM", "rahim uddin")).toBe(80)
  })
  test("no match and empty inputs score zero", () => {
    expect(scoreText("xyz", "payroll")).toBe(0)
    expect(scoreText("xyz", null)).toBe(0)
    expect(scoreText("", "payroll")).toBe(0)
  })
  test("hyphen/slash/ampersand count as word boundaries", () => {
    expect(scoreText("fence", "geo-fence")).toBe(65)
    expect(scoreText("kpi", "performance/kpi")).toBe(65)
    expect(scoreText("tax", "AIT & tax")).toBe(65)
  })
})

describe("rankByRelevance", () => {
  const rows = [
    { code: "EMP-0002", name: "Karim" },
    { code: "EMP-0012", name: "Rahim Uddin" },
    { code: "EMP-0007", name: "Rahima" },
  ]
  const fields = (r: any) => [{ text: r.code, boost: 5 }, { text: r.name }]

  test("employee code match ranks first (boost reflects intent)", () => {
    const out = rankByRelevance("emp-0012", rows, fields, (r) => r.name, 7)
    expect(out[0].code).toBe("EMP-0012")
  })
  test("exact name beats starts-with name", () => {
    const out = rankByRelevance("rahim", rows, fields, (r) => r.name, 7)
    expect(out[0].name).toBe("Rahim Uddin") // exact (100) > starts-with "Rahima" (80)
    expect(out.map((r) => r.name)).toContain("Rahima")
  })
  test("limit is respected and non-matching rows are dropped", () => {
    const out = rankByRelevance("rahim", rows, fields, (r) => r.name, 1)
    expect(out.length).toBe(1)
    expect(rankByRelevance("zzz", rows, fields, (r) => r.name, 7)).toEqual([])
  })
  test("deterministic alphabetical tie-break", () => {
    const tie = [{ n: "Beta" }, { n: "Alpha" }]
    const out = rankByRelevance("a", tie, (r) => [{ text: r.n }], (r) => r.n, 5)
    expect(out.map((x) => x.n)).toEqual(["Alpha", "Beta"])
  })
})

describe("searchStatic — menus", () => {
  test("menu search finds Attendance & Shifts", () => {
    const { menus } = searchStatic("attendance", allowAll)
    expect(menus.some((m) => m.view === "attendance")).toBe(true)
  })
  test("partial and case-insensitive matching (pay → Payroll)", () => {
    const { menus } = searchStatic("pay", allowAll)
    expect(menus.some((m) => m.view === "payroll")).toBe(true)
  })
  test("keyword recall: 'kpi' finds Performance & KPI, 'salary' finds Payroll", () => {
    const { menus } = searchStatic("kpi", allowAll)
    expect(menus.some((m) => m.view === "performance")).toBe(true)
    const { menus: bySalary } = searchStatic("salary", allowAll)
    expect(bySalary.some((m) => m.view === "payroll")).toBe(true)
  })
  test("results carry the destination view key (existing SPA route)", () => {
    const { menus } = searchStatic("leave", allowAll)
    for (const m of menus) expect(typeof m.view).toBe("string")
  })
})

describe("searchStatic — permission gating (critical)", () => {
  test("user without payroll.view never sees Payroll menus or tabs", () => {
    const { menus, tabs } = searchStatic("payroll", noPayroll)
    expect(menus.some((m) => m.view === "payroll")).toBe(false)
    expect(tabs.every((t) => t.view !== "payroll")).toBe(true)
  })
  test("user with no permissions only sees the universal (permission-free) items", () => {
    const { menus, tabs } = searchStatic("a", allowNone)
    // notifications + announcements are intentionally permission-free in
    // nav.ts (every logged-in account sees them) — nothing else may appear.
    // SaaS layer: "subscription" (the tenant's own plan/usage view) is
    // likewise permission-free BY DESIGN: every member of the organization
    // can see what their company's plan includes. Nothing else may appear.
    const universal = new Set(["notifications", "announcements", "subscription"])
    expect(menus.every((m) => universal.has(m.view))).toBe(true)
    expect(menus.length).toBeGreaterThan(0)
    expect(tabs).toEqual([])
  })
  test("module-hidden destinations are excluded", () => {
    const hidden = { ...allowAll, hiddenModules: new Set(["payroll"]) }
    const { menus, tabs } = searchStatic("payroll", hidden)
    expect(menus.some((m) => m.view === "payroll")).toBe(false)
    expect(tabs.every((t) => t.view !== "payroll")).toBe(true)
  })
  test("ESS menu requires an employee link for non-employee roles", () => {
    const { menus } = searchStatic("self", { ...allowAll, hasEmployeeId: false })
    expect(menus.some((m) => m.view === "ess")).toBe(false)
    const { menus: withLink } = searchStatic("self", { ...allowAll, hasEmployeeId: true })
    expect(withLink.some((m) => m.view === "ess")).toBe(true)
  })
})

describe("searchStatic — tabs", () => {
  test("tab search returns view + tab value for deep-linking (payroll → Payroll & AIT tabs)", () => {
    const { tabs } = searchStatic("payroll", allowAll)
    const runTabs = tabs.filter((t) => t.view === "payroll")
    expect(runTabs.length).toBeGreaterThan(2)
    for (const t of runTabs) {
      expect(t.tab).toBeTruthy() // tab value present → navigate(view, { tab })
    }
  })
  test("'my leave' finds the My Leave tab only with an employee link", () => {
    const withLink = searchStatic("my leave", { ...allowAll, hasEmployeeId: true })
    expect(withLink.tabs.some((t) => t.view === "leave" && t.tab === "my")).toBe(true)
    const noLink = searchStatic("my leave", { ...allowAll, hasEmployeeId: false })
    expect(noLink.tabs.some((t) => t.view === "leave" && t.tab === "my")).toBe(false)
  })
  test("results are capped per category", () => {
    const { menus, tabs } = searchStatic("e", allowAll, 8)
    expect(menus.length).toBeLessThanOrEqual(8)
    expect(tabs.length).toBeLessThanOrEqual(8)
  })
  test("exact tab label outranks partial tab label", () => {
    const { tabs } = searchStatic("deleg", allowAll)
    const labels = tabs.filter((t) => t.label === "Delegation")
    expect(labels.length).toBe(1)
  })
})

describe("targetVisible — explicit gating rules", () => {
  const t = (over: Partial<SearchTarget>): SearchTarget => ({
    kind: "menu", view: "x", label: "X", parent: "Group", ...over,
  })
  test("permission is enforced when present", () => {
    expect(targetVisible(t({ perm: ["payroll", "view"] }), allowAll)).toBe(true)
    expect(targetVisible(t({ perm: ["payroll", "view"] }), allowNone)).toBe(false)
  })
  test("items without permission or module are always visible", () => {
    expect(targetVisible(t({}), allowNone)).toBe(true)
  })
  test("requiresEmployeeId honours employee-linked and employee-only users", () => {
    const ess = t({ requiresEmployeeId: true })
    expect(targetVisible(ess, { ...allowNone, hasEmployeeId: false, isEmployeeOnly: true })).toBe(true)
    expect(targetVisible(ess, { ...allowNone, hasEmployeeId: true, isEmployeeOnly: false })).toBe(true)
    expect(targetVisible(ess, { ...allowNone, hasEmployeeId: false, isEmployeeOnly: false })).toBe(false)
  })
})

describe("index integrity", () => {
  test("every nav item is indexed (menus = sidebar)", () => {
    const navCount = NAV_INDEX.length
    expect(navCount).toBeGreaterThanOrEqual(25)
    const views = new Set(NAV_INDEX.map((m) => m.view))
    expect(views.has("dashboard")).toBe(true)
    expect(views.has("settings")).toBe(true)
  })
  test("every tab entry has view + tab and a known destination view", () => {
    const navViews = new Set(NAV_INDEX.map((m) => m.view))
    for (const tab of TAB_INDEX) {
      expect(tab.tab).toBeTruthy()
      expect(navViews.has(tab.view)).toBe(true) // tab pages are reachable menus
    }
  })
  test("no duplicate (view, tab, tpl) triples", () => {
    // 2026-10 templates restructure: settings→templates has ONE generic entry
    // PLUS three tpl-discriminated deep links (sms/email/letter) — all four
    // are intentionally distinct search targets. The uniqueness key therefore
    // includes tpl; every other (view, tab) pair must still be unique.
    const seen = new Set<string>()
    for (const tab of TAB_INDEX) {
      const k = `${tab.view}:${tab.tab}:${(tab as { tpl?: string }).tpl ?? ""}`
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
  })
})
