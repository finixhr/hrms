/// <reference types="bun-types" />
// ============ Phase 3 WS-C — backup hardening (OPS-1/2/3) =====================
// The unit suite covers what runs WITHOUT the postgres client tools (the test
// container ships no pg_dump/pg_restore): the AES-256-CBC at-rest encryption
// round-trip (OPS-1), the artifact flavor router that keeps pre-Phase-3
// artifacts restorable (OPS-2), encryption gating on HRM_BACKUP_KEY, and the
// /readyz long-job exclusion that stops Docker from restarting the container
// mid-backup (OPS-3).
import "./_testdb"
import { describe, test, expect, afterAll } from "bun:test"
import { db } from "@/lib/db"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  encryptFile, decryptFile, backupEncryptionEnabled, backupArtifactFlavor,
} from "@/hrm-server/saas/backup"
import { GET as readyz } from "@/app/api/readyz/route"
import { NextRequest } from "next/server"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p3-backup-"))
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe("OPS-1 — at-rest encryption (AES-256-CBC, PBKDF2-SHA256, streaming)", () => {
  test("encrypt → decrypt round-trips byte-identically", async () => {
    const src = path.join(tmp, "plain.dump")
    const payload = Buffer.concat([
      Buffer.from("PGDMP custom-format archive simulation\n"),
      crypto.randomBytes(256 * 1024), // a real-sized blob
    ])
    fs.writeFileSync(src, payload)

    const enc = path.join(tmp, "plain.dump.enc")
    await encryptFile(src, enc, "p3-backup-key")

    // ciphertext ≠ plaintext and carries the documented header
    const cipher = fs.readFileSync(enc)
    expect(cipher.length).toBeGreaterThanOrEqual(payload.length + 7 + 16 + 16)
    expect(cipher.subarray(0, 7).toString("utf8")).toBe("HRMBK1\n")
    expect(cipher.includes(payload.subarray(0, 64))).toBe(false)

    const back = path.join(tmp, "roundtrip.dump")
    await decryptFile(enc, back, "p3-backup-key")
    expect(fs.readFileSync(back).equals(payload)).toBe(true)
  })

  test("a wrong key fails the round-trip instead of returning garbage", async () => {
    const src = path.join(tmp, "secret.dump")
    fs.writeFileSync(src, Buffer.from("sensitive tenant data"))
    const enc = path.join(tmp, "secret.dump.enc")
    await encryptFile(src, enc, "correct-key")
    const out = path.join(tmp, "secret-wrong.dump")
    await expect(decryptFile(enc, out, "WRONG-key")).rejects.toThrow()
  })

  test("a non-artifact file is refused with a clear header error", async () => {
    const notEnc = path.join(tmp, "not-an-artifact")
    fs.writeFileSync(notEnc, Buffer.from("plain text that is not a backup"))
    await expect(decryptFile(notEnc, path.join(tmp, "x"), "k")).rejects.toThrow(/Not a Finix HR encrypted backup/)
  })

  test("backupEncryptionEnabled follows HRM_BACKUP_KEY", () => {
    const prev = process.env.HRM_BACKUP_KEY
    delete process.env.HRM_BACKUP_KEY
    expect(backupEncryptionEnabled()).toBe(false)
    process.env.HRM_BACKUP_KEY = "  " // whitespace-only = unset
    expect(backupEncryptionEnabled()).toBe(false)
    process.env.HRM_BACKUP_KEY = "p3-real-key"
    expect(backupEncryptionEnabled()).toBe(true)
    if (prev === undefined) delete process.env.HRM_BACKUP_KEY
    else process.env.HRM_BACKUP_KEY = prev
  })
})

describe("OPS-2 — artifact flavor router (custom format now, plain-SQL before)", () => {
  test("every artifact generation this engine ever wrote is recognized", () => {
    expect(backupArtifactFlavor("backups/hrm-20261022T010500Z.dump")).toBe("pg-custom")
    expect(backupArtifactFlavor("backups/hrm-20261022T010500Z.dump.enc")).toBe("pg-custom")
    expect(backupArtifactFlavor("backups/hrm-20260901T010500Z.sql.gz")).toBe("pg-plain-gz") // pre-Phase-3
    expect(backupArtifactFlavor("backups/hrm-20260901T010500Z.sql.gz.enc")).toBe("pg-plain-gz")
    expect(backupArtifactFlavor("backups/hrm-20261022T010500Z.db.gz")).toBe("sqlite-gz")
    expect(backupArtifactFlavor("backups/hrm-20261022T010500Z.db.gz.enc")).toBe("sqlite-gz")
    expect(backupArtifactFlavor("backups/something-else")).toBe("unknown")
  })
})

describe("OPS-3 — /readyz excludes known-long job types from the staleness check", () => {
  test("a 20-minute RUNNING BACKUP_PG_DUMP keeps the instance READY", async () => {
    const job = await db.bgJob.create({
      data: {
        vendorId: "platform", type: "BACKUP_PG_DUMP",
        status: "RUNNING", startedAt: new Date(Date.now() - 20 * 60_000),
      },
    })
    try {
      const res = await readyz()
      const body = await res.json()
      // the bgJobQueue CHECK is the assertion target (the overall status also
      // reflects the migrations check, which a db-pushed test database lacks)
      expect(body.checks.bgJobQueue.ok).toBe(true)
      expect(String(body.checks.bgJobQueue.detail)).toContain("excluded")
    } finally {
      await db.bgJob.delete({ where: { id: job.id } })
    }
  })

  test("a 20-minute RUNNING ordinary job still flips readiness (the deadlock signal stays)", async () => {
    const job = await db.bgJob.create({
      data: {
        vendorId: "platform", type: "COMMUNICATION_SEND",
        status: "RUNNING", startedAt: new Date(Date.now() - 20 * 60_000),
      },
    })
    try {
      const res = await readyz()
      const body = await res.json()
      expect(body.checks.bgJobQueue.ok).toBe(false) // the deadlock signal stays
      expect(String(body.checks.bgJobQueue.detail)).toMatch(/stale RUNNING/)
    } finally {
      await db.bgJob.delete({ where: { id: job.id } })
    }
  })

  test("RESTORE_DRILL is excluded as well", async () => {
    const job = await db.bgJob.create({
      data: {
        vendorId: "platform", type: "RESTORE_DRILL",
        status: "RUNNING", startedAt: new Date(Date.now() - 15 * 60_000),
      },
    })
    try {
      const res = await readyz()
      const body = await res.json()
      expect(body.checks.bgJobQueue.ok).toBe(true)
    } finally {
      await db.bgJob.delete({ where: { id: job.id } })
    }
  })
})
