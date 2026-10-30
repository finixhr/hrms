// ============ Salary Payout + Dynamic Salary Export routes (2026-10 round §42–§54, §76–§78) ============
// Payout settings live in the existing HrSetting system (group "payout" —
// Settings → Payroll → Payout Settings + Payroll view tab). These routes add:
//   payroll.payout.validate   one-employee compliance check (create/edit UX)
//   payroll.payout.status     per-run compliance report (server-side totals)
//   payroll.export.salary     ALL / BANK / CASH / MFS × XLSX / CSV / PDF
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { S } from "../validation"
import { getSettings } from "../settings"
import { resolveSalaryPayout, resolveSalaryPayouts, payoutSettings, validatePayout } from "../payout"
import { buildSalaryExport, renderCsv, renderXlsx, renderPdf, type SalaryExportType } from "../salary-export"
import { z } from "zod"
import { monthName } from "../utils"

/** Validate an employee's payout configuration against a salary amount (§45).
 *  Used by the employee create/edit dialog (frontend prevention) AND by the
 *  server-side enforcement points (the backend repeats the check regardless). */
route("payroll.payout.validate", {
  perm: ["payroll", "view"],
  schema: z.object({
    employeeId: z.string().nullish(),
    method: z.enum(["BANK", "CASH", "MFS"]).nullish(),
    salary: z.number().finite().min(0).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const settings = payoutSettings(await getSettings(ctx.vendorId))
    if (p.employeeId) {
      const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId } })
      if (!emp) throw new Deny("Employee not found", 404)
      const payout = await resolveSalaryPayout(p.employeeId)
      const salary = p.salary ?? (await activeGross(p.employeeId)) ?? 0
      return { ...validatePayout(payout, salary, settings), settings, salary }
    }
    // hypothetical (create-dialog) validation
    const probe = {
      method: p.method ?? null,
      account: p.method === "BANK" || p.method === "MFS" ? { id: "probe", accountNumber: "x", mfsNumber: "x", bank: "x", branch: "x", holderName: "x", routingNumber: "x", mfsProvider: "x" } : null,
    }
    return { ...validatePayout(probe as any, p.salary ?? 0, settings), settings, salary: p.salary ?? 0 }
  },
})

async function activeGross(employeeId: string): Promise<number | null> {
  const s = await db.salaryStructure.findFirst({ where: { employeeId, status: "ACTIVE" }, orderBy: { effectiveFrom: "desc" } })
  return s?.gross ?? null
}

/** Per-run payout compliance report (§78 pre-flight): every INCLUDED entry
 *  checked against the payout rules; totals computed server-side (§79). */
route("payroll.payout.status", {
  perm: ["payroll", "view"],
  schema: z.object({ runId: z.string().min(1) }).strict(),
  handler: async (ctx, p) => {
    const run = await db.payrollRun.findFirst({ where: { id: p.runId, vendorId: ctx.vendorId } })
    if (!run) throw new Deny("Payroll run not found", 404)
    const entries = await db.payrollEntry.findMany({ where: { runId: run.id, status: { in: ["INCLUDED", "ADJUSTED"] } } })
    const settings = payoutSettings(await getSettings(ctx.vendorId))
    // RPT-12 — batched resolution: the old per-entry findUnique +
    // resolveSalaryPayout loop cost 2 round-trips PER EMPLOYEE (~10-15k at
    // 5,000 employees) although the batch resolver already existed.
    const [payouts, emps] = await Promise.all([
      resolveSalaryPayouts(entries.map((e) => e.employeeId)),
      db.employee.findMany({ where: { id: { in: entries.map((e) => e.employeeId) } }, select: { id: true, code: true, fullName: true } }),
    ])
    const empById = new Map(emps.map((e) => [e.id, e]))
    const rows: { code: string; name: string; method: string | null; net: number; ok: boolean; reasons: string[] }[] = []
    let compliant = 0
    let blocked = 0
    for (const e of entries) {
      const emp = empById.get(e.employeeId)
      if (!emp) continue
      const payout = payouts.get(e.employeeId) || { method: null, account: null, note: "Employee not found" }
      const v = validatePayout(payout, settings.thresholdBasis === "NET" ? e.net : e.gross, settings)
      if (v.ok) compliant++
      else blocked++
      rows.push({ code: emp.code, name: emp.fullName, method: v.method, net: e.net, ok: v.ok, reasons: v.reasons })
    }
    rows.sort((a, b) => (a.ok === b.ok ? a.code.localeCompare(b.code) : a.ok ? 1 : -1))
    return { rows, summary: { total: rows.length, compliant, blocked }, settings }
  },
})

/** Salary export (§48–§54). Permissions: payroll.export for every type;
 *  BANK additionally requires bankInfo.view (full account details on the
 *  sheet — §50). Every export is audited (run, type, filters, count, format).
 *  The server re-resolves each employee's TRUE payout method (§77) — a client
 *  "type=BANK" never fabricates bank rows. */
route("payroll.export.salary", {
  perm: ["payroll", "export"],
  schema: S.salaryExport,
  handler: async (ctx, p) => {
    if (p.type === "BANK" && !ctx.permissions.has("bankInfo.view")) {
      throw new Deny("Bank transfer export requires the bankInfo.view permission", 403)
    }
    const data = await buildSalaryExport(ctx.vendorId, p.runId, p.type as SalaryExportType, {
      branchId: p.branchId ?? null, departmentId: p.departmentId ?? null, employeeId: p.employeeId ?? null,
    })
    if (!data.rows.length && !data.skipped.length) {
      throw new Deny("No payroll entries match these filters for this export type", 404)
    }
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId }, select: { name: true } })
    const filtersDesc = [p.branchId ? "branch-filtered" : null, p.departmentId ? "department-filtered" : null, p.employeeId ? "single-employee" : null].filter(Boolean).join(", ") || "no filters"
    await audit(ctx, `payroll.export.${p.type.toLowerCase()}`, "PayrollRun", p.runId,
      `Exported ${p.type} salary sheet (${p.format.toUpperCase()}, ${data.totals.employees} employees, net ৳${Math.round(data.totals.net).toLocaleString("en-IN")}, ${filtersDesc}) — run ${data.runLabel}`)
    if (p.format === "csv") {
      return { format: "csv", filename: `salary-${p.type.toLowerCase()}-${data.runLabel}.csv`, csv: renderCsv(p.type, data), totals: data.totals, skipped: data.skipped }
    }
    if (p.format === "xlsx") {
      const buf = renderXlsx(p.type, data, data.runLabel)
      return { format: "xlsx", filename: `salary-${p.type.toLowerCase()}-${data.runLabel}.xlsx`, base64: buf.toString("base64"), totals: data.totals, skipped: data.skipped }
    }
    const pdfBytes = await renderPdf(p.type, data, data.runLabel, vendor?.name || "HRMS")
    return { format: "pdf", filename: `salary-${p.type.toLowerCase()}-${data.runLabel}.pdf`, base64: Buffer.from(pdfBytes).toString("base64"), totals: data.totals, skipped: data.skipped }
  },
})

/** Preview totals before export (§76: preview before generating). */
route("payroll.export.preview", {
  perm: ["payroll", "export"],
  schema: z.object({
    runId: z.string().min(1),
    type: z.enum(["ALL", "BANK", "CASH", "MFS"]),
    branchId: z.string().nullish(),
    departmentId: z.string().nullish(),
    employeeId: z.string().nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const data = await buildSalaryExport(ctx.vendorId, p.runId, p.type as SalaryExportType, {
      branchId: p.branchId ?? null, departmentId: p.departmentId ?? null, employeeId: p.employeeId ?? null,
    })
    const recipients = p.type === "ALL" ? data.totals.employees : data.rows.filter((r) => r.payoutMethod === p.type).length
    return { totals: data.totals, payoutRecipients: recipients, skipped: data.skipped, runLabel: data.runLabel }
  },
})

// ================= WP-F (2026-10-08) — payout confirmation leg =================
// payroll.payout.confirm — the missing second leg of the payroll→accounting
// bridge. The ACCRUAL journal (pay → Dr expenses / Cr Salaries Payable) posts
// inside the pay transaction (idempotencyKey PAYROLL:{runId}); confirming the
// disbursement posts the SETTLEMENT: Dr Salaries Payable (total net), Cr
// Bank / Cash / MFS split by each entry's resolved payout method.
// Idempotency key SALARY_PAYOUT:{runId} — double-confirm can never double-post.
route("payroll.payout.confirm", {
  perm: ["payroll", "pay"],
  schema: z.object({ runId: z.string().min(1), note: z.string().max(500).optional() }).strict(),
  handler: async (ctx, p) => {
    const run = await db.payrollRun.findFirst({ where: { id: p.runId, vendorId: ctx.vendorId } })
    if (!run) throw new Deny("Payroll run not found", 404)
    if (run.status !== "PAID") throw new Deny(`Payout confirmation applies to PAID runs — this run is ${run.status}`, 400)
    if (run.payoutConfirmedAt) {
      // idempotent answer, not an error: the journal exists, nothing to redo
      return { ok: true, alreadyConfirmed: true, journalId: run.payoutJournalId, confirmedAt: run.payoutConfirmedAt }
    }
    const entries = await db.payrollEntry.findMany({ where: { runId: run.id, status: { in: ["INCLUDED", "ADJUSTED"] } }, select: { employeeId: true, net: true } })
    if (!entries.length) throw new Deny("This run has no active entries to confirm", 400)

    // Per-entry payout-method resolution drives the Dr/Cr split. A null method
    // (legacy employee) settles as CASH — exactly the semantics validatePayout
    // applied when the run was allowed to reach PAID.
    const totals: Record<"BANK" | "CASH" | "MFS", number> = { BANK: 0, CASH: 0, MFS: 0 }
    // RPT-12 — one batched resolution instead of a per-entry round-trip
    const payoutByEmp = await resolveSalaryPayouts(entries.map((e) => e.employeeId))
    for (const e of entries) {
      const payout = payoutByEmp.get(e.employeeId) || { method: null, account: null, note: "Employee not found" }
      const method = payout.method === "BANK" ? "BANK" : payout.method === "MFS" ? "MFS" : "CASH"
      totals[method] += e.net
    }
    const settings = await getSettings(ctx.vendorId)
    const { postJournal, resolveAccountMapping, roleLine, normalizeJournalSides } = await import("../accounting")
    const am = resolveAccountMapping(settings)
    const date = new Date().toISOString().slice(0, 10)

    // Integer paisa arithmetic avoids sub-paisa float drift and guarantees that
    // the debit and credit sides balance to the exact paisa (H-9, L-5).
    const bankPaisa = Math.round(totals.BANK * 100)
    const cashPaisa = Math.round(totals.CASH * 100)
    const mfsPaisa = Math.round(totals.MFS * 100)
    const totalSettledPaisa = bankPaisa + cashPaisa + mfsPaisa
    const bank = bankPaisa / 100
    const cash = cashPaisa / 100
    const mfs = mfsPaisa / 100
    const totalSettled = totalSettledPaisa / 100

    // PAY-001 — adjustment runs carry DELTAS: a negative net is an amount recovered
    // from the employee (Dr Bank/Cash/MFS, Cr Salaries Payable). normalizeJournalSides
    // flips any negative lines to their proper accounting side and drops zero lines.
    const rawLines = [
      roleLine(am, "salariesPayable", totalSettled, "debit"),
      ...(bank !== 0 ? [roleLine(am, "bank", bank, "credit")] : []),
      ...(cash !== 0 ? [roleLine(am, "cash", cash, "credit")] : []),
      ...(mfs !== 0 ? [roleLine(am, "mfs", mfs, "credit")] : []),
    ]
    const lines = normalizeJournalSides(rawLines)

    let journalId: string | null = null
    if (lines.length > 0) {
      const journalAmount = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
      const isAdj = run.runType === "ADJUSTMENT"
      const memo = `Salary payout confirmed — ${monthName(run.periodMonth)} ${run.periodYear}${isAdj ? ` (adjustment #${run.adjustSeq ?? 1})` : ""}: Bank ৳${Math.round(totals.BANK).toLocaleString("en-IN")} · Cash ৳${Math.round(totals.CASH).toLocaleString("en-IN")} · MFS ৳${Math.round(totals.MFS).toLocaleString("en-IN")}${p.note ? ` — ${p.note}` : ""}`
      journalId = await postJournal(ctx, "SALARY_PAYOUT", run.id, date,
        memo,
        lines, journalAmount, { idempotencyKey: `SALARY_PAYOUT:${run.id}` })
    }

    await db.payrollRun.update({
      where: { id: run.id },
      data: { payoutConfirmedAt: new Date(), payoutJournalId: journalId },
    })
    return { ok: true, journalId, totals, entries: entries.length }
  },
})

// ================= WP-F — run cancellation with journal reversal =================
// Cancelling a run that already posted a journal posts the REVERSAL entry
// (every debit becomes a credit and vice versa) so the books return to the
// pre-run state; idempotency key PAYROLL_REVERSAL:{runId}. Runs that never
// reached PAID simply flip to CANCELLED (no journal to reverse). A run with
// a confirmed payout cannot be cancelled until the payout journal is reversed
// manually — refusing here is the safe, auditable answer.
//
// R1 (2026-10-12) — cancel is now fully REVERSIBLE and the month can be re-paid:
//   1. every side effect of payRun is reverted in the same transaction:
//      loan installments/loans (from PayrollEntry.recoveryJson — the exact
//      amounts recovered at pay time), advances, bonuses → APPROVED,
//      deductions → ACTIVE, PF contributions (PAYROLL source) deleted,
//      payslip numbers cleared (frees the vendor-unique payslipNumber space);
//   2. the cancelled run is TOMBSTONED out of the
//      (vendorId, periodYear, periodMonth, periodWeek, runType, adjustSeq)
//      unique slot (adjustSeq := negative one-off sequence from
//      SequenceCounter) so a fresh REGULAR run for the same month can be
//      created immediately — payroll.runs.create ignores CANCELLED runs;
//   3. the pre-pay branch now uses a conditional status claim so a run that
//      slips into PROCESSING concurrently cannot be cancelled underneath the
//      payment transaction.
route("payroll.runs.cancel", {
  perm: ["payroll", "pay"],
  schema: z.object({ runId: z.string().min(1), reason: z.string().min(3).max(500) }).strict(),
  handler: async (ctx, p) => {
    const run = await db.payrollRun.findFirst({ where: { id: p.runId, vendorId: ctx.vendorId } })
    if (!run) throw new Deny("Payroll run not found", 404)
    if (run.status === "CANCELLED") throw new Deny("Run is already cancelled", 400)
    if (run.status === "PROCESSING") throw new Deny("This run is being paid right now — wait for the payment to finish, then cancel it.", 409)

    // ---- tombstone sequence: allocated BEFORE the ledger transaction (a
    // failed statement inside a PG interactive tx aborts it — same pattern as
    // createAdjustmentRun's counter allocation). M-7 atomic single-statement
    // upsert: the create branch seeds at 1, the update branch increments —
    // neither branch can log a caught P2025/P2002 as a scary `prisma:error`.
    let tombSeq = 0
    if (run.runType === "REGULAR") {
      const tombKey = `cancel:${ctx.vendorId}:${run.periodYear}-${run.periodMonth}-${run.periodWeek ?? 0}`
      const tombCounter = await db.sequenceCounter.upsert({
        where: { key: tombKey },
        update: { value: { increment: 1 } },
        create: { key: tombKey, value: 1 },
        select: { value: true },
      })
      tombSeq = tombCounter.value
    }

    // ---- reversal journal (PAID runs only) — R2b-004: moved INSIDE the ledger
    // $transaction so the journal and the run status change are atomic.
    // If the journal post fails, the run stays unchanged (no partial state).
    let reversalJournalId: string | null = null

    // ---- ledger reversal + payslip clear + tombstone (one transaction) -----
    const reversal = await db.$transaction(async (tx) => {
      // R2b-004: PAID reversal journal posted INSIDE the transaction — atomic with run status change
      if (run.status === "PAID") {
        if (run.payoutConfirmedAt) throw new Deny("The payout for this run was already confirmed. Reverse the payout journal from your books before cancelling.", 400)
        if (!run.journalId) throw new Deny("Run is PAID but has no journal to reverse — contact support", 400)
        const original = await tx.accountJournal.findFirst({ where: { id: run.journalId, vendorId: ctx.vendorId } })
        if (!original) throw new Deny("Original payroll journal not found — cannot reverse", 404)
        const originalLines = JSON.parse(original.linesJson || "[]") as { account: string; accountName: string; debit?: number; credit?: number }[]
        const flipped = originalLines
          .map((l) => ({ account: l.account, accountName: l.accountName, debit: l.credit, credit: l.debit }))
          .filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0)
        const { postJournal } = await import("../accounting")
        reversalJournalId = await postJournal(ctx, "PAYROLL_REVERSAL", run.id, new Date().toISOString().slice(0, 10),
          `REVERSAL — Payroll ${monthName(run.periodMonth)} ${run.periodYear} cancelled: ${p.reason}`,
          flipped, Math.abs(original.amount), { idempotencyKey: `PAYROLL_REVERSAL:${run.id}` })
      }

      // conditional claim: only the status we validated still holds
      const claim = await tx.payrollRun.updateMany({
        where: { id: run.id, vendorId: ctx.vendorId, status: run.status },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      })
      if (claim.count === 0) throw new Deny(`Run status changed while cancelling (now ${(await tx.payrollRun.findUnique({ where: { id: run.id } }))?.status}) — refresh and retry`, 409)

      const entries = await tx.payrollEntry.findMany({ where: { runId: run.id, status: { in: ["INCLUDED", "ADJUSTED"] } } })
      let loansReverted = 0, advancesReverted = 0
      for (const e of entries) {
        // 1. precise loan/advance reversal from the pay-time recovery record
        const rec = JSON.parse(e.recoveryJson || "null") as
          | { loan: { installmentId: string; amount: number }[]; advance: { advanceId: string; amount: number }[]; leave?: { balanceId: string; days: number; leaveTypeId?: string }[] }
          | null
        if (rec?.loan?.length) {
          for (const lr of rec.loan) {
            const inst = await tx.loanInstallment.findUnique({ where: { id: lr.installmentId } })
            if (!inst) continue
            const newPaid = Math.max(0, inst.paidAmount - lr.amount)
            await tx.loanInstallment.update({
              where: { id: inst.id },
              data: {
                paidAmount: newPaid,
                status: newPaid <= 0 ? "PENDING" : newPaid >= inst.amount ? "PAID" : "PARTIAL",
                paidAt: newPaid > 0 ? inst.paidAt : null,
                payrollEntryId: newPaid > 0 ? inst.payrollEntryId : null,
              },
            })
            // the owning loan follows the installment back
            const loan = await tx.loan.findUnique({ where: { id: inst.loanId } })
            if (loan) {
              const newLoanPaid = Math.max(0, loan.paidAmount - lr.amount)
              const outstanding = Math.max(0, loan.principal - newLoanPaid)
              await tx.loan.update({
                where: { id: loan.id },
                data: { paidAmount: newLoanPaid, outstanding, status: outstanding > 0 ? "ACTIVE" : loan.status },
              })
            }
            loansReverted++
          }
        } else if (e.loanDeduction > 0) {
          // legacy row paid before recoveryJson existed: best-effort reversal
          // via the payrollEntryId link (exact amounts unavailable)
          const insts = await tx.loanInstallment.findMany({ where: { payrollEntryId: e.id } })
          for (const inst of insts) {
            await tx.loanInstallment.update({
              where: { id: inst.id },
              data: { paidAmount: 0, status: "PENDING", paidAt: null, payrollEntryId: null },
            })
            const loan = await tx.loan.findUnique({ where: { id: inst.loanId } })
            if (loan) {
              const outstanding = Math.min(loan.principal, loan.outstanding + inst.paidAmount)
              await tx.loan.update({
                where: { id: loan.id },
                data: { paidAmount: Math.max(0, loan.paidAmount - inst.paidAmount), outstanding, status: "ACTIVE" },
              })
            }
            loansReverted++
          }
        }
        if (rec?.advance?.length) {
          for (const ar of rec.advance) {
            const adv = await tx.advance.findUnique({ where: { id: ar.advanceId } })
            if (!adv) continue
            const deducted = Math.max(0, adv.deducted - ar.amount)
            const outstanding = Math.min(adv.amount, adv.outstanding + ar.amount)
            await tx.advance.update({
              where: { id: adv.id },
              data: { deducted, outstanding, status: outstanding > 0 ? "RECOVERING" : adv.status },
            })
            advancesReverted++
          }
        } else if (e.advanceDeduction > 0) {
          // legacy fallback: revert by the entry's advance deduction amount
          const advs = await tx.advance.findMany({ where: { vendorId: ctx.vendorId, employeeId: e.employeeId, status: { in: ["RECOVERED", "RECOVERING"] } } })
          let toRevert = e.advanceDeduction
          for (const adv of advs) {
            if (toRevert <= 0) break
            const back = Math.min(adv.deducted, toRevert)
            toRevert -= back
            const deducted = adv.deducted - back
            const outstanding = Math.min(adv.amount, adv.outstanding + back)
            await tx.advance.update({
              where: { id: adv.id },
              data: { deducted, outstanding, status: outstanding > 0 ? "RECOVERING" : adv.status },
            })
            advancesReverted++
          }
        }
        if (rec?.leave?.length) {
          for (const lr of rec.leave) {
            const bal = await tx.leaveBalance.findUnique({ where: { id: lr.balanceId } })
            if (bal) {
              const newUsed = Math.max(0, bal.used - lr.days)
              await tx.leaveBalance.update({
                where: { id: bal.id },
                data: { used: newUsed },
              })
            }
          }
        }

        // 2. bonuses → back to APPROVED; deductions → back to ACTIVE.
        // PAY-008 (R3-2) — partially-disbursed bonuses (IN_PAYROLL) revert too,
        // so the cancelled run's fraction is re-payable by the re-created run.
        await tx.bonus.updateMany({
          where: { vendorId: ctx.vendorId, runId: run.id, status: { in: ["PAID", "IN_PAYROLL"] } },
          data: { status: "APPROVED", runId: null },
        })
        await tx.deduction.updateMany({
          where: { vendorId: ctx.vendorId, employeeId: e.employeeId, month: run.periodMonth, year: run.periodYear, status: "PAID" },
          data: { status: "ACTIVE" },
        })

        // 3. PF ledger rows for this run
        await tx.pfContribution.deleteMany({ where: { vendorId: ctx.vendorId, runId: run.id, source: "PAYROLL" } })

        // 4. clear payslip numbers → frees the vendor-unique payslip space so
        // a re-created run can mint fresh numbers without P2002
        await tx.payrollEntry.update({
          where: { id: e.id },
          data: { payslipNumber: null, emailStatus: null, recoveryJson: null },
        })
      }

      // 5. tombstone the cancelled run out of the (vendor, period, week,
      //    runType, adjustSeq) unique slot so the month can be re-created.
      //    Negative values never collide with REGULAR (0) or ADJUSTMENT (1..n).
      //    The counter itself is allocated OUTSIDE this transaction (above) —
      //    a failed UPDATE inside a PG transaction aborts the whole tx.
      if (tombSeq > 0) {
        await tx.payrollRun.update({ where: { id: run.id }, data: { adjustSeq: -tombSeq } })
      }
      return { loansReverted, advancesReverted }
    }, { timeout: 60_000, maxWait: 10_000 })

    await audit(ctx, "payroll.runs.cancel", "PayrollRun", run.id,
      `Cancelled ${run.status} run ${monthName(run.periodMonth)} ${run.periodYear}${reversalJournalId ? ` — reversal journal ${reversalJournalId} posted` : " (no journal posted)"}. ` +
      `Ledger side effects reverted: ${reversal.loansReverted} loan installment(s), ${reversal.advancesReverted} advance(s); payslips voided. ` +
      `The month can now be re-created. Reason: ${p.reason}`,
      { newValue: { status: "CANCELLED", reversalJournalId, ...reversal } })
    return { ok: true, status: "CANCELLED", reversalJournalId, ...reversal, monthCanBeRecreated: true }
  },
})
