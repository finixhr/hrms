// ============ M-20 + M-36 + F28(P6) — encrypt plaintext secrets at rest (one-shot) ============
// Audit M-20: AttendanceDevice.commKey was stored in plaintext next to its
// scrypt hash — a database dump exposed working device credentials. Audit
// M-36: the SMTP password and SMS apiKey/apiSecret sat in cleartext HrSetting
// rows. Audit F28 (Phase 5 P6): employee PII — BankAccount.accountNumber /
// mfsNumber and EmployeeDocument.docNumber / fileData — was plaintext at
// rest (masking was API-layer only). All families are now encrypted at rest
// under HRM_MFA_KEY (AES-256-GCM via the shared crypto-field scheme,
// context-separated), with legacy plaintext rows still readable so upgrades
// never break — this script re-wraps every remaining plaintext row in one
// pass so a database dump alone no longer exposes working credentials or
// employee PII.
//
// MODES
//   (default)           DRY-RUN — report only, changes nothing
//   --apply             re-wrap the reported rows
//   --apply --allow-production   required (in addition to --apply) when
//                         DATABASE_URL does not contain "test"/"staging"
//
// PREREQUISITE: HRM_MFA_KEY must be set (64-char hex).
//
// Idempotent by construction: encrypted rows carry the format markers
// ("enc::" for comm keys, "enc::" JSON for settings) and are skipped on re-run.
//
// A HUMAN runs this against production after validating on staging:
//   bun run scripts/encrypt-secrets-at-rest.ts                   # dry-run
//   bun run scripts/encrypt-secrets-at-rest.ts --apply --allow-production
import { PrismaClient } from "@prisma/client"
import crypto from "crypto"

const db = new PrismaClient()
const APPLY = process.argv.includes("--apply")
const ALLOW_PROD = process.argv.includes("--allow-production")

const BASE_SALT = "finix-mart-hrm"
const ENC_PREFIX = "enc::"

function hkdfKey(context: string): Buffer {
  const ikm = Buffer.from(process.env.HRM_MFA_KEY || "", "utf8")
  const salt = Buffer.from(BASE_SALT, "utf8")
  const info = Buffer.from(context, "utf8")
  try {
    return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32))
  } catch {
    const prk = crypto.createHmac("sha256", salt).update(ikm).digest()
    return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, 32)
  }
}

function encField(plain: string, context: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", hkdfKey(context), iv)
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return `${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${enc.toString("hex")}`
}

/** F28 (P6) — the pii::v1 file envelope (encf::<ivB64>.<tagB64>.<dataB64>).
 * Same key derivation as encField, base64 transport for MB payloads. */
function encFieldFile(plain: string): string {
  const [ivH, tagH, encH] = encField(plain, "pii::v1").split(".")
  return [
    Buffer.from(ivH, "hex").toString("base64"),
    Buffer.from(tagH, "hex").toString("base64"),
    Buffer.from(encH, "hex").toString("base64"),
  ].join(".")
}

function gate() {
  const url = process.env.DATABASE_URL || ""
  if (!url) {
    console.error("ERROR: DATABASE_URL is not set.")
    process.exit(1)
  }
  if (APPLY && !/test|staging/i.test(url) && !ALLOW_PROD) {
    console.error("ERROR: --apply against a non-test/staging DATABASE_URL requires --allow-production.")
    console.error(`       DATABASE_URL=${url.replace(/:[^:@/]+@/, ":***@")}`)
    console.error("       Run the DRY-RUN first, review the report, and take a fresh backup.")
    process.exit(1)
  }
  if (!process.env.HRM_MFA_KEY) {
    console.error("ERROR: HRM_MFA_KEY is not set — there is no deployment key to encrypt under.")
    console.error("       Generate one with: openssl rand -hex 32   (then re-run this script).")
    process.exit(1)
  }
}

async function rotateCommKeys(): Promise<number> {
  let n = 0
  const devices = await db.attendanceDevice.findMany({ where: { commKey: { not: null } }, select: { id: true, deviceIdentifier: true, commKey: true } })
  for (const d of devices) {
    const v = d.commKey || ""
    if (!v || v.startsWith(ENC_PREFIX)) continue // already encrypted
    if (APPLY) {
      await db.attendanceDevice.update({ where: { id: d.id }, data: { commKey: ENC_PREFIX + encField(v, "devices::v1") } })
      console.log(`  [commKey] wrapped device ${d.deviceIdentifier} (${d.id})`)
    } else {
      console.log(`  [commKey] would wrap device ${d.deviceIdentifier} (${d.id}) — plaintext at rest`)
    }
    n++
  }
  return n
}

/** M-36 — settings secrets: stored as JSON strings in HrSetting.value. The
 *  encrypted form is the JSON string "enc::<iv.tag.enc>" (comms::v1 context). */
const SETTINGS_SECRETS: [string, string][] = [
  ["email", "password"],
  ["sms", "apiKey"],
  ["sms", "apiSecret"],
]

async function rotateSettingsSecrets(): Promise<number> {
  let n = 0
  for (const [group, key] of SETTINGS_SECRETS) {
    const rows = await db.hrSetting.findMany({ where: { group, key } })
    for (const r of rows) {
      const raw = (() => { try { return JSON.parse(r.value) } catch { return null } })()
      if (typeof raw !== "string" || raw === "" || raw.startsWith(ENC_PREFIX)) continue
      if (APPLY) {
        await db.hrSetting.update({ where: { id: r.id }, data: { value: JSON.stringify(ENC_PREFIX + encField(raw, "comms::v1")) } })
        console.log(`  [settings] wrapped ${group}.${key} for vendor ${r.vendorId}`)
      } else {
        console.log(`  [settings] would wrap ${group}.${key} for vendor ${r.vendorId} — plaintext at rest`)
      }
      n++
    }
  }
  return n
}

/** F28 (P6) — employee PII rotation: bank/MFS account numbers, document
 *  numbers and document FILES (base64 payload → encf:: envelope). The stored
 *  (encrypted) file length replaces the plaintext length in UsageRollup so
 *  the storage quota keeps tracking actual database bytes. */
async function rotatePiiRows(): Promise<number> {
  let n = 0
  // ---- BankAccount.accountNumber / mfsNumber ----
  const accounts = await db.bankAccount.findMany({
    where: { OR: [{ accountNumber: { not: null } }, { mfsNumber: { not: null } }] },
    select: { id: true, employeeId: true, accountNumber: true, mfsNumber: true },
  })
  for (const a of accounts) {
    const data: Record<string, string | null> = {}
    if (a.accountNumber && !a.accountNumber.startsWith(ENC_PREFIX)) {
      data.accountNumber = ENC_PREFIX + encField(a.accountNumber, "pii::v1")
    }
    if (a.mfsNumber && !a.mfsNumber.startsWith(ENC_PREFIX)) {
      data.mfsNumber = ENC_PREFIX + encField(a.mfsNumber, "pii::v1")
    }
    if (!Object.keys(data).length) continue
    if (APPLY) {
      await db.bankAccount.update({ where: { id: a.id }, data })
      console.log(`  [pii] wrapped bank account ${a.id} (employee ${a.employeeId})`)
    } else {
      console.log(`  [pii] would wrap bank account ${a.id} (employee ${a.employeeId}) — plaintext at rest`)
    }
    n++
  }
  // ---- EmployeeDocument.docNumber / fileData ----
  // Chunked scan (never materialize every document byte at once): fetch ids
  // first, then row-by-row so peak memory stays at ONE file payload.
  const docIds = await db.employeeDocument.findMany({
    where: { OR: [{ docNumber: { not: null } }, { fileData: { not: null } }] },
    select: { id: true },
  })
  for (const { id } of docIds) {
    const d = await db.employeeDocument.findUnique({ where: { id }, select: { id: true, vendorId: true, docNumber: true, fileData: true } })
    if (!d) continue
    const data: Record<string, string> = {}
    let oldLen = 0, newLen = 0
    if (d.docNumber && !d.docNumber.startsWith(ENC_PREFIX)) {
      data.docNumber = ENC_PREFIX + encField(d.docNumber, "pii::v1")
    }
    if (d.fileData && !d.fileData.startsWith("encf::")) {
      oldLen = d.fileData.length
      data.fileData = "encf::" + encFieldFile(d.fileData)
      newLen = data.fileData.length
    }
    if (!Object.keys(data).length) continue
    if (APPLY) {
      await db.employeeDocument.update({ where: { id: d.id }, data })
      // keep the storage rollup tracking actual DB bytes (encf is ≈ input
      // +33%; the nightly reconcileStorageRollups pass heals any residual
      // drift by recomputing LENGTH("fileData") from the stored rows)
      if (newLen !== oldLen) {
        await db.usageRollup.upsert({
          where: { vendorId: d.vendorId },
          create: { vendorId: d.vendorId, storageBytes: BigInt(Math.max(0, newLen - oldLen)) },
          update: { storageBytes: { increment: BigInt(newLen - oldLen) } },
        }).catch(() => { /* best-effort — nightly reconcile heals */ })
      }
      console.log(`  [pii] wrapped document ${d.id}${d.fileData ? " (incl. file bytes)" : ""}`)
    } else {
      console.log(`  [pii] would wrap document ${d.id}${d.fileData ? " (incl. file bytes)" : ""} — plaintext at rest`)
    }
    n++
  }
  return n
}

async function main() {
  gate()
  console.log(`=== M-20/M-36/F28 secrets+PII-at-rest rotation — ${APPLY ? "APPLY" : "DRY-RUN"} ===`)
  console.log("(device commKeys + SMTP/SMS secrets + employee PII: bank/MFS numbers, doc numbers, doc files → AES-256-GCM under HRM_MFA_KEY)\n")
  const a = await rotateCommKeys()
  const b = await rotateSettingsSecrets()
  const c = await rotatePiiRows()
  console.log(`\n${APPLY ? "Wrapped" : "Would wrap"}: ${a} comm key(s), ${b} settings secret(s), ${c} employee PII row(s).`)
  if (!APPLY) console.log("Dry-run only — re-run with --apply (plus --allow-production on prod) to wrap.")
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
