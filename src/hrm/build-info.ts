// ============ App build tag — visible version marker ============
// Shown in the sidebar footer and the main footer so anyone can verify IN ONE
// GLANCE which code the running server actually serves. If the tag you see in
// the browser does not match this file, the server is running a stale copy of
// the project (wrong folder, un-rebuilt production bundle, or an old dev
// process) — NOT a bug in the code.
//
// Bump this on every delivery round.
export const APP_BUILD = "r9 · 16 Oct 2026"

// Feature markers of this round (for support conversations):
// - r8: AIT / Income Tax LEGAL AUDIT — every rule re-verified against the NBR
//       consolidated Income Tax Act 2023 (amendments to 16 June 2025), KPMG's
//       "Salient Features of Finance Ordinance 2025" and PwC's FY 2026/27
//       individual rates table. Corrections: §78 rebate now = LOWER OF 3% of
//       taxable income / 15% (10% from IY 2026-27) of eligible investment /
//       ৳10,00,000 (৳7,50,000 from IY 2026-27) · thresholds corrected to the
//       ENACTED Finance Ordinance 2025 figures for IY 2025-26 (general
//       ৳3,75,000 · women/senior ৳4,25,000 · third-gender/disabled
//       ৳5,00,000 · FF/July Warriors ৳5,25,000) and Finance Act 2026 for IY
//       2026-27 (general ৳4,00,000 · women/senior ৳4,50,000 · third/disabled
//       ৳5,25,000 · FF ৳5,50,000) — both years ship as versioned configs and
//       the year containing today is ACTIVE · payroll TDS rebuilt on §86(1)+
//       (4): the annual estimate is built from FY-to-date PAID actuals +
//       projection (a bonus now lands ONCE, never ×12) and each month's
//       deduction carries the statutory surplus/deficit catch-up ·
//       minimum-tax floor tested AFTER rebate with the corrected citation
//       (annual Finance Act, §163 framework — the old "§164" cite was wrong)
//       · net-wealth surcharge (10–35% bands + motor-car trigger) computed
//       on the annual tax with missing-info warnings · female threshold
//       auto-applied from the employee gender (with verify warning) ·
//       non-resident flat 30% · assessment-year labels fixed (§2(15)/(24)) ·
//       every payroll AIT computation journaled with its config snapshot
//       (AitCalculationLog kind=PAYROLL) · 20-scenario legal test suite.
// - r7: Loan & Advance guarantor fallback — a borrower with no payable salary
//       in a period has the monthly loan/advance installment recovered from
//       the designated GUARANTOR's salary (capped at a % of net, cumulative),
//       with a new "Loan & Advance Control" tab under Payroll (recovery plan,
//       per-guarantor exposure, fallback on/off + cap) · AIT now renders
//       EXACTLY ONCE in the payslip breakdown dialog (double-display fix) ·
//       "Attendance & Shifts" split into Attendance + Shifts menus; Field &
//       Security and Devices promoted to top-level menus · TIN (e-TIN) field
//       on the Employee create form, edit dialog and 360° profile header ·
//       Employee Directory: full status filter chips (incl. the previously
//       missing INACTIVE/SUSPENDED/RETIRED) · Employee Actions quick links on
//       the 360° profile (Leave History, Payslips, Performance, Loans &
//       Advances, Attendance register, Location Hit Map — every target
//       pre-filters on the employee)
// - r6: Field Force Reports → Employee per-row "View Location Hit Map" (date
//       chooser + day replay) · rich multi-day seed GPS trails (routes with
//       dwell stops + matching visits + unplanned stoppages)
// - r5: visible build tag · universal dialog click guard (modal-integrity)
// - r4: deployment guide only (no code changes)
// - r3: unit-test DB bootstrap (tests/preload.ts candidate probing)
// - r2: payroll BigInt (INT4 overflow) · DataTable row-click portal guard ·
//       notification read scope · canonical weekly-off precedence ·
//       Field Force History tab + Location Hit Map + plan-editor map picker
// - r1: ChunkLoadError / dev-origins / self-healing chunk recovery
