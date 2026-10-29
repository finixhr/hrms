// Reset test-user credentials directly (dev DB only) — clears mustChangePassword,
// lockouts and failed counters, sets a known password hash.
import { PrismaClient } from "@prisma/client"
import { requireConfirmation } from "./lib/guard"

// H-01/H-02 (re-audit 2026-10-18) — the blanket session deleteMany({}) below
// makes this a destructive script: it must refuse production and demand a
// deliberate --confirm outside test-looking DATABASE_URLs.
requireConfirmation("reset-test-users")

const db = new PrismaClient()
const NEW_PASSWORD = process.argv[2] || "Rayhan@123"

// Matches src/hrm-server/auth.ts hashPassword(): "saltHex:hashHex" via plain scrypt
async function hashPassword(pw: string): Promise<string> {
  const crypto = await import("node:crypto")
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

async function main() {
  const hash = await hashPassword(NEW_PASSWORD)
  const targets = [
    "owner@bengaltextworks.example",
    "admin@bengaltextworks.example",
    "hr@bengaltextworks.example",
    "payroll@bengaltextworks.example",
    "employee@bengaltextworks.example",
    "employee2@bengaltextworks.example",
    "owner@rongintraders.com",
  ]
  for (const email of targets) {
    const r = await db.user.updateMany({
      where: { email },
      data: { passwordHash: hash, mustChangePassword: false, lockedUntil: null, failedLoginCount: 0, passwordChangedAt: new Date() },
    })
    console.log(`${email}: ${r.count} reset`)
  }
  await db.session.deleteMany({}) // clear stale sessions/lockouts
  console.log("sessions cleared; password =", NEW_PASSWORD)
}

main().finally(() => db.$disconnect())
