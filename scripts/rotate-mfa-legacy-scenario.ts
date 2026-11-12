// ============ M-3 staging scenario — validates rotate-mfa-legacy-secrets ============
// Creates a controlled fixture on the TEST database (refuses non-test URLs),
// runs the rotation logic end-to-end, and proves:
//   1. a legacy-format row is re-encrypted to "v2:" under HRM_MFA_KEY
//   2. the re-encrypted row decrypts to the SAME TOTP secret
//   3. re-running is a no-op (idempotent)
// Run:  bun run scripts/rotate-mfa-legacy-scenario.ts
import { PrismaClient } from "@prisma/client"
import crypto from "crypto"

const db = new PrismaClient()

const BASE_SALT = "finix-mart-hrm"
const MFA_LEGACY_SALT = "finix-mart-hrm::mfa::v1"
const MFA_CONTEXT = "mfa::v2"

function gate() {
  const url = process.env.DATABASE_URL || ""
  if (!/test|staging/i.test(url)) {
    console.error("ERROR: staging scenario must run against a test/staging DATABASE_URL.")
    console.error(`       DATABASE_URL=${url ? url.replace(/:[^:@/]+@/, ":***@") : "(unset)"}`)
    process.exit(1)
  }
  if (!process.env.HRM_MFA_KEY) {
    console.error("ERROR: HRM_MFA_KEY must be set (the rotation target key).")
    process.exit(1)
  }
}

function encryptLegacy(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(MFA_LEGACY_SALT).digest(), iv)
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return `${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${enc.toString("hex")}`
}

function deriveV2Key(): Buffer {
  const ikm = Buffer.from(process.env.HRM_MFA_KEY || "", "utf8")
  const salt = Buffer.from(BASE_SALT, "utf8")
  const info = Buffer.from(MFA_CONTEXT, "utf8")
  try {
    return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32))
  } catch {
    const prk = crypto.createHmac("sha256", salt).update(ikm).digest()
    return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, 32)
  }
}

function decryptV2(packed: string): string {
  const body = packed.replace(/^v2:/, "")
  const [ivH, tagH, encH] = body.split(".")
  const d = crypto.createDecipheriv("aes-256-gcm", deriveV2Key(), Buffer.from(ivH, "hex"))
  d.setAuthTag(Buffer.from(tagH, "hex"))
  return Buffer.concat([d.update(Buffer.from(encH, "hex")), d.final()]).toString("utf8")
}

function b32secret(): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  return Array.from(crypto.randomBytes(20), (b) => A[b % 32]).join("")
}

async function main() {
  gate()
  console.log("=== M-3 rotation staging scenario ===\n")

  // 1. fixture: vendor + user + legacy-format MFA secret
  const vendor = await db.vendor.create({ data: { name: "M3 Rotation Scenario", code: `M3-${Date.now().toString(36)}` } })
  const user = await db.user.create({
    data: {
      name: "M3 Scenario", email: `m3-${Date.now().toString(36)}@scenario.test`, passwordHash: "x",
      role: "EMPLOYEE", permissions: "[]", vendorId: vendor.id, mfaEnrolled: true,
    },
  })
  const secret = b32secret()
  await db.userMfaSecret.create({
    data: { vendorId: vendor.id, userId: user.id, secretEnc: encryptLegacy(secret), recoveryCodesHash: "[]" },
  })
  console.log(`fixture: user ${user.email} with legacy-format (public-key) secret`)

  // 2. run the rotation script in APPLY mode as a subprocess
  const proc = Bun.spawnSync(["bun", "run", "scripts/rotate-mfa-legacy-secrets.ts", "--apply"], {
    cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "inherit",
  })
  const out = new TextDecoder().decode(proc.stdout)
  console.log(out.trim())
  if (proc.exitCode !== 0) throw new Error(`rotation script exited ${proc.exitCode}`)

  // 3. assert the row is now v2 and decrypts to the SAME secret
  const row = (await db.userMfaSecret.findMany({ where: { userId: user.id } }))[0]
  if (!row.secretEnc.startsWith("v2:")) throw new Error("FAIL: secret still legacy format after rotation")
  const round = decryptV2(row.secretEnc)
  console.log(`\nafter rotation: format=v2, secret roundtrip ${round === secret ? "EXACT ✓" : "MISMATCH ✗"}`)
  if (round !== secret) throw new Error("FAIL: rotated secret does not decrypt to the original plaintext")

  // 4. idempotency: re-run must be a no-op for this row
  const proc2 = Bun.spawnSync(["bun", "run", "scripts/rotate-mfa-legacy-secrets.ts", "--apply"], {
    cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "inherit",
  })
  const out2 = new TextDecoder().decode(proc2.stdout)
  const noLegacy = /No legacy-format MFA secrets found/.test(out2)
  console.log(`re-run no-op: ${noLegacy ? "CONFIRMED ✓ (no legacy rows remain)" : "check output:"}`)
  if (!noLegacy) console.log(out2.trim())

  // 5. cleanup
  await db.userMfaSecret.deleteMany({ where: { userId: user.id } })
  await db.user.delete({ where: { id: user.id } })
  await db.vendor.delete({ where: { id: vendor.id } })
  console.log("\ncleanup done — scenario PASSED")
}

main()
  .catch((e) => { console.error("SCENARIO FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
