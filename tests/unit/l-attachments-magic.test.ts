/// <reference types="bun-types" />
// ============ L-29 regression: attachment bytes are validated (magic numbers) ============
// Audit L-29 (Low): document/attachment MIME was derived from the
// client-controlled FILENAME and selfie proofs checked only the data-URL
// PREFIX — a renamed executable could be stored and later served inline.
//
// Fix under test:
//  - leave apply validates attachmentData bytes (2MB + JPEG/PNG/WebP/PDF)
//  - leaveRequests.attachment + employees.docs.view serve the SNIFFED mime
//  - both selfie-proof writers validate the decoded bytes via
//    validateSelfieDataUrl (unit + source invariant)
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync } from "node:fs"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { validateSelfieDataUrl } from "@/hrm-server/uploads"

// a real 1×1 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
// an MZ executable (this is NOT a real PE — just the magic bytes + junk)
const EXE_B64 = Buffer.from("MZ\u0000\u0000fake-executable-payload").toString("base64")

const DAY = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]
const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
/** A non-Friday future date (the vendor weekly off is FRIDAY — a Friday-only
 *  span has zero working days and would 400 before the attachment logic). */
function workDay(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  while (DAY[d.getDay()] === "FRIDAY") d.setDate(d.getDate() + 1)
  return iso(d)
}

let vendor: { id: string }
let employeeId: string
let empToken: string
let adminToken: string
let leaveTypeId: string

beforeAll(async () => {
  vendor = await mkVendor("L29 Attach Vendor")
  const emp = await mkEmployee(vendor.id, { fullName: "L29 Employee" })
  employeeId = emp.id
  const empUser = await mkUser(vendor.id, { role: "EMPLOYEE", name: "L29 Self", employeeId })
  empToken = await mkSession(empUser.id, "FULL")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L29 Admin", email: `l29-ad-${uniq()}@test.local` })
  adminToken = await mkSession(admin.id, "FULL")
  leaveTypeId = (await db.leaveType.create({ data: { vendorId: vendor.id, code: uniq("L29"), name: "L29 Annual", defaultDays: 10, paid: true } })).id
  // leave applies submit through the approval engine — vendor needs a LEAVE workflow
  const wf = await db.approvalWorkflow.create({ data: { vendorId: vendor.id, processType: "LEAVE", name: `L29 ${uniq()}`, active: true } })
  await db.approvalStep.create({ data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: 1, name: "Owner Approval", approverRole: "VENDOR_OWNER", required: true, rejectBehavior: "REJECT_ALL", departmentScope: false, branchScope: false, amountThreshold: null, allowDelegation: false } })
})

describe("L-29 — leave attachment upload validates the BYTES", () => {
  test("renamed executable (declared image, MZ bytes) → 400", async () => {
    const d = workDay(40)
    const r = await postHrm("leaveRequests.apply", {
      employeeId, leaveTypeId, fromDate: d, toDate: d,
      reason: "L-29 exe attachment", attachmentName: "doctor-note.png", attachmentData: `data:image/png;base64,${EXE_B64}`,
    }, { bearer: empToken })
    expect(r.status).toBe(400)
    expect(String(r.body?.error || "")).toContain("Unsupported attachment type")
  })

  test("a real PNG attachment is accepted and stored", async () => {
    const d = workDay(45)
    const r = await postHrm("leaveRequests.apply", {
      employeeId, leaveTypeId, fromDate: d, toDate: d,
      reason: "L-29 png attachment", attachmentName: "note.png", attachmentData: `data:image/png;base64,${PNG_B64}`,
    }, { bearer: empToken })
    expect(r.status).toBe(200)
    const reqId = r.body?.data?.id as string
    const stored = await db.leaveRequest.findUnique({ where: { id: reqId } })
    expect(stored?.attachmentData).toBeTruthy()
  })
})

describe("L-29 — served MIME comes from the stored bytes, not the filename", () => {
  test("leaveRequests.attachment sniffs: .png filename over JPEG bytes → image/jpeg", async () => {
    const reqId = (await db.leaveRequest.findFirst({ where: { vendorId: vendor.id, employeeId }, orderBy: { createdAt: "desc" } }))!.id
    // swap the stored bytes to JPEG while keeping the .png filename
    const jpgB64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgA//9k="
    await db.leaveRequest.update({ where: { id: reqId }, data: { attachmentName: "mislabeled.png", attachmentData: `data:image/jpeg;base64,${jpgB64}` } })
    const r = await postHrm("leaveRequests.attachment", { id: reqId }, { bearer: adminToken })
    expect(r.status).toBe(200)
    expect(r.body?.data?.mimeType).toBe("image/jpeg") // sniffed — the filename lied
  })

  test("employees.docs.view serves unknown payloads as application/octet-stream (no inline preview)", async () => {
    const doc = await db.employeeDocument.create({
      data: {
        vendorId: vendor.id, employeeId, category: "ID", docType: "Passport",
        title: "L29 doc", fileName: "scary.svg",
        fileData: Buffer.from("<svg onload='alert(1)'>not really an image</svg>").toString("base64"),
      } as any,
    })
    const r = await postHrm("employees.docs.view", { id: doc.id }, { bearer: adminToken })
    expect(r.status).toBe(200)
    expect(r.body?.data?.mimeType).toBe("application/octet-stream") // sniff failed → safe default
  })
})

describe("L-29 — selfie proofs validate the decoded bytes", () => {
  test("validateSelfieDataUrl unit: real PNG passes; MZ-executable declared as jpeg fails", () => {
    expect(validateSelfieDataUrl(`data:image/png;base64,${PNG_B64}`)).toMatchObject({ ok: true, mime: "image/png" })
    const bad = validateSelfieDataUrl(`data:image/jpeg;base64,${EXE_B64}`)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toContain("JPEG, PNG or WebP")
  })

  test("source invariant: BOTH selfie writers route through validateSelfieDataUrl", () => {
    const att = readFileSync("src/hrm-server/routes/attendance.ts", "utf8")
    const trk = readFileSync("src/hrm-server/routes/tracking.ts", "utf8")
    expect(att).toContain("validateSelfieDataUrl") // storeSelfieProofLocal
    expect(trk).toContain("validateSelfieDataUrl") // storeSelfieProof
  })
})
