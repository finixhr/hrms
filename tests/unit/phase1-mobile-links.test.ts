/// <reference types="bun-types" />
// ============ FIN-007 (Phase 1) — mobile launcher link resolution ============
// The audit: every module card on the mobile Modules screen opened
// `${base}/employees` (…/payroll, …/tracking) — but the web SPA exists ONLY
// at /app, so EVERY card was a 404. The launcher now builds
// `${base}/app?view=<key>` and the web shell resolves the key (unknown keys
// fall back to the dashboard — the SPA has one route, so no link can 404).
//
// This is the link-resolution E2E check the audit asked for: every `view`
// value the mobile app advertises must be a REAL key of the web VIEWS
// registry, and the launcher file must build the /app URL. A new module card
// with a typo'd view key fails HERE instead of shipping a 404 button.
import "./_testdb"
import * as fs from "fs"
import * as path from "path"
import { describe, test, expect } from "bun:test"
import { VIEWS } from "@/hrm/views/registry"

const LAUNCHER = path.join(import.meta.dir, "..", "..", "mobile", "app", "(modules)", "[module].tsx")

/** Strip //-comment and /*-block lines so guards check CODE, not prose. */
function stripComments(src: string): string {
  return src.split("\n").filter((l) => {
    const t = l.trim()
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
  }).join("\n")
}

describe("FIN-007 — every mobile module card resolves in the web shell", () => {
  test("the launcher file exists and builds the /app deep link (never a bare path)", () => {
    const src = fs.readFileSync(LAUNCHER, "utf8")
    // the URL is ${base}/app?view=<key> — the SPA's ONLY route
    expect(src).toContain("/app?view=${encodeURIComponent(meta.view)}")
    // and no residual bare-path launcher
    expect(src).not.toContain("const url = `${getBaseUrl()}${meta.path}`")
  })

  test("every advertised view key is a key of the web VIEWS registry", () => {
    const src = fs.readFileSync(LAUNCHER, "utf8")
    // every MODULE_META entry: view: "<key>"
    const advertised = [...src.matchAll(/view:\s*"([a-z0-9-]+)"/g)].map((m) => m[1])
    expect(advertised.length).toBeGreaterThanOrEqual(25) // the full long-tail catalogue
    const registryKeys = new Set(Object.keys(VIEWS))
    const unresolved = advertised.filter((k) => !registryKeys.has(k))
    expect(`Mobile module cards advertising views the web shell cannot resolve: ${unresolved.join(", ")}
(Add the view to src/hrm/views/registry.tsx or point the card at an existing view.)`).toBe(
      `Mobile module cards advertising views the web shell cannot resolve: \n(Add the view to src/hrm/views/registry.tsx or point the card at an existing view.)`,
    )
  })

  test("the web shell accepts the ?view= deep link (store init resolves it)", async () => {
    // the store's init reads window.location.search — exercised through the
    // module source contract rather than a browser: the param handling code
    // must exist and validate the key shape
    const store = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src/hrm/store.ts"), "utf8")
    expect(store).toContain('search.get("view")')
    expect(store).toContain('key: viewParam')
  })
})

describe("FIN-008 — mobile honesty guards", () => {
  test("the background-location permission is gone from the manifest until tracking ships", () => {
    const appJson = fs.readFileSync(path.join(import.meta.dir, "..", "..", "mobile", "app.json"), "utf8")
    expect(appJson).not.toContain("ACCESS_BACKGROUND_LOCATION")
  })

  test("the dead background-tracking pipeline is deleted; the one-shot helpers remain", () => {
    const loc = stripComments(fs.readFileSync(path.join(import.meta.dir, "..", "..", "mobile", "src/lib/location.ts"), "utf8"))
    expect(loc).not.toContain("TaskManager.defineTask")
    expect(loc).not.toContain("startLocationUpdatesAsync")
    expect(loc).not.toContain("import * as TaskManager")
    expect(loc).toContain("getLocationWithAccuracy") // the foreground punch helper stays
  })

  test("no local-state-only toggles remain on the profile screen", () => {
    const profile = stripComments(fs.readFileSync(path.join(import.meta.dir, "..", "..", "mobile", "app/(tabs)/profile.tsx"), "utf8"))
    expect(profile).not.toContain("toggle?:")        // the fake Switch row shape is gone
    expect(profile).not.toContain("<Switch")         // no switch control at all
    expect(profile).not.toContain("Biometrics")      // never implemented
    expect(profile).not.toContain("Dark Mode")       // never implemented
    expect(profile).not.toContain("Secured end-to-end") // the false security claim
  })

  test("push taps route somewhere: the root layout wires the response listener + badge clearing", () => {
    const layout = fs.readFileSync(path.join(import.meta.dir, "..", "..", "mobile", "app/_layout.tsx"), "utf8")
    expect(layout).toContain("addNotificationResponseReceivedListener")
    expect(layout).toContain("clearBadge")
    expect(layout).toContain("/app?view=") // web-portal deep-link flow
  })
})
