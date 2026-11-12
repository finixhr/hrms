/// <reference types="bun-types" />
// ============ Hotfix #3 (2026-10-22) — backup artifact lifecycle regression =======
// The Phase-3 WS-C rework left the PostgreSQL backup leg writing its dump to
// hrm-<stamp>.dump.tmp and NEVER renaming it to the final hrm-<stamp>.dump —
// every real pg_dump run then ENOENT'd at encryptFile (encrypted) or at
// sha256File (plain). It slipped through because the test container ships no
// pg_dump/pg_restore, so the full runBackup PostgreSQL leg had never executed
// in CI (see phase3-wsc-backup.test.ts's header). This suite closes that gap
// with STUB client tools on PATH:
//
//   1. PostgreSQL + encryption  → DONE, .dump.enc exists, plain .dump and
//      .dump.tmp are gone, checksum recorded, report says flavor=postgresql.
//      (Exactly the customer's failed run — this test ENOENTs on the old code.)
//   2. PostgreSQL, no key       → DONE, PLAIN .dump survives on disk (the
//      artifact IS the deliverable when encryption is off). Also ENOENTs on
//      the old code, later in the pipeline (at the checksum).
//   3. SQLite + encryption      → DONE, .db.gz.enc survives, plain .db.gz
//      removed after encryption.
//   4. SQLite, no key           → DONE, .db.gz SURVIVES — the old code pushed
//      the plain artifact into the temp list unconditionally and the finally
//      DELETED the just-delivered backup (DONE row pointing at a ghost file).
//   5. A failed run (stub exits 1) leaves NO files behind in the backup dir.
//
// The stubs are POSIX shell scripts — this suite is skipped on Windows the way
// the rest of the CI harness is Linux-bound (bunfig/e2e run under Linux).
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { mkdtemp, mkdir, writeFile, chmod, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { db } from "@/lib/db"
import { runBackup, saveBackupSettings } from "@/hrm-server/saas/backup"

const isWindows = process.platform === "win32"

/** Temp workspace: stub bin dir + per-test backup dirs + a fake sqlite file. */
let stubBin = ""
let work = ""
let prevPath: string | undefined = ""
let prevKey: string | undefined
let prevSource: string | undefined

/** Write a stub executable that parses `--file <path>` (pg_dump) or the
 * VACUUM INTO 'path' argument (sqlite3) and writes deterministic bytes. */
async function writeStub(name: string, script: string): Promise<void> {
  const p = path.join(stubBin, name)
  await writeFile(p, `#!/bin/sh\n${script}\n`, "utf8")
  await chmod(p, 0o755)
}

beforeAll(async () => {
  if (isWindows) return
  work = await mkdtemp(path.join(tmpdir(), "hrm-hf3-"))
  stubBin = path.join(work, "bin")
  await mkdir(stubBin, { recursive: true })
  // pg_dump [--file <path> ...] → write a deterministic custom-format-ish blob
  await writeStub(
    "pg_dump",
    `out=""
     while [ $# -gt 0 ]; do
       if [ "$1" = "--file" ]; then out="$2"; shift 2; continue; fi
       shift
     done
     if [ -z "$out" ]; then echo "stub-pg_dump: no --file" >&2; exit 2; fi
     printf 'PGDMPSTUB-9.6-custom-%s' "$$" > "$out"
     exit 0`,
  )
  // sqlite3 <db> "VACUUM INTO '<path>'" → write a deterministic sqlite-ish blob.
  // Quote-safe parsing: the SQL is the LAST argv; strip quotes with tr, the
  // prefix with sed (a case-pattern with escaped quotes trips dash).
  await writeStub(
    "sqlite3",
    `last=""
     for a in "$@"; do last="$a"; done
     out=$(printf '%s' "$last" | tr -d "'" | sed 's/^VACUUM INTO //')
     if [ -z "$out" ]; then echo "stub-sqlite3: no VACUUM INTO" >&2; exit 2; fi
     printf 'SQLITESTUB-%s' "$$" > "$out"
     exit 0`,
  )
  // a stub that FAILS on demand (phase-1 failure → nothing may be left behind)
  await writeStub("pg_dump_fail", `echo "stub-pg_dump: simulated server crash" >&2; exit 1`)
  prevPath = process.env.PATH
  prevKey = process.env.HRM_BACKUP_KEY
  prevSource = process.env.HRM_BACKUP_SOURCE_URL
})

afterEach(async () => {
  // restore env mutated by each test
  process.env.PATH = prevPath
  if (prevKey === undefined) delete process.env.HRM_BACKUP_KEY
  else process.env.HRM_BACKUP_KEY = prevKey
  if (prevSource === undefined) delete process.env.HRM_BACKUP_SOURCE_URL
  else process.env.HRM_BACKUP_SOURCE_URL = prevSource
})

afterAll(async () => {
  if (!isWindows) await rm(work, { recursive: true, force: true }).catch(() => {})
})

/** Point the backup engine at a fresh dir with the stub tools on PATH. */
async function freshBackupDir(): Promise<string> {
  const dir = path.join(work, `backups-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await saveBackupSettings({ dir, retention: 50 })
  process.env.PATH = `${stubBin}${path.delimiter}${prevPath ?? ""}`
  return dir
}

/** Run a backup through the REAL runner (no mocks) and return the run row. */
async function runOnce(trigger: "MANUAL" | "SCHEDULED" = "MANUAL") {
  const result = (await runBackup(
    { id: `hf3-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, payloadJson: JSON.stringify({ trigger }) },
    async () => {},
  )) as { runId: string; artifact: string; checksum: string; encrypted: boolean }
  const row = await db.saasBackupRun.findUnique({ where: { id: result.runId } })
  return { result, row }
}

const files = async (dir: string) => (await readdir(dir)).sort()

describe.skipIf(isWindows)("Hotfix #3 — PostgreSQL backup artifact lifecycle (stub pg_dump)", () => {
  test("encrypted: .dump.tmp is renamed to .dump, then encrypted — the exact customer ENOENT is gone", async () => {
    const dir = await freshBackupDir()
    process.env.HRM_BACKUP_KEY = "hf3-real-backup-key"
    const { result, row } = await runOnce()
    expect(row?.status).toBe("DONE")
    expect(result.encrypted).toBe(true)
    // the final artifact exists and is the ONLY thing in the dir
    expect(await files(dir)).toEqual([path.basename(result.artifact)])
    expect(result.artifact.endsWith(".dump.enc")).toBe(true)
    // no plain dump, no .tmp left behind (the raw data never lingers)
    // checksum recorded + row points at the file that exists
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.locationPath).toBe(result.artifact)
    expect(row?.checksum).toBe(result.checksum)
    expect(row?.sizeBytes).toBeGreaterThan(0)
    const report = JSON.parse(row?.reportJson ?? "{}")
    expect(report.flavor).toBe("postgresql")
    expect(report.encrypted).toBe(true)
    expect(report.format).toContain("pg_dump")
  })

  test("plain (no HRM_BACKUP_KEY): the unencrypted .dump IS the deliverable and survives", async () => {
    const dir = await freshBackupDir()
    delete process.env.HRM_BACKUP_KEY
    const { result, row } = await runOnce()
    expect(row?.status).toBe("DONE")
    expect(result.encrypted).toBe(false)
    expect(result.artifact.endsWith(".dump")).toBe(true)
    expect(await files(dir)).toEqual([path.basename(result.artifact)])
    const report = JSON.parse(row?.reportJson ?? "{}")
    expect(report.flavor).toBe("postgresql")
    expect(report.encrypted).toBe(false)
  })

  test("a phase-1 pg_dump failure leaves NOTHING behind and records FAILED", async () => {
    const dir = await freshBackupDir()
    process.env.HRM_BACKUP_KEY = "hf3-real-backup-key"
    // swap pg_dump for the failing stub (it shadows the real name in stubBin)
    await writeStub(
      "pg_dump",
      `echo "stub-pg_dump: simulated server crash" >&2; exit 1`,
    )
    await expect(runOnce()).rejects.toThrow(/pg_dump exited with code 1/)
    expect(await files(dir)).toEqual([]) // no .tmp, no partial artifacts
    const latest = await db.saasBackupRun.findFirst({ where: { type: "BACKUP" }, orderBy: { startedAt: "desc" } })
    expect(latest?.status).toBe("FAILED")
    expect(String(latest?.error)).toContain("pg_dump")
    // restore the healthy stub for any later test
    await writeStub(
      "pg_dump",
      `out=""
       while [ $# -gt 0 ]; do
         if [ "$1" = "--file" ]; then out="$2"; shift 2; continue; fi
         shift
       done
       if [ -z "$out" ]; then echo "stub-pg_dump: no --file" >&2; exit 2; fi
       printf 'PGDMPSTUB-9.6-custom-%s' "$$" > "$out"
       exit 0`,
    )
  })
})

describe.skipIf(isWindows)("Hotfix #3 — SQLite backup artifact lifecycle (stub sqlite3)", () => {
  test("encrypted: .db.gz.enc survives; the plain .db.gz is removed after encryption", async () => {
    const dir = await freshBackupDir()
    process.env.HRM_BACKUP_KEY = "hf3-real-backup-key"
    // route the flavor at a (nonexistent — the stub never reads it) sqlite file
    process.env.HRM_BACKUP_SOURCE_URL = `file:${path.join(work, "fake-source.db")}`
    const { result, row } = await runOnce()
    expect(row?.status).toBe("DONE")
    expect(result.encrypted).toBe(true)
    expect(result.artifact.endsWith(".db.gz.enc")).toBe(true)
    expect(await files(dir)).toEqual([path.basename(result.artifact)])
    const report = JSON.parse(row?.reportJson ?? "{}")
    expect(report.flavor).toBe("sqlite")
    expect(report.encrypted).toBe(true)
  })

  test("plain (no key): the .db.gz deliverable SURVIVES the finally-cleanup (old code deleted it)", async () => {
    const dir = await freshBackupDir()
    delete process.env.HRM_BACKUP_KEY
    process.env.HRM_BACKUP_SOURCE_URL = `file:${path.join(work, "fake-source.db")}`
    const { result, row } = await runOnce()
    expect(row?.status).toBe("DONE")
    expect(result.encrypted).toBe(false)
    expect(result.artifact.endsWith(".db.gz")).toBe(true)
    // THE regression: the DONE row's artifact still exists on disk afterwards
    expect(await files(dir)).toEqual([path.basename(result.artifact)])
  })
})
