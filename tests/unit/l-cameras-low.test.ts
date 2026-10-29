/// <reference types="bun-types" />
// ============ Camera Low findings: L-24 (seed encryption), L-25 (includeDisabled gate) ============
// L-24 — the seed used to write camera verificationCode directly, bypassing
//        the HIGH-14 encryption helper, so seeded demo rows were plaintext at
//        rest and the decrypt-on-read launch path failed on them. The seed
//        now goes through the SAME maybeEncryptVc write path.
// L-25 — camera.list includeDisabled (soft-deleted/disabled cameras) is an
//        admin-recovery view: it requires camera.edit. A camera.view-only
//        caller silently gets the enabled-only list.
// Route-layer for L-25 (real dispatcher); L-24 verified by roundtrip + source
// invariant (running the full seed in a unit test is not practical).
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync } from "node:fs"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { maybeEncryptVc } from "@/hrm-server/cameras/repository"

let vendor: { id: string }
let editToken: string   // camera.view + camera.edit
let viewOnlyToken: string // camera.view only

beforeAll(async () => {
  vendor = await mkVendor("L25 Camera Vendor")
  const editor = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L25 Editor", email: `l25-ed-${uniq()}@test.local` })
  editToken = await mkSession(editor.id, "FULL")
  // RBAC-103 (R3-5) — explicit grants only ever WIDEN the role template, so a
  // role-less mkUser defaults to VENDOR_OWNER and silently carries camera.edit.
  // The view-only caller must ride a role whose template has NO camera.edit:
  // PAYROLL_OFFICER ∪ {camera.view} = camera.view only.
  const viewer = await mkUser(vendor.id, { role: "PAYROLL_OFFICER", name: "L25 Viewer", email: `l25-vw-${uniq()}@test.local`, permissions: ["camera.view"] })
  viewOnlyToken = await mkSession(viewer.id, "FULL")

  await db.camera.create({ data: { vendorId: vendor.id, brand: "HIKVISION", name: "L25 Enabled", serialNumber: uniq("SN"), channel: 1, enabled: true, status: "ONLINE" } as any })
  await db.camera.create({ data: { vendorId: vendor.id, brand: "HIKVISION", name: "L25 Disabled", serialNumber: uniq("SN"), channel: 1, enabled: false, status: "OFFLINE" } as any })
})

describe("L-25 — includeDisabled is an admin-recovery view (camera.edit)", () => {
  test("camera.view-only caller gets the ENABLED-ONLY list even when asking for disabled", async () => {
    const r = await postHrm("camera.list", { includeDisabled: true }, { bearer: viewOnlyToken })
    expect(r.status).toBe(200)
    const names = (r.body?.data?.cameras || []).map((c: any) => c.name)
    expect(names).toContain("L25 Enabled")
    expect(names).not.toContain("L25 Disabled")
    expect(r.body?.data?.pagination?.total).toBe(1)
  })

  test("caller WITH camera.edit sees the disabled camera (recovery view)", async () => {
    const r = await postHrm("camera.list", { includeDisabled: true }, { bearer: editToken })
    expect(r.status).toBe(200)
    const names = (r.body?.data?.cameras || []).map((c: any) => c.name)
    expect(names).toContain("L25 Enabled")
    expect(names).toContain("L25 Disabled")
  })

  test("default list (no includeDisabled) stays enabled-only for everyone", async () => {
    const r = await postHrm("camera.list", {}, { bearer: editToken })
    expect(r.status).toBe(200)
    expect((r.body?.data?.cameras || []).map((c: any) => c.name)).not.toContain("L25 Disabled")
  })
})

describe("L-24 — seed writes camera verification codes through the encryption helper", () => {
  test("maybeEncryptVc encrypts (never plaintext at rest) when the deployment key is set", async () => {
    const stored = maybeEncryptVc("l24-secret-code")
    // test env sets HRM_MFA_KEY (.env) → the helper MUST encrypt into the
    // packed "<ivHex>.<tagHex>.<encHex>" GCM format (crypto-field encryptField)
    expect(stored).toBeTruthy()
    expect(stored).not.toBe("l24-secret-code")
    expect(stored).toMatch(/^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/)
  })

  test("source invariant: seed.ts uses maybeEncryptVc (no raw verificationCode writes)", () => {
    const seed = readFileSync("src/hrm-server/seed.ts", "utf8")
    expect(seed).toContain('maybeEncryptVc(vc)')
    expect(seed).not.toMatch(/verificationCode:\s*vc\b/) // the old raw write
  })
})
