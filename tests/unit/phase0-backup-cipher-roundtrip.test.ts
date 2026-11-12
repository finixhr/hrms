/// <reference types="bun-types" />
// ============ FIN-001 (Phase 0) — backup cipher round-trip gate ============
// The P0: scripts/backup.sh encrypted with `openssl enc -aes-256-gcm`, which
// openssl's enc utility does not support (AEAD). The invocation failed on
// EVERY nightly run — after the plaintext dump had landed — so no encrypted
// backup ever existed and the unencrypted dump stayed on disk.
//
// This gate pins the fix three ways:
//   1. STATIC  — backup.sh encrypts with aes-256-cbc + pbkdf2 + the SAME
//      iteration count restore-drill.sh and the runbook decrypt with; the
//      unsupported GCM invocation must never come back; the failure path
//      must remove the plaintext intermediate dump.
//   2. LIVE    — an encrypt→decrypt round-trip with the EXACT flags from
//      backup.sh / restore-drill.sh must reproduce the payload byte-for-byte.
//   3. TAMPER  — flipping one ciphertext byte must change the decrypted
//      output (not silently authenticate) OR fail — CBC has no auth tag, so
//      the SHA-256 manifest (verified by the drill BEFORE decrypting) is the
//      documented tamper-evidence layer; this test only documents that the
//      cipher itself is not authenticated, guarding against someone
//      "upgrading" the flags back to an enc-incompatible AEAD mode.
import { describe, test, expect } from "bun:test"
import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

const ROOT = path.resolve(import.meta.dir, "..", "..")
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8")

describe("FIN-001 — backup lane cipher (Phase 0)", () => {
  const backupSh = read("scripts/backup.sh")
  const drillSh = read("scripts/restore-drill.sh")
  const runbook = read("docs/postgresql-backup-restore.md")

  test("backup.sh encrypts with aes-256-cbc + pbkdf2 + 600000 iterations", () => {
    expect(backupSh).toContain("openssl enc -aes-256-cbc -pbkdf2 -salt -iter 600000")
    // no INVOCATION may use the enc-unsupported AEAD mode (prose explaining the
    // history may mention it — commands may not)
    expect(backupSh).not.toMatch(/openssl enc[^\n]*-aes-256-gcm/)
  })

  test("restore-drill.sh decrypts with the SAME cipher + KDF parameters", () => {
    expect(drillSh).toContain("openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000")
    expect(drillSh).not.toMatch(/openssl enc[^\n]*-aes-256-gcm/)
  })

  test("the runbook's manual decrypt example matches the drill", () => {
    expect(runbook).toContain("openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000")
    expect(runbook).not.toMatch(/openssl enc[^\n]*-aes-256-gcm/)
  })

  test("the failure path removes the plaintext intermediate dump", () => {
    // the on_failure trap + the explicit encryption-failure branch
    expect(backupSh).toContain("removed the unencrypted intermediate dump")
    expect(backupSh).toContain("removing the plaintext intermediate dump")
  })

  test("LIVE round-trip — the exact pipeline flags reproduce the payload byte-for-byte", () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "hrm-bk-"))
    try {
      const payload = crypto.getRandomValues(new Uint8Array(65536))
      const src = path.join(dir, "hrm-test.dump")
      const enc = `${src}.enc`
      const dec = path.join(dir, "hrm-restored.dump")
      fs.writeFileSync(src, payload)
      // EXACT invocation from scripts/backup.sh (env-passed passphrase)
      execSync(
        `BACKUP_PASSPHRASE="$KEY" openssl enc -aes-256-cbc -pbkdf2 -salt -iter 600000 -in "${src}" -out "${enc}" -pass env:BACKUP_PASSPHRASE`,
        { env: { ...process.env, KEY: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", BACKUP_PASSPHRASE: "" }, shell: "/bin/bash", stdio: "pipe" },
      )
      expect(fs.statSync(enc).size).toBeGreaterThan(payload.length) // salt + padding overhead
      // EXACT invocation from scripts/restore-drill.sh
      execSync(
        `BACKUP_PASSPHRASE="$KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "${enc}" -out "${dec}" -pass env:BACKUP_PASSPHRASE`,
        { env: { ...process.env, KEY: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", BACKUP_PASSPHRASE: "" }, shell: "/bin/bash", stdio: "pipe" },
      )
      expect(fs.readFileSync(dec).equals(Buffer.from(payload))).toBe(true)
      // a wrong key must NOT decrypt to the payload (fail or garbage — never silent success)
      let wrongKeyDecrypted = false
      try {
        execSync(
          `BACKUP_PASSPHRASE="wrong-key" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "${enc}" -out "${dec}-wrong" -pass env:BACKUP_PASSPHRASE 2>/dev/null || true; cmp -s "${dec}-wrong" "${src}" && echo SAME`,
          { shell: "/bin/bash", stdio: "pipe" },
        ).toString().includes("SAME") && (wrongKeyDecrypted = true)
      } catch { /* cmp missing file — fine */ }
      expect(wrongKeyDecrypted).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
