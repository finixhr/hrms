/// <reference types="bun-types" />
// ============ AUDIT M-11 (2026-11-07) — mutating ⇒ zod schema ratchet ============
// The 2026-11-07 security audit (finding M-11) found payload schema coverage
// to be partial: only ~213 of 597 tenant actions declared a zod `schema`, and
// every other action received `payload: any`, validated ad hoc inside the
// handler. The recommended short-term enforcement is a REGISTRY TEST: every
// MUTATING action must declare `def.schema` (the dispatcher validates and
// whitelists the payload BEFORE the handler runs — M-01), so an untyped
// payload can never reach a write path.
//
// THE CLASSIFIER is deliberately a NAME HEURISTIC (not def.mutating — that
// flag only exists for the read-only-lockout override and defaults to
// undefined on most routes): an action is MUTATING when its head (the part
// after the last dot) CONTAINS one of the audit's verb stems, matched
// case-insensitively:
//   save create update delete remove cancel approve reject pay process enable
//   disable import assign mark bulkMark reset rotate revoke grant submit post
//   unpost adjust transfer respond change set add write upload send issue
//   return close reopen suspend activate deactivate verify
// The classifier is intentionally dumb and OVER-approximates — known false
// positives that are pure READS whose heads merely CONTAIN a verb substring
// are absorbed in the baseline below (documented): "pay" ⊂ payroll/payslip/
// paymentInstructions (reports.payroll*, ess.payroll, billing.paymentInstruc-
// tions), "set" ⊂ asset/myAssets (ess.myAssets, reports.assetAssignments*),
// "write" ⊂ rewrites (reports.paidPeriodRewrites*), "import" ⊂ importPreview
// (commissionRules.importPreview). The baseline absorbs whatever the
// heuristic yields; the test's job is the RATCHET, not perfection. A future
// cleanup may add a read-exception list — do not silently tighten the verbs.
//
// ENUMERATION SCOPE:
//   • T-20 aliases (routeAliases) are EXCLUDED — alias() shares the
//     canonical's RouteDef object by construction (registry.ts), so an alias
//     can never drift from its canonical's schema coverage;
//   • PUBLIC actions are INCLUDED — the 4 public auth flows in the baseline
//     (auth.mfa.verify, auth.mfa.enroll.enable, auth.resetPassword,
//     auth.password.change) validate ad hoc with capability tokens, which is
//     exactly M-11's concern; when they gain schemas they drop out.
//
// THE RATCHET: the live set of mutating actions WITHOUT def.schema must
// EQUAL the sorted BASELINE below. A NEW mutating action without a schema
// FAILS this test until a schema is added (preferred) or the baseline is
// consciously extended with a justification. An action that GAINS a schema
// also fails until its baseline entry is removed — both directions require
// a human, so the gap only ever shrinks on purpose.
//
// COVERAGE as of 2026-11-07 (this remediation's starting line):
//   mutating actions (canonical, incl. public): 259
//   … WITH schema: 82   … WITHOUT: 177   coverage: 31.7%
// The percentage is recomputed and printed on every run — the summary test
// below surfaces it so regressions/improvements are visible in CI logs.
import { describe, test, expect } from "bun:test"
import "@/hrm-server/routes/router" // side-effect import — registers every action
import { routes, routeAliases } from "@/hrm-server/routes/registry"

const MUTATING_VERB_STEMS: readonly string[] = [
  "save", "create", "update", "delete", "remove", "cancel", "approve", "reject",
  "pay", "process", "enable", "disable", "import", "assign", "mark", "bulkmark",
  "reset", "rotate", "revoke", "grant", "submit", "post", "unpost", "adjust",
  "transfer", "respond", "change", "set", "add", "write", "upload", "send",
  "issue", "return", "close", "reopen", "suspend", "activate", "deactivate",
  "verify",
]

function isMutatingByHead(action: string): boolean {
  const head = (action.split(".").pop() || action).toLowerCase()
  return MUTATING_VERB_STEMS.some((v) => head.includes(v))
}

const canonicalActions = Object.keys(routes).filter((a) => !routeAliases[a]).sort()
const mutatingActions = canonicalActions.filter(isMutatingByHead)
const withSchema = mutatingActions.filter((a) => !!routes[a]?.schema)
const withoutSchema = mutatingActions.filter((a) => !routes[a]?.schema).sort()

// ----------------------------------------------------------------------------
// BASELINE (2026-11-07) — the 177 mutating actions WITHOUT def.schema, the
// audit's M-11 gap. Sorted, grouped by module prefix for review ergonomics.
// Shrinking it is always welcome (add `schema: z.object({...})` to the def);
// extending it requires a justification comment on the new entry.
// ----------------------------------------------------------------------------
const BASELINE_MUTATING_WITHOUT_SCHEMA: readonly string[] = [
  // --- ait ---
  "ait.calc.save",
  "ait.categories.save",
  "ait.employee.save",
  "ait.fiscalYears.activate",
  "ait.fiscalYears.save",
  "ait.slabs.save",
  // --- announcements ---
  "announcements.create",
  "announcements.delete",
  // --- attendance ---
  "attendance.otApprove",
  "attendance.reprocess",
  // --- auth (public pre-auth flows — ad-hoc/capability-token validation) ---
  "auth.mfa.disable",
  "auth.mfa.enable",
  "auth.mfa.enroll.enable",
  "auth.mfa.verify",
  "auth.password.change",
  "auth.resetPassword",
  // --- billing (READ misclassified: "pay" ⊂ paymentInstructions) ---
  "billing.paymentInstructions",
  // --- bonuses ---
  "bonuses.approve",
  "bonuses.create",
  "bonuses.createBulk",
  "bonuses.savePolicy",
  // --- branches ---
  "branches.create",
  "branches.delete",
  "branches.update",
  // --- camera ---
  "camera.create",
  "camera.credential.delete",
  "camera.delete",
  "camera.setStatus",
  "camera.update",
  // --- clearance ---
  "clearance.save",
  // --- commissionRules (importPreview is a dry-run READ: "import" ⊂ head) ---
  "commissionRules.delete",
  "commissionRules.importDecide",
  "commissionRules.importPreview",
  "commissionRules.importSubmit",
  // --- communications ---
  "communications.send",
  // --- cycles ---
  "cycles.save",
  // --- deductions ---
  "deductions.delete",
  "deductions.save",
  // --- delegations ---
  "delegations.save",
  // --- departments ---
  "departments.create",
  "departments.delete",
  "departments.update",
  // --- designations ---
  "designations.create",
  "designations.delete",
  "designations.update",
  // --- devices ---
  "devices.delete",
  "devices.hardDelete",
  "devices.reprocess",
  "devices.save",
  "devices.setCommKey",
  "devices.setEnabled",
  // --- employees ---
  "employees.activate",
  "employees.banks.create",
  "employees.banks.delete",
  "employees.banks.update",
  "employees.banks.verify",
  "employees.changeShift",
  "employees.delete",
  "employees.docs.create",
  "employees.docs.delete",
  "employees.docs.update",
  "employees.docs.verify",
  "employees.education.create",
  "employees.education.delete",
  "employees.education.update",
  "employees.family.create",
  "employees.family.delete",
  "employees.family.update",
  "employees.hardDelete",
  "employees.prevEmployment.create",
  "employees.prevEmployment.delete",
  "employees.prevEmployment.update",
  "employees.references.create",
  "employees.references.delete",
  "employees.references.update",
  "employees.resetPassword",
  "employees.suspend",
  "employees.updatePhoto",
  // --- ess (myAssets/payroll are READs misclassified by "set"/"pay" ⊂ head) ---
  "ess.myAssets",
  "ess.payroll",
  "ess.profile.update",
  // --- events ---
  "events.create",
  "events.delete",
  // --- expenses ---
  "expenses.create",
  // --- holidays ---
  "holidays.bulkCreate",
  "holidays.create",
  "holidays.delete",
  // --- inventory ---
  "inventory.categories.delete",
  "inventory.categories.save",
  "inventory.items.delete",
  "inventory.items.save",
  "inventory.masterRequest.create",
  "inventory.stock.adjust",
  "inventory.stock.entries.post",
  "inventory.stock.entries.save",
  "inventory.stock.transfer",
  "inventory.suppliers.save",
  "inventory.units.delete",
  "inventory.units.save",
  "inventory.warehouses.save",
  // --- kpiAssignments ---
  "kpiAssignments.assign",
  "kpiAssignments.submitResults",
  // --- kpiTemplates ---
  "kpiTemplates.delete",
  "kpiTemplates.save",
  // --- leaveRequests ---
  "leaveRequests.cancel",
  "leaveRequests.substitute.change",
  "leaveRequests.substitute.respond",
  // --- leaveTypes ---
  "leaveTypes.save",
  // --- letters ---
  "letters.issue",
  "letters.submit",
  // --- lifecycle ---
  "lifecycle.transfer",
  // --- loans ---
  "loans.guarantorRespond",
  // --- orgChart ---
  "orgChart.assignDesignationDepartment",
  "orgChart.batchSetReporting",
  "orgChart.desigChart.saveHierarchy",
  "orgChart.reassignEmployee",
  "orgChart.saveLayout",
  "orgChart.setReportingManager",
  // --- overtime ---
  "overtime.submit",
  // --- payroll ---
  "payroll.adjustmentCreate",
  "payroll.pay",
  // --- pf ---
  "pf.contribution.add",
  "pf.setStatus",
  // --- purchase / purchases (legacy + current spellings) ---
  "purchase.cancel",
  "purchase.create",
  "purchase.quotations.add",
  "purchase.submit",
  "purchases.cancel",
  "purchases.create",
  "purchases.quotations.add",
  "purchases.submit",
  // --- reimbursements ---
  "reimbursements.mark",
  // --- reports (READs misclassified: "pay" ⊂ payroll/payslip, "set" ⊂
  //     assetAssignments, "write" ⊂ paidPeriodRewrites) ---
  "reports.assetAssignments",
  "reports.assetAssignmentsCsv",
  "reports.paidPeriodRewrites",
  "reports.paidPeriodRewritesCsv",
  "reports.payroll",
  "reports.payrollBranch",
  "reports.payrollBranchCsv",
  "reports.payrollCsv",
  "reports.payrollDeductions",
  "reports.payrollDeductionsCsv",
  "reports.payrollDepartment",
  "reports.payrollDepartmentCsv",
  "reports.payslipDistribution",
  "reports.payslipDistributionCsv",
  // --- requisitions ---
  "requisitions.cancel",
  "requisitions.create",
  "requisitions.issue",
  "requisitions.submit",
  "requisitions.update",
  // --- resignations ---
  "resignations.submit",
  // --- reviews ---
  "reviews.save",
  // --- roles ---
  "roles.delete",
  "roles.save",
  // --- rosters ---
  "rosters.assign",
  "rosters.delete",
  // --- salaryStructures ---
  "salaryStructures.save",
  // --- salaryTemplates ---
  "salaryTemplates.delete",
  "salaryTemplates.save",
  // --- sessions ---
  "sessions.revoke",
  "sessions.revokeAllForUser",
  // --- settings ---
  "settings.save",
  // --- settlements ---
  "settlements.approve",
  "settlements.pay",
  // --- shifts ---
  "shifts.create",
  "shifts.delete",
  "shifts.update",
  // --- tasks ---
  "tasks.delete",
  // --- taxExemptions ---
  "taxExemptions.delete",
  "taxExemptions.save",
  // --- taxRules ---
  "taxRules.save",
  // --- templates ---
  "templates.delete",
  "templates.save",
  // --- users ---
  "users.delete",
  "users.save",
  // --- workflows ---
  "workflows.save",
]

const baselineSet = new Set(BASELINE_MUTATING_WITHOUT_SCHEMA)

describe("AUDIT M-11 — mutating ⇒ schema ratchet", () => {
  test("the registry is fully populated (router side-effect import worked)", () => {
    expect(canonicalActions.length).toBeGreaterThan(700) // 733 canonical on 2026-11-07 (775 incl. 42 aliases)
    expect(mutatingActions.length).toBeGreaterThan(200) // 259 on 2026-11-07
  })

  test("coverage summary is printed for the reviewer (baseline 82/259 = 31.7% on 2026-11-07)", () => {
    const pct = mutatingActions.length
      ? ((withSchema.length / mutatingActions.length) * 100).toFixed(1)
      : "0.0"
    console.log(
      `[M-11] mutating=${mutatingActions.length} with-schema=${withSchema.length} ` +
      `without-schema=${withoutSchema.length} coverage=${pct}%`,
    )
    // sanity: the summary must reflect a real partition (every mutating
    // action is in exactly one bucket, and the live gap matches a baseline
    // that was recorded from this same computation)
    expect(withSchema.length + withoutSchema.length).toBe(mutatingActions.length)
    expect(Number(pct)).toBeGreaterThan(0)
    expect(Number(pct)).toBeLessThan(100)
  })

  test("the live set of mutating actions WITHOUT schema equals the baseline exactly", () => {
    const added = withoutSchema.filter((a) => !baselineSet.has(a))
    const removed = BASELINE_MUTATING_WITHOUT_SCHEMA.filter((a) => !withoutSchema.includes(a))
    const lines: string[] = []
    if (added.length) {
      lines.push(
        `NEW mutating action(s) WITHOUT def.schema (AUDIT M-11 ratchet):`,
        ...added.map((a) => `  - ${a}: add a zod schema to its route() def (preferred), rename the head if it is a pure read misclassified by the verb heuristic, or extend the baseline with a justification`),
      )
    }
    if (removed.length) {
      lines.push(
        `baseline entr(ies) that now HAVE a schema (or disappeared) — remove them from BASELINE_MUTATING_WITHOUT_SCHEMA:`,
        ...removed.map((a) => `  - ${a}`),
      )
    }
    const msg = lines.length ? lines.join("\n") + "\n" : ""
    expect(msg).toBe("")
  })

  test("the baseline is internally consistent (sorted, unique, all still registered mutating actions)", () => {
    const sorted = [...BASELINE_MUTATING_WITHOUT_SCHEMA].sort()
    const dupes = BASELINE_MUTATING_WITHOUT_SCHEMA.filter((a, i) => BASELINE_MUTATING_WITHOUT_SCHEMA.indexOf(a) !== i)
    const unregistered = BASELINE_MUTATING_WITHOUT_SCHEMA.filter((a) => !routes[a])
    const notMutating = BASELINE_MUTATING_WITHOUT_SCHEMA.filter((a) => routes[a] && !isMutatingByHead(a))
    const problems = [
      ...dupes.map((a) => `  - ${a}: duplicated baseline entry`),
      ...unregistered.map((a) => `  - ${a}: not registered anymore — delete the entry`),
      ...notMutating.map((a) => `  - ${a}: no longer matches the verb heuristic — delete the entry`),
      ...(JSON.stringify(BASELINE_MUTATING_WITHOUT_SCHEMA) !== JSON.stringify(sorted)
        ? ["  - baseline array is not sorted — re-sort it"]
        : []),
    ]
    const msg = problems.length ? `BASELINE_MUTATING_WITHOUT_SCHEMA consistency problems:\n${problems.join("\n")}\n` : ""
    expect(msg).toBe("")
  })
})
