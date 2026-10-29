# Finix HR — Deployment Guide

> ## OPS-R5 Errata (this audit, 2026-09-28)
>
> The original deployment guide shipped with several inaccuracies that this
> errata corrects. Cross-reference any step in the body of the guide against
> this section.
>
> 1. **Migration count**: the guide says "10 migrations" — the actual count
>    is **9 baseline migrations + 1 HIGH-3 fix migration** (drop
>    PasswordResetToken) = 10. Either count is now correct after the
>    HIGH-3 fix lands. Run `ls prisma/migrations/` to verify.
> 2. **Test count**: the guide says "195 tests" — the actual count is
>    **130 camera tests across 4 files + ~70 other tests ≈ 200 tests total**.
>    Run `bun test tests/unit | tail -5` for the authoritative count.
> 3. **Caddyfile**: the guide ships a trivial 4-line Caddyfile. The actual
>    production file is `deploy/Caddyfile` (73 LOC) with security headers,
>    dedicated device plane, plaintext redirect for legacy firmware.
>    **Use deploy/Caddyfile, not the snippet in this guide.**
> 4. **Backup subsystem**: the guide does NOT mention the backup subsystem.
>    The actual deployable artifacts are:
>    - `scripts/backup.sh` — nightly backup (pg_dump custom format + openssl)
>    - `deploy/backup.service` + `deploy/backup.timer` — systemd unit (02:30)
>    - `scripts/restore-drill.sh` — quarterly restore test
>    - `deploy/restore-drill.service` + `deploy/restore-drill.timer`
>    - `scripts/backup-alert.ts` — email on failure
>    - `docs/BACKUP_RESTORE.md` — full runbook (referenced from systemd units)
>    - ~~`vacuum.service` + `vacuum.timer` units (deploy/)~~ REMOVED (PostgreSQL autovacuum)
>    - `deploy/logrotate.conf` — log rotation
>    - `scripts/disk-check.sh` — pre-flight disk-space check
>    - **Required env vars**: `HRM_BACKUP_KEY` (32-char hex),
>      `BACKUP_OFFSITE_CMD` (optional), `HRM_BACKUP_ALERT_EMAIL` (optional)
> 5. **CI pipeline**: the guide references `.github/workflows/ci.yml` which
>    **now exists** (created in this audit). The 8-stage CI runs on every
>    push + PR. Use `bun run ci` locally to run the same stages.
> 6. **Production server systemd unit**: the guide does NOT mention that
>    the Next.js server itself needs supervision. Use `deploy/hrm.service`
>    (created in this audit) with `Restart=on-failure`.
> 7. **Env vars**: see `.env.example` for the complete list — it now
>    includes 16+ keys that were previously undocumented (HRM_BACKUP_KEY,
>    HRM_INTERNAL_TOKEN, BACKUP_OFFSITE_CMD, ADMS_PHOTO_RETENTION_DAYS,
>    HRM_SESSION_DAYS, HRM_ALLOW_HTTP_LAN, HRM_DEPLOYMENT_MODE,
>    HRM_JOBS_TICK_MS, etc.).
> 8. **Readiness vs liveness**: `/api/health` is the lean liveness probe
>    (DB reachable). `/api/readyz` (created in this audit) is the readiness
>    probe (DB + migrations + bgJob queue healthy). `/api/metrics` is the
>    Prometheus-format metrics endpoint (auth-gated by HRM_INTERNAL_TOKEN).
> 9. **Multi-instance**: single-instance PostgreSQL is the supported production
>    shape. Multi-instance requires Redis for rate limit, BgJob queue, and
>    camera token cache. Set `HRM_DEPLOYMENT_MODE=multi` to surface an
>    advisory at boot.

> ## PostgreSQL Migration Errata (2026-09-30)
>
> The application database moved from **SQLite → PostgreSQL**. Sections of this
> guide that mention `prisma/db/custom.db`, `file:` DATABASE_URLs, SQLite
> prerequisites, or `vacuum.service` unit describe the RETIRED layout and are
> superseded as follows:
>
> 1. **Prerequisites**: replace "SQLite (included with the OS)" with
>    **PostgreSQL 16/17** (server) + **postgresql-client** (psql, pg_dump,
>    pg_restore) on the app host.
> 2. **DATABASE_URL**: `postgresql://hrm_user:CHANGE_ME@127.0.0.1:5432/hrm_production`
>    (bind PostgreSQL to 127.0.0.1 or a private NIC — never expose it publicly).
> 3. **Fresh installs**: `bash scripts/setup-and-seed.sh` now creates the dev
>    PostgreSQL database automatically, then applies `prisma migrate deploy`.
> 4. **Existing SQLite data**: run
>    `DATABASE_URL=… bun run db:migrate-sqlite` (reads `prisma/db/custom.db`
>    read-only, verifies reconciliation row-by-row — see
>    `docs/postgresql-migration-report.md` and `docs/postgresql-cutover.md`).
> 5. **Backup subsystem**: `scripts/backup.sh` now uses `pg_dump --format=custom`
>    (still openssl-encrypted + SHA-256 manifest + offsite + retention +
>    alerting); `scripts/restore-drill.sh` restores via `pg_restore`.
> 6. **`vacuum.service` + `vacuum.timer` units (deploy/) were REMOVED** —
>    PostgreSQL maintains itself via autovacuum; see
>    `docs/postgresql-migration-report.md` (§Known differences) for the
>    recommended periodic `VACUUM ANALYZE` cadence.
> 7. **systemd**: `deploy/hrm.service` now starts `After=postgresql.service`.
> 8. **Prisma migrations**: the PostgreSQL history is a single baseline
>    (`prisma/migrations/0_init_postgresql/`) plus subsequent dated migrations.
>    The historical SQLite migrations were removed from the deliverable (audit
>    L-6 — documentation-drift risk, no runtime impact); they remain retrievable
>    from the repository's pre-cutover git history, and the PostgreSQL rollback
>    procedure is documented in `docs/postgresql-rollback.md`.
>
> Complete step-by-step deployment instructions for both **testing** (with dummy data) and **production** (clean owner-only seed).

---

## Prerequisites

- **Bun** runtime v1.3+ ([install](https://bun.sh))
- **Node.js** v24+ (Bun uses it for some native modules)
- **PostgreSQL 16 or 17** server + **postgresql-client** (psql/pg_dump/pg_restore on the app host) — see the PostgreSQL Migration Errata above
- **Caddy** (for production reverse proxy + HTTPS — optional but recommended)

---

## Part 1 — Testing / Development Deployment (with Dummy Data)

This creates a full demo database with 2 vendors, multiple employees per role, attendance history, payroll runs, loans, cameras (10 cameras across 4 brands), and EZVIZ/Imou credentials.

### Step 1: Extract the project

```bash
unzip HRMS_FINIXHR.zip -d HRMS_FINIXHR
cd HRMS_FINIXHR
```

### Step 2: Copy and edit `.env`

```bash
cp .env.example .env
```

Edit `.env` — the ONLY field you MUST change for testing is `HRM_MFA_KEY`. Generate a new key:

```bash
# Generate a 256-bit hex key
openssl rand -hex 32
# Copy the output and paste it into .env:
# HRM_MFA_KEY="<your-generated-key>"
```

> **WARNING:** Do NOT use the example key from `.env.example` in any deployment. Generate your own with `openssl rand -hex 32`.

All other `.env` defaults work for local testing. See the full `.env` reference at the bottom of this guide.

### Step 3: Install dependencies

```bash
bun install
```

### Step 4: Generate Prisma Client

```bash
bun run db:generate
```

### Step 5: Apply database migrations

```bash
bun run db:deploy
```

This applies all 10 migrations (baseline → comm_key → payroll_adjust → fk_integrity → user_email_index → paisa → bg_jobs → throttle → m07_pipeline → **cameras**) to create the full database schema including the new Camera + CameraCredential tables.

### Step 6: Seed with dummy data (TEST profile — huge corpus)

```bash
bun run seed          # uses .env (SEED_TEST_* knobs apply)
bun run seed:test     # same, but loads the dedicated .env.test profile
```

This creates:
- 2 vendors (Finix HR + Rongin Traders)
- Full organization (branches, departments, designations, shifts)
- 24 curated employees for every role (HR_ADMIN, HR_MANAGER, PAYROLL_OFFICER, BRANCH_MANAGER, etc.)
- Attendance history, payroll runs, loans, KPIs, letters
- **10 cameras** (8 for Finix HR across all 4 brands + 2 for Rongin Traders)
- **BULK TEST CORPUS** (env-tunable, defaults): 800 extra dummy employees with
  full 360° data, ~120k attendance rows over 180 days, 3 extra PAID payroll
  runs with payslips + journals, bulk leave/loans/expenses/KPIs, 25 ESS
  load-test accounts. Set `SEED_TEST_BULK_EMPLOYEES=0` for the classic
  curated-only demo corpus.
- **EZVIZ + IMOU encrypted credentials** for Finix HR
- 1 soft-deleted camera (to test restore flow)

### Step 7: Start the dev server

```bash
bun run dev
```

Open `http://localhost:3000` in your browser.

### Step 8: Login

Use any of the seeded accounts (password: `Pass@123` for all):

| Email | Role |
|---|---|
| `owner@finixhr.com` | VENDOR_OWNER (full access including camera.*) |
| `hradmin@finixhr.com` | HR_ADMIN (full camera.* access) |
| `hrmanager@finixhr.com` | HR_MANAGER (view, create, edit, launch — no delete/manage) |
| `branchmgr@finixhr.com` | BRANCH_MANAGER (view + launch, own branch only) |
| `owner@rongintraders.com` | VENDOR_OWNER (tenant #2) |

### Step 9: Test Camera Manager

1. Login as `owner@finixhr.com` (or `hradmin@finixhr.com`)
2. Click **"Camera Manager"** in the sidebar (under "Attendance" group)
3. You should see 8 cameras for Finix HR (7 active + 1 decommissioned)
4. Click the **Launch** button (▶) on any camera — the launch dialog shows the brand portal link + copyable details
5. Click **"Credentials"** button — the credential panel shows EZVIZ + IMOU as "✓ Configured"
6. Click **"Refresh status"** (🔄) on any camera — bumps `lastStatusCheckAt`
7. Filter by brand (HIKVISION/DAHUA/EZVIZ/IMOU) or status (Active/Disabled/All)

### Step 10: Run tests (optional verification)

```bash
# Run all camera + crypto tests (195 tests)
bun test tests/unit/camera-tenant-isolation.test.ts \
  tests/unit/camera-providers.test.ts \
  tests/unit/camera-providers-ezviz.test.ts \
  tests/unit/camera-providers-imou.test.ts \
  tests/unit/crypto-field-mfa-backcompat.test.ts

# Run the full test suite (includes regression tests)
bun test tests/unit/
```

---

## Part 2 — Production Deployment (Clean Owner Seed)

This creates a fresh database with ONE vendor + ONE owner account, NO dummy data. The owner gets ALL permissions (including camera.*) and must rotate their password on first login.

### Step 1: Extract the project

```bash
unzip HRMS_FINIXHR.zip -d HRMS_FINIXHR
cd HRMS_FINIXHR
```

### Step 2: Copy and edit `.env`

```bash
cp .env.example .env
```

Edit `.env` with your production values:

```bash
# MANDATORY: generate a fresh key (DO NOT use the example value)
HRM_MFA_KEY="$(openssl rand -hex 32)"

# Database (PostgreSQL — bind to 127.0.0.1, never expose publicly)
DATABASE_URL="postgresql://hrm_user:CHANGE_ME@127.0.0.1:5432/hrm_production"

# Production seed configuration
HRM_SEED_VENDOR_NAME="Your Company Name"
HRM_SEED_VENDOR_CODE="YOURCO"
HRM_SEED_VENDOR_LEGAL_NAME="Your Company Ltd."
HRM_SEED_VENDOR_ADDRESS="Your Address, City, Country"
HRM_SEED_VENDOR_PHONE="+880 1XXXXXXXXX"
HRM_SEED_VENDOR_EMAIL="info@yourcompany.com"

# Owner account
HRM_SEED_OWNER_EMAIL="owner@yourcompany.com"
HRM_SEED_OWNER_NAME="Owner Name"
HRM_SEED_OWNER_PHONE="+880 1XXXXXXXXX"
HRM_SEED_OWNER_PASSWORD="YourStrongPassword123!"

# Trust proxy (set to 1 if behind Caddy/Nginx)
HRM_TRUST_PROXY="1"
```

### Step 3: Install dependencies

```bash
bun install
```

### Step 4: Generate Prisma Client

```bash
bun run db:generate
```

### Step 5: Apply database migrations

```bash
bun run db:deploy
```

Verify the migration applied:

```bash
bunx prisma migrate status
# Expected: "Database schema is up to date!"
```

### Step 6: Seed with production data (clean — NO dummy data)

```bash
bun run seed:prod     # loads the dedicated .env.production profile (recommended)
bun run seed:owner    # same seed, but uses the active .env
```

This creates:
- 1 vendor (your company)
- 1 owner account (VENDOR_OWNER with ALL 540 permissions — includes camera.*)
- 14 approval workflows (single Owner Approval step each)
- 8 statutory leave types (Bangladesh standard)
- AIT FY 2025-26 tax configuration
- Password policy (90-day expiry — owner must rotate on first login)
- **0 cameras, 0 credentials** (build your real setup via the UI)

### Step 7: Build for production

```bash
bun run build
```

This creates a standalone production build at `.next/standalone/`.

### Step 8: Start the production server

```bash
bun run start
```

The server runs on port 3000. For HTTPS, use Caddy:

### Step 9 (Optional): Configure Caddy for HTTPS

Create `/etc/caddy/Caddyfile`:

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl restart caddy
```

### Step 10: First login

1. Open `https://your-domain.com` (or `http://localhost:3000` for local)
2. Login with `owner@yourcompany.com` and the password you set
3. **You will be forced to change your password** (90-day policy + passwordChangedAt=epoch)
4. After password change, the full HRM is available

### Step 11: Backfill camera permissions (if upgrading an existing DB)

If you're adding Camera Manager to an EXISTING production database (not a fresh seed):

```bash
# Add camera.* permissions to existing Role rows (additive, idempotent)
bun run scripts/migrate-role-perms-cameras.ts
```

This adds `camera.view`, `camera.create`, `camera.edit`, `camera.delete`, `camera.launch`, `camera.manage` to existing Role rows per the confirmed permission table:

| Role | Permissions Added |
|---|---|
| HR_ADMIN | all camera.* |
| VENDOR_OWNER | all camera.* |
| HR_MANAGER | view, create, edit, launch |
| BRANCH_MANAGER | view, launch |
| PAYROLL_OFFICER | none |
| DEPT_MANAGER | none |
| EMPLOYEE | none |

### Step 12: Verify Camera Manager is working

1. Login as the owner
2. Click **"Camera Manager"** in the sidebar (under "Attendance" group)
3. You should see an empty state: "No cameras — Click 'Add Camera' to register your first CCTV camera."
4. Click **"Add Camera"** — the create form appears with a brand selector
5. Select a brand (HIKVISION/DAHUA/EZVIZ/IMOU) — conditional fields appear:
   - HIKVISION/DAHUA: verificationCode field (required)
   - EZVIZ/IMOU: serialNumber field (required, verificationCode not used)
6. Fill in the camera details and click **Create**
7. The camera appears in the list with status "UNKNOWN"
8. Click **"Credentials"** → select EZVIZ or IMOU → click **"Configure"** → enter appKey/appSecret → Save

---

## Monitoring & Alerting (audit L-34)

The app exposes three operational endpoints (all safe to scrape from a
monitoring host on the private network):

- `/api/health` — liveness (DB reachable); use for the UP/DOWN check
- `/api/readyz` — readiness (DB + migrations + bgJob queue healthy)
- `/api/metrics` — Prometheus-format gauges (`hrm_uptime_seconds`,
  `hrm_bgjob_pending/running/failed`, `hrm_zkteco_raw_received`,
  `hrm_zkteco_raw_dead_letter`, `hrm_devices_online`, row totals), gated by
  the `HRM_INTERNAL_TOKEN` bearer header.

A starter Prometheus rule set ships at `deploy/hrm-alerts.rules.yml` —
instance-down, crash-loop, job-queue backlog, device-ingest backlog,
dead-letters, all-devices-offline. Point your Prometheus `rule_files` at it
and send the internal token in the scrape job's `authorization` block (the
exact snippet is in the rule file's header comment). Structured logging is
plain `console.*` at the edges by design — ship `logs/hrm.log` (see
`deploy/logrotate.conf`) to your log collector if you need centralized
search.

---

## Part 3 — Full `.env` Reference

```bash
# ========================================================================
# Finix HR — .env Reference (with Camera Manager additions)
# ========================================================================
# Copy to .env and fill in YOUR values. NEVER commit .env.

# --- Database (PostgreSQL) ---
DATABASE_URL="postgresql://hrm_user:CHANGE_ME@127.0.0.1:5432/hrm_production"
# isolated unit-test database (never production)
TEST_DATABASE_URL="postgresql://hrm_user:CHANGE_ME@127.0.0.1:5432/hrm_test"

# --- MFA + Camera Credentials Encryption Key (MANDATORY) ---
# Used by crypto-field.ts for AES-256-GCM encryption of:
#   - MFA TOTP secrets (UserMfaSecret.secretEnc, context="mfa::v2")
#   - Camera cloud credentials (CameraCredential.encryptedPayload, context="cameras::v1")
# Generate: openssl rand -hex 32
# DO NOT use the example value — generate your own.
HRM_MFA_KEY="GENERATE_YOUR_OWN_KEY_WITH_openssl_rand_hex_32"

# --- Device gateway security (ZKTeco/Hikvision attendance terminals) ---
HRM_DEVICE_SN_RATE_LIMIT_PER_MIN="60"
ZKTECO_ADMS_DEBUG_CAPTURE="false"
ZKTECO_ADMS_ENABLED="true"
ADMS_RATE_LIMIT_PER_MIN="300"
ADMS_AUTO_CHECK_SECONDS="120"
ADMS_LOGDELAY_SECONDS="60"

# --- CSRF origin allowlist (comma-separated, optional) ---
HRM_ALLOWED_ORIGINS=""

# --- LAN access from other PCs (dev server) ---
HRM_ALLOWED_DEV_ORIGINS=""

# --- Trust proxy (set to 1 behind Caddy/Nginx) ---
HRM_TRUST_PROXY="0"

# --- Prisma log level (query,info,warn,error — comma separated) ---
HRM_PRISMA_LOG=""

# --- Observability kill-switches ---
HRM_JOBS_ENABLED="true"

# --- Seed passwords (testing only — change in production!) ---
HRM_SEED_PASSWORD="Pass@123"

# --- Production seed configuration (bun run seed:owner) ---
HRM_SEED_VENDOR_NAME="Finix HR"
HRM_SEED_VENDOR_CODE="FINIX"
HRM_SEED_VENDOR_LEGAL_NAME=""
HRM_SEED_VENDOR_ADDRESS=""
HRM_SEED_VENDOR_PHONE=""
HRM_SEED_VENDOR_EMAIL=""
HRM_SEED_OWNER_EMAIL="owner@finixhr.com"
HRM_SEED_OWNER_NAME="Owner"
HRM_SEED_OWNER_PHONE=""
HRM_SEED_OWNER_PASSWORD=""
```

### What changed from the original `.env.example`?

**Nothing structural changed.** The Camera Manager reuses the existing `HRM_MFA_KEY` env var — it does NOT introduce any new env vars. The key derivation uses a context-parameterized salt (`cameras::v1` vs `mfa::v2`), so MFA secrets and camera credentials derive different AES-256 keys from the same env key.

**What you MUST verify:**
1. `HRM_MFA_KEY` is set (mandatory — crypto-field throws without it)
2. `DATABASE_URL` points to the correct PostgreSQL database (and PostgreSQL is running)
3. If upgrading an existing DB, run `bun run scripts/migrate-role-perms-cameras.ts` to backfill camera permissions

---

## Quick Reference: All Commands

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies |
| `bun run db:generate` | Generate Prisma Client |
| `bun run db:deploy` | Apply all migrations (creates Camera + CameraCredential tables) |
| `bun run db:push` | Push schema directly (dev only — bypasses migrations) |
| `bun run db:reset` | Reset DB + re-apply all migrations |
| `bun run seed` | **TEST seed** — huge dummy data (2 vendors, 24 curated + configurable bulk employees, 180-day attendance, payroll history; SEED_TEST_* knobs in `.env`) |
| `bun run seed:test` | Same TEST seed, but loads the self-contained `.env.test` profile (dedicated disposable `hrm_seed_test` database) |
| `bun run seed:prod` | **PRODUCTION seed** — clean owner-only tenant, loads the self-contained `.env.production` profile (NO dummy data) |
| `bun run seed:owner` | Same production seed, but uses the active `.env` (legacy alias) |
| `bun run scripts/migrate-role-perms-cameras.ts` | Backfill camera.* permissions to existing Role rows |
| `bun run dev` | Start dev server on port 3000 |
| `bun run build` | Build for production |
| `bun run start` | Start production server |
| `bun test tests/unit/` | Run all unit tests |
| `bunx prisma migrate status` | Check migration status |
| `bunx eslint src/hrm/views/cameras.tsx` | Lint the camera view |

---

## Troubleshooting

### "Camera Manager shows the dashboard instead of the camera list"

The view registry is missing the `cameras` entry. Verify `src/hrm/views/registry.tsx` contains:
```tsx
cameras: dynamic(() => import("./cameras"), { loading }),
```
If missing, add it and restart the dev server.

### "EZVIZ/IMOU credentials can't be saved — error about HRM_MFA_KEY"

`HRM_MFA_KEY` is not set in `.env`. Generate one:
```bash
echo "HRM_MFA_KEY=\"$(openssl rand -hex 32)\"" >> .env
```
Then restart the server.

### "camera.launch returns 429 — too many launch attempts"

The rate limit is 30 launches/min per camera and 120/min per tenant. Wait 60 seconds and retry. To increase the limits, edit `LAUNCH_RATE_PER_CAMERA` and `LAUNCH_RATE_PER_TENANT` in `src/hrm-server/routes/cameras.ts`.

### "Camera status shows UNKNOWN even though the camera is online"

For HIKVISION/DAHUA cameras: the status is "last known" (no cloud API). The status field stays at whatever was set at registration (default: `UNKNOWN`). Click "Refresh status" to bump `lastStatusCheckAt` — the status itself won't change (it's provider-set, not polled).

For EZVIZ/IMOU cameras: the provider polls the brand cloud API. If the API returns an error, the status becomes `UNKNOWN` (NOT `OFFLINE` — "UNKNOWN" means "we can't see it", "OFFLINE" means "the camera is unreachable").

### "Brand portal URLs are wrong"

Each provider has `// TODO(verify)` markers for URLs that weren't independently verified against the brand's official developer docs. Check:
- `src/hrm-server/cameras/providers/hikvision.ts` — `HIK_CONNECT_WEB_URL`
- `src/hrm-server/cameras/providers/dahua.ts` — `DMSS_WEB_URL`
- `src/hrm-server/cameras/providers/ezviz.ts` — `EZVIZ_OPEN_BASE` + `ezopenUrl` format
- `src/hrm-server/cameras/providers/imou.ts` — `IMOU_OPEN_BASE` + `IMOU_WEB_PORTAL`

Swap the constants with verified URLs from the brand's developer portal.

## Multi-Instance & Scaling (2026-10-26)

The boot warning `HRM_DEPLOYMENT_MODE=multi — multi-instance requires Redis …`
points here. Running more than one app instance (horizontal scale-out) is
supported with zero code changes because every piece of shared state is
external to the process:

- **Sessions** live in PostgreSQL (token-hash lookups) — no sticky sessions.
- **Scheduler work** is single-flighted cluster-wide via the distributed tick
  lock (Redis `SET NX PX` when `REDIS_URL` is set, Postgres `CoordinationLock`
  otherwise).
- **Rate buckets** count cluster-wide when Redis is up (in-process fallback
  otherwise).
- **Background jobs / transactional outbox** claim rows with conditional
  updates + `FOR UPDATE SKIP LOCKED` — safe with any instance count.

Minimal multi-instance recipe:

```bash
# 1) Provide Redis and point every instance at it (.env on each machine):
REDIS_URL=redis://:password@redis-host:6379/0
HRM_DEPLOYMENT_MODE=multi

# 2) Start 2+ instances (PORT=3001.. and PORT=3002..), then run the edge:
caddy run --config deploy/Caddyfile.lb   # health-checked LB across instances

# 3) Put PgBouncer in front of PostgreSQL once instances × connections grow
#    (deploy/pgbouncer/ — see the ini header for the URL parameters).
```

The complete runbook — capacity model, CDN cache rules, Redis TTL/invalidation
contract, PgBouncer sizing, read-replica consistency matrix, attendance-table
partitioning plan, observability and load testing — lives in
**docs/SCALING.md**. Load-test scenarios live in **loadtest/**.
