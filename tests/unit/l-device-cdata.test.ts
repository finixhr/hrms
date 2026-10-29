/// <reference types="bun-types" />
// ============ L-10 regression: unparseable ATTLOG lines are ACKed ============
// Audit L-10 (Low, firmware behavior UNVERIFIED): the cdata response ACKed
// only accepted + duplicates + operlog/userinfo/biodata — INVALID lines were
// stored in the comm log (INVALID_LINES) but never acknowledged, so firmware
// that re-pushes undelivered records could resend them forever.
//
// Fix under test: the ACK count includes res.invalid. Acking is the safe
// default — nothing is lost, the comm-log row keeps the evidence.
// Route-layer: real POST against the /iclock/cdata route handler.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { NextRequest } from "next/server"
import { POST as cdataPOST } from "@/app/iclock/cdata/route"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { saveSettingsGroup } from "@/hrm-server/settings"

let vendor: { id: string }
let sn: string

beforeAll(async () => {
  vendor = await mkVendor("L10 Cdata Vendor")
  await mkUser(vendor.id, { role: "VENDOR_OWNER" })
  await saveSettingsGroup(vendor.id, "devices", { allowKeyless: true })
  const d = await db.attendanceDevice.create({
    data: {
      vendorId: vendor.id, deviceId: uniq("DEV"), name: "L10 Terminal",
      manufacturer: "ZKTeco", protocol: "ADMS", deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"),
      timezone: "Asia/Dhaka", enabled: true, status: "OFFLINE",
    } as any,
  })
  sn = d.deviceIdentifier!
})

function post(sn: string, body: string) {
  return new NextRequest(`http://localhost:3000/iclock/cdata?SN=${sn}`, {
    method: "POST",
    headers: { "content-type": "text/plain", "x-forwarded-for": uniq("l10ip"), "content-length": String(body.length) },
    body,
  })
}

describe("L-10 — invalid ATTLOG lines are ACKed (no infinite re-push)", () => {
  test("2 valid + 1 garbage line → ACK covers all 3 (was: 2, garbage never ACKed)", async () => {
    const res = await cdataPOST(post(sn, [
      "1\t09:00:00\t1\t0\t1\t0",
      "1\t18:05:00\t1\t0\t1\t0",
      "this-is-not-an-attlog-line",
    ].join("\n")))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.trim()).toBe("OK: 3") // accepted(2) + invalid(1) — all ACKed
  })
})
