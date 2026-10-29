# RELEASE NOTES — ADMIN (Audit Remediation, October 2026)

Human-facing behavior changes from the Build-5 audit remediation. Each entry tells you what changed in
day-to-day operation. Technical detail lives in `REMEDIATION-TRACKER.md` and the per-finding commits.

## 🚨 Deploying this build? Read this first — P3009 recovery runbook (2026-10-03)

**What happened:** the first shipping of migration `3_audit_remediation_20261002` contained a bug — its
duplicate-payslip renumbering ordered by a column that does not exist (`PayrollEntry."createdAt"`), so
`bunx prisma migrate deploy` failed with **P3009** on every fresh database. This build ships the corrected
migration. If your database already recorded the failure (deploy refused with "migrate found failed
migrations"), run the recovery below — the failed migration applied nothing (PostgreSQL rolled it back
atomically), so nothing needs undoing.

**Recovery — run in this exact order:**

```bash
# 1. Clear the failed-migration record (safe: the migration was rolled back automatically)
bunx prisma migrate resolve --rolled-back 3_audit_remediation_20261002

# 2. See what the database recorded, if anything else fails (self-diagnosis, read-only)
bun run scripts/show-migration-error.ts

# 3. Check whether your Employee data collides with the new identity uniques (read-only)
bun run scripts/check-employee-identity-uniques.ts

# 4. If step 3 reports collisions, clear them (dry-run first, then apply)
bun run scripts/fix-identity-uniques.ts             # dry-run report
bun run scripts/fix-identity-uniques.ts --apply     # earliest employee keeps the value,
                                                   # later duplicates are nulled; every
                                                   # change is written to Employee history

# 5. Deploy — succeeds on clean data
bunx prisma migrate deploy
```

- **Why step 3 can report collisions:** migration 3 deliberately FAILS LOUDLY while two employees of the
  same vendor share an `officialEmail` or `mobile` (that is finding M-6 working as designed — silently
  skipping the unique index would recreate the audit finding). Empty strings count as values too: two
  employees with `mobile = ""` collide; `NULL` is exempt. The fix script normalizes both cases.
- **If `bunx prisma migrate deploy` fails again after step 4**, it left a new failed record — re-run
  step 1 (`migrate resolve --rolled-back 3_audit_remediation_20261002`), read the error with step 2,
  fix what it names, and deploy again.
- The payslip renumbering in the same migration is automatic: historical duplicate payslip numbers get a
  `-R2`, `-R3`… suffix (first occurrence keeps its number verbatim) so the new unique payslip index can
  exist. No operator action is needed for payslips.
- The CI gate now includes a **fresh-database migration smoke** stage (`scripts/migrate-fresh-smoke.ts`)
  so a migration that cannot apply to an empty database can never pass CI again.

## 🔐 Security

### MFA enrollment is now REQUIRED for admin roles (H-1)
- **Who is affected:** every `VENDOR_OWNER` and `HR_ADMIN` user, plus any role whose Role row has
  "MFA required" enabled, who has NOT yet enrolled an authenticator app.
- **What changes:** at the next sign-in, instead of entering the app single-factor, these users land on a
  one-time **"Set up two-factor authentication"** wizard: scan the QR code with Google/Microsoft
  Authenticator (or any TOTP app), enter the 6-digit code, save the 10 recovery codes shown exactly once,
  then continue into the app.
- **Nobody is locked out:** anyone with a valid password can self-enroll — no administrator action needed.
  Users who are already enrolled see no change (they get the usual verification-code step).
- **Already-enrolled accounts cannot be re-enrolled with a password alone** — that path is blocked to
  prevent an attacker replacing a victim's second factor.

### Session security hardening (C-1)
- The short-lived tokens issued during the MFA / expired-password steps are no longer accepted as
  full sign-in credentials anywhere. This closes a bypass of two-factor verification; there is **no
  visible change for legitimate users**.

## ⚙️ Settings

### Self-Service Portal toggles now actually save (H-2)
- **Important:** before this fix, every save on *Settings → Self-Service Portal* failed silently —
  nothing was ever persisted, so **the all-ON defaults were always in effect**, even if the page appeared
  to show your choices.
- **Action required:** re-visit **Settings → Self-Service Portal** and set the quick-action / request-button
  visibility the way you actually want it. Anything you believe you disabled earlier was never saved.
- The same fix makes the settings whitelist derive from the settings schema itself, so no future settings
  tab can ship un-savable again.

## 📟 Attendance & devices

### Hikvision ISAPI events are accepted again (H-3)
- On UTC servers (the standard deployment), the ISAPI receiver was rejecting **every fresh attendance
  event** as "out of window" while telling the device it had been delivered — silent attendance loss.
- **After deployment, expect a one-time volume jump** as devices re-upload previously dropped events
  (duplicate protection makes re-uploads idempotent, so nothing is double-counted). The Sync Monitor's
  OUT_OF_WINDOW counter should fall to near zero and stay there.

### Accidental double geo check-ins no longer corrupt the day (H-4)
- A repeated geo-fence check-in later in the day (double-tap, second phone) used to **overwrite the
  morning check-in and wipe the check-out** — zeroing worked minutes and flagging the employee LATE.
- Now: a same-day re-check-in at or after the original time returns a clear "Already checked in today"
  message and changes nothing; a genuinely EARLIER punch moves the check-in back while preserving the
  check-out. This matches how biometric devices have always behaved.

## 💰 Money

### Multi-loan payroll recovery is capped at the payslip deduction (H-5)
- Employees with **two or more active loans** could have their loan ledgers credited MORE than the
  payslip actually deducted (guaranteed on weekly payroll runs). Loans could close early and outstanding
  balances were understated.
- **Historical data:** `scripts/repair-h5-loan-overrecovery.ts` reconciles past over-recovery. It runs in
  dry-run mode by default (report only); applying it against production requires
  `--apply --allow-production` and is executed by an operator after a backup. Every correction writes an
  employee-history row (`LOAN_ADJUSTMENT`) documenting the change.

### Final settlements pay exactly once (H-6)
- Two concurrent "Pay settlement" actions (double-click, two tabs) could both pay an employee's final
  settlement. Now exactly one payment goes through; the second caller gets a clear "already paid" message.

### Leave encashment targets the requested leave type (H-7)
- Encashment requests must now name the leave type (the API rejects requests without `leaveTypeId`), and
  days are always reserved against that exact type's balance. Previously the system could pick an
  arbitrary type's balance row for an employee with several leave types.

## ✅ Quality gates

- The repository linter is green again (H-14) and the CI workflow file exists in the repository, so the
  documented 8-stage gate actually runs on every push (H-15 — final environment wiring completes with the
  Phase-2 batch).

## 📋 Phase-2 batch (behavior changes for staff)

- **Flagged geo check-ins now leave a review trail (M-15):** an employee inside the geo-fence
  whose GPS accuracy cannot be verified is still denied (as before), but the attempt now
  records a **REVIEW_REQUIRED** event with the fence, distance and reason, plus an audit row —
  security staff can find these under attendance security events instead of the attempt
  vanishing without a trace.
- **Selfie uploads are rate-limited (M-14):** at most 12 selfie-proofs per employee per 10
  minutes on geo check-in/out; the 13th within the window returns a "retry in Ns" message.
- **Geo check-in/out requests are strictly validated (M-14):** coordinates are required and
  malformed payloads are rejected up front; API requests over 8 MB are refused before parsing.
- **Settings saves are immediately visible (H-12):** payout toggles, Self-Service portal
  visibility and module visibility update on screen the moment they are saved — no reload needed.
- **Cancelled selfie dialogs no longer freeze ESS buttons (H-11):** closing the camera picker
  (or leaving it open past 90 seconds) releases the Check-In / Check-Out buttons cleanly.
- **Geo-fence dragging works (H-13):** the fence center pin can be dragged smoothly; the
  coordinates commit when you drop the pin.
- **CI runs on every push (H-15):** the 8-stage gate (typecheck, lint, unit tests, guards,
  permission lint, dependency audit, build) now actually executes on GitHub Actions.

## 📋 Phase-3 batch (behavior changes for staff)

- **One-time MFA secret rotation — run after upgrading (M-3):** if your database predates the
  HRM_MFA_KEY encryption key, older authenticator secrets are stored under a key derived from a
  public constant. After setting `HRM_MFA_KEY` and deploying, run once:
  `bun run scripts/rotate-mfa-legacy-secrets.ts` (dry-run report first; add `--apply
  --allow-production` on the server after a backup). Users see no change — their authenticator
  apps keep working; the secrets are simply re-wrapped under your deployment key.
- **Login, logout and MFA changes are now audited (M-4):** sign-ins, sign-outs, MFA
  enable/disable and password changes each leave an audit row under Settings → Audit Log —
  previously MFA disable left no trail at all.
- **Internal metrics endpoint is disabled until configured (M-5):** `/api/metrics` now returns
  503 when `HRM_INTERNAL_TOKEN` is not set, instead of serving employee/user counts publicly.

## 📋 Phase-4 batch (Low-severity polish — 2026-10-02)

- **Disabling MFA needs your PASSWORD and a code (L-1):** the Security & MFA dialog now asks for
  your account password next to the current verification code — a stolen session can no longer
  remove the second factor with a shoulder-surfed code alone.
- **Login error messages are generic (L-2):** locked accounts and multi-vendor emails now get the
  same "Invalid email or password" as everyone else (support can still see the real cause in the
  Audit Log); password-reset responses no longer reveal whether an email is registered.
- **Holidays can stop consuming leave balance (L-9):** new setting **Settings → Leave** →
  "Holidays inside a leave span consume balance". Default ON keeps today's behavior. Switch it OFF
  and public/company holidays inside a leave request stop consuming balance (optional holidays
  still count — employees elect those individually).
- **Plain portal check-out respects the method policy (L-13):** employees whose attendance policy
  only allows GPS/biometric check-outs can no longer bypass it via the no-location fallback — the
  button now explains that GPS is required.
- **Destructive device commands ask for the serial (L-15):** CLEAR DATA / CLEAR LOG / REBOOT on a
  biometric terminal require typing the device's serial number as confirmation (same pattern as
  employee hard-delete). CHECK/CHECK TIME etc. queue as before.
- **Attendance corrections decided by permission, not role name (L-19):** the decision button now
  follows the standard RBAC system (`attendance.verify` — HR Admin, Owner, and HR Manager carry
  it). Custom roles can be granted or denied it like any other permission.
- **Announcement delivery is honest (L-26):** large announcements (2000+ recipients) report how
  many notifications were delivered and whether the list was capped.
- **Employee photos: https or upload only (L-27):** photo fields no longer accept http:// links,
  javascript: URLs or arbitrary text.
- **Report date ranges capped at 1 year (L-28):** attendance overview requests wider than 366
  days are rejected with a clear message (split the period or export per year); the dashboard
  refreshes from a 60-second cache instead of re-scanning the whole organization every poll.
- **Attachments are checked by content, not filename (L-29):** leave supporting documents and
  selfie proofs must actually BE images/PDF (magic-byte check); a renamed executable is rejected.
  Documents whose stored content doesn't match their name open as a download instead of an
  inline preview.
- **Loan plans can no longer produce a ৳0.00 installment (L-7):** amounts are split to the paisa
  (e.g. ৳0.04 over 3 → ৳0.02/৳0.01/৳0.01). The interest-rate field is recorded on the ledger but
  is NOT charged in installments — the loan dialog now says so.
- **Approval chains need two humans when you have them (L-8):** a single super-approver cannot
  take every step of a multi-step approval when another approver exists in the organization
  (sole-admin organizations keep the one-person path).
- **Dialogs protect unsaved work (L-23):** closing a dialog with unsaved changes (Esc / backdrop
  / X) now asks before discarding.
- **Ops (L-6/L-31/L-34):** the archived SQLite migration folder is gone from the deliverable
  (preserved in git history); deployment docs now describe the PostgreSQL truth and the reverse
  proxy template carries an unmissable REPLACE-ME domain banner; a Prometheus starter alert-rule
  file ships at `deploy/hrm-alerts.rules.yml` (see DEPLOYMENT-GUIDE → Monitoring & Alerting).
- **Maps on air-gapped networks (L-14):** set `NEXT_PUBLIC_MAP_TILES_URL` to your internal tile
  server so tracking/geofence maps stop loading tiles from the public OpenStreetMap CDN.
- **Cameras (L-24/L-25/L-35):** demo/seed camera credentials are encrypted at rest like
  production ones; the "include disabled cameras" listing now needs camera-edit permission; the
  camera deep-link verification checklist lives in `src/hrm-server/cameras/providers/README.md`
  (one live launch per brand before go-live).
