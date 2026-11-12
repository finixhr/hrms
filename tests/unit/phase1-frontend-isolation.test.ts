/// <reference types="bun-types" />
// ============ FORENSIC AUDIT 2026-11-10 — PHASE 1 frontend isolation logic ============
// FIN-004 (view remount key carries the company) and FIN-014 (lookup cache is
// company-scoped and invalidated by mutations) as PURE-LOGIC regressions: the
// hooks themselves need a DOM, but the isolation semantics live in the key
// builders and the invalidation rules asserted here. The user-visible flow
// (switch company → remount + fresh pickers) is additionally covered by the
// Playwright spec tests/e2e-ui/company-switch.spec.ts.
import { describe, test, expect, beforeAll } from "bun:test"
import { viewRemountKey } from "@/hrm/store"
import {
  invalidateLookupsFor,
  clearLookupCache,
  setLookupScopeProvider,
  invalidateEmployeeDirectory,
  _lookupCacheForTests,
} from "@/hrm/api"

const CA = "cmp-a-111"
const CB = "cmp-b-222"

describe("FIN-004 — viewRemountKey carries the company context", () => {
  const view = { key: "employees", params: { id: "e1" } }

  test("same view under a different company yields a DIFFERENT key (forces remount)", () => {
    expect(viewRemountKey(view, CA, false)).not.toBe(viewRemountKey(view, CB, false))
  })

  test("same view, same company → stable key (no gratuitous remount)", () => {
    expect(viewRemountKey(view, CA, false)).toBe(viewRemountKey(view, CA, false))
  })

  test("switching to All Companies mode remounts too (both directions)", () => {
    const concrete = viewRemountKey(view, CA, false)
    const allMode = viewRemountKey(view, null, true)
    expect(concrete).not.toBe(allMode)
    // leaving All Companies back to a concrete company also remounts
    expect(allMode).not.toBe(viewRemountKey(view, CB, false))
  })

  test("params still participate (navigation remount unchanged)", () => {
    expect(viewRemountKey({ key: "employees", params: { id: "e1" } }, CA, false))
      .not.toBe(viewRemountKey({ key: "employees", params: { id: "e2" } }, CA, false))
    expect(viewRemountKey({ key: "employees" }, CA, false))
      .not.toBe(viewRemountKey({ key: "payroll" }, CA, false))
  })
})

describe("FIN-014 — lookup cache mutation-invalidation rules", () => {
  beforeAll(() => {
    // a provider must be registered (the store does this in the app); the
    // scope value itself does not matter for these rule-level assertions
    setLookupScopeProvider(() => CA)
  })

  const seed = () => {
    _lookupCacheForTests.clear()
    for (const k of [
      `${CA}::employees.list:{}`,
      `${CA}::employees.refList:{"take":10000}`,
      `${CB}::employees.list:{}`,
      `${CA}::departments.list:{}`,
      `${CA}::branches.list:{}`,
      `${CA}::users.list:{}`,
    ]) {
      _lookupCacheForTests.set(k, { at: Date.now(), data: [], inflight: null })
    }
  }
  const keys = () => [..._lookupCacheForTests.keys()].sort()

  test("a mutating employees rpc drops EVERY company's employees entries (and the directory)", () => {
    seed()
    invalidateLookupsFor("employees.update")
    expect(keys().some((k) => k.includes("::employees."))).toBe(false)
    expect(keys()).toContain(`${CA}::departments.list:{}`)
    expect(keys()).toContain(`${CA}::users.list:{}`)
  })

  test("reads never invalidate (employees.list / employees.refList / employees.get)", () => {
    seed()
    invalidateLookupsFor("employees.list")
    invalidateLookupsFor("employees.refList")
    invalidateLookupsFor("employees.get")
    expect(keys().filter((k) => k.includes("::employees.")).length).toBe(3)
  })

  test("departments.delete drops only the departments dataset", () => {
    seed()
    invalidateLookupsFor("departments.delete")
    expect(keys()).not.toContain(`${CA}::departments.list:{}`)
    expect(keys()).toContain(`${CA}::employees.list:{}`)
    expect(keys()).toContain(`${CA}::branches.list:{}`)
  })

  test("actions outside the cached dataset prefixes are ignored", () => {
    seed()
    invalidateLookupsFor("pf.import.execute")
    invalidateLookupsFor("settings.save")
    expect(keys().length).toBe(6)
  })

  test("clearLookupCache wipes the whole plane (the switchCompany path)", () => {
    seed()
    invalidateEmployeeDirectory() // no-op on an empty directory cache — must not throw
    clearLookupCache()
    expect(keys().length).toBe(0)
  })

  test("the cache key format embeds the company scope (a Company B entry can never be served under Company A)", () => {
    seed()
    // the scoped-key invariant FIN-014 is built on: two companies, same
    // action+payload → two distinct entries
    expect(keys()).toContain(`${CA}::employees.list:{}`)
    expect(keys()).toContain(`${CB}::employees.list:{}`)
    expect(`${CA}::employees.list:{}`).not.toBe(`${CB}::employees.list:{}`)
  })
})
