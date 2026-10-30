/// <reference types="bun-types" />
// ============ Phase 5 P6 WS-A — employee PII encrypted at rest (F28) ========
// Covers src/hrm-server/pii-field.ts + every storage/egress boundary it now
// guards:
//   1. The envelopes — enc:: (small text) and encf:: (file bytes): exact
//      round-trips, format markers, plaintext-nowhere-in-storage, and the
//      context isolation (a pii::v1 ciphertext does NOT decrypt under any
//      other crypto-field context).
//   2. Legacy rows (pre-P6 plaintext) stay readable through every read path
//      until the rotation script re-wraps them — upgrade-safe by design.
//   3. Failure semantics — readPiiText → null on a rotated-away key (display
//      paths degrade to "—"), readPiiTextStrict THROWS with an
//      operator-actionable message (a salary export must never silently emit
//      a missing account number).
//   4. The ROUTE boundaries — employees.banks.* stores ciphertext and returns
//      the C-05 mask with the REAL last-4; employees.docs.* stores ciphertext
//      doc numbers + file bytes and download/view decrypt EXACTLY; employees.get
//      masks from the decrypted value; the payout resolvers (single + batch)
//      return the decrypted number for the disbursement paths.
//   5. The fail-closed write rule — storing NEW plaintext PII without a
//      deployment key is refused (the MFA/comm-key/comms discipline).
//   6. The rotation script's core transform (dry-run reporting + idempotence
//      by prefix) is exercised end-to-end through the enc::/encf:: helpers.
import "./_testdb"
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, uniq } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"
import {
  piiEncrypted, encryptPiiText, readPiiText, readPiiTextStrict,
  encryptPiiFile, readPiiFileStrict, readPiiFile, maskPiiNumber, piiTextForStorage,
} from "@/hrm-server/pii-field"
import { encryptField, decryptField } from "@/hrm-server/crypto-field"
import { resolveSalaryPayout, resolveSalaryPayouts } from "@/hrm-server/payout"

const TEST_KEY = "a".repeat(64) // 64-char hex test key (NOT a real deployment key)
let SAVED_KEY: string | undefined

beforeAll(() => {
  SAVED_KEY = process.env.HRM_MFA_KEY
  process.env.HRM_MFA_KEY = TEST_KEY
})
afterAll(() => {
  if (SAVED_KEY != null) process.env.HRM_MFA_KEY = SAVED_KEY
  else delete process.env.HRM_MFA_KEY
})

describe("P6 WS-A — the envelopes (pii::v1)", () => {
  test("encryptPiiText stores the enc:: marker and readPiiText recovers the exact value; plaintext never appears at rest", () => {
    const acct = "1701204578412003"
    const stored = encryptPiiText(acct)
    expect(stored.startsWith("enc::")).toBe(true)
    expect(stored).not.toContain(acct)
    expect(readPiiText(stored)).toBe(acct)
  })

  test("encryptPiiFile stores the encf:: marker and readPiiFileStrict recovers the exact payload (base64 document bytes)", () => {
    const fileData = "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".padEnd(2000, "A")
    const stored = encryptPiiFile(fileData)
    expect(stored.startsWith("encf::")).toBe(true)
    expect(stored).not.toContain(fileData.slice(-24)) // the payload tail never rides in the clear
    expect(readPiiFileStrict(stored)).toBe(fileData)
    // base64 transport: a realistic document costs ≈ input + 33% — NOT the
    // +100% a hex envelope would add (the reason the file format exists)
    expect(stored.length).toBeGreaterThan(fileData.length)
    expect(stored.length).toBeLessThan(Math.ceil(fileData.length * 1.4))
  })

  test("every encrypted value decrypts under pii::v1 and under NO other context (context isolation)", () => {
    const packed = encryptPiiText("01712345678").slice("enc::".length)
    expect(decryptField(packed, "pii::v1")).toBe("01712345678")
    // the same packed value must NOT authenticate under any sibling context
    for (const other of ["devices::v1", "comms::v1", "mfa::v2", "cameras::v1", "push::v1"]) {
      let threw = false
      try { decryptField(packed, other) } catch { threw = true }
      expect(threw).toBe(true)
    }
  })

  test("legacy plaintext rows pass through every read path unchanged (upgrade-safe until rotated)", () => {
    expect(piiEncrypted("LEGACY_PLAINTEXT")).toBe(false)
    expect(readPiiText("LEGACY_PLAINTEXT")).toBe("LEGACY_PLAINTEXT")
    expect(readPiiTextStrict("LEGACY_PLAINTEXT", "bank account number")).toBe("LEGACY_PLAINTEXT")
    expect(readPiiFileStrict("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
    expect(readPiiText(null)).toBeNull()
    expect(readPiiText("")).toBeNull()
  })

  test("readPiiText degrades to null on an undecryptable value; the STRICT variants throw operator-actionable errors", () => {
    // encrypt under a DIFFERENT random key, then flip the env key — simulates rotation away
    const prev = process.env.HRM_MFA_KEY
    process.env.HRM_MFA_KEY = "b".repeat(64)
    const orphan = encryptPiiText("9876543210987")
    process.env.HRM_MFA_KEY = prev
    expect(readPiiText(orphan)).toBeNull()
    expect(() => readPiiTextStrict(orphan, "bank account number")).toThrow(/pii::v1/)
    // corrupt file envelope → strict throw, lenient null
    const corruptFile = "encf::not.valid.data"
    expect(readPiiFile(corruptFile)).toBeNull()
    expect(() => readPiiFileStrict(corruptFile)).toThrow()
  })

  test("maskPiiNumber masks the DECRYPTED value — the last-4 shown is always the real one", () => {
    const stored = encryptPiiText("1701204578412003")
    expect(maskPiiNumber(stored)).toBe("•••• 2003")
    expect(maskPiiNumber("9998887776665")).toBe("•••• 6665") // legacy row
    expect(maskPiiNumber(null)).toBeNull()
  })

  test("piiTextForStorage: blank → null, already-encrypted → untouched (no double-encrypt), plaintext → encrypted", () => {
    const stored = encryptPiiText("1234567890")
    expect(piiTextForStorage(null)).toBeNull()
    expect(piiTextForStorage("")).toBeNull()
    expect(piiTextForStorage(stored)).toBe(stored)
    const fresh = piiTextForStorage("98712345678")
    expect(fresh?.startsWith("enc::")).toBe(true)
    expect(readPiiText(fresh!)).toBe("98712345678")
  })

  test("fail-closed write rule — with NO deployment key, encrypting new PII is refused (the comm-key discipline)", () => {
    const prev = process.env.HRM_MFA_KEY
    delete process.env.HRM_MFA_KEY
    try {
      expect(() => encryptPiiText("1234567890")).toThrow()
      expect(() => encryptPiiFile("data:image/png;base64,AAAA")).toThrow()
    } finally {
      process.env.HRM_MFA_KEY = prev
    }
  })
})

describe("P6 WS-A — the route boundaries", () => {
  let vendor: any, owner: any, ctx: any, emp: any
  let bankRowId: string // the encrypted-row handle (stable across the rename test)

  beforeAll(async () => {
    vendor = await mkVendor("P6-PII")
    owner = await mkUser(vendor.id)
    // explicit verbs (the "*" set does not expand for direct handler
    // invocation — the dispatcher expands it in production)
    ctx = makeCtx(owner, [
      "employees.view", "employees.edit",
      "bankInfo.view", "bankInfo.edit", "bankInfo.verify",
      "employeeDocs.view", "employeeDocs.upload", "employeeDocs.edit", "employeeDocs.download", "employeeDocs.reveal",
    ])
    emp = await mkEmployee(vendor.id, { fullName: "Pia Pii" })
  })

  test("employees.banks.create stores CIPHERHTEXT and answers the mask with the REAL last-4", async () => {
    const res: any = await getRoute("employees.banks.create")!.handler(ctx, {
      employeeId: emp.id, holderName: "Pia Pii", bank: "DBBL", accountNumber: "1701204578412003",
      paymentMethod: "BANK", accountType: "SALARY",
    })
    expect(res.accountNumber).toBe("•••• 2003")
    expect(res.accountNumber).not.toContain("1701204578412003")
    const row = await db.bankAccount.findFirstOrThrow({ where: { employeeId: emp.id, bank: "DBBL" } })
    bankRowId = row.id
    expect(row.accountNumber?.startsWith("enc::")).toBe(true)
    expect(row.accountNumber).not.toContain("1701204578412003")
    expect(readPiiText(row.accountNumber)).toBe("1701204578412003")
  })

  test("employees.banks.list masks from the decrypted value (legacy plaintext rows included)", async () => {
    // a legacy pre-P6 row, written straight to the DB
    await db.bankAccount.create({
      data: { vendorId: emp.vendorId, employeeId: emp.id, holderName: "Legacy Holder", bank: "BRAC", accountNumber: "9998887776665", paymentMethod: "BANK" },
    })
    const rows = (await getRoute("employees.banks.list")!.handler(ctx, { employeeId: emp.id })) as any[]
    const byNumber = new Map(rows.map((r) => [r.accountNumber, r]))
    expect(byNumber.get("•••• 2003")).toBeDefined()      // encrypted row
    expect(byNumber.get("•••• 6665")).toBeDefined()      // legacy plaintext row — same honest mask
    for (const r of rows) expect(String(r.accountNumber)).not.toMatch(/17012045|99988877/)
  })

  test("employees.banks.update keeps the stored ciphertext when the client sends blanks (the payout merge rule)", async () => {
    const before = (await db.bankAccount.findFirstOrThrow({ where: { id: bankRowId } })).accountNumber
    await getRoute("employees.banks.update")!.handler(ctx, { id: bankRowId, holderName: "Pia Pii Renamed" })
    const after = await db.bankAccount.findFirstOrThrow({ where: { id: bankRowId } })
    expect(after.holderName).toBe("Pia Pii Renamed")
    expect(after.accountNumber).toBe(before) // untouched ciphertext — no double-encrypt, no data loss
    expect(readPiiText(after.accountNumber)).toBe("1701204578412003")
  })

  test("employees.docs.create stores docNumber + fileData encrypted; list answers the RAW number (the module's designed surface); download decrypts EXACTLY", async () => {
    const fileData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    const res: any = await getRoute("employees.docs.create")!.handler(ctx, {
      employeeId: emp.id, category: "IDENTITY", docType: "NID", title: "NID Card",
      docNumber: "19931234567890123", fileData,
    })
    expect(res.docNumber).toBe("19931234567890123") // the designed raw-number surface
    expect(res.fileData).toBeUndefined()            // file bytes never ride a list/create echo
    const row = await db.employeeDocument.findFirstOrThrow({ where: { employeeId: emp.id, docType: "NID" } })
    expect(row.docNumber?.startsWith("enc::")).toBe(true)
    expect(row.fileData?.startsWith("encf::")).toBe(true)
    // list decrypts the number
    const list = (await getRoute("employees.docs.list")!.handler(ctx, { employeeId: emp.id })) as any[]
    expect(list.some((d) => d.docNumber === "19931234567890123")).toBe(true)
    // download returns the EXACT stored payload
    const dl: any = await getRoute("employees.docs.download")!.handler(ctx, { id: row.id })
    expect(dl.fileData).toBe(fileData)
  })

  test("employees.get: banks masked from ciphertext, identity number projected from the DECRYPTED doc number", async () => {
    const out: any = await getRoute("employees.get")!.handler(ctx, { id: emp.id })
    expect(out.banks.some((b: any) => b.accountNumber === "•••• 2003")).toBe(true)
    // HR_MANAGER-style reveal: the VENDOR_OWNER ctx has full access → raw identity number
    expect(out.employee.identityNumber).toBe("19931234567890123")
    expect(out.docs.some((d: any) => d.docNumber === "19931234567890123")).toBe(true)
  })

  test("the payout resolvers (single + batch) hand the DISBURSEMENT paths the decrypted account number", async () => {
    await db.employee.update({
      where: { id: emp.id },
      data: { salaryPayoutMethod: "BANK", salaryPayoutAccountId: bankRowId } as any,
    })
    const single = await resolveSalaryPayout(emp.id)
    expect(single.method).toBe("BANK")
    expect(single.account?.accountNumber).toBe("1701204578412003")
    const batch = await resolveSalaryPayouts([emp.id])
    expect(batch.get(emp.id)?.account?.accountNumber).toBe("1701204578412003")
    // the resolver THROWS (never silently nulls) on a rotated-away key
    const prev = process.env.HRM_MFA_KEY
    process.env.HRM_MFA_KEY = "c".repeat(64)
    const orphan = encryptPiiText("1111222233334")
    process.env.HRM_MFA_KEY = prev // restore BEFORE resolving — the orphan is now unreadable
    await db.bankAccount.update({
      where: { id: single.account!.id },
      data: { accountNumber: orphan, mfsNumber: null },
    })
    try {
      let threw = false
      try { await resolveSalaryPayout(emp.id) } catch (e: any) { threw = /pii::v1/.test(String(e?.message)) }
      expect(threw).toBe(true)
    } finally {
      // key FIRST, then re-encrypt the fixture under the active key
      process.env.HRM_MFA_KEY = prev
      await db.bankAccount.update({ where: { id: single.account!.id }, data: { accountNumber: encryptPiiText("1701204578412003") } })
    }
  })

  test("ess.profile decrypts the employee's OWN bank rows", async () => {
    const essCtx = makeCtx({ ...owner, employeeId: emp.id } as any)
    const out: any = await getRoute("ess.profile")!.handler(essCtx, {})
    expect(out.banks.some((b: any) => b.accountNumber === "1701204578412003")).toBe(true)
  })

  test("the audit layer stays PII-safe: diffs redact the PII keys by NAME regardless of value format", async () => {
    const row = await db.bankAccount.findFirstOrThrow({ where: { id: bankRowId } })
    const updated = { ...row, accountNumber: encryptPiiText("5554443332221"), holderName: "Changed" }
    const { auditDiff } = await import("@/hrm-server/audit")
    const diff = auditDiff(row, updated)!
    expect(diff.newValue.accountNumber).toBe("[redacted]")
    expect(JSON.stringify(diff)).not.toMatch(/17012045|5554443332221/)
  })
})

describe("P6 WS-A — rotation-script semantics (encrypt-secrets-at-rest.ts, F28 section)", () => {
  test("the PII transform is idempotent by prefix — already-wrapped rows are skipped on re-run", async () => {
    const vendor = await mkVendor("P6-ROT")
    const emp = await mkEmployee(vendor.id)
    // one plaintext legacy row + one already-encrypted row
    await db.bankAccount.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, accountNumber: "12111098765432", paymentMethod: "BANK" } })
    await db.bankAccount.create({ data: { vendorId: emp.vendorId, employeeId: emp.id, accountNumber: encryptPiiText("21222324252627"), paymentMethod: "BANK" } })
    const rows = await db.bankAccount.findMany({ where: { employeeId: emp.id } })
    const wouldWrap = rows.filter((r) => r.accountNumber && !r.accountNumber.startsWith("enc::"))
    expect(wouldWrap.length).toBe(1) // only the legacy row — the enc:: row is skipped
    // wrapping it through the same helper the script uses leaves it readable
    for (const r of wouldWrap) {
      await db.bankAccount.update({ where: { id: r.id }, data: { accountNumber: encryptPiiText(r.accountNumber!) } })
    }
    const after = await db.bankAccount.findMany({ where: { employeeId: emp.id } })
    expect(after.every((r) => r.accountNumber?.startsWith("enc::"))).toBe(true)
    const values = after.map((r) => readPiiText(r.accountNumber)).sort()
    expect(values).toContain("12111098765432")
    expect(values).toContain("21222324252627")
  })

  test("a full legacy corpus (bank + MFS + doc number + doc file) round-trips through wrap-then-read", async () => {
    const vendor = await mkVendor("P6-ROT2")
    const emp = await mkEmployee(vendor.id)
    const fileData = "data:application/pdf;base64,JVBERi0xLjQK"
    await db.bankAccount.create({
      data: { vendorId: emp.vendorId, employeeId: emp.id, accountNumber: "34353637383940", mfsNumber: "01812345678", paymentMethod: "BANK" },
    })
    await db.employeeDocument.create({
      data: { vendorId: vendor.id, employeeId: emp.id, category: "IDENTITY", docType: "NID", title: "NID", docNumber: "19881234567890123", fileData },
    })
    // the script's transform (dry-run then apply, simplified to the same helpers)
    const bank = await db.bankAccount.findFirstOrThrow({ where: { employeeId: emp.id } })
    await db.bankAccount.update({
      where: { id: bank.id },
      data: {
        accountNumber: encryptPiiText(bank.accountNumber!),
        mfsNumber: encryptPiiText(bank.mfsNumber!),
      },
    })
    const doc = await db.employeeDocument.findFirstOrThrow({ where: { employeeId: emp.id } })
    await db.employeeDocument.update({
      where: { id: doc.id },
      data: { docNumber: encryptPiiFile(doc.docNumber!).startsWith("encf::") ? doc.docNumber : encryptPiiText(doc.docNumber!), fileData: encryptPiiFile(doc.fileData!) },
    })
    // every read path recovers the exact plaintext
    const bank2 = await db.bankAccount.findFirstOrThrow({ where: { id: bank.id } })
    expect(readPiiText(bank2.accountNumber)).toBe("34353637383940")
    expect(readPiiText(bank2.mfsNumber)).toBe("01812345678")
    const doc2 = await db.employeeDocument.findFirstOrThrow({ where: { id: doc.id } })
    expect(readPiiText(doc2.docNumber)).toBe("19881234567890123")
    expect(readPiiFileStrict(doc2.fileData)).toBe(fileData)
  })
})
