// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS script by design (node scripts/map-users.cjs)
const { PrismaClient } = require("@prisma/client")
const db = new PrismaClient()
async function main() {
  const us = await db.user.findMany({ select: { email: true, role: true, employeeId: true } })
  const emps = await db.employee.findMany({ where: { code: { in: ["EMP-0007", "EMP-0008", "EMP-0009", "EMP-0010"] } }, select: { id: true, code: true, fullName: true } })
  for (const u of us.filter((u) => u.employeeId)) console.log("user:", u.email, u.role, "→", emps.find((e) => e.id === u.employeeId)?.code || u.employeeId)
  for (const e of emps) console.log("tracked:", e.code, e.fullName)
}
main().finally(() => db.$disconnect())
