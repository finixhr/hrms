/// <reference types="bun-types" />
// ============ L-15 regression: destructive device commands need confirmation ============
// Audit L-15 (Low): CLEAR DATA / CLEAR LOG / REBOOT queued immediately on
// devices.edit — an accidental click irreversibly wiped a terminal
// (employees.hardDelete already required a typed confirmation token).
//
// Fix under test: the destructive trio requires confirm === deviceIdentifier
// (the device serial); non-destructive commands queue as before.
// Route-layer: drives devices.queueCommand through POST /api/hrm.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let token: string
let sn: string
let deviceId: string

beforeAll(async () => {
  vendor = await mkVendor("L15 Devices Vendor")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L15 Admin" })
  token = await mkSession(admin.id, "FULL")
  const d = await db.attendanceDevice.create({
    data: {
      vendorId: vendor.id, deviceId: uniq("DEV"), name: "L15 Terminal",
      manufacturer: "ZKTeco", protocol: "ADMS", deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"),
      timezone: "Asia/Dhaka", enabled: true, status: "OFFLINE",
    } as any,
  })
  sn = d.deviceIdentifier!
  deviceId = d.id
})

describe("L-15 — destructive commands require the device serial as confirmation", () => {
  test("REBOOT without confirm → 400 naming the required serial, nothing queued", async () => {
    const r = await postHrm("devices.queueCommand", { deviceId, command: "REBOOT" }, { bearer: token })
    expect(r.status).toBe(400)
    expect(String(r.body?.error || "")).toContain(sn)
    expect(await db.deviceCommand.count({ where: { deviceId, command: "REBOOT" } })).toBe(0)
  })

  test("CLEAR DATA with the WRONG confirm → 400, nothing queued", async () => {
    const r = await postHrm("devices.queueCommand", { deviceId, command: "CLEAR DATA", confirm: "WRONG-SN" }, { bearer: token })
    expect(r.status).toBe(400)
    expect(await db.deviceCommand.count({ where: { deviceId, command: "CLEAR DATA" } })).toBe(0)
  })

  test("CLEAR LOG with the correct serial → queued (audited destructive action)", async () => {
    const r = await postHrm("devices.queueCommand", { deviceId, command: "CLEAR LOG", confirm: sn }, { bearer: token })
    expect(r.status).toBe(200)
    expect(await db.deviceCommand.count({ where: { deviceId, command: "CLEAR LOG" } })).toBe(1)
  })

  test("non-destructive command (CHECK TIME) still queues WITHOUT confirmation", async () => {
    const r = await postHrm("devices.queueCommand", { deviceId, command: "CHECK TIME" }, { bearer: token })
    expect(r.status).toBe(200)
    expect(await db.deviceCommand.count({ where: { deviceId, command: "CHECK TIME" } })).toBe(1)
  })
})
