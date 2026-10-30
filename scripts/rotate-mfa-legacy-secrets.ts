// ============ M-3 one-shot rotation — re-encrypt legacy MFA secrets ============
// Audit M-3: TOTP secrets written before the H-8 remediation are encrypted
// under a key derived from a PUBLIC repo constant (MFA_LEGACY_SALT) — anyone
// with a database dump can decrypt them. H-8 introduced the env key
// (HRM_MFA_KEY) plus lazy migration on next successful verify; this script
// closes the gap for rows whose owner has not logged in since: it re-encrypts
// every legacy-format UserMfaSecret row under the deployment key in one pass.
//
// MODES
//   (default)           DRY-RUN — report only, changes nothing
//   --apply             re-encrypt the reported rows
//   --apply --allow-production   required (in addition to --apply) when
//                         DATABASE_URL does not contain "test"/"staging"
//
// PREREQUISITE: HRM_MFA_KEY must be set (64-char hex) — the script refuses to
// run without it (there is nothing to rotate TO).
//
// Idempotent by construction: re-encrypted rows carry the "v2:" prefix and
// are skipped on re-run. Rows that fail BOTH the legacy decrypt and the
// env-key decrypt are reported CORRUPT and never touched (no data loss).
//
// A HUMAN runs this against production after validating on staging:
//   bun run scripts/rotate-mfa-legacy-secrets.ts                   # dry-run
//   bun run scripts/rotate-mfa-legacy-secrets.ts --apply --allow-production
import { PrismaClient } from "@prisma/client"
import crypto from "crypto"

const db = new PrismaClient()
const APPLY = process.argv.includes("--apply")
const ALLOW_PROD = process.argv.includes("--allow-production")

function gate() {
  const url = process.env.DATABASE_URL || ""
  if (!url) {
    console.error("ERROR: DATABASE_URL is not set.")
    process.exit(1)
  }
  const looksProd = !/test|staging/i.test(url)
  if (APPLY && looksProd && !ALLOW_PROD) {
    console.error("ERROR: --apply against a non-test/staging DATABASE_URL requires --allow-production.")
    console.error(`       DATABASE_URL=${url.replace(/:[^:@/]+@/, ":***@")}`)
    console.error("       Run the DRY-RUN first, review the report, and take a fresh backup.")
    process.exit(1)
  }
  const key = process.env.HRM_MFA_KEY || ""
  if (!key) {
    console.error("ERROR: HRM_MFA_KEY is not set — there is no deployment key to rotate TO.")
    console.error("       Generate one with: openssl rand -hex 32   (then re-run this script).")
    process.exit(1)
  }
}

// Local crypto mirrors (kept self-contained like the H-5/H-9 repair scripts —
// no src imports so the script runs against any checkout):
//   legacy: AES-256-GCM under sha256("finix-mart-hrm::mfa::v1") — PUBLIC key (M-3)
//   v2:     AES-256-GCM under HKDF-SHA256(base="finix-mart-hrm", info="mfa::v2", ikm=HRM_MFA_KEY)
const BASE_SALT = "finix-mart-hrm"
const MFA_LEGACY_SALT = "finix-mart-hrm::mfa::v1"
const MFA_CONTEXT = "mfa::v2"

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

function decryptLegacy(packed: string): string {
  const [ivH, tagH, encH] = packed.split(".")
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(MFA_LEGACY_SALT).digest(), Buffer.from(ivH, "hex"))
  d.setAuthTag(Buffer.from(tagH, "hex"))
  return Buffer.concat([d.update(Buffer.from(encH, "hex")), d.final()]).toString("utf8")
}

function encryptV2(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", deriveV2Key(), iv)
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return `v2:${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${enc.toString("hex")}`
}

async function main() {
  gate()
  console.log(`=== M-3 legacy MFA secret rotation — ${APPLY ? "APPLY" : "DRY-RUN"} ===`)
  console.log("(pre-H8 rows are encrypted under a PUBLIC constant — this re-encrypts them under HRM_MFA_KEY)\n")

  const rows = await db.userMfaSecret.findMany()
  const legacy = rows.filter((r) => !String(r.secretEnc || "").startsWith("v2:"))
  if (!legacy.length) {
    console.log(`No legacy-format MFA secrets found (${rows.length} row(s) checked) — nothing to rotate.`)
    return
  }

  let rotated = 0
  const corrupt: string[] = []
  for (const row of legacy) {
    let plain: string
    try {
      plain = decryptLegacy(row.secretEnc)
      if (!plain) throw new Error("empty plaintext")
    } catch (e: any) {
      corrupt.push(`${row.id} (user ${row.userId}): legacy decrypt failed — ${e?.message || e}`)
      continue
    }
    const v2 = encryptV2(plain)
    if (APPLY) {
      await db.userMfaSecret.update({ where: { id: row.id }, data: { secretEnc: v2 } })
      console.log(`  rotated ${row.id} (user ${row.userId}) → v2 under HRM_MFA_KEY`)
    } else {
      console.log(`  would rotate ${row.id} (user ${row.userId}) — legacy format, decrypts cleanly`)
    }
    rotated++
  }

  console.log(`\n${APPLY ? "Rotated" : "Would rotate"}: ${rotated} row(s).`)
  if (corrupt.length) {
    console.log(`CORRUPT (untouched — manual review): ${corrupt.length}`)
    for (const c of corrupt) console.log(`  ${c}`)
    console.log("These rows decrypt under NEITHER key. They were already unusable; owners must re-enroll.")
  }
  if (!APPLY) console.log("\nDry-run only — re-run with --apply (plus --allow-production on prod) to rotate.")
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
