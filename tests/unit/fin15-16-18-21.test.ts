/// <reference types="bun-types" />
// ============ FIN-015 / FIN-016 / FIN-018 / FIN-021 (Phase 2) — frontend & config regressions ============
// FIN-015: the pager exists in the DataTable source with its disabled logic
// (behavior is pinned by the Playwright lane — lists over 15 rows page).
// FIN-016: the All-Companies policy is pure and unit-tested here; the nav
// filter consumes the same function (no second copy to drift).
// FIN-018: the type-check shards exist and the driver lists them.
// FIN-021: the mobile transport fails fast — no plaintext fallback line, a
// startup assertion, and production/preview profiles that REQUIRE pins.
import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { allCompaniesViewPolicy, ALL_COMPANIES_CONSOLIDATED_VIEWS } from "@/hrm/module-map"
import { NAV } from "@/hrm/nav"

describe("FIN-016 — All-Companies navigation policy", () => {
  test("the consolidated whitelist covers the reporting surfaces and nothing operational", () => {
    for (const v of ["dashboard", "reports", "analytics", "audit", "billing"]) {
      expect(allCompaniesViewPolicy(v)).toBe("show-ro")
    }
    for (const v of ["employees", "attendance", "payroll", "inventory", "procurement", "settings", "ess", "recruitment", "leave", "devices", "assets"]) {
      expect(allCompaniesViewPolicy(v)).toBe("hide")
    }
  })

  test("every whitelist entry is a real NAV view (no dead policy entries)", () => {
    const navKeys = new Set(NAV.flatMap((g) => g.items.map((i) => i.key)))
    for (const v of ALL_COMPANIES_CONSOLIDATED_VIEWS) {
      expect(navKeys.has(v), `policy entry "${v}" is not a NAV view`).toBe(true)
    }
  })

  test("the shell consumes the policy (single source, no drift)", () => {
    const shell = readFileSync("src/hrm/app-shell.tsx", "utf8")
    expect(shell).toContain("allCompaniesViewPolicy(it.key) === \"hide\"")
    expect(shell).toContain("import { allCompaniesViewPolicy } from \"./module-map\"")
    // FIN-029 — the persistent banner rides the same mode
    expect(shell).toContain('data-testid="all-companies-banner"')
  })
})

describe("FIN-015 — DataTable pager controls", () => {
  test("the pager markup + disabled logic + server-mode exemption exist", () => {
    const src = readFileSync("src/hrm/shared/data-table.tsx", "utf8")
    expect(src).toContain('data-testid="data-table-pager"')
    expect(src).toContain('!isServerPaged && pages > 1') // only when it has work to do
    expect(src).toContain('disabled={safePage <= 1}')    // Prev
    expect(src).toContain('disabled={safePage >= pages}') // Next
    expect(src).toContain('aria-label="Previous page"')
    expect(src).toContain('aria-label="Next page"')
  })
})

describe("FIN-018 — sharded type-check lane", () => {
  test("the three shard configs exist and the driver lists exactly them", () => {
    for (const s of ["check-app", "check-server", "check-tests"]) {
      expect(existsSync(`tsconfig.${s}.json`), `tsconfig.${s}.json missing`).toBe(true)
    }
    expect(existsSync("tsconfig.base.json")).toBe(true)
    const r = Bun.spawnSync(["bash", "scripts/typecheck.sh", "--list"])
    expect(r.exitCode).toBe(0)
    const list = r.stdout.toString().trim().split("\n")
    expect(list).toEqual(["check-app", "check-server", "check-tests"])
    const pkg = JSON.parse(readFileSync("package.json", "utf8"))
    expect(pkg.scripts.typecheck).toContain("scripts/typecheck.sh")
    expect(pkg.scripts["typecheck:whole"]).toBeTruthy()
    const ci = readFileSync("scripts/ci.sh", "utf8")
    expect(ci).toContain("bash scripts/typecheck.sh") // the gate runs the sharded lane
  })
})

describe("FIN-021 — mobile transport fail-fast + default pinning", () => {
  test("getBaseUrl has NO plaintext fallback line and throws UNCONFIGURED_BASE_URL", () => {
    const src = readFileSync("mobile/src/lib/api.ts", "utf8")
    expect(src).not.toContain('?? "http://localhost:4055"')
    expect(src).toContain('"UNCONFIGURED_BASE_URL"')
    expect(src).toContain("assertApiConfiguration();") // startup (import time)
    expect(src).toContain('"INSECURE_BASE_URL"')        // strict-https
    expect(src).toContain("EXPO_PUBLIC_REQUIRE_PINS")   // pin-or-die
  })

  test("eas.json: production + preview REQUIRE pins; app.json base URL is https", () => {
    const eas = JSON.parse(readFileSync("mobile/eas.json", "utf8"))
    expect(eas.build.production.env.EXPO_PUBLIC_API_BASE_URL).toMatch(/^https:\/\//)
    expect(eas.build.production.env.EXPO_PUBLIC_REQUIRE_PINS).toBe("1")
    expect(eas.build.preview.env.EXPO_PUBLIC_REQUIRE_PINS).toBe("1")
    expect(eas.build.development.env.EXPO_PUBLIC_API_BASE_URL).toMatch(/^http:\/\/localhost/) // dev loopback stays allowed
    const app = JSON.parse(readFileSync("mobile/app.json", "utf8"))
    expect(app.expo.extra.apiBaseUrl).toMatch(/^https:\/\//)
  })

  test("the pin-resolution path survives transport (display-safe content check)", () => {
    const src = readFileSync("mobile/src/lib/api.ts", "utf8")
    // the file must still index the pin map by host — checked via a variable
    // name rather than raw bracket display (the tool display eats some
    // bracket sequences; python reads the real bytes).
    expect(src).toContain("pinsByHost")
    expect(src).toContain("resolveTlsPins()")
  })
})
