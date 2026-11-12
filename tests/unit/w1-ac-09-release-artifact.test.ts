/// <reference types="bun-types" />
// ============ W1-AC-09 — wrong-manifest rejection (R-30, V1–V10) ============
// Spawns the REAL validator (scripts/check-release-artifact.mjs) as a
// subprocess against temp fixture trees: every corruption class must exit
// non-zero with its specific FAIL V<n> message; the committed manifest +
// the real tree must pass. 21 tests.
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "child_process"
import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const VALIDATOR = join(REPO_ROOT, "scripts", "check-release-artifact.mjs")
const MANIFEST = join(REPO_ROOT, "deploy", "release-manifest.json")

let tmp: string
const fixtureDirs: string[] = []

/** Build a fixture root = the real manifest + the real migration tree. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "w1ac09-"))
  fixtureDirs.push(dir)
  mkdirSync(join(dir, "deploy"), { recursive: true })
  mkdirSync(join(dir, "scripts"), { recursive: true })
  cpSync(join(REPO_ROOT, "prisma", "migrations"), join(dir, "prisma", "migrations"), { recursive: true })
  cpSync(MANIFEST, join(dir, "deploy", "release-manifest.json"))
  return dir
}

/** Run the validator in --tree mode against a fixture root. */
function runValidator(root: string, mode: "tree" | "image" = "tree"): { code: number; out: string } {
  try {
    const out = execFileSync("node", [VALIDATOR, `--${mode}`, root], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
    return { code: 0, out }
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}\n${e.stderr || ""}` }
  }
}

/** Mutate the fixture manifest through a JSON transform (strict-JSON output). */
function rewriteManifest(root: string, transform: (m: any) => any) {
  const m = JSON.parse(readFileSync(join(root, "deploy", "release-manifest.json"), "utf8"))
  writeFileSync(join(root, "deploy", "release-manifest.json"), JSON.stringify(transform(m), null, 2))
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "w1ac09-root-"))
})

afterAll(() => {
  for (const d of [...fixtureDirs, tmp]) rmSync(d, { recursive: true, force: true })
})

describe("W1-AC-09 — wrong-manifest rejection (V1–V10)", () => {
  test("control: the COMMITTED manifest + the REAL tree pass (dynamic count)", () => {
    const r = runValidator(REPO_ROOT)
    expect(r.code).toBe(0)
    // FORENSIC AUDIT 2026-11-10, FIN-002 (Phase 0): the count is derived from
    // the manifest itself, not frozen — a frozen "66" is exactly the drift
    // class that let zzak land undeclared and turn CI stage 15/15 red.
    const n = JSON.parse(readFileSync(MANIFEST, "utf8")).migrations.length
    expect(r.out).toContain(`${n} migrations`)
  })

  test("control: a rebuilt fixture (real manifest + real tree copies) passes", () => {
    const fx = makeFixture()
    const r = runValidator(fx)
    expect(r.code).toBe(0)
    const n = JSON.parse(readFileSync(MANIFEST, "utf8")).migrations.length
    expect(r.out).toContain(`${n} migrations`)
  })

  test("V7: a declared-but-missing migration directory is rejected", () => {
    const fx = makeFixture()
    rmSync(join(fx, "prisma", "migrations", "9_wave9zza_mc_expand_20261103"), { recursive: true })
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V7")
    expect(r.out).toContain("9_wave9zza_mc_expand_20261103")
  })

  test("V7: a present-but-undeclared migration directory is rejected", () => {
    const fx = makeFixture()
    mkdirSync(join(fx, "prisma", "migrations", "9_wave9zzz_rogue_extra_20261104"))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V7")
    expect(r.out).toContain("9_wave9zzz_rogue_extra_20261104")
  })

  test("V4: a duplicate entry is rejected", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => ({ ...m, migrations: [...m.migrations, "0_init_postgresql"] }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V4")
  })

  test("V5: a misordered array is rejected", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => {
      const arr = [...m.migrations]
      const i = arr.indexOf("9_wave9zy_multi_company_20261103")
      arr[i] = arr[i - 1]; arr[i - 1] = "9_wave9zy_multi_company_20261103"
      return { ...m, migrations: arr }
    })
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V5")
  })

  test("V3: ellipsis placeholders (...) are rejected", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => ({ ...m, migrations: [...m.migrations, "..."] }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V3")
  })

  test("V3: same-as: references are rejected", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => ({ ...m, migrations: [...m.migrations, "same-as:R1"] }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V3")
  })

  test("V3: wildcard entries are rejected", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => ({ ...m, migrations: [...m.migrations, "9_wave9z*"] }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V3")
  })

  test("V9: the M4 name in an R1 manifest is rejected", () => {
    const fx = makeFixture()
    mkdirSync(join(fx, "prisma", "migrations", "9_wave9zzb_mc_enforce_20261103"))
    rewriteManifest(fx, (m) => ({ ...m, migrations: [...m.migrations, "9_wave9zzb_mc_enforce_20261103"].sort() }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V9")
  })

  test("V9: any 'enforce' entry is rejected in R1 (pattern guard)", () => {
    const fx = makeFixture()
    mkdirSync(join(fx, "prisma", "migrations", "x_enforce_guard"))
    rewriteManifest(fx, (m) => ({ ...m, migrations: [...m.migrations, "x_enforce_guard"].sort() }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V9")
  })

  test("V1: a JSON comment is rejected", () => {
    const fx = makeFixture()
    const raw = readFileSync(join(fx, "deploy", "release-manifest.json"), "utf8")
    writeFileSync(join(fx, "deploy", "release-manifest.json"), `// release manifest\n${raw}`)
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V1")
  })

  test("V1: a trailing comma is rejected", () => {
    const fx = makeFixture()
    const raw = readFileSync(join(fx, "deploy", "release-manifest.json"), "utf8")
    writeFileSync(join(fx, "deploy", "release-manifest.json"), raw.replace(/\}\s*$/, ",}"))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V1")
  })

  test("V1: a duplicate JSON key is rejected (no silent last-wins)", () => {
    const fx = makeFixture()
    const raw = readFileSync(join(fx, "deploy", "release-manifest.json"), "utf8")
    writeFileSync(join(fx, "deploy", "release-manifest.json"), raw.replace("{\n", '{\n  "release": "R2",\n'))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V1")
    expect(r.out).toContain("duplicate key")
  })

  test("V1: a byte-order mark is rejected with the SPECIFIC BOM message", () => {
    const fx = makeFixture()
    const raw = readFileSync(join(fx, "deploy", "release-manifest.json"), "utf8")
    writeFileSync(join(fx, "deploy", "release-manifest.json"), `\uFEFF${raw}`)
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V1")
    expect(r.out).toContain("BOM")
  })

  test("V2: a wrong releaseWave is rejected", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => ({ ...m, releaseWave: "W2" }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V2")
  })

  test("V2: an unexpected key is rejected", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => ({ ...m, notes: "not allowed" }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V2")
  })

  test("V10: an R5 manifest WITHOUT M4 is rejected (built as a fixture: same set, release R5)", () => {
    const fx = makeFixture()
    rewriteManifest(fx, (m) => ({ ...m, release: "R5", releaseWave: "W5" }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V10")
  })

  test("V8: an entry outside the approved contract set is rejected", () => {
    const fx = makeFixture()
    mkdirSync(join(fx, "prisma", "migrations", "9_wave9zzz_rogue_migration_20261105"))
    rewriteManifest(fx, (m) => ({ ...m, migrations: [...m.migrations, "9_wave9zzz_rogue_migration_20261105"].sort() }))
    const r = runValidator(fx)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V8")
  })

  test("V1: a nonexistent root is rejected", () => {
    const r = runValidator(join(tmp, "does-not-exist"))
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V1")
  })

  test("V6: image-mode drift is rejected (extra directory in the image tree)", () => {
    const fx = makeFixture()
    mkdirSync(join(fx, "prisma", "migrations", "9_wave9zzb_mc_enforce_20261103"))
    const r = runValidator(fx, "image")
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL V6")
  })

  test("committed-manifest invariants: count = disk (structural), lexicographic, M1 present, M4 absent, chain history present, Stage B correctives present", () => {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"))
    expect(m.manifestVersion).toBe(1)
    expect(m.release).toBe("R1")
    expect(m.releaseWave).toBe("W1")
    // FORENSIC AUDIT 2026-11-10, FIN-002 (Phase 0): the length assertion is
    // now STRUCTURAL — the manifest must declare exactly what the disk holds
    // (67 as of the zzak registration; 2026-11-07: 60 → 62; 2026-11-09 P0:
    // 62 → 64; 2026-11-09 P2: 64 → 66; 2026-11-10 Phase 0: 66 → 67 with
    // 9_wave9zzak_stock_entry_company_id_20261109). A frozen literal here
    // would fail every future amendment — the guard must compare, not count.
    const diskDirs = readdirSync(join(REPO_ROOT, "prisma", "migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    expect(m.migrations.length).toBe(diskDirs.length)
    expect(new Set(m.migrations).size).toBe(diskDirs.length)
    for (const d of diskDirs) expect(m.migrations).toContain(d)
    expect(m.migrations).toContain("9_wave9zy_multi_company_20261103")
    expect(m.migrations).toContain("9_wave9zz_all_companies_mode_20261103")
    expect(m.migrations).toContain("9_wave9zza_mc_expand_20261103")
    expect(m.migrations).not.toContain("9_wave9zzb_mc_enforce_20261103")
    expect(m.migrations.every((x: string, i: number) => i === 0 || m.migrations[i - 1] < x)).toBe(true)
    expect(m.migrations[0]).toBe("0_init_postgresql")
    // the baseline cutoff: 53 entries through 9_wave9zx (deployment strategy
    // §5.2 "the 53 baseline directories"), then the two existing 2026-11-03
    // release migrations, M1 and the two Stage B correctives — 0-based index
    // 52 is the LAST baseline entry
    expect(m.migrations[52]).toBe("9_wave9zx_money_paisa_backfill_20261102")
    // Stage B (B-7 Option 1 / 1(b)): the corrective guard sorts BETWEEN
    // 9_wave9zx and 9_wave9zy so the historical DROP INDEX in 9_wave9zy
    // resolves on fresh installs
    expect(m.migrations[53]).toBe("9_wave9zxz_payroll_run_index_name_guard_20261103")
    expect(m.migrations[54]).toBe("9_wave9zy_multi_company_20261103")
    // 2026-11-09 (P0 audit wave): the chain gained two deliberate amendments —
    // 9_wave9zzag (SEC-3 registration duplicateEmail flag + SEC-4 letter
    // verification-code prefix, both additive with backfill) and 9_wave9zzah
    // (the KpiAssignment.status DEFAULT drift repair the schema-drift gate
    // caught). Both APPEND after zzaf; the tip is now zzah, and every entry
    // still sorts BEFORE the reserved M4 name (9_wave9zzb_…) so M4 remains a
    // pure in-order append.
    expect(m.migrations[59]).toBe("9_wave9zzad_employee_company_transfer_20261105")
    expect(m.migrations[59] < "9_wave9zzb_mc_enforce_20261103").toBe(true)
    expect(m.migrations[62]).toBe("9_wave9zzag_p0_registration_flag_letter_prefix_20261109")
    expect(m.migrations[63]).toBe("9_wave9zzah_kpi_assignment_status_default_20261109")
    expect(m.migrations[63] < "9_wave9zzb_mc_enforce_20261103").toBe(true)
    expect(m.migrations).toContain("9_wave9zxz_payroll_run_index_name_guard_20261103")
    expect(m.migrations).toContain("9_wave9zzab_payroll_parity_normalization_20261103")
  })
})
