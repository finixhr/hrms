/// <reference types="bun-types" />
// ============ H-6 regression: settlements.pay is exactly-once ============
// Audit H-6 (High): settlements.pay did findFirst(APPROVED) → unconditional
// postJournal (NO idempotencyKey) → unconditional status=PAID update, with no
// transaction. Two concurrent calls (double-click, two tabs) both passed the
// APPROVED check, both posted journals, and both marked the resignation
// COMPLETED — a direct double payment of final settlement money. Every other
// money path already uses claim-plus-backstop (payRun: PAYROLL:${runId},
// loans: LOAN_DISBURSE:${loan.id}, expenses: EXPENSE: keys).
//
// Fix under test: one $transaction with a conditional claim
// (updateMany where status=APPROVED, assert count===1), journal idempotencyKey
// SETTLEMENT:${id}, remaining writes inside the same transaction.
//
// Route-layer: two CONCURRENT settlements.pay calls through POST /api/hrm.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let token: string
let settlementIds: string[] = []

/** Build one APPROVED settlement fixture (resignation + employee + settlement). */
async function mkApprovedSettlement(): Promise<string> {
  const emp = await mkEmployee(vendor.id, { fullName: "H6 Exiting" })
  const res = await db.resignation.create({
    data: {
      vendorId: vendor.id, employeeId: emp.id,
      submissionDate: "2026-09-01", resignationDate: "2026-09-15", proposedLwd: "2026-10-15",
      reason: "H6 test resignation", status: "ACCEPTED",
    },
  })
  const comp = { gross: 5000, loanDue: 0, advanceDue: 0, noticeBuyout: 0, otherDeductions: 0, netPayable: 5000 }
  const rec = await db.finalSettlement.create({
    data: {
      vendorId: vendor.id, resignationId: res.id,
      computationJson: JSON.stringify(comp), netPayable: 5000, status: "APPROVED",
    },
  })
  settlementIds.push(rec.id)
  return rec.id
}

function journalCount(id: string) {
  return db.accountJournal.count({ where: { refType: "SETTLEMENT", refId: id } })
}

beforeAll(async () => {
  vendor = await mkVendor("H6 Settlement Vendor")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "H6 Admin" })
  token = await mkSession(admin.id, "FULL")
})

describe("H-6 settlements.pay is exactly-once under concurrency", () => {
  test("two CONCURRENT settlements.pay calls ⇒ exactly one journal entry, one transition", async () => {
    const id = await mkApprovedSettlement()
    const [a, b] = await Promise.allSettled([
      postHrm("settlements.pay", { id }, { bearer: token }),
      postHrm("settlements.pay", { id }, { bearer: token }),
    ])
    const results = [a, b].map((r) => (r.status === "fulfilled" ? r.value : null))
    const oks = results.filter((r) => r && r.status === 200 && r.body.ok === true)
    const denied = results.filter((r) => r && r.status !== 200)
    expect(oks.length).toBe(1) // ← was 2 (both posted journals, both flipped PAID)
    expect(denied.length).toBe(1)
    expect(denied[0]!.body.error).toMatch(/already paid|no longer approved/i)

    // exactly ONE journal row — with the idempotency key as backstop
    expect(await journalCount(id)).toBe(1)
    const journal = await db.accountJournal.findFirst({ where: { refType: "SETTLEMENT", refId: id } })
    expect(journal?.idempotencyKey).toBe(`SETTLEMENT:${id}`)

    // one status transition: settlement PAID, resignation COMPLETED, employee RESIGNED
    const rec = await db.finalSettlement.findUnique({ where: { id } })
    expect(rec?.status).toBe("PAID")
    expect(rec?.paidAt).toBeTruthy()
    expect(rec?.journalId).toBe(journal?.id)
    const res = await db.resignation.findUnique({ where: { id: rec!.resignationId } })
    expect(res?.status).toBe("COMPLETED")
    const emp = await db.employee.findUnique({ where: { id: res!.employeeId } })
    expect(emp?.status).toBe("RESIGNED")
  })

  test("a sequential re-pay after success is also denied (no double journal)", async () => {
    const id = await mkApprovedSettlement()
    const first = await postHrm("settlements.pay", { id }, { bearer: token })
    expect(first.status).toBe(200)
    const second = await postHrm("settlements.pay", { id }, { bearer: token })
    expect(second.status).not.toBe(200)
    expect(second.body.error).toMatch(/already paid|no longer approved|not found/i)
    expect(await journalCount(id)).toBe(1)
  })
})
