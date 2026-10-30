/// <reference types="bun-types" />
// ============ C-03 regression: device comm-key authentication ============
// The device plane authenticates by pre-registered SN PLUS a comm key set at
// enrollment (verified timing-safely against a scrypt hash). Keyless devices
// pass only when the vendor admin setting "Allow Keyless Devices" is enabled
// (Settings → Devices) — the former 7-day grace window and lab-only
// ALLOW_OPEN override were removed.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll, afterEach } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { resolveDevice, snRateLimited } from "@/hrm-server/zkteco/gateway"
import { hashCommKey, verifyCommKey } from "@/hrm-server/zkteco/commkey"
import { saveSettingsGroup, getSettings } from "@/hrm-server/settings"
import { mkVendor, mkUser, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }

const saveEnv = { ...process.env }

afterEach(() => {
  process.env.HRM_DEVICE_SN_RATE_LIMIT_PER_MIN = saveEnv.HRM_DEVICE_SN_RATE_LIMIT_PER_MIN
})

async function mkDevice(vendorId: string, over: { key?: string | null; createdAt?: Date; enabled?: boolean } = {}) {
  const sn = uniq("SN").slice(0, 20)
  const key = over.key === undefined ? null : over.key
  const { hash, salt } = key ? hashCommKey(key) : { hash: null, salt: null }
  return db.attendanceDevice.create({
    data: {
      vendorId,
      deviceId: sn,
      name: "Test Terminal " + sn,
      deviceIdentifier: sn,
      enabled: over.enabled ?? true,
      commKey: key,
      commKeyHash: hash,
      commKeySalt: salt,
      commKeySetAt: key ? new Date() : null,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  })
}

beforeAll(async () => {
  vendor = await mkVendor("C03 Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Owner" })
})

describe("C-03 commkey hashing", () => {
  test("hashCommKey + verifyCommKey round-trip", () => {
    const { hash, salt } = hashCommKey("ABCD1234")
    expect(verifyCommKey("ABCD1234", hash, salt)).toBe(true)
    expect(verifyCommKey("ABCD1235", hash, salt)).toBe(false)
    expect(verifyCommKey("", hash, salt)).toBe(false)
    expect(verifyCommKey("ABCD1234", null, null)).toBe(false)
  })
  test("legacy unsalted sha256 hex values still verify read-only", () => {
    const crypto = require("crypto")
    const legacy = crypto.createHash("sha256").update("OLDKEY").digest("hex")
    expect(verifyCommKey("OLDKEY", legacy, null)).toBe(true)
    expect(verifyCommKey("WRONG", legacy, null)).toBe(false)
  })
})

describe("C-03 resolveDevice — comm-key enforcement", () => {
  test("enrolled device + correct key → ok", async () => {
    const d = await mkDevice(vendor.id, { key: "RIGHT-KEY-1" })
    const auth = await resolveDevice(d.deviceIdentifier, "RIGHT-KEY-1")
    expect(auth.ok).toBe(true)
  })
  test("enrolled device + wrong key → 401", async () => {
    const d = await mkDevice(vendor.id, { key: "RIGHT-KEY-2" })
    const auth = await resolveDevice(d.deviceIdentifier, "WRONG-KEY")
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.code).toBe(401)
  })
  test("enrolled device + missing key → 401", async () => {
    const d = await mkDevice(vendor.id, { key: "RIGHT-KEY-3" })
    const auth = await resolveDevice(d.deviceIdentifier, null)
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.code).toBe(401)
  })
  test("keyless device + Allow Keyless Devices OFF (default) → 401 with actionable reason", async () => {
    // secure default: a fresh vendor has no devices.allowKeyless row → false
    await saveSettingsGroup(vendor.id, "devices", { allowKeyless: false })
    const d = await mkDevice(vendor.id, {})
    const auth = await resolveDevice(d.deviceIdentifier, null)
    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.code).toBe(401)
      expect(auth.reason).toContain("no comm key enrolled")
      expect(auth.reason).toContain("Allow Keyless Devices")
    }
  })
  test("keyless device + Allow Keyless Devices ON → ok + keyless flag (Sync Monitor warning)", async () => {
    await saveSettingsGroup(vendor.id, "devices", { allowKeyless: true })
    const d = await mkDevice(vendor.id, {})
    const auth = await resolveDevice(d.deviceIdentifier, null)
    expect(auth.ok).toBe(true)
    if (auth.ok) expect(auth.keyless).toBe(true)
  })
  test("keyed device works regardless of the Allow Keyless Devices setting", async () => {
    const d = await mkDevice(vendor.id, { key: "KEY-REGARDLESS" })
    await saveSettingsGroup(vendor.id, "devices", { allowKeyless: false })
    expect((await resolveDevice(d.deviceIdentifier, "KEY-REGARDLESS")).ok).toBe(true)
    await saveSettingsGroup(vendor.id, "devices", { allowKeyless: true })
    expect((await resolveDevice(d.deviceIdentifier, "KEY-REGARDLESS")).ok).toBe(true)
    // …and a wrong key is still rejected for a keyed device under either value
    const wrong = await resolveDevice(d.deviceIdentifier, "WRONG")
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.code).toBe(401)
  })
  test("settings.save accepts the devices group and the toggle reaches resolveDevice", async () => {
    const res: any = await (getRoute("settings.save")!).handler(makeCtx(owner), { group: "devices", values: { allowKeyless: true } })
    expect(res.devices.allowKeyless).toBe(true)
    expect((await getSettings(vendor.id)).devices.allowKeyless).toBe(true)
    const d = await mkDevice(vendor.id, {})
    const auth = await resolveDevice(d.deviceIdentifier, null)
    expect(auth.ok).toBe(true)
    if (auth.ok) expect(auth.keyless).toBe(true)
  })
  test("disabled device → 403 regardless of key", async () => {
    const d = await mkDevice(vendor.id, { key: "K", enabled: false })
    const auth = await resolveDevice(d.deviceIdentifier, "K")
    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.code).toBe(403)
  })
})

describe("C-03 per-SN rate limit", () => {
  test("bursts above the per-SN cap are throttled independent of IP", () => {
    process.env.HRM_DEVICE_SN_RATE_LIMIT_PER_MIN = "3"
    const sn = uniq("SN").slice(0, 20)
    expect(snRateLimited(sn)).toBe(false)
    expect(snRateLimited(sn)).toBe(false)
    expect(snRateLimited(sn)).toBe(false)
    expect(snRateLimited(sn)).toBe(true) // 4th within the minute
    // a different SN is unaffected (per-serial buckets, not shared)
    expect(snRateLimited(sn + "X")).toBe(false)
  })
})

describe("C-03 devices.setCommKey (enrollment route)", () => {
  test("generates a key server-side, returns it ONCE, stores only hash-verified state", async () => {
    const d = await mkDevice(vendor.id, {})
    const def = getRoute("devices.setCommKey")!
    const res: any = await def.handler(makeCtx(owner), { id: d.id })
    expect(res.ok).toBe(true)
    expect(res.key).toMatch(/^[0-9A-F]{12}$/)
    // after enrollment the key works on the device plane
    const auth = await resolveDevice(d.deviceIdentifier, res.key)
    expect(auth.ok).toBe(true)
    if (auth.ok) expect(auth.keyless).toBeUndefined()
  })
  test("operator-supplied key is accepted and immediately enforced", async () => {
    const d = await mkDevice(vendor.id, {})
    const def = getRoute("devices.setCommKey")!
    const res: any = await def.handler(makeCtx(owner), { id: d.id, key: "OP-KEY-42" })
    expect(res.key).toBe("OP-KEY-42")
    expect((await resolveDevice(d.deviceIdentifier, "OP-KEY-42")).ok).toBe(true)
    expect((await resolveDevice(d.deviceIdentifier, "NOPE")).ok).toBe(false)
  })
  test("publicDevice responses never leak the plaintext commKey or hash", async () => {
    const d = await mkDevice(vendor.id, { key: "SECRET-9" })
    const list: any = await (getRoute("devices.list")!).handler(makeCtx(owner), {})
    const row = (list.devices || list).find?.((r: any) => r.id === d.id) ?? (Array.isArray(list) ? list.find((r: any) => r.id === d.id) : null)
    if (row) {
      expect(row.commKey).toBeUndefined()
      expect(row.commKeyHash).toBeUndefined()
      expect(row.commKeySalt).toBeUndefined()
      expect(row.hasCommKey).toBe(true)
    }
    const json = JSON.stringify(list)
    expect(json).not.toContain("SECRET-9")
  })
  test("duplicate-SN error is tenant-neutral (no other-tenant device name)", async () => {
    const other = await mkVendor("Other Vendor")
    const d = await mkDevice(other.id, { key: null })
    const def = getRoute("devices.save")!
    let msg = ""
    try {
      await def.handler(makeCtx(owner), { name: "Clone", deviceIdentifier: d.deviceIdentifier })
    } catch (e: any) {
      msg = String(e.message || e)
    }
    expect(msg).toContain("already registered")
    expect(msg).not.toContain(d.name)
  })
})
