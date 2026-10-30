import { db } from "@/lib/db"
const rows = await db.loginAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 8, select: { plane: true, email: true, success: true, browser: true, os: true, deviceType: true, userAgent: true, createdAt: true } })
for (const r of rows) console.log(`${r.plane} ${r.success ? "OK " : "FAIL"} browser=${r.browser || "-"} os=${r.os || "-"} dev=${r.deviceType || "-"} ua=${String(r.userAgent || "").slice(0, 40)}`)
process.exit(0)
