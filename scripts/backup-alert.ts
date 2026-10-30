// ============ H-11 — backup failure alerting through the existing email gateway ============
// Called by scripts/backup.sh on failure:
//   bun run scripts/backup-alert.ts "subject" "body"
// Reads the SMTP configuration from the vendor's HR settings (group "email"),
// exactly like the application does, and sends an alert to
// HRM_BACKUP_ALERT_EMAIL (fallback: the settings' fromAddress).
// Never throws — alerting must not break the failure path.
import { PrismaClient } from "@prisma/client"
import nodemailer from "nodemailer"

const db = new PrismaClient()

function j<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

async function main() {
  const subject = process.argv[2] || "HRM backup alert"
  const body = process.argv[3] || "Backup status changed."

  // First vendor with an enabled email gateway (single-tenant deployments).
  const rows = await db.hrSetting.findMany({ where: { group: "email" } })
  const cfg: any = {}
  for (const r of rows) cfg[r.key] = j(r.value, r.value)
  if (!cfg.enabled || !cfg.host || !cfg.username || !cfg.password) {
    console.error("[backup-alert] email gateway is not configured — alert only logged:")
    console.error(`  SUBJECT: ${subject}`)
    console.error(`  BODY: ${body}`)
    return
  }
  const to = process.env.HRM_BACKUP_ALERT_EMAIL || cfg.fromAddress || cfg.username
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: !!cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
  })
  await transporter.sendMail({
    from: `"${cfg.fromName || "HRM Backup"}" <${cfg.fromAddress || cfg.username}>`,
    to,
    subject,
    text: body,
  })
  console.log(`[backup-alert] alert emailed to ${to}`)
}

main()
  .catch((e) => {
    console.error("[backup-alert] failed:", e instanceof Error ? e.message : e)
    console.error(`  SUBJECT: ${process.argv[2] || "HRM backup alert"}`)
  })
  .finally(() => db.$disconnect())
