/// <reference types="bun-types" />
// ============ M-36 — SMTP/SMS secrets encrypted at rest ============
// Regression (audit M-36): the email gateway password and the SMS
// apiKey/apiSecret were stored as cleartext HrSetting rows — readable in any
// database dump, inconsistent with the AES-256-GCM camera-credential scheme.
// Fix: "enc::<iv.tag.enc>" at rest under HRM_MFA_KEY (comms::v1 context);
// internal readers (sendEmail/sendSms) get the plaintext via getSettings;
// masked reads keep blanking them. Legacy plaintext rows stay readable until
// the one-shot rotation script re-wraps them.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkUser, mkVendor, uniq } from "./_fixtures"
import { getSettings } from "@/hrm-server/settings"

const SMTP_PASSWORD = "gmail-app-password-XYZ"

describe("M-36 — comms secrets encrypted at rest", () => {
  it("settings.save encrypts the SMTP password in the HrSetting row; internal reads decrypt it", async () => {
    const vendor = await mkVendor("M36-Save")
    const u = await mkUser(vendor.id) // VENDOR_OWNER
    const sid = `m36-${uniq("s")}`
    const sess = (await db.session.create({ data: { id: sid, tokenHash: sessionTokenHash(sid), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })).id
    const r = await postHrm("settings.save", { group: "email", values: { enabled: true, host: "smtp.gmail.com", port: 587, username: "hr@example.com", password: SMTP_PASSWORD, fromName: "HR", fromAddress: "hr@example.com" } }, { bearer: sess })
    expect(r.status).toBe(200)

    // at rest: encrypted, plaintext nowhere in the row
    const row = await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "email", key: "password" } })
    expect(row?.value).toBeTruthy()
    const stored = JSON.parse(row!.value)
    expect(String(stored).startsWith("enc::")).toBe(true)
    expect(row!.value).not.toContain(SMTP_PASSWORD)

    // internal read (sendEmail path): plaintext recovered
    const s = await getSettings(vendor.id, { maskSecrets: false, noCache: true })
    expect(s.email.password).toBe(SMTP_PASSWORD)

    // masked read (API responses): blanked, but "set" flag true
    const m = await getSettings(vendor.id, { maskSecrets: true, noCache: true })
    expect(m.email.password).toBe("")
    expect((m.email as any).passwordSet).toBe(true)
  })

  it("SMS apiKey/apiSecret get the same treatment", async () => {
    const vendor = await mkVendor("M36-Sms")
    const u = await mkUser(vendor.id)
    const sid = `m36b-${uniq("s")}`
    const sess = (await db.session.create({ data: { id: sid, tokenHash: sessionTokenHash(sid), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })).id
    const r = await postHrm("settings.save", { group: "sms", values: { enabled: true, apiUrl: "https://api.example.com/send?phone={phone}&message={message}", apiKey: "sms-key-ABC", apiSecret: "sms-secret-DEF", method: "GET" } }, { bearer: sess })
    expect(r.status).toBe(200)
    const keyRow = await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "sms", key: "apiKey" } })
    const secRow = await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "sms", key: "apiSecret" } })
    expect(JSON.parse(keyRow!.value).startsWith("enc::")).toBe(true)
    expect(JSON.parse(secRow!.value).startsWith("enc::")).toBe(true)
    const s = await getSettings(vendor.id, { maskSecrets: false, noCache: true })
    expect(s.sms.apiKey).toBe("sms-key-ABC")
    expect(s.sms.apiSecret).toBe("sms-secret-DEF")
  })

  it("re-saving the group with a BLANK password keeps the stored encrypted value (write-only UX intact)", async () => {
    const vendor = await mkVendor("M36-Keep")
    const u = await mkUser(vendor.id)
    const sid = `m36c-${uniq("s")}`
    const sess = (await db.session.create({ data: { id: sid, tokenHash: sessionTokenHash(sid), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })).id
    await postHrm("settings.save", { group: "email", values: { enabled: true, host: "smtp.gmail.com", port: 587, username: "hr@example.com", password: SMTP_PASSWORD } }, { bearer: sess })
    const before = (await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "email", key: "password" } }))!.value
    // save again with the password left blank (masked round-trip) — keep stored
    const r2 = await postHrm("settings.save", { group: "email", values: { enabled: true, host: "smtp.gmail.com", port: 465, username: "hr@example.com", password: "" } }, { bearer: sess })
    expect(r2.status).toBe(200)
    const after = (await db.hrSetting.findFirst({ where: { vendorId: vendor.id, group: "email", key: "password" } }))!.value
    expect(after).toBe(before)
    const s = await getSettings(vendor.id, { maskSecrets: false, noCache: true })
    expect(s.email.password).toBe(SMTP_PASSWORD)
    expect(s.email.port).toBe(465)
  })

  it("legacy plaintext rows keep working (readable until the rotation script runs)", async () => {
    const vendor = await mkVendor("M36-Legacy")
    await db.hrSetting.create({ data: { vendorId: vendor.id, group: "email", key: "password", value: JSON.stringify("legacy-plain-password") } })
    const s = await getSettings(vendor.id, { maskSecrets: false, noCache: true })
    expect(s.email.password).toBe("legacy-plain-password")
  })

  it("undecryptable rows (rotated HRM_MFA_KEY) read as unset — never leak ciphertext into SMTP AUTH", async () => {
    const vendor = await mkVendor("M36-BadKey")
    await db.hrSetting.create({ data: { vendorId: vendor.id, group: "email", key: "password", value: JSON.stringify("enc::deadbeef.deadbeef.deadbeef") } })
    const s = await getSettings(vendor.id, { maskSecrets: false, noCache: true })
    expect(s.email.password).toBe("")
  })
})
