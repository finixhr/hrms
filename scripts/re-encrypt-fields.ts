// ============ SEC-13 (Phase 1) — re-encrypt at-rest fields after a key rotation ============
// Companion to scripts/rotate-secrets.ts. When HRM_MFA_KEY (or a per-context
// override) rotates, every encrypted-at-rest field must be re-wrapped under
// the NEW key — until then the app reads them as garbage (GCM auth failure).
// MFA TOTP secrets self-heal lazily on next verify (totp.ts needsReencrypt),
// but the eager surfaces need this pass:
//
//   1. AttendanceDevice.commKey           — context devices::v1 ("enc::" rows)
//   2. HrSetting comms rows               — context comms::v1 ("enc::" rows)
//   3. SaaSSetting payments credentials   — context saas-payments::v1 (raw rows)
//   4. WebhookEndpoint.secret             — context webhooks::v1
//   5. AiProvider secrets                 — context ai::v1 (raw rows in HrSetting)
//   6. CameraCredential.encryptedPayload  — context cameras::v<row version>
//   7. UserMfaSecret / SaasOwnerMfaSecret — context mfa::v2 ("v2:" rows; eager
//      even though the lazy path exists, so the rotation is complete at once)
//
// Keys:
//   HRM_MFA_KEY / per-context overrides — the NEW values (already in .env)
//   HRM_OLD_MFA_KEY                     — the value being rotated AWAY from
//   (plus HRM_OLD_CAMERA_KEY etc. when the per-context keys rotated too;
//    one OLD_* per context, all optional — a context without an OLD_* value
//    is reported as "cannot decrypt" if its rows are not yet under the new key)
//
// MODES
//   (default)  DRY-RUN — report only
//   --apply    write the re-wrapped rows
//
// Idempotent: rows already under the new key are skipped (reencryptField
// returns null after a successful new-key decrypt).
//
//   HRM_OLD_MFA_KEY=... bun run scripts/re-encrypt-fields.ts          # dry-run
//   HRM_OLD_MFA_KEY=... bun run scripts/re-encrypt-fields.ts --apply
import { PrismaClient } from "@prisma/client"
import { reencryptField, decryptFieldWithKey } from "../src/hrm-server/crypto-field"

const db = new PrismaClient()
const APPLY = process.argv.includes("--apply")

const NEW_ROOT = process.env.HRM_MFA_KEY || ""
const OLD_ROOT = process.env.HRM_OLD_MFA_KEY || ""
const contextKeys = (context: string): { newKey: string; oldKey?: string } => {
  const perContext: Record<string, [string, string]> = {
    "cameras::": ["HRM_CAMERA_KEY", "HRM_OLD_CAMERA_KEY"],
    "devices::v1": ["HRM_DEVICE_KEY", "HRM_OLD_DEVICE_KEY"],
    "webhooks::v1": ["HRM_WEBHOOK_KEY", "HRM_OLD_WEBHOOK_KEY"],
    "ai::v1": ["HRM_AI_KEY", "HRM_OLD_AI_KEY"],
    "comms::v1": ["HRM_COMMS_KEY", "HRM_OLD_COMMS_KEY"],
    "saas-payments::v1": ["HRM_PAYMENTS_KEY", "HRM_OLD_PAYMENTS_KEY"],
    "mfa::v2": ["HRM_MFA_KEY", "HRM_OLD_MFA_KEY"],
    "pii::v1": ["HRM_PII_KEY", "HRM_OLD_PII_KEY"],  // T2-006: BankAccount, EmployeeDocument
  }
  for (const [prefix, [ne, oe]] of Object.entries(perContext)) {
    if (context.startsWith(prefix)) {
      return {
        newKey: (process.env[ne] as string) || NEW_ROOT,
        oldKey: (process.env[oe] as string) || (prefix === "mfa::v2" ? OLD_ROOT || undefined : undefined),
      }
    }
  }
  return { newKey: NEW_ROOT, oldKey: OLD_ROOT || undefined }
}

type RowReport = { table: string; id: string; outcome: "re-encrypted" | "already-new" | "FAILED (decrypts under neither key)" | "skipped (no old key)" }
const report: RowReport[] = []

async function rewrite(
  table: string,
  rows: Array<{ id: string; packed: string }>,
  contextOf: (row: any) => string,
  persist: (row: any, newPacked: string) => Promise<unknown>,
): Promise<void> {
  for (const row of rows) {
    const context = contextOf(row)
    const { newKey, oldKey } = contextKeys(context)
    if (!newKey) { report.push({ table, id: row.id, outcome: "skipped (no old key)" }); continue }
    const next = reencryptField(row.packed, context, newKey, oldKey)
    if (next === null) {
      // null = already under new key, OR undecryptable — distinguish loudly
      let alreadyNew = false
      try { decryptFieldWithKey(row.packed, context, newKey); alreadyNew = true } catch { alreadyNew = false }
      report.push({ table, id: row.id, outcome: alreadyNew ? "already-new" : oldKey ? "FAILED (decrypts under neither key)" : "skipped (no old key)" })
      continue
    }
    report.push({ table, id: row.id, outcome: "re-encrypted" })
    if (APPLY) await persist(row, next)
  }
}

async function main() {
  if (!NEW_ROOT) {
    console.error("ERROR: HRM_MFA_KEY (the NEW key) is not set — run scripts/rotate-secrets.ts first.")
    process.exit(1)
  }
  if (!OLD_ROOT) {
    console.warn("NOTE: HRM_OLD_MFA_KEY is not set — rows that are not yet under the new key cannot be re-wrapped and will be reported as skipped.")
  }
  console.log(`rotation: old ${OLD_ROOT ? "provided" : "ABSENT"} → new provided; --apply=${APPLY}`)

  // 1. device comm keys ("enc::<iv.tag.enc>")
  {
    const devices = await db.attendanceDevice.findMany({ where: { commKey: { startsWith: "enc::" } }, select: { id: true, commKey: true } })
    await rewrite("AttendanceDevice.commKey", devices.map((d) => ({ id: d.id, packed: (d.commKey || "").slice(5) })), () => "devices::v1",
      async (row, next) => { await db.attendanceDevice.update({ where: { id: row.id }, data: { commKey: "enc::" + next } }) })
  }
  // 2. comms settings rows — stored as JSON.stringify("enc::<iv.tag.enc>")
  //    (settings.ts wraps the value, then the save path JSON-stringifies it);
  //    restricted to the comms secret keys settings.ts actually wraps.
  {
    const commsKeys = new Set(["email", "sms"]) // groups carrying wrapped secrets
    const rows = await db.hrSetting.findMany({ where: { group: { in: [...commsKeys] } }, select: { id: true, key: true, value: true, group: true } })
    const wrapped: Array<{ id: string; packed: string }> = []
    for (const r of rows) {
      if (!["password", "apiKey", "apiSecret"].includes(r.key)) continue
      let v: unknown = null
      try { v = JSON.parse(r.value || "") } catch { continue }
      if (typeof v === "string" && v.startsWith("enc::")) wrapped.push({ id: r.id, packed: v.slice(5) })
    }
    await rewrite("HrSetting.comms", wrapped, () => "comms::v1",
      async (row, next) => { await db.hrSetting.update({ where: { id: row.id }, data: { value: JSON.stringify("enc::" + next) } }) })
  }
  // 3. payments credentials (raw packed values in SaaSSetting group "payments")
  {
    const rows = await db.saasSetting.findMany({ where: { group: "payments" }, select: { id: true, key: true, value: true } })
    const subset = rows.filter((r) => r.key.startsWith("credentials:") && r.value && r.value.includes("."))
    await rewrite("SaaSSetting.payments", subset.map((r) => ({ id: r.id, packed: r.value as string })), () => "saas-payments::v1",
      async (row, next) => { await db.saasSetting.update({ where: { id: row.id }, data: { value: next } }) })
  }
  // 4. webhook secrets
  {
    const rows = await db.webhookEndpoint.findMany({ where: { secret: { not: null } }, select: { id: true, secret: true } })
    await rewrite("WebhookEndpoint.secret", rows.map((r) => ({ id: r.id, packed: (r.secret || "") as string })), () => "webhooks::v1",
      async (row, next) => { await db.webhookEndpoint.update({ where: { id: row.id }, data: { secret: next } }) })
  }
  // 5. AI provider keys ("enc::<...>" rows in HrSetting group "ai", JSON-stringified)
  {
    const rows = await db.hrSetting.findMany({ where: { group: "ai" }, select: { id: true, key: true, value: true } })
    const wrapped: Array<{ id: string; packed: string }> = []
    for (const r of rows) {
      let v: unknown = null
      try { v = JSON.parse(r.value || "") } catch { continue }
      if (typeof v === "string" && v.startsWith("enc::")) wrapped.push({ id: r.id, packed: v.slice(5) })
    }
    await rewrite("HrSetting.ai", wrapped, () => "ai::v1",
      async (row, next) => { await db.hrSetting.update({ where: { id: row.id }, data: { value: JSON.stringify("enc::" + next) } }) })
  }
  // 6. camera credentials (context carries the row's key version)
  {
    const rows = await db.cameraCredential.findMany({ select: { id: true, encryptedPayload: true, encryptionKeyVersion: true } })
    await rewrite("CameraCredential", rows.map((r) => ({ id: r.id, packed: r.encryptedPayload })), (row) => `cameras::v${row.encryptionKeyVersion || 1}`,
      async (row, next) => { await db.cameraCredential.update({ where: { id: row.id }, data: { encryptedPayload: next, rotatedAt: new Date() } }) })
  }
  // 7. MFA TOTP secrets ("v2:" prefix; context mfa::v2)
  {
    const users = await db.userMfaSecret.findMany({ where: { secretEnc: { startsWith: "v2:" } }, select: { id: true, secretEnc: true } })
    await rewrite("UserMfaSecret", users.map((r) => ({ id: r.id, packed: (r.secretEnc || "").slice(4) })), () => "mfa::v2",
      async (row, next) => { await db.userMfaSecret.update({ where: { id: row.id }, data: { secretEnc: "v2:" + next } }) })
    const owners = await db.saasOwnerMfaSecret.findMany({ where: { secretEnc: { startsWith: "v2:" } }, select: { id: true, secretEnc: true } })
    await rewrite("SaasOwnerMfaSecret", owners.map((r) => ({ id: r.id, packed: (r.secretEnc || "").slice(4) })), () => "mfa::v2",
      async (row, next) => { await db.saasOwnerMfaSecret.update({ where: { id: row.id }, data: { secretEnc: "v2:" + next } }) })
  }
  // 8. PII fields — BankAccount.accountNumber (T2-006: pii::v1 context was missing)
  {
    const rows = await db.bankAccount.findMany({ select: { id: true, accountNumber: true } })
    const wrapped = rows
      .filter((r) => r.accountNumber && (r.accountNumber as string).startsWith("enc::"))
      .map((r) => ({ id: r.id, packed: (r.accountNumber as string).slice(5) }))
    await rewrite("BankAccount.accountNumber", wrapped, () => "pii::v1",
      async (row, next) => { await db.bankAccount.update({ where: { id: row.id }, data: { accountNumber: "enc::" + next } }) })
  }
  // 9. PII fields — EmployeeDocument.fileData (T2-006: pii::v1 context was missing)
  // Note: the field is called fileData (base64 file content), not encryptedContent.
  {
    const rows = await db.employeeDocument.findMany({ where: { fileData: { not: null } }, select: { id: true, fileData: true } })
    const wrapped = rows
      .filter((r) => r.fileData && (r.fileData as string).startsWith("enc::"))
      .map((r) => ({ id: r.id, packed: (r.fileData as string).slice(5) }))
    await rewrite("EmployeeDocument.fileData", wrapped, () => "pii::v1",
      async (row, next) => { await db.employeeDocument.update({ where: { id: row.id }, data: { fileData: "enc::" + next } }) })
  }

  // ---- summary ----
  const byOutcome: Record<string, number> = {}
  for (const r of report) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1
  console.log("")
  console.log(`rows examined: ${report.length}`)
  for (const [k, v] of Object.entries(byOutcome)) console.log(`  ${k}: ${v}`)
  const failed = report.filter((r) => r.outcome.startsWith("FAILED"))
  if (failed.length) {
    console.log("")
    console.log("FAILED rows (decrypt under NEITHER the new nor the old key):")
    for (const f of failed.slice(0, 20)) console.log(`  ${f.table} ${f.id}`)
    if (failed.length > 20) console.log(`  …and ${failed.length - 20} more`)
    console.log("  These rows predate the rotation pair being offered; they need the key")
    console.log("  generation that encrypted them (set the matching HRM_OLD_* variable).")
  }
  if (!APPLY) console.log("\nDRY RUN — re-run with --apply to write the re-wrapped rows.")
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
