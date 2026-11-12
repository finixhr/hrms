/// <reference types="bun-types" />
// ============ FIN-022 (Phase 3) — per-company backup volumes + masking =======
// The audit: "Tenant backup export is one tenant-wide file (all companies),
// with no per-company split or selective exclusion." Exit criterion: "A
// single-company export contains no sibling-company data." Verified here
// against the real builder (DMMF-driven, real database):
//
//   V1  a Company A volume carries ONLY Company A rows — every row with a
//       companyId column equals A; children scope through A's employee set
//       (b1's bank account is absent);
//   V2  models WITHOUT a company dimension (Loan, PurchaseQuotation,
//       SequenceCounter …) are bypassed LOUDLY — listed in companyScope with
//       reasons, never silently dropped (the DB-01 rule);
//   V3  users bound to Company B's employee row are absent from A's volume
//       (safe fields carry only A's staff accounts);
//   V4  masking replaces the selected field with a deterministic digest and
//       never leaks the original;
//   V5  the tenant-wide export (no companyId) is unchanged — both companies'
//       rows ride together, no companyScope key.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, uniq } from "./_fixtures"
import { buildTenantBackupExport, applyExportMasking } from "@/hrm-server/backup-export"

let vendor: any, cA: any, cB: any
let a1: any, b1: any, bankA: any, bankB: any, itemA: any, itemB: any
let userA: any, userB: any, userFree: any

beforeAll(async () => {
  vendor = await mkVendor("FIN-022 Vendor", { company: false })
  cA = await db.company.create({ data: { vendorId: vendor.id, code: "A", name: "Alpha Co", isDefault: true, active: true } })
  cB = await db.company.create({ data: { vendorId: vendor.id, code: "B", name: "Beta Co", isDefault: false, active: true } })

  a1 = await db.employee.create({ data: { vendorId: vendor.id, companyId: cA.id, fullName: "Alpha Staff", code: uniq("EA"), joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })
  b1 = await db.employee.create({ data: { vendorId: vendor.id, companyId: cB.id, fullName: "Beta Staff", code: uniq("EB"), joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })

  bankA = await db.bankAccount.create({ data: { vendorId: vendor.id, employeeId: a1.id, accountNumber: "ACC-ALPHA-001", bank: "BRAC", branch: "Gulshan" } as any })
  bankB = await db.bankAccount.create({ data: { vendorId: vendor.id, employeeId: b1.id, accountNumber: "ACC-BETA-002", bank: "DBBL", branch: "Motijheel" } as any })

  itemA = await db.item.create({ data: { vendorId: vendor.id, companyId: cA.id, code: uniq("ITA"), name: "Alpha Item", unit: "PCS" } as any })
  itemB = await db.item.create({ data: { vendorId: vendor.id, companyId: cB.id, code: uniq("ITB"), name: "Beta Item", unit: "PCS" } as any })

  userA = await mkUser(vendor.id, { employeeId: a1.id, name: "Alpha User" })
  userB = await mkUser(vendor.id, { employeeId: b1.id, name: "Beta User" })
  userFree = await mkUser(vendor.id, { name: "Tenant Admin (no employee binding)" })
})

describe("FIN-022 per-company backup volumes", () => {
  test("V1: a Company A volume contains no sibling-company data", async () => {
    const out: any = await buildTenantBackupExport(vendor.id, { companyId: cA.id })
    // every row carrying a companyId equals A
    for (const [table, rows] of Object.entries(out.data)) {
      for (const r of rows as any[]) {
        if (r && r.companyId !== undefined) {
          expect(`${table} row carries a foreign companyId`).toBe(`${table} row carries a foreign companyId`) // guard text
          expect(r.companyId).toBe(cA.id)
        }
      }
    }
    // children scope through A's employee set — b1's bank account is absent
    expect(out.data.bankAccount).toHaveLength(1)
    expect(out.data.bankAccount[0].id).toBe(bankA.id)
    expect(out.data.bankAccount.some((r: any) => r.accountNumber === "ACC-BETA-002")).toBe(false)
    // items: only Alpha's
    expect(out.data.item.map((r: any) => r.id).sort()).toEqual([itemA.id].sort())
    // employees: only A's
    expect(out.data.employee.map((r: any) => r.id)).toEqual([a1.id])
  })

  test("V2: models without a company dimension are bypassed LOUDLY", async () => {
    const out: any = await buildTenantBackupExport(vendor.id, { companyId: cA.id })
    expect(out.companyScope).toBeDefined()
    expect(out.companyScope.companyId).toBe(cA.id)
    expect(out.companyScope.companyName).toBe("Alpha Co")
    const bypassed = out.companyScope.bypassed.map((b: any) => b.model)
    // PurchaseQuotation + Loan + CommunicationLog carry no companyId column;
    // SequenceCounter scopes by id-key prefix; all must be declared:
    for (const m of ["PurchaseQuotation", "Loan", "CommunicationLog", "SequenceCounter"]) {
      expect(bypassed).toContain(m)
    }
    for (const b of out.companyScope.bypassed) expect(b.reason.length).toBeGreaterThan(10)
    // and they are genuinely absent from the payload
    expect(out.data.purchaseQuotation).toBeUndefined()
    expect(out.data.sequenceCounter).toBeUndefined()
  })

  test("V3: users bound to Company B's employee are absent from A's volume", async () => {
    const out: any = await buildTenantBackupExport(vendor.id, { companyId: cA.id })
    const userIds = out.data.user.map((u: any) => u.id)
    expect(userIds).toContain(userA.id) // A's staff account
    expect(userIds).toContain(userFree.id) // unbound tenant-admin account stays (tenant-level identity)
    expect(userIds).not.toContain(userB.id) // B's staff account — NOT A's data
    // safe fields only (C-2): no password material anywhere
    for (const u of out.data.user) {
      expect(Object.keys(u).sort()).toEqual(["createdAt", "departmentId", "email", "employeeId", "id", "lastLoginAt", "mfaEnrolled", "name", "role", "status", "branchId"].sort())
    }
  })

  test("V4: masking replaces the selected field with a deterministic digest", async () => {
    const out: any = await buildTenantBackupExport(vendor.id, { companyId: cA.id, mask: ["bankAccount.accountNumber", "user.email"] })
    const acc = out.data.bankAccount[0] as any
    expect(acc.accountNumber).toMatch(/^masked:[0-9a-f]{12}$/)
    expect(acc.accountNumber).not.toContain("ACC-ALPHA-001")
    expect(out.masked).toEqual({ bankAccount: ["accountNumber"], user: ["email"] })
    // deterministic: same input, same digest
    const out2: any = await buildTenantBackupExport(vendor.id, { companyId: cA.id, mask: ["bankAccount.accountNumber"] })
    expect((out2.data.bankAccount[0] as any).accountNumber).toBe(acc.accountNumber)
  })

  test("V5: unknown mask selectors and foreign companyIds fail loudly", async () => {
    await expect(buildTenantBackupExport(vendor.id, { companyId: cA.id, mask: ["noSuchTable.field"] })).rejects.toThrow(/unknown table/)
    await expect(buildTenantBackupExport(vendor.id, { companyId: cA.id, mask: ["bankAccount.noSuchField"] })).rejects.toThrow(/never occurs/)
    const foreign: any = await mkVendor("FIN-022 other vendor", { company: false })
    await expect(buildTenantBackupExport(vendor.id, { companyId: foreign.id })).rejects.toThrow(/does not belong to vendor/)
  })

  test("V6: the tenant-wide export is unchanged (both companies, no companyScope)", async () => {
    const out: any = await buildTenantBackupExport(vendor.id)
    expect(out.companyScope).toBeUndefined()
    expect(out.data.employee.map((r: any) => r.id).sort()).toEqual([a1.id, b1.id].sort())
    expect(out.data.bankAccount).toHaveLength(2)
    expect(out.data.item).toHaveLength(2)
    expect(out.data.sequenceCounter).toBeDefined() // key-prefix lane runs tenant-wide
  })
})

describe("FIN-022 applyExportMasking (pure)", () => {
  test("empty mask list is a no-op", () => {
    const data: any = { bankAccount: [{ accountNumber: "X" }] }
    expect(() => applyExportMasking(data, [])).not.toThrow()
    expect(data.bankAccount[0].accountNumber).toBe("X")
  })
})
