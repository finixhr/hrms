# PostgreSQL backup & restore — operations runbook

> **Reconstructed 2026-11-10 (forensic-audit Phase 0)**: this runbook failed to
> ship with the 2026-11-09 release archive (the `docs/` directory rode out
> empty), so the suite gate `tests/unit/phase0-backup-cipher-roundtrip.test.ts`
> had nothing to pin. The content below documents the backup lane AS BUILT —
> `scripts/backup.sh`, `scripts/restore-drill.sh`, `deploy/backup.service`,
> `deploy/backup.timer`, `deploy/restore-drill.service` — and the manual
> decrypt example is byte-identical to the drill's invocation.

## 1. What the nightly lane does

`deploy/backup.timer` fires `deploy/backup.service` (oneshot) which runs
`bash scripts/backup.sh`:

1. **Logical snapshot** — `pg_dump --format=custom` (self-compressed,
   `pg_restore`-able) against `HRM_BACKUP_SOURCE_URL` (read replica) or
   `DATABASE_URL`. The app role is sufficient; no superuser required.
2. **Encryption by default** (`BACKUP_ENCRYPT=true`) — the key comes from
   `HRM_BACKUP_KEY` **through the dedicated backup channel only**
   (see §5). Cipher: AES-256-CBC with PBKDF2 (600,000 iterations, salted),
   passphrase passed via environment (`-pass env:`), never on the command
   line. The historical note: the first P0 attempt used an AEAD mode that
   the `openssl enc` utility does not support, so the invocation failed on
   EVERY nightly run — after the plaintext dump had landed. The gate test
   pins the supported parameters and the failure path.
3. **SHA-256 checksum manifest** written alongside every backup
   (`<backup>.sha256`).
4. **Offsite copy** (`BACKUP_OFFSITE_CMD`, whitespace-split argv — no shell
   evaluation; missing or failed copy is FATAL unless
   `HRM_BACKUP_OFFSITE_OPTIONAL=1`).
5. **Retention** sweep of local artifacts.

If encryption fails, the failure trap **removes the unencrypted intermediate
dump** (no ciphertext, no plaintext left behind).

## 2. Tamper evidence

CBC has no authentication tag: a flipped ciphertext byte decrypts to garbage
rather than failing. The tamper-evidence layer is the **SHA-256 manifest** —
the restore drill verifies it BEFORE decrypting anything. Treat a checksum
mismatch as a compromised backup: do not decrypt, escalate instead.

## 3. The quarterly restore drill

`deploy/restore-drill.timer` → `deploy/restore-drill.service` →
`bash scripts/restore-drill.sh`:

1. picks the newest backup in `backups/`;
2. **verifies the checksum manifest first** (a mismatch aborts the drill);
3. decrypts with the SAME cipher + KDF parameters as the backup lane;
4. recreates a THROWAWAY scratch database and `pg_restore`s into it
   (`--no-owner --no-privileges --exit-on-error`);
5. reports PASS/FAIL — a backup that does not restore cleanly is a failed
   backup, whatever the encryption says.

## 4. Manual restore (runbook procedure)

On a machine with the backup channel env and `pg_restore`/`psql` available:

```bash
set -a; source /etc/systemd/system/hrm-backup.env; set +a   # the backup channel (FIN-038)

# 1. verify the manifest BEFORE decrypting (tamper evidence)
cd backups && sha256sum -c hrm-<timestamp>.dump.enc.sha256

# 2. decrypt — the EXACT parameters the drill uses
BACKUP_PASSPHRASE="$HRM_BACKUP_KEY" openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in hrm-<timestamp>.dump.enc -out /tmp/hrm-restored.dump -pass env:BACKUP_PASSPHRASE

# 3. restore into the target database
pg_restore --dbname "$DATABASE_URL" --no-owner --no-privileges --exit-on-error /tmp/hrm-restored.dump

# 4. remove the plaintext immediately after the restore is confirmed
rm -f /tmp/hrm-restored.dump
```

## 5. Where the key lives (channel separation)

`HRM_BACKUP_KEY` is a **backup-channel** secret:

- nightly backup: `/etc/systemd/system/hrm-backup.env` (mode 600, root:root)
  sourced by `deploy/backup.service`;
- restore drill: `/etc/systemd/system/hrm-restore-drill.env` — the drill's
  OWN environment file (drill-only key copy + drill `DATABASE_URL`), sourced
  by `deploy/restore-drill.service`;
- the runtime application environment (`hrm.env` / `.env`) must NEVER carry
  it — whoever can read the app's environment must not gain backup-decrypt
  capability.

Rotation, re-keying of existing backups, and the KMS option are covered in
`docs/runbooks/secret-rotation.md`.

## 6. Verification gates

- `bun test tests/unit/phase0-backup-cipher-roundtrip.test.ts` — static pin
  of the cipher parameters + a LIVE encrypt→decrypt round-trip with the exact
  pipeline flags + the wrong-key check.
- `bash scripts/verify-release-archive.sh <archive.zip>` — no backup artifact
  may ever ship inside a release archive.

## 7. Incident note (2026-11-09 archive)

The 2026-11-09 release archive shipped `backups/hrm-20261109T125823Z.dump.enc`
together with the `.env` that carried its encryption key — the dump must be
treated as disclosed tenant data. See `docs/runbooks/secret-rotation.md` §6
for the quarantine and disclosure-response procedure.
