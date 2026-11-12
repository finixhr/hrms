/// <reference types="bun-types" />
// ============ W1-AC-07 — boot-time schema assertion (R-26) ============
// Positive on the migrated unit database; negative/partial/full on a scratch
// database created and dropped by this test on the DISPOSABLE PostgreSQL
// server (the production path is unchanged — the scratch client parameter is
// the test hook). 4 tests.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { PrismaClient } from "@prisma/client"
import { assertMultiCompanySchema } from "@/instrumentation"

const SCRATCH_URL = process.env.W1_AC07_SCRATCH_URL || "postgresql://postgres:postgres@127.0.0.1:55432/hrm_w1_ac07_scratch"

/** Create the scratch database if absent (on the disposable server). */
async function ensureScratchDb() {
  const admin = new PrismaClient({ datasources: { db: { url: SCRATCH_URL.replace(/\/[^/]+$/, "/postgres") } } })
  await admin.$executeRawUnsafe(`CREATE DATABASE hrm_w1_ac07_scratch`).catch(() => {}) // exists on a re-run
  await admin.$disconnect()
}

/** Build the four M1-relevant tables WITHOUT the M1 columns (the pre-M1
 *  shape), on a scratch database. */
async function buildPreM1Scratch() {
  await ensureScratchDb()
  const p = new PrismaClient({ datasources: { db: { url: SCRATCH_URL } } })
  await p.$executeRawUnsafe(`DROP SCHEMA public CASCADE`)
  await p.$executeRawUnsafe(`CREATE SCHEMA public`)
  await p.$executeRawUnsafe(`CREATE TABLE "AuditLog" (id TEXT PRIMARY KEY, "vendorId" TEXT NOT NULL)`)
  await p.$executeRawUnsafe(`CREATE TABLE "BgJob" (id TEXT PRIMARY KEY, "vendorId" TEXT NOT NULL)`)
  await p.$executeRawUnsafe(`CREATE TABLE "AttendancePolicyAssignment" (id TEXT PRIMARY KEY, "vendorId" TEXT NOT NULL)`)
  await p.$executeRawUnsafe(`CREATE TABLE "UserCompanyAccess" (id TEXT PRIMARY KEY, "vendorId" TEXT NOT NULL)`)
  return p
}

describe("W1-AC-07 — boot-time schema assertion (R-26)", () => {
  test("positive: the migrated unit database passes (all five M1 columns present)", async () => {
    // the unit DB is db-push'd from the full schema (M1 included) by _testdb
    await assertMultiCompanySchema()
  })

  test("negative: a pre-M1 scratch database is refused naming ALL five column pairs AND the migration; the refusal is read-only", async () => {
    const p = await buildPreM1Scratch()
    try {
      await assertMultiCompanySchema(p)
      throw new Error("expected the assertion to refuse")
    } catch (e: any) {
      const msg = String(e?.message || e)
      expect(msg).toContain("AuditLog.companyId")
      expect(msg).toContain("BgJob.companyId")
      expect(msg).toContain("AttendancePolicyAssignment.companyId")
      expect(msg).toContain("UserCompanyAccess.permissions")
      expect(msg).toContain("UserCompanyAccess.excludedPermissions")
      expect(msg).toContain("9_wave9zza_mc_expand_20261103")
    }
    // read-only refusal: the table shape is untouched (byte-identical columns)
    const cols = await p.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'UserCompanyAccess' ORDER BY ordinal_position`
    expect(cols.map((c) => c.column_name)).toEqual(["id", "vendorId"])
    await p.$disconnect()
  })

  test("partial repair (one column added) still refuses, naming the remaining four", async () => {
    const p = await buildPreM1Scratch()
    await p.$executeRawUnsafe(`ALTER TABLE "AuditLog" ADD COLUMN "companyId" TEXT`)
    try {
      await assertMultiCompanySchema(p)
      throw new Error("expected the assertion to refuse")
    } catch (e: any) {
      const msg = String(e?.message || e)
      expect(msg).not.toContain("AuditLog.companyId")
      expect(msg).toContain("BgJob.companyId")
      expect(msg).toContain("UserCompanyAccess.permissions")
    }
    await p.$disconnect()
  })

  test("the full M1 set on the scratch database passes (deploy-path equivalence)", async () => {
    const p = await buildPreM1Scratch()
    // one statement per call — PostgreSQL prepared statements take a single command
    await p.$executeRawUnsafe(`ALTER TABLE "AuditLog" ADD COLUMN "companyId" TEXT`)
    await p.$executeRawUnsafe(`ALTER TABLE "BgJob" ADD COLUMN "companyId" TEXT`)
    await p.$executeRawUnsafe(`ALTER TABLE "AttendancePolicyAssignment" ADD COLUMN "companyId" TEXT`)
    await p.$executeRawUnsafe(`ALTER TABLE "UserCompanyAccess" ADD COLUMN "permissions" TEXT NOT NULL DEFAULT '[]'`)
    await p.$executeRawUnsafe(`ALTER TABLE "UserCompanyAccess" ADD COLUMN "excludedPermissions" TEXT NOT NULL DEFAULT '[]'`)
    await assertMultiCompanySchema(p) // resolves without throwing
    await p.$disconnect()
  })
})
