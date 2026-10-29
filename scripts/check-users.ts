import { db } from "@/lib/db"
const users = await db.user.findMany({ select: { email: true, role: true, status: true, vendorId: true }, take: 60 })
const vendors = await db.vendor.findMany({ select: { id: true, name: true, code: true } })
const vmap = new Map(vendors.map((v) => [v.id, v.code]))
for (const u of users) console.log(`${vmap.get(u.vendorId) || "?"}  ${String(u.role).padEnd(14)} ${u.status.padEnd(8)} ${u.email}`)
process.exit(0)
