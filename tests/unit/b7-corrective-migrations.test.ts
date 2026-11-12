/// <reference types="bun-types" />
// ============ B-7 (Stage B, Option 1 / 1(b)) — corrective migration guards ====
// Exercises EVERY guarded branch of the two Stage B corrective migrations
// against real scratch databases, using the BYTE-EXACT migration SQL read
// from the committed files (executed via `prisma db execute --file`):
//
//   9_wave9zxz_payroll_run_index_name_guard_20261103 (Migration A — the B-7
//     fresh-install replay guard):
//       A1 fresh-replay state   (index carries 0_init's truncated name) → RENAME
//       A2 server-truncated     (db-push-like name)                      → no-op
//       A3 both variants present                                          → drop the
//                                                                          truncated
//                                                                          twin, warn
//       A4 absent                                                          → no-op
//
//   9_wave9zzab_payroll_parity_normalization_20261103 (Migration B — the
//     normalize-then-exempt parity normalization), on a database that replayed
//     the FULL 58-migration chain:
//       B0 normalized end-state assertions (rename happened, default set,
//          ApprovalRequest index present) + the parity gate PASSES
//       B1 already-normalized          → idempotent re-run is a no-op
//       B2 server-truncated company index name                        → renamed
//       B3 both company-index variants                                → twin dropped
//       B4 company index absent                                       → no-op
//       B5 updatedAt default missing                                  → restored
//       B6 ApprovalRequest companyId index missing                    → recreated
//
//   scripts/check-schema-parity.mjs (the fail-closed exemption gate):
//       P1 PASS on the healthy replayed database
//       P2 FAIL — unexpected extra index on Employee (representable drift is
//          never exempted)
//       P3 FAIL — an expected GIN/trigram index is MISSING
//       P4 FAIL — an expected GIN/trigram index is CHANGED (definition mismatch)
//       P5 FAIL — an EXTRA GIN index on Employee (the exemption can't widen)
//       P6 FAIL — a representable drift class (ApprovalRequest index dropped)
//       P7 FAIL — unreachable database (infrastructure error path)
//
// The suite provisions its own disposable scratch databases on the unit-test
// PostgreSQL server (never hrm_test, never a development/production URL) and
// skips itself in DB-less environments (same convention as tests/preload.ts).
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync, spawnSync } from "child_process"
import { mkdtempSync, cpSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrismaClient } from "@prisma/client"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const PRISMA_CLI = join(REPO_ROOT, "node_modules", "prisma", "build", "index.js")
const MIG_A_DIR = "9_wave9zxz_payroll_run_index_name_guard_20261103"
const MIG_B_DIR = "9_wave9zzab_payroll_parity_normalization_20261103"
const MIG_A_SQL = join(REPO_ROOT, "prisma", "migrations", MIG_A_DIR, "migration.sql")
const MIG_B_SQL = join(REPO_ROOT, "prisma", "migrations", MIG_B_DIR, "migration.sql")
const PARITY = join(REPO_ROOT, "scripts", "check-schema-parity.mjs")

// The three documented PayrollRun vendor-period index names (see the Stage A
// report §3.2): 0_init creates the 63-char Prisma-pre-truncated name, the
// historical DROP in 9_wave9zy uses the 75-char full name which PostgreSQL
// server-truncates to its own 63-char spelling.
const VENDOR_TRUNCATED = "PayrollRun_vendorId_periodYear_periodMonth_periodWeek_runTy_key"
const VENDOR_FULL = "PayrollRun_vendorId_periodYear_periodMonth_periodWeek_runType_adjustSeq_key"
const VENDOR_SERVER = VENDOR_FULL.slice(0, 63) // …_runType_a
const VENDOR_COLS = '"vendorId", "periodYear", "periodMonth", "periodWeek", "runType", "adjustSeq"'
// The company-level replacement index (created by 9_wave9zy under a 76-char
// name; the server truncates it) vs Prisma's expected 63-char spelling.
const COMPANY_SERVER = "PayrollRun_companyId_periodYear_periodMonth_periodWeek_runType_"
const COMPANY_EXPECTED = "PayrollRun_companyId_periodYear_periodMonth_periodWeek_runT_key"
const COMPANY_COLS = '"companyId", "periodYear", "periodMonth", "periodWeek", "runType", "adjustSeq"'

// ---------- scratch-database server discovery (skip when DB-less) ----------
function baseUrls(): string[] {
  const out: string[] = []
  for (const u of [process.env.TEST_DATABASE_URL, process.env.DATABASE_URL]) {
    if (u && /^postgres(ql)?:\/\//i.test(u) && !/production/i.test(u)) {
      try {
        const parsed = new URL(u)
        const creds = parsed.username ? `${parsed.username}:${parsed.password}@` : ""
        const base = `${parsed.protocol}//${creds}${parsed.host}`
        if (!out.includes(base)) out.push(base)
      } catch { /* ignore */ }
    }
  }
  return out
}
async function probeServer(): Promise<string | null> {
  for (const base of baseUrls()) {
    try {
      const p = new PrismaClient({ datasources: { db: { url: `${base}/postgres` } } })
      const race = new Promise<boolean>((resolve) => {
        p.$queryRawUnsafe("SELECT 1").then(() => resolve(true)).catch(() => resolve(false))
        setTimeout(() => resolve(false), 4000)
      })
      const ok = await race
      await p.$disconnect().catch(() => {})
      if (ok) return base
    } catch { /* try next */ }
  }
  return null
}
const SERVER = await probeServer()

describe.skipIf(!SERVER)("B-7 corrective migrations — guarded branches (real scratch databases)", () => {
  const base = SERVER as string
  const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`
  const DB_A = `hrm_b7_ga_${suffix}` // 0_init only — Migration A states
  const DB_B = `hrm_b7_gb_${suffix}` // full 58-migration chain — Migration B states
  let tmpTree = "" // temp prisma tree holding ONLY 0_init
  let a: PrismaClient // client on DB_A
  let b: PrismaClient // client on DB_B

  const url = (db: string) => `${base}/${db}`
  const admin = (db: string) => new PrismaClient({ datasources: { db: { url: `${base}/postgres` } } })

  function sql(client: PrismaClient, statement: string) {
    return client.$executeRawUnsafe(statement)
  }
  async function indexes(client: PrismaClient, table: string): Promise<Array<{ indexname: string; indexdef: string }>> {
    return client.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='${table}' ORDER BY indexname`,
    ) as any
  }
  /** Execute a migration file BYTE-EXACT against a scratch database. */
  function execMigrationFile(file: string, db: string) {
    execFileSync(process.execPath, [PRISMA_CLI, "db", "execute", "--file", file, "--url", url(db)], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    })
  }
  function runParity(db: string): { code: number; out: string } {
    const r = spawnSync(process.execPath, [PARITY, url(db)], { encoding: "utf8", timeout: 120_000 })
    return { code: r.status ?? -1, out: `${r.stdout || ""}\n${r.stderr || ""}` }
  }

  // ---- Part 1 helpers: put the PayrollRun vendor-period index into a state --
  async function dropAllVendorIndexes() {
    for (const row of await indexes(a, "PayrollRun")) {
      if (row.indexname.startsWith("PayrollRun_vendorId_periodYear")) await sql(a, `DROP INDEX public."${row.indexname}"`)
    }
  }
  async function createVendorIndex(name: string) {
    await sql(a, `CREATE UNIQUE INDEX "${name}" ON "PayrollRun"(${VENDOR_COLS})`)
  }
  // ---- Part 2 helpers: reset the PayrollRun company-period index set ------
  async function dropAllCompanyIndexes() {
    for (const row of await indexes(b, "PayrollRun")) {
      if (row.indexname.startsWith("PayrollRun_companyId_periodYear")) await sql(b, `DROP INDEX public."${row.indexname}"`)
    }
  }
  async function createCompanyIndex(name: string) {
    await sql(b, `CREATE UNIQUE INDEX "${name}" ON "PayrollRun"(${COMPANY_COLS})`)
  }

  beforeAll(async () => {
    // scratch databases on the disposable test server
    for (const db of [DB_A, DB_B]) {
      const adm = admin(db)
      await adm.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}"`)
      await adm.$executeRawUnsafe(`CREATE DATABASE "${db}"`)
      await adm.$disconnect()
    }
    // DB_A: apply ONLY 0_init (temp prisma tree with a single migration dir)
    tmpTree = mkdtempSync(join(tmpdir(), "b7-ga-"))
    mkdirSync(join(tmpTree, "migrations", "0_init_postgresql"), { recursive: true })
    cpSync(join(REPO_ROOT, "prisma", "schema.prisma"), join(tmpTree, "schema.prisma"))
    cpSync(join(REPO_ROOT, "prisma", "migrations", "0_init_postgresql"), join(tmpTree, "migrations", "0_init_postgresql"), { recursive: true })
    execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", join(tmpTree, "schema.prisma")], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url(DB_A) },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    })
    // DB_B: the FULL approved 58-migration chain (also re-proves fresh replay)
    execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy", "--schema", join(REPO_ROOT, "prisma", "schema.prisma")], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url(DB_B) },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    })
    a = new PrismaClient({ datasources: { db: { url: url(DB_A) } } })
    b = new PrismaClient({ datasources: { db: { url: url(DB_B) } } })
  }, 300_000)

  afterAll(async () => {
    await a?.$disconnect().catch(() => {})
    await b?.$disconnect().catch(() => {})
    if (SERVER) {
      const adm = new PrismaClient({ datasources: { db: { url: `${base}/postgres` } } })
      for (const db of [DB_A, DB_B]) {
        await adm.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}"`).catch(() => {})
      }
      await adm.$disconnect().catch(() => {})
    }
    if (tmpTree) rmSync(tmpTree, { recursive: true, force: true })
  }, 60_000)

  // ==========================================================================
  // Part 1 — Migration A (9_wave9zxz) guarded branches, on 0_init state
  // ==========================================================================
  test("A1 fresh-replay state: 0_init's truncated name is RENAMED to the name 9_wave9zy's DROP resolves to", async () => {
    await dropAllVendorIndexes()
    await createVendorIndex(VENDOR_TRUNCATED)
    execMigrationFile(MIG_A_SQL, DB_A)
    const rows = await indexes(a, "PayrollRun")
    const names = rows.map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_vendorId_periodYear"))
    expect(names).toEqual([VENDOR_SERVER])
    const def = rows.find((r) => r.indexname === VENDOR_SERVER)!.indexdef
    expect(def).toContain("UNIQUE INDEX")
    expect(def).toContain('"vendorId", "periodYear", "periodMonth", "periodWeek", "runType", "adjustSeq"')
  }, 60_000)

  test("A2 server-truncated state (db-push topology): the guard is a NO-OP", async () => {
    await dropAllVendorIndexes()
    await createVendorIndex(VENDOR_SERVER)
    execMigrationFile(MIG_A_SQL, DB_A)
    const names = (await indexes(a, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_vendorId_periodYear"))
    expect(names).toEqual([VENDOR_SERVER]) // untouched — 9_wave9zy's DROP resolves directly
  }, 60_000)

  test("A3 both variants present: the truncated-name twin is dropped, the drop-target survives", async () => {
    await dropAllVendorIndexes()
    await createVendorIndex(VENDOR_TRUNCATED)
    await createVendorIndex(VENDOR_SERVER)
    let both = (await indexes(a, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_vendorId_periodYear"))
    expect(both.sort()).toEqual([VENDOR_TRUNCATED, VENDOR_SERVER].sort())
    execMigrationFile(MIG_A_SQL, DB_A)
    const names = (await indexes(a, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_vendorId_periodYear"))
    expect(names).toEqual([VENDOR_SERVER])
    const def = (await indexes(a, "PayrollRun")).find((r) => r.indexname === VENDOR_SERVER)!.indexdef
    expect(def).toContain("UNIQUE INDEX") // unique semantics preserved on the survivor
  }, 60_000)

  test("A4 absent state: the guard does nothing and errors nowhere", async () => {
    await dropAllVendorIndexes()
    execMigrationFile(MIG_A_SQL, DB_A)
    const names = (await indexes(a, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_vendorId_periodYear"))
    expect(names).toEqual([])
  }, 60_000)

  // ==========================================================================
  // Part 2 — Migration B (9_wave9zzab) on the fully-replayed chain
  // ==========================================================================
  test("B0 the replayed chain converges to the normalized state and the parity gate PASSES", async () => {
    const rows = await indexes(b, "PayrollRun")
    expect(rows.map((r) => r.indexname)).toContain(COMPANY_EXPECTED)
    expect(rows.map((r) => r.indexname)).not.toContain(COMPANY_SERVER)
    const ua = await b.$queryRawUnsafe(`SELECT column_default FROM information_schema.columns WHERE table_name='WorkforceSnapshot' AND column_name='updatedAt'`) as any
    expect(String(ua[0].column_default)).toContain("now()")
    expect((await indexes(b, "ApprovalRequest")).map((r) => r.indexname)).toContain("ApprovalRequest_companyId_idx")
    const p = runParity(DB_B)
    expect(p.code).toBe(0)
    expect(p.out).toContain("PASS")
  }, 120_000)

  test("B1 already-normalized state: re-running the migration SQL is an idempotent no-op", async () => {
    const before = await indexes(b, "PayrollRun")
    execMigrationFile(MIG_B_SQL, DB_B)
    const after = await indexes(b, "PayrollRun")
    expect(after).toEqual(before) // byte-identical index set — no unnecessary modification
  }, 60_000)

  test("B2 server-truncated company-index name (production-like topology): RENAMED to Prisma's expected name", async () => {
    await dropAllCompanyIndexes()
    await createCompanyIndex(COMPANY_SERVER)
    let names = (await indexes(b, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_companyId_periodYear"))
    expect(names).toEqual([COMPANY_SERVER])
    execMigrationFile(MIG_B_SQL, DB_B)
    names = (await indexes(b, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_companyId_periodYear"))
    expect(names).toEqual([COMPANY_EXPECTED])
    const def = (await indexes(b, "PayrollRun")).find((r) => r.indexname === COMPANY_EXPECTED)!.indexdef
    expect(def).toContain("UNIQUE INDEX")
    expect(def).toContain('"companyId", "periodYear", "periodMonth", "periodWeek", "runType", "adjustSeq"')
  }, 60_000)

  test("B3 both company-index variants present: the non-canonical twin is dropped, the expected name survives", async () => {
    await dropAllCompanyIndexes()
    await createCompanyIndex(COMPANY_EXPECTED)
    await createCompanyIndex(COMPANY_SERVER)
    let names = (await indexes(b, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_companyId_periodYear"))
    expect(names.sort()).toEqual([COMPANY_EXPECTED, COMPANY_SERVER].sort())
    execMigrationFile(MIG_B_SQL, DB_B)
    names = (await indexes(b, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_companyId_periodYear"))
    expect(names).toEqual([COMPANY_EXPECTED])
    const def = (await indexes(b, "PayrollRun")).find((r) => r.indexname === COMPANY_EXPECTED)!.indexdef
    expect(def).toContain("UNIQUE INDEX")
  }, 60_000)

  test("B4 company index absent (anomalous): the guard is a no-op — parity, not the migration, flags it", async () => {
    await dropAllCompanyIndexes()
    execMigrationFile(MIG_B_SQL, DB_B)
    const names = (await indexes(b, "PayrollRun")).map((r) => r.indexname).filter((n) => n.startsWith("PayrollRun_companyId_periodYear"))
    expect(names).toEqual([]) // not silently recreated; no destructive action; no error
    // parity gate FAILS on this state (the index is representable — not exempted)
    const p = runParity(DB_B)
    expect(p.code).toBe(1)
    // restore for later tests
    await createCompanyIndex(COMPANY_EXPECTED)
  }, 120_000)

  test("B5 WorkforceSnapshot.updatedAt default missing: SET DEFAULT now() restores the datamodel expectation", async () => {
    await sql(b, `ALTER TABLE "WorkforceSnapshot" ALTER COLUMN "updatedAt" DROP DEFAULT`)
    execMigrationFile(MIG_B_SQL, DB_B)
    const ua = await b.$queryRawUnsafe(`SELECT column_default FROM information_schema.columns WHERE table_name='WorkforceSnapshot' AND column_name='updatedAt'`) as any
    expect(String(ua[0].column_default)).toContain("now()")
  }, 60_000)

  test("B6 ApprovalRequest companyId index missing (db-push-baselined topology): CREATE IF NOT EXISTS recreates it", async () => {
    await sql(b, `DROP INDEX public."ApprovalRequest_companyId_idx"`)
    expect((await indexes(b, "ApprovalRequest")).map((r) => r.indexname)).not.toContain("ApprovalRequest_companyId_idx")
    execMigrationFile(MIG_B_SQL, DB_B)
    const rows = await indexes(b, "ApprovalRequest")
    expect(rows.map((r) => r.indexname)).toContain("ApprovalRequest_companyId_idx")
    expect(rows.find((r) => r.indexname === "ApprovalRequest_companyId_idx")!.indexdef).toContain('("companyId")')
  }, 60_000)

  // ==========================================================================
  // Part 3 — the fail-closed parity exemption (scripts/check-schema-parity.mjs)
  // ==========================================================================
  test("P2 FAIL: an unexpected extra Employee index (representable drift) is never exempted", async () => {
    await sql(b, `CREATE INDEX "Employee_code_btree_extra_idx" ON "Employee"("code")`)
    const p = runParity(DB_B)
    expect(p.code).toBe(1)
    expect(p.out).toContain("FAIL")
    await sql(b, `DROP INDEX public."Employee_code_btree_extra_idx"`)
  }, 120_000)

  test("P3 FAIL: an expected GIN/trigram index that is MISSING fails the gate", async () => {
    await sql(b, `DROP INDEX public."Employee_fullName_trgm_idx"`)
    const p = runParity(DB_B)
    expect(p.code).toBe(1)
    expect(p.out).toContain("Employee_fullName_trgm_idx")
    expect(p.out).toContain("MISSING")
    await sql(b, `CREATE INDEX "Employee_fullName_trgm_idx" ON "Employee" USING gin ("fullName" gin_trgm_ops)`)
  }, 120_000)

  test("P4 FAIL: an expected GIN/trigram index whose definition CHANGED fails the gate", async () => {
    await sql(b, `DROP INDEX public."Employee_code_trgm_idx"`)
    await sql(b, `CREATE INDEX "Employee_code_trgm_idx" ON "Employee" USING gin ("mobile" gin_trgm_ops)`) // same name, wrong column
    const p = runParity(DB_B)
    expect(p.code).toBe(1)
    expect(p.out).toContain("unexpected definition")
    await sql(b, `DROP INDEX public."Employee_code_trgm_idx"`)
    await sql(b, `CREATE INDEX "Employee_code_trgm_idx" ON "Employee" USING gin (code gin_trgm_ops)`)
  }, 120_000)

  test("P5 FAIL: an EXTRA GIN index on Employee can never widen the exemption", async () => {
    await sql(b, `CREATE INDEX "Employee_dob_trgm_idx" ON "Employee" USING gin (dob gin_trgm_ops)`)
    const p = runParity(DB_B)
    expect(p.code).toBe(1)
    expect(p.out).toContain("Employee_dob_trgm_idx")
    expect(p.out).toContain("unexpected GIN index")
    await sql(b, `DROP INDEX public."Employee_dob_trgm_idx"`)
  }, 120_000)

  test("P6 FAIL: a representable drift class (dropped ApprovalRequest index) is not exempted", async () => {
    await sql(b, `DROP INDEX public."ApprovalRequest_companyId_idx"`)
    const p = runParity(DB_B)
    expect(p.code).toBe(1)
    expect(p.out).toContain("ApprovalRequest")
    execMigrationFile(MIG_B_SQL, DB_B) // restore via the corrective itself
    expect(runParity(DB_B).code).toBe(0)
  }, 120_000)

  test("P7 FAIL: an unreachable database is an infrastructure failure, never a silent pass", async () => {
    const p = runParity(`${base}/hrm_b7_does_not_exist_zzz`)
    expect(p.code).toBe(1)
    expect(p.out).toContain("FAIL")
  }, 120_000)

  test("final: after all branch tests the scratch database passes the parity gate again", async () => {
    const p = runParity(DB_B)
    expect(p.code).toBe(0)
  }, 120_000)
})
