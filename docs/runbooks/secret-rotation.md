# Secret rotation runbook (Phase 0 — emergency containment)

> **Scope**: this runbook operationalizes forensic-audit findings FIN-001 and
> FIN-038 (Phase 0, 2026-11-10). It is the complete procedure for rotating the
> env-plane secrets, separating the backup-key channel, purging leaked material
> from release artifacts and Git history, and verifying the result. The
> scripts it references live in the repository; the systemd paths live on the
> operator host.

## 1. Incident history — three leaked generations

| Generation | Incident | What shipped | Where blocked now |
|---|---|---|---|
| 1st (pre-2026-10) | 2026-10 shared artifact | `.env` + `.env.orig-backup` values | `src/instrumentation.ts` boot blocklist, `scripts/scan-secrets.ts` |
| 2nd (post-2026-10 rotation) | same artifact | rotated values rode out again | same blocklists |
| 3rd (post-2026-10-31 rotation) | **2026-11-09 release archive** | the live `.env` **plus** `backups/hrm-20261109T125823Z.dump.enc` (4.06 MB, decryptable with the shipped `HRM_BACKUP_KEY`) | blocklisted 2026-11-10 (Phase 0); this runbook closes the channel gap |

Root cause of the third leak: the archive was cut **outside** the sanctioned
packaging lane (`scripts/package-zip.sh`), which refuses to package while
`.env` exists and runs `scripts/scan-secrets.ts`. Remediation therefore adds
archive-level verification (`scripts/verify-release-archive.sh`) so ANY
produced archive — however it was built — fails distribution checks when it
carries secrets.

## 2. Rotate the env-plane secrets

```bash
# on the operator host, in the deployment tree:
bun run scripts/rotate-secrets.ts --backup-env /etc/systemd/system/hrm-backup.env --purge-sessions
```

What this does:

1. `HRM_MFA_KEY` and `HRM_INTERNAL_TOKEN` are replaced **in `.env`** (runtime
   plane). Every other `.env` line is preserved byte-for-byte.
2. `HRM_BACKUP_KEY` is **removed from `.env`** (if present) and the fresh
   value is written **only** to the backup channel file
   (`/etc/systemd/system/hrm-backup.env`, mode 600). See §4.
3. Every Session row is deleted (`--purge-sessions`) — sessions minted under
   compromised material must not survive. All users re-login.
4. The rotation record (sha256 of each old value — never the values) is
   appended to `.env.rotation-log` (gitignored).

Then:

```bash
bun run scripts/re-encrypt-fields.ts   # re-wrap at-rest fields under the new MFA key
bash scripts/rekey-backups.sh          # re-key existing encrypted backups under the new backup key
sudo systemctl restart hrm.service     # boot guard refuses the old values on purpose
```

## 3. Rotate the database password (operator action)

The archive's `.env` carried a `DATABASE_URL` password. Rotate it where it
lives:

```bash
sudo -u postgres psql -c "ALTER ROLE hrm_user WITH PASSWORD '<fresh password>';"
# then update DATABASE_URL in .env (runtime) and hrm-backup.env (backup channel)
```

## 4. Backup-key channel separation (FIN-038)

The backup key and the runtime keys must never share an injection surface:

- **Runtime plane**: `/etc/systemd/system/hrm.env` (used by `deploy/hrm.service`)
  — no `HRM_BACKUP_KEY`, ever.
- **Backup plane**: `/etc/systemd/system/hrm-backup.env` (used by
  `deploy/backup.service`) — the sole home of the live backup key.
- **Restore drill**: `/etc/systemd/system/hrm-restore-drill.env` (used by
  `deploy/restore-drill.service`) — a drill-only copy plus the drill
  `DATABASE_URL`. Never the runtime env; never shared with the nightly backup.
- **Hardened deployments**: inject from a KMS/secret manager instead of a flat
  file — the channel, not the file format, is the control.

Manual backup run (do not use the app's `.env`):

```bash
set -a; source /etc/systemd/system/hrm-backup.env; set +a
bash scripts/backup.sh
```

## 5. Purge leaked material from Git history

The 2026-11-09 archive carried `.env` and `backups/` in the working tree. If
any such file ever reached a commit, rewrite history — this is a
**coordinated, all-clones** operation:

```bash
git filter-repo --invert-paths --path .env --path .env.orig-backup \
  --path backups/hrm-20261109T125823Z.dump.enc --path-glob 'backups/*.dump.enc'
# then force-push, re-clone every working copy, and revoke any deploy keys
# that had access to the old history (GitHub keeps unreachable objects ~90 days).
```

## 6. Quarantine compromised artifacts

- Move any leaked archive and `backups/*.dump.enc` out of every machine that
  received them into a locked quarantine location (access restricted, logged).
- The shipped dump is decryptable with a shipped key — treat it as disclosed
  PII and follow the incident-response/retention policy for the affected
  tenants.

## 7. Verify

```bash
bun run scripts/scan-secrets.ts                    # tree scan: 0 violations
node scripts/check-release-artifact.mjs --tree .   # manifest lockstep: exit 0
bash scripts/verify-release-archive.sh <archive.zip>  # ANY archive: 0 secret hits
bun test tests/unit/w1-ac-09-release-artifact.test.ts  # validator suite green
```

Exit criteria for Phase 0 (per the audit roadmap): a newly built archive has
zero secret-scan hits, and every pre-rotation secret value is refused by the
boot guard (`src/instrumentation.ts` blocklist) and the scanner
(`scripts/scan-secrets.ts` blocklist) — old values verified dead.

## 8. Prevention

- Only `scripts/package-zip.sh` may cut release archives (C-02 leak guard +
  secret-scan gate + FIN-084 clean-tree requirement).
- `scripts/verify-release-archive.sh` runs against any archive before it is
  distributed — including ones built elsewhere.
- The pre-commit hook (`scripts/install-hooks.ts`) blocks `.env`-family files
  by name, scans staged content, and enforces release-manifest lockstep
  (FIN-002).
- CI stage 15/15 runs `scripts/check-release-artifact.mjs --tree .`; the
  container entrypoint runs the image-mode assertion (V12) before migrating.
- Rotate on every suspected disclosure — and add the retired generation's
  sha256 to BOTH blocklists in the same change (they are deliberately
  duplicated; keep them in sync).
