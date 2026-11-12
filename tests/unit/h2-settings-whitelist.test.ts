/// <reference types="bun-types" />
// ============ H-2 regression: essPortal savable + whitelist-coverage invariants ============
// Audit H-2 (High): the essPortal settings group (R5 Self-Service Portal
// toggles) existed in server defaults and the Settings UI but was missing from
// BOTH inline whitelists in settings.save / settings.patch — every save of the
// tab threw "Unknown settings group" and the toggles silently reverted.
//
// Fix under test: the whitelist is now DERIVED from DEFAULT_SETTINGS
// (SETTINGS_SAVE_GROUPS, settings.ts) — one registry, structurally unable to
// drift. This file also pins the class-level invariants so the defect class
// (audit root cause #4 — registry drift) cannot recur:
//   1. route-layer: settings.save / settings.patch on essPortal succeed + persist
//   2. every DEFAULT_SETTINGS group is savable (schema → whitelist)
//   3. every whitelist entry has defaults (no dead groups)
//   4. every GroupEditor group rendered by the Settings UI is savable (UI → whitelist)
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { mkVendor, mkUser, mkSession } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { DEFAULT_SETTINGS, SETTINGS_SAVE_GROUPS } from "@/hrm-server/settings"

let token: string

beforeAll(async () => {
  const vendor = await mkVendor("H2 Settings Vendor")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "H2 Admin" })
  token = await mkSession(admin.id, "FULL")
})

describe("H-2 essPortal settings group is savable (route layer)", () => {
  test("settings.save on essPortal persists and is readable back via settings.get", async () => {
    const values = {
      showGeoCheckIn: true, showCheckOut: false, showApplyLeave: true, showExpenseClaim: false,
      showLoanRequest: true, showAdvanceRequest: false, showGoodsRequest: true, showResignation: false,
    }
    const save = await postHrm("settings.save", { group: "essPortal", values }, { bearer: token })
    expect(save.status).toBe(200) // ← was 403 "Unknown settings group"
    expect(save.body.ok).toBe(true)

    const get = await postHrm("settings.get", {}, { bearer: token })
    expect(get.status).toBe(200)
    const cfg = get.body.data.essPortal
    expect(cfg.showCheckOut).toBe(false)      // persisted, not silently reverted
    expect(cfg.showResignation).toBe(false)   // the R5 headline control works
    expect(cfg.showGeoCheckIn).toBe(true)
  })

  test("settings.patch on essPortal merges a single key", async () => {
    const res = await postHrm("settings.patch", { group: "essPortal", values: { showLoanRequest: false } }, { bearer: token })
    expect(res.status).toBe(200) // ← was 403
    expect(res.body.ok).toBe(true)
    const get = await postHrm("settings.get", {}, { bearer: token })
    expect(get.body.data.essPortal.showLoanRequest).toBe(false)
    // other keys untouched by the patch
    expect(get.body.data.essPortal.showGeoCheckIn).toBe(true)
  })

  test("unknown groups are still rejected (whitelist still gates)", async () => {
    const res = await postHrm("settings.save", { group: "notARealGroup", values: { x: 1 } }, { bearer: token })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/unknown settings group/i)
  })
})

describe("H-2 class invariants — registry drift cannot recur", () => {
  test("every DEFAULT_SETTINGS group is savable (schema → whitelist)", () => {
    const missing = Object.keys(DEFAULT_SETTINGS).filter((g) => !SETTINGS_SAVE_GROUPS.includes(g))
    expect(missing).toEqual([])
  })

  test("every whitelist entry has defaults (no dead groups)", () => {
    const dead = SETTINGS_SAVE_GROUPS.filter((g) => !(g in DEFAULT_SETTINGS))
    expect(dead).toEqual([])
  })

  test("every GroupEditor group rendered by the Settings UI is savable (UI → whitelist)", () => {
    // grep-test (same pattern as camera-tenant-isolation.test.ts): extract
    // group="..." from the Settings view's GroupEditor rows
    const src = readFileSync(join(import.meta.dir, "../../src/hrm/views/settings.tsx"), "utf8")
    const groups = [...src.matchAll(/<GroupEditor[^>]*\sgroup="([a-zA-Z]+)"/g)].map((m) => m[1])
    expect(groups.length).toBeGreaterThan(0)
    const unsavable = groups.filter((g) => !SETTINGS_SAVE_GROUPS.includes(g))
    expect(unsavable).toEqual([])
  })
})
