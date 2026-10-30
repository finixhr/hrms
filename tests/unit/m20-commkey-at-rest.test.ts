/// <reference types="bun-types" />
// ============ M-20 — device commKey encrypted at rest; ISAPI HMAC honest ============
// Regression (audit M-20): commKey was stored in PLAINTEXT next to its scrypt
// hash (DB dump = working device credentials), and hash-only legacy rows
// verified ISAPI HMAC against an EMPTY key (permanently broken, misleading
// error). Fix: enc:: format under HRM_MFA_KEY + explicit re-enroll reason.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import crypto from "crypto"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkUser, mkVendor, uniq } from "./_fixtures"
import { encryptCommKey, readCommKey, commKeyEncrypted } from "@/hrm-server/zkteco/comm-key"

async function mkDevice(vendorId: string, over: Record<string, any> = {}) {
  return db.attendanceDevice.create({
    data: {
      vendorId, deviceId: uniq("DEV"), name: "M20 Device", deviceIdentifier: uniq("SN"), protocol: "ADMS",
      timezone: "Asia/Dhaka", ...over,
    },
  })
}

describe("M-20 — commKey at-rest encryption", () => {
  it("encryptCommKey stores the enc:: format and readCommKey recovers the exact key", () => {
    const key = "AB12CD34"
    const stored = encryptCommKey(key)
    expect(commKeyEncrypted(stored)).toBe(true)
    expect(stored).not.toContain(key) // the plaintext never appears in the stored form
    expect(readCommKey(stored)).toBe(key)
  })

  it("legacy plaintext rows stay readable (upgrade-safe until rotated); null/empty → null", () => {
    expect(readCommKey("LEGACYPLAINTEXT")).toBe("LEGACYPLAINTEXT")
    expect(readCommKey(null)).toBeNull()
    expect(readCommKey("")).toBeNull()
  })

  it("a corrupted ciphertext is treated as keyless, never leaked into an HMAC", () => {
    expect(readCommKey("enc::not.valid.hex")).toBeNull()
  })

  it("devices.setCommKey persists the ENCRYPTED form — the raw key is nowhere in the row", async () => {
    const vendor = await mkVendor("M20-Set")
    const u = await mkUser(vendor.id) // VENDOR_OWNER role template carries devices.edit
    const sessId = `m20-${uniq("s")}`
    const sess = (await db.session.create({ data: { id: sessId, tokenHash: sessionTokenHash(sessId), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })).id
    const dev = await mkDevice(vendor.id)
    const KEY = "KEYM20XYZ"
    const r = await postHrm("devices.setCommKey", { id: dev.id, key: KEY }, { bearer: sess })
    expect(r.status).toBe(200)
    expect(r.body?.data?.key).toBe(KEY) // shown exactly once — the enrollment response
    const row = await db.attendanceDevice.findUnique({ where: { id: dev.id } })
    expect(row?.commKey).toBeTruthy()
    expect(commKeyEncrypted(row!.commKey!)).toBe(true) // at rest: encrypted
    expect(row!.commKey!).not.toContain(KEY)
    expect(readCommKey(row!.commKey!)).toBe(KEY) // and it still verifies
  })

  it("hash-only legacy device rows are reported for re-enroll — not verified against an empty key", async () => {
    const { POST } = await import("@/app/ISAPI/AccessControl/Notification/streamData/route")
    const { NextRequest } = await import("next/server")
    const vendor = await mkVendor("M20-Isapi")
    // hash-only row: commKeyHash set, commKey null (pre-C-03 enrollment)
    const dev = await mkDevice(vendor.id, { protocol: "HIKVISION_ISAPI", commKeyHash: "a".repeat(64), commKey: null })
    const ts = new Date().toISOString()
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<NotificationEvent notificationType="attendance">
<Code>attendance</Code>
<DateTime>${ts}</DateTime>
<EmployeeNo>1001</EmployeeNo>
<DeviceName>M20-Test-Terminal</DeviceName>
<DeviceSerial>${dev.deviceIdentifier}</DeviceSerial>
<AttendanceType>checkIn</AttendanceType>
<VerifyMode>face</VerifyMode>
</NotificationEvent>
</EventNotificationAlert>`
    const sig = crypto.createHmac("sha256", "").update(`${ts}\n${body}`).digest("hex")
    const req = new NextRequest("http://localhost:3000/ISAPI/AccessControl/Notification/streamData", {
      method: "POST", headers: { "content-type": "application/xml", "x-hik-ts": ts, "x-hik-sig": sig }, body,
    })
    const res = await POST(req)
    const text = await res.text()
    // honest, actionable rejection — NOT the empty-key HMAC mismatch
    expect(text).toContain("legacy key hash")
    expect(text).toContain("Set Comm Key")
  })
})
