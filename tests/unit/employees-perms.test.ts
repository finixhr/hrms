/// <reference types="bun-types" />
// ============ C-05 regression: bank accounts + document bytes ============
// employees.get must never hand BankAccount rows to callers without
// bankInfo.view; entitled callers get last-4 masks; document fileData bytes
// never ride the profile payload (metadata + hasFile only) and downloads
// remain permission-gated + audited.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { getRoute } from "@/hrm-server/routes/router"
import { mkVendor, mkUser, mkEmployee, mkSession, makeCtx, uniq } from "./_fixtures"

let vendor: { id: string }
let emp: { id: string; code: string }
let bankId: string
let docId: string
const FULL_ACCOUNT = "1234567890123"

beforeAll(async () => {
  vendor = await mkVendor("C05 Vendor")
  emp = await mkEmployee(vendor.id, { fullName: "C Five" })
  await db.bankAccount.create({
    data: { id: (bankId = uniq("bank")), vendorId: vendor.id, employeeId: emp.id, holderName: "C Five", bank: "DBBL", accountNumber: FULL_ACCOUNT, accountType: "SALARY" },
  })
  await db.employeeDocument.create({
    data: { id: (docId = uniq("doc")), vendorId: vendor.id, employeeId: emp.id, docType: "NID", title: "NID Card", fileName: "nid.png", fileData: "aGVsbG8=" },
  })
})

describe("C-05 employees.get — bank gating", () => {
  test("BRANCH_MANAGER (employees.view only) receives NO bank rows at all", async () => {
    const branchManager = await mkUser(vendor.id, { role: "BRANCH_MANAGER", employeeId: null, branchId: null })
    const def = getRoute("employees.get")!
    const out = (await def.handler(makeCtx(branchManager), { id: emp.id })) as any
    expect(out.banks).toEqual([])
    const json = JSON.stringify(out)
    expect(json).not.toContain(FULL_ACCOUNT)
  })

  test("entitled caller (bankInfo.view) gets masked account number (last 4 only)", async () => {
    const hrAdmin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const def = getRoute("employees.get")!
    const out = (await def.handler(makeCtx(hrAdmin), { id: emp.id })) as any
    expect(out.banks.length).toBe(1)
    expect(out.banks[0].accountNumber).toBe(`•••• ${FULL_ACCOUNT.slice(-4)}`)
    expect(out.banks[0].accountNumber).not.toContain(FULL_ACCOUNT)
    expect(JSON.stringify(out)).not.toContain(FULL_ACCOUNT)
  })
})

describe("C-05 employees.get — document bytes", () => {
  test("document metadata returned WITHOUT fileData bytes", async () => {
    const hrAdmin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const def = getRoute("employees.get")!
    const out = (await def.handler(makeCtx(hrAdmin), { id: emp.id })) as any
    expect(out.docs.length).toBe(1)
    expect(Object.keys(out.docs[0])).not.toContain("fileData")
    expect(out.docs[0].hasFile).toBe(true)
    expect(out.docs[0].fileName).toBe("nid.png")
    expect(JSON.stringify(out)).not.toContain("aGVsbG8=")
  })

  test("BRANCH_MANAGER payload contains neither accountNumber nor fileData", async () => {
    const branchManager = await mkUser(vendor.id, { role: "BRANCH_MANAGER" })
    const def = getRoute("employees.get")!
    const out = (await def.handler(makeCtx(branchManager), { id: emp.id })) as any
    const json = JSON.stringify(out)
    expect(json).not.toContain(FULL_ACCOUNT)
    expect(json).not.toContain("aGVsbG8=")
    expect(json).not.toMatch(/"fileData"/)
  })
})

describe("C-05 employees.docs.download — audited path stays intact", () => {
  test("returns file bytes for entitled caller AND writes an audit row", async () => {
    const hrAdmin = await mkUser(vendor.id, { role: "HR_ADMIN" })
    const before = await db.auditLog.count({ where: { vendorId: vendor.id, action: "employeeDocs.download" } })
    const def = getRoute("employees.docs.download")!
    const out = (await def.handler(makeCtx(hrAdmin), { id: docId })) as any
    expect(out.fileData).toBe("aGVsbG8=")
    expect(out.fileName).toBe("nid.png")
    const after = await db.auditLog.count({ where: { vendorId: vendor.id, action: "employeeDocs.download" } })
    expect(after).toBe(before + 1)
  })
})
