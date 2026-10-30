# CHANGES — 2026-10-23 · Remediation Phases R5–R7 (audit roadmap completion)

**Source:** `Finix_HR_Complete_Code_Audit_and_Tenant_Side_Upgrade_Roadmap.pdf`
(2026-10-22, 158 findings) — this delivery completes the seven-phase
remediation program: **R5 security & isolation hardening, R6 performance &
scale, R7 feature gaps (product parity)** on top of the R1–R4 tree.

**Verification (this build):** full **14-stage** CI gate **EXIT 0** —
1,586/1,586 unit tests (1,531 R1–R4 baseline + 21 R5 + 13 R6 + 21 R7) +
6 perf budgets green + **7 E2E HTTP journeys green (new stage 14)**, zero
schema drift (5 migrations: 9_wave9zk/zl/zm/zn/zo), fresh-DB migration smoke
green, `bun run build` EXIT 0, tsc/eslint clean, permission registry lint
green with 8 new annotated self-scoped actions.

---

## Phase R5 — security & isolation hardening (11 findings) · commit `d06c83d`

| ID | Fix | Files |
|----|-----|-------|
| DB-02 | `vendorId` NOT NULL on all 15 child models (backfill verified on real data) + structural uniques (ApprovalStep/LoanInstallment/TaxSlab) + tenant-scoped indexes; ~120 create sites swept typecheck-enforced | migration `9_wave9zl`, schema.prisma, all route files |
| SEC-02 | Session tokens hashed at rest on BOTH planes (tokenHash column, backfilled so every session resolves through the hash immediately — no dual-read window); leaked row-id replay rejected | migration `9_wave9zm`, auth.ts, saas/* |
| SEC-01 | `mayMintTokensFor` resolves the role TEMPLATE (empty grants → custom DB Role → static template) — BRANCH_MANAGER no longer self-mints; v1 user tokens carry the manager's org scope | rbac.ts, api/v1/_tokens.ts |
| API-01 | v1 password grant: failure-only per-IP throttle (10/5min), login-audit rows for every outcome, trust-gated XFF (`resolveClientIp`) | api/v1/_tokens.ts, login-audit.ts |
| PRC-01 | All procurement decorator fetches vendor-scoped | procurement.ts |
| COM-01 | announcements.list audience-filtered for EMPLOYEE viewers | communication.ts |
| COM-03 | Calendar self-scope: EMPLOYEE viewers see sensitive per-person events only for themselves | calendar.ts |
| PAY-05 | salaryStructures.list + payroll.entries honor `scopedEmployeeWhere` | payroll.ts |
| EMP-04 | e-TIN → identity field group (mask=last-4); the dead `_EMPLOYEE_SELECT` revived as the directory select (taxTin/payout-config never ship on list rows) | employees.ts |
| EMP-10 | `employees.purge` verb split from soft archive (typed employee-code confirm; admin templates + client gate) | employees.ts, admin.ts, employees.tsx |
| ATT-019 | devices.sync status from the sweep outcome (failed → OFFLINE) | attendance.ts |

## Phase R6 — performance & scale (10 findings) · commit `dc3b52f`

| ID | Fix | Files |
|----|-----|-------|
| PAY-08 | payslips.list optional MOD-16 pagination + page-scoped decoration; ESS payslips capped at 60 newest | payroll.ts, ess.ts |
| ACC-01 | SQL-side statement aggregation — `jsonb_to_recordset` line projection with exact paisa ROUND parity; **the 20,000-row ceiling is gone**; cash-flow machinery + budget actuals SQL-side (memoised) | accounting.ts |
| ACC-03 | Stats block as SQL FILTER aggregates incl. the unbalanced-invariant monitor | accounting.ts |
| COM-06 | Calendar leave-type lookup + loan installments batched (was N+1 each) | calendar.ts |
| LVE-121 | Branch-scoped holidays (branch-specific only for that branch) + vendor-scoped encash read | calendar.ts, leave.ts |
| ESS-07 | ess.profile ships the 96×96 thumbnail; expenses/tasks capped at 200; picker directory bounded at 1000 | ess.ts |
| EMP-12 | `lookups.employees` dropped from employees.get; pickers read the CACHED `useEmployeeDirectory` refList | employees.ts, dialogs, employees.tsx |
| EMP-13 | Trigram GIN indexes on mobile/altMobile/officialEmail/personalEmail | migration `9_wave9zn` |
| COM-04 | `notificationRetentionSweep` (settings-driven, 0=keep-forever) wired into dailyJobs; unread badge capped at the list's 100 with the true total riding along | jobs.ts, communication.ts, settings.ts |
| DB-06 | `apiRefreshTokenPurge` (expired + stale-revoked) + expiresAt index | jobs.ts, migration `9_wave9zn` |

## Phase R7 — feature gaps / product parity (15 findings) · this commit

| ID | Fix | Files |
|----|-----|-------|
| ESS-02 | Self-service profile edit: whitelisted photo/phones/personal email/present address/emergency contact (server-enforced whitelist; smuggled HR-only fields dropped; audited + HR notified) | routes/ess.ts, ess.tsx (new **My Profile** tab + header button) |
| ESS-05 | Review acknowledgment: SUBMITTED → ACKNOWLEDGED with the employee's own comments; ess.performance widened to SUBMITTED/ACKNOWLEDGED/FINAL (DRAFT stays hidden) | routes/performance.ts, ess.tsx |
| ESS-06 | **My Assets** tab: own assignments with outstanding/overdue flags | routes/ess.ts, ess.tsx |
| LTR-01 | ESS letter requests (salary certificate / experience / employment cert / NOC): employees request, HR approves (draft letter generated from the active template, variables rendered) or rejects with a note | routes/letters.ts, documents.tsx (Requests tab), ess.tsx |
| LTR-02 | Letter verification codes: HMAC-derived, minted at issue, printed on the letter + verification footer; **public** verification page `/verify/letter` + rate-limited API (no login; invalid codes reveal nothing) | letters.ts, app/verify/letter, app/api/verify/letter |
| COM-02 | Announcement read receipts: `AnnouncementRead` table; employees get a notice board in the ESS inbox (open = read); HR gets per-notice read progress strips (readCount/audienceSize) | migration `9_wave9zo`, communication.ts, announcements.tsx, ess.tsx |
| EMP-08 | Probation workflow: **calendar-month** end-date math (the old ×30-day drift), `employees.probation` CONFIRM/EXTEND actions, daily 7-day-out + due-date HR reminders | utils.ts, employees.ts, jobs.ts, calendar.ts, employees.tsx (Lifecycle menu) |
| EXT-04 | Printable **Full & Final statement** (`settlements.html`, HR + own APPROVED/PAID); exit packet fixed — the old `EXPERIENCE_CERTIFICATE`/`RELIEVING_LETTER` type strings matched no template and minted empty letters; now the vocabulary types render real content | exit.ts, roadmap.ts, exit.tsx (Print F&F + Exit Packet buttons), ess.tsx |
| EXT-05 | Rehire linkage: `Employee.priorEmployeeId` + `employees.rehireMatches` (mobile/email/name+DOB/NID via PII-encrypted identity docs); create-dialog detection banner; 360° prior-service banner | employees.ts, schema.prisma, employee-create-dialog.tsx, employees.tsx |
| LVE-112 | Leave approval SLA + auto-cancel: `leave.approvalSlaDays` (HR + requester nudges) and `leave.autoCancelPendingDays` (system cancel releases the reserved balance with the manual path's guarded decrements); Settings UI | jobs.ts (leaveSlaSweep), settings.ts, settings.tsx |
| LVE-113 | BD-compliant seeded policy at all three definition sites (seed/seed-owner/provision): encashment on ANNUAL only, SICK requires a medical certificate, CASUAL 3-day consecutive cap (enforced on apply, adjacent requests stitched), the EARNED duplicate removed, BD fixed-date holiday template for fresh vendors | seed.ts, seed-owner.ts, saas/provision.ts, leave.ts, migration `9_wave9zo` |
| REC-01 | **My Interviews** tab for named interviewers (self-scoped, candidate contacts masked); candidate email/phone masked in applications.list for viewers without recruitment.edit | ats.ts, recruitment.ts, ess.tsx |
| PRF-01 | Multi-reviewer input: self-assessment from ESS (`inputsJson.self`, manager ratings untouched) + HR-recorded peer inputs (`inputsJson.peers`); review dialog renders self/peer panels with peer averages | performance.ts, schema.prisma, performance.tsx, ess.tsx |
| ATT-017 | `ATTENDANCE_RULES` policy type: per-group late-grace / early-leave / half-day / daily-OT overrides (standard assignment precedence EMPLOYEE > DEPARTMENT > BRANCH > ALL); policy fields override the SHIFT defaults too; typed zod config + settings form | attendance-policy.ts, attendance.ts, tracking.ts, validation.ts, attendance-policies.tsx |
| TEST-01 | **E2E lane (CI stage 14)**: HTTP-level journeys against the real app on a scratch database — login/CSRF, auth.me, ESS profile, leave apply → approval, payroll create → calculate → SoD owner-approval → pay → ESS payslip | scripts/e2e.sh, tests/e2e/*, scripts/ci.sh |

## UI/UX modernization (R7 surfaces)

- ESS portal: **three new tabs** (My Profile / My Assets / My Interviews) in
  the existing emerald/teal design language — gradient CTA buttons, stat
  cards, notice-board cards with unread gradient states, modern empty states.
- HR Letters: a dedicated **Requests** queue tab (pending-first chips,
  inline approve/reject with notes) + verification-code column on issued
  letters.
- Announcements: per-notice read-progress strips (gradient progress bar).
- Exit management: **Print F&F Statement** + **Exit Packet** actions.
- Employees: probation Confirm/Extend in the Lifecycle menu; rehire detection
  banner (radio-linked candidates) in the create wizard; prior-service banner
  on the 360° profile.
- Public **/verify/letter** page: standalone gradient verification card with
  valid/invalid result states (no login required).

## Schema (additive only)

- `9_wave9zl` — vendorId on 15 child models (backfill) + structural uniques
- `9_wave9zm` — session tokenHash (both planes, backfilled)
- `9_wave9zn` — trigram indexes (mobile/emails) + ApiRefreshToken.expiresAt index
- `9_wave9zo` — AnnouncementRead, LetterRequest, Employee.priorEmployeeId,
  LeaveType.maxConsecutiveDays, PerformanceReview.inputsJson,
  HrLetter.verificationCode

## Test ledger

| Phase | File | Tests |
|-------|------|-------|
| R5 | tests/unit/phase-r5-security-isolation.test.ts | 21 |
| R6 | tests/unit/phase-r6-performance-scale.test.ts | 13 |
| R7 | tests/unit/phase-r7-feature-parity.test.ts | 21 |
| R7 (E2E) | tests/e2e/journeys.test.ts | 7 |

Deliberate assertion updates: saas-layer provisioning leave-type count 8 → 7
and verify-owner-seed 8 → 7 (LVE-113 removed the EARNED duplicate — the
expected seeded policy changed, not the check's strength).
