/// <reference types="bun-types" />
// ============ M-37 — server-side document upload validation ============
// Regression (audit M-37): employee document uploads had no server-side
// size/type validation — the 2 MB cap was client-only (employees.tsx) and any
// binary could be stored as a "document". Fix: 2 MB decoded cap + magic-byte
// MIME allowlist (JPG/PNG/WebP/PDF) enforced at the route layer on BOTH the
// create and update (file-replacement) paths.
import { describe, expect, it } from "bun:test"
import { sessionTokenHash } from "@/hrm-server/auth"
import { postHrm } from "./_hrm-endpoint"
import { db } from "@/lib/db"
import { mkEmployee, mkUser, mkVendor, uniq } from "./_fixtures"
import { validateEmployeeDoc, sniffMime } from "@/hrm-server/uploads"

// real 1×1 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PDF_B64 = Buffer.from("%PDF-1.4\n%fake-but-valid-magic\n").toString("base64")
const EXE_B64 = Buffer.from("MZ\x90\x00\x03\x00\x00\x00fake-executable").toString("base64")

async function adminSession(vendorId: string) {
  const u = await mkUser(vendorId)
  const id = `m37-${uniq("s")}`
  await db.session.create({ data: { id, tokenHash: sessionTokenHash(id), userId: u.id, kind: "FULL", csrfToken: "x", expiresAt: new Date(Date.now() + 3600_000), ip: "127.0.0.1", lastSeenAt: new Date() } })
  return id
}

describe("M-37 — server-side document upload validation", () => {
  it("sniffMime recognizes the allowlisted formats", () => {
    expect(sniffMime(Buffer.from("ffd8ff", "hex"))).toBe("image/jpeg")
    expect(sniffMime(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png")
    expect(sniffMime(Buffer.from("%PDF-"))).toBe("application/pdf")
    expect(sniffMime(Buffer.from("MZ\x90\x00"))).toBeNull() // PE executable — rejected
  })

  it("employees.docs.create accepts a valid PNG and stores it", async () => {
    const vendor = await mkVendor("M37-Ok")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    const r = await postHrm("employees.docs.create", {
      employeeId: emp.id, docType: "NID", title: "Photo ID", fileName: "id.png", fileData: PNG_B64,
    }, { bearer: sess })
    expect(r.status).toBe(200)
    expect(r.body?.data?.id).toBeTruthy()
  })

  it("employees.docs.create rejects an oversized file even though the dispatcher 8MB cap lets it through", async () => {
    const vendor = await mkVendor("M37-Big")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    // 1.5 MB of valid PNG-prefixed bytes → decodes over... no: under 2MB.
    // Build a >2MB buffer with a PNG header so ONLY the size rule fires.
    const big = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(2 * 1024 * 1024 + 100, 0x41)])
    const r = await postHrm("employees.docs.create", {
      employeeId: emp.id, docType: "NID", title: "Too big", fileName: "big.png", fileData: big.toString("base64"),
    }, { bearer: sess })
    expect(r.status).toBe(400)
    expect(r.body?.error).toContain("too large")
  })

  it("employees.docs.create rejects a non-allowlisted binary (renamed executable)", async () => {
    const vendor = await mkVendor("M37-Exe")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    const r = await postHrm("employees.docs.create", {
      employeeId: emp.id, docType: "OTHER", title: "Payslip", fileName: "payslip.pdf.exe.png", fileData: EXE_B64,
    }, { bearer: sess })
    expect(r.status).toBe(400)
    expect(r.body?.error).toContain("Unsupported file type")
  })

  it("metadata-only rows (no fileData) still validate — registration before upload stays possible", async () => {
    const vendor = await mkVendor("M37-Meta")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    const r = await postHrm("employees.docs.create", {
      employeeId: emp.id, docType: "NID", title: "Pending scan", docNumber: "AB-123",
    }, { bearer: sess })
    expect(r.status).toBe(200)
  })

  it("employees.docs.update enforces the same rule on file replacement", async () => {
    const vendor = await mkVendor("M37-Upd")
    const emp = await mkEmployee(vendor.id)
    const sess = await adminSession(vendor.id)
    const create = await postHrm("employees.docs.create", {
      employeeId: emp.id, docType: "NID", title: "Photo ID", fileName: "id.png", fileData: PNG_B64,
    }, { bearer: sess })
    const id = create.body?.data?.id as string
    const upd = await postHrm("employees.docs.update", { id, fileName: "bad.png", fileData: EXE_B64 }, { bearer: sess })
    expect(upd.status).toBe(400)
    expect(upd.body?.error).toContain("Unsupported file type")
    // and a legit replacement still passes
    const upd2 = await postHrm("employees.docs.update", { id, fileName: "doc.pdf", fileData: PDF_B64 }, { bearer: sess })
    expect(upd2.status).toBe(200)
  })
})
