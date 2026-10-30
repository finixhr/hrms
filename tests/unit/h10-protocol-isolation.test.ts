/// <reference types="bun-types" />
// ============ H-10 regression: /iclock enforces endpoint-protocol isolation ============
// Audit H-10 (High): resolveDevice() implements ADMS/ISAPI plane isolation
// (M-07) and it is unit-tested — but the opts parameter was NEVER passed by any
// of the six /iclock/* call sites, so the control was dead code in production:
// a device registered as HIKVISION_ISAPI could authenticate on /iclock/* and
// push ADMS ATTLOG punches. (The unit suite stayed green because it calls the
// engine directly — the exact build-versus-wire failure this remediation's
// route-layer tests exist to prevent.)
//
// Fix under test: every /iclock/* call site passes { endpointProtocol: "ADMS" };
// the ISAPI receiver's legacy lookup is filtered to devices that have never
// handshaked on the ADMS plane (pushVersion IS NULL).
//
// Route-layer: real GET/POST against the /iclock/cdata route handlers.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { NextRequest } from "next/server"
import { GET as cdataGET, POST as cdataPOST } from "@/app/iclock/cdata/route"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { saveSettingsGroup } from "@/hrm-server/settings"

let vendor: { id: string }
let admsSn: string
let isapiSn: string

beforeAll(async () => {
  vendor = await mkVendor("H10 Isolation Vendor")
  await mkUser(vendor.id, { role: "VENDOR_OWNER" })
  // keyless devices allowed — the isolation check runs BEFORE the comm-key
  // check, so keyless fixtures exercise exactly the protocol gate
  await saveSettingsGroup(vendor.id, "devices", { allowKeyless: true })

  const mk = (protocol: string, manufacturer: string) =>
    db.attendanceDevice.create({
      data: {
        vendorId: vendor.id, deviceId: uniq("DEV"), name: `H10 ${protocol}`,
        manufacturer, protocol, deviceIdentifier: uniq("SN"), serialNumber: uniq("SN"),
        timezone: "Asia/Dhaka", enabled: true, status: "OFFLINE",
      } as any,
    })
  admsSn = (await mk("ADMS", "ZKTeco")).deviceIdentifier!
  isapiSn = (await mk("HIKVISION_ISAPI", "Hikvision")).deviceIdentifier!
})

function iclockReq(method: "GET" | "POST", sn: string, body?: string) {
  return new NextRequest(`http://localhost:3000/iclock/cdata?SN=${sn}${method === "GET" ? "&options=all&pushver=1.0" : ""}`, {
    method,
    headers: {
      "content-type": "text/plain",
      "x-forwarded-for": uniq("h10ip"),
      ...(body != null ? { "content-length": String(body.length) } : {}),
    },
    ...(body != null ? { body } : {}),
  })
}

describe("H-10 /iclock rejects devices registered for the ISAPI plane", () => {
  test("POST ATTLOG with an ISAPI-registered serial → 403 protocol isolation (was 200)", async () => {
    const res = await cdataPOST(iclockReq("POST", isapiSn, "1\t09:00:00\t1\t0\t1\t0"))
    expect(res.status).toBe(403) // ← was 200 (isolation never wired)
    expect(await res.text()).toMatch(/not accepted on an ADMS endpoint/i)
    // and nothing was stored
    const rows = await db.attendanceRawEvent.findMany({ where: { deviceSerial: isapiSn } })
    expect(rows.length).toBe(0)
  })

  test("GET handshake with an ISAPI-registered serial → 403 too", async () => {
    const res = await cdataGET(iclockReq("GET", isapiSn))
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/not accepted on an ADMS endpoint/i)
  })

  test("control: a genuine ADMS device still handshakes and pushes on /iclock", async () => {
    const get = await cdataGET(iclockReq("GET", admsSn))
    expect(get.status).toBe(200)
    const post = await cdataPOST(iclockReq("POST", admsSn, "1\t09:00:00\t1\t0\t1\t0"))
    expect(post.status).toBe(200)
    expect(await post.text()).toMatch(/^OK/)
  })
})

describe("H-10 all six /iclock call sites pass endpointProtocol (source invariant)", () => {
  test("no /iclock route resolves a device without { endpointProtocol: 'ADMS' }", async () => {
    const { readFileSync } = await import("fs")
    const { join } = await import("path")
    const routes = ["cdata", "cdatapic", "devicecmd", "deviceparams", "getrequest", "ping"]
    const missing: string[] = []
    for (const r of routes) {
      const src = readFileSync(join(import.meta.dir, `../../src/app/iclock/${r}/route.ts`), "utf8")
      // every line that resolves a device must pass the ADMS protocol filter
      // (line-based check — a call-args regex would truncate at the inner
      // paren of searchParams.get(...))
      const offenders = src
        .split("\n")
        .filter((line) => line.includes("resolveDevice("))
        .filter((line) => !line.includes('endpointProtocol: "ADMS"'))
        .map((line) => `${r}: ${line.trim()}`)
      missing.push(...offenders)
    }
    expect(missing).toEqual([])
  })
})
