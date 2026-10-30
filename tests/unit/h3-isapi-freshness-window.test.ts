/// <reference types="bun-types" />
// ============ H-3 regression: ISAPI freshness window in the device tz frame ============
// Audit H-3 (High): the ISAPI receiver computed tzHours but used raw new Date()
// as the freshness reference, while the /iclock gateway correctly shifts into
// the device frame (Date.now() + ADMS_TIMEZONE_OFFSET_HOURS). On a UTC server
// (default offset +6, Asia/Dhaka) every FRESH Hikvision event parsed as ~6h in
// the future — beyond the +5-minute tolerance — so ALL fresh events were
// dropped as OUT_OF_WINDOW and still ACKed with ResponseStatus OK: silent,
// permanent attendance loss.
//
// This test drives the REAL route boundary: POST /ISAPI/AccessControl/
// Notification/streamData with a NextRequest carrying the device XML, exactly
// like a Hikvision terminal. NOTE: the reproduction requires the server-local
// clock ≠ device frame (CI/sandbox run UTC; the deployment target is UTC).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { NextRequest } from "next/server"
import { POST } from "@/app/ISAPI/AccessControl/Notification/streamData/route"
import { db } from "@/lib/db"
import { mkVendor, uniq } from "./_fixtures"
import { saveSettingsGroup } from "@/hrm-server/settings"

const TZ_H = 6 // Asia/Dhaka (ADMS_TIMEZONE_OFFSET_HOURS default)
let vendor: { id: string }
let sn: string
let deviceId: string

/** Dhaka wall-clock stamp "YYYY-MM-DDTHH:MM:SS+06:00" for (now + offsetMs). */
function dhakaStamp(offsetMs = 0): string {
  const t = new Date(Date.now() + TZ_H * 3600_000 + offsetMs)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+06:00`
}

function xmlBody(stamp: string, employeeNo: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<NotificationEvent notificationType="attendance">
<Code>attendance</Code>
<DateTime>${stamp}</DateTime>
<EmployeeNo>${employeeNo}</EmployeeNo>
<DeviceName>H3-Test-Terminal</DeviceName>
<DeviceSerial>${sn}</DeviceSerial>
<AttendanceType>checkIn</AttendanceType>
<VerifyMode>face</VerifyMode>
</NotificationEvent>
</EventNotificationAlert>`
}

async function postIsapi(body: string, ipTag: string) {
  const req = new NextRequest("http://localhost:3000/ISAPI/AccessControl/Notification/streamData", {
    method: "POST",
    headers: { "content-type": "application/xml", "x-real-ip": ipTag },
    body,
  })
  const res = await POST(req)
  return { status: res.status, text: await res.text() }
}

async function lastCommLog() {
  const rows = await db.deviceCommLog.findMany({
    where: { serial: sn, requestType: "ISAPI_ATTENDANCE" },
    orderBy: { createdAt: "desc" as const },
    take: 1,
  })
  return rows[0] as any
}

beforeAll(async () => {
  process.env.ADMS_TIMEZONE_OFFSET_HOURS = String(TZ_H)
  vendor = await mkVendor("H3 ISAPI Vendor")
  // vendor allows keyless devices (HMAC auth is a separate control — H-3 is
  // about the freshness frame; keyless keeps the test focused on the window)
  await saveSettingsGroup(vendor.id, "devices", { allowKeyless: true })
  sn = uniq("H3SN")
  const device = await db.attendanceDevice.create({
    data: {
      vendorId: vendor.id, deviceId: uniq("DEV"), name: "H3 Terminal",
      protocol: "HIKVISION_ISAPI", deviceIdentifier: sn, enabled: true,
      status: "ONLINE",
    },
  })
  deviceId = device.id
})

describe("H-3 ISAPI freshness window uses the device timezone frame", () => {
  test("a FRESH Dhaka-stamped event is accepted (was dropped as OUT_OF_WINDOW)", async () => {
    const emp = uniq("H3EMP")
    const res = await postIsapi(xmlBody(dhakaStamp(0), emp), uniq("h3ip"))
    expect(res.status).toBe(200)
    expect(res.text).toContain("ResponseStatus") // device is ACKed either way — the loss was silent
    // the event is DURABLY STORED (this is what the bug destroyed)
    const row = await db.attendanceRawEvent.findFirst({ where: { deviceId, deviceUserId: emp } })
    expect(row).toBeTruthy()
    expect(row?.processingStatus).not.toBe("REJECTED")
    // the comm log must show accepted=1 outOfWindow=0
    const log = await lastCommLog()
    expect(String(log?.error || "")).toMatch(/accepted=1/)
    expect(String(log?.error || "")).toMatch(/outOfWindow=0/)
  })

  test("the window guard still rejects genuinely old events (no over-acceptance)", async () => {
    const emp = uniq("H3OLD")
    const eightDaysAgo = dhakaStamp(-8 * 86_400_000)
    const res = await postIsapi(xmlBody(eightDaysAgo, emp), uniq("h3ip"))
    expect(res.status).toBe(200) // ACKed — the device should not re-push
    // MOD-1 (Phase 1, 2026-10-21): out-of-window punches are QUARANTINED, not
    // dropped. The old contract (`row` is null) was the silent data-loss bug —
    // the firmware purged the punch as DELIVERED and it was gone forever. The
    // event is now durably stored with processingStatus OUT_OF_WINDOW and
    // becomes eligible the moment a widened history-sync window covers it.
    const row = await db.attendanceRawEvent.findFirst({ where: { deviceId, deviceUserId: emp } })
    expect(row).toBeTruthy()
    expect(row?.processingStatus).toBe("OUT_OF_WINDOW")
    expect(String(row?.processingError || "")).toMatch(/awaiting historical-sync reprocessing/)
    const log = await lastCommLog()
    expect(String(log?.error || "")).toMatch(/outOfWindow=1/)
  })

  test("MOD-1 — garbage far-future clocks (beyond +5 min) are still NOT stored", async () => {
    const emp = uniq("H3FUTURE")
    const ahead = dhakaStamp(3600_000) // +1h — outside the +5min ahead tolerance
    const res = await postIsapi(xmlBody(ahead, emp), uniq("h3ip"))
    expect(res.status).toBe(200)
    const row = await db.attendanceRawEvent.findFirst({ where: { deviceId, deviceUserId: emp } })
    expect(row).toBeNull() // rejected outright — a broken clock is not recoverable evidence
    const log = await lastCommLog()
    expect(String(log?.error || "")).toMatch(/outOfWindow=1/)
  })
})
