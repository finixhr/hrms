// ============ Server instrumentation — starts background services ============
// Runs once per server process (dev + production Node runtime). The ADMS
// sweeper owns retry/queue recovery (spec §17, §43); the jobs scheduler owns
// payroll automation, wishes delivery, attendance alerts and document-expiry
// reminders (spec §9.3, §12.2, §12.3).
//
// M-06 — the documented env names are now the ONLY accepted names
// (HRM_JOBS_ENABLED / ZKTECO_ADMS_ENABLED — the old JOBS_ENABLED /
// ZKTECO_SWEEPER_ENABLED spellings are rejected at boot so a stale .env can
// never silently disable a subsystem: the process fails fast with a list of
// the offending keys).
//
// CRIT-1 / HIGH-2 / SEC-1 / SEC-2 (Phase 1) — boot-time value validation:
//   - HRM_MFA_KEY must be 64-char hex; refuses boot on ANY known-leaked value
//     (both 2026-10 archive generations + the compose 64-zero default)
//   - HRM_INTERNAL_TOKEN / HRM_BACKUP_KEY: refuse boot on known-leaked values
//   - HRM_SEED_PASSWORD must not equal "Pass@123" in production
//
// EDGE RUNTIME (2026-10-22 post-delivery hotfix #2): Next.js compiles
// instrumentation.ts for EVERY runtime — including the Edge runtime that
// proxy.ts runs on — and the previous static top-level
// `import crypto from "crypto"` made each Edge compile fail with
// "A Node.js module is loaded ('crypto' …) which is not supported in the
// Edge Runtime" + "Ecmascript file had an error", printed once per request
// in dev. node:crypto is therefore imported DYNAMICALLY inside the
// nodejs-guarded branch of register() below: Turbopack inlines
// process.env.NEXT_RUNTIME per compile target, so that branch (and every
// dynamic import it contains) is dead-code-eliminated from the Edge bundle
// and the Edge compile of this file succeeds cleanly.

/** M-06 — every HRM_* / ZKTECO_* / ADMS_* key the code actually reads. */
const KNOWN_ENV_KEYS = new Set([
  // scheduler + sweeper kill-switches
  "HRM_JOBS_ENABLED",
  "ZKTECO_ADMS_ENABLED",
  // device plane (gateway + sweeper tuning)
  "ADMS_SWEEP_INTERVAL_MS",
  "ADMS_AUTO_CHECK_SECONDS",
  "ADMS_LOGDELAY_SECONDS",
  "ADMS_RATE_LIMIT_PER_MIN",
  "ADMS_REALTIME",
  "ADMS_PHOTO_FUN",
  "ADMS_PHOTO_RETENTION_DAYS",
  "ADMS_TIMEOUT_MIN",
  "ADMS_TIMEZONE_OFFSET_HOURS",
  "ADMS_TRANS_INTERVAL_MIN",
  "HRM_DEVICE_SN_RATE_LIMIT_PER_MIN",
  "HRM_DEVICE_INGEST_WINDOW_DAYS",
  "ATTENDANCE_EVENT_RETRY_LIMIT",
  "ATTENDANCE_DEVICE_OFFLINE_THRESHOLD_SECONDS",
  "ATTENDANCE_DEVICE_WARNING_THRESHOLD_SECONDS",
  "ZKTECO_ADMS_DEBUG_CAPTURE",
  "ZKTECO_ADMS_HEALTH_DETAILED",
  "ZKTECO_SIMULATOR_ENABLED",
  // core app configuration
  "HRM_TRUST_PROXY",
  "HRM_ALLOWED_ORIGINS",
  "HRM_ALLOWED_DEV_ORIGINS",
  "HRM_MFA_KEY",
  "HRM_PRISMA_LOG",
  "HRM_INTERNAL_TOKEN",
  "HRM_BACKUP_KEY",
  // SEC-13 (Phase 1) — per-context encryption-key overrides (empty = ride the
  // HRM_MFA_KEY root, which is exactly the pre-Phase-1 behavior)
  "HRM_CAMERA_KEY",
  "HRM_DEVICE_KEY",
  "HRM_WEBHOOK_KEY",
  "HRM_AI_KEY",
  "HRM_COMMS_KEY",
  "HRM_PAYMENTS_KEY",
  // SEC-13 — the previous generation of each key, set ONLY while running
  // scripts/re-encrypt-fields.ts after a rotation; safe to leave in .env
  // afterwards (nothing reads it at runtime).
  "HRM_OLD_MFA_KEY",
  "HRM_OLD_CAMERA_KEY",
  "HRM_OLD_DEVICE_KEY",
  "HRM_OLD_WEBHOOK_KEY",
  "HRM_OLD_AI_KEY",
  "HRM_OLD_COMMS_KEY",
  "HRM_OLD_PAYMENTS_KEY",
  "BACKUP_OFFSITE_CMD",
  "HRM_BACKUP_ALERT_EMAIL",
  "HRM_E2E_CONFIRM",
  "HRM_SESSION_DAYS",
  "HRM_ALLOW_HTTP_LAN",
  "HRM_DEPLOYMENT_MODE",
  "HRM_JOBS_TICK_MS",
  // Passkey / Biometric MFA (2026-10-25 Part K; 2026-10-26 hotfix — these were
  // read by passkey.ts + documented in .env.example but MISSING from this
  // allowlist, so every .env that followed .env.example failed validateEnvKeys
  // at boot: "[env] Unknown or renamed environment variable(s):
  // HRM_WEBAUTHN_ORIGINS, HRM_WEBAUTHN_RPID". Both stay optional — unset means
  // derive RP ID / origins from the request host (localhost + single-domain
  // deployments need neither).
  "HRM_WEBAUTHN_RPID",
  "HRM_WEBAUTHN_ORIGINS",
  // SaaS platform layer (seed-saas.ts: owner console account + demo mode)
  "HRM_SAAS_OWNER_EMAIL",
  "HRM_SAAS_OWNER_NAME",
  "HRM_SAAS_OWNER_PASSWORD",
  "HRM_SAAS_SEED_DEMO",
  // seed-time overrides (seed-owner.ts / seed.ts)
  "HRM_SEED_KEEP_DATA",
  "HRM_SEED_PASSWORD",
  "HRM_SEED_OWNER_EMAIL",
  "HRM_SEED_OWNER_NAME",
  "HRM_SEED_OWNER_PASSWORD",
  "HRM_SEED_OWNER_PHONE",
  "HRM_SEED_VENDOR_ADDRESS",
  "HRM_SEED_VENDOR_CODE",
  "HRM_SEED_VENDOR_EMAIL",
  "HRM_SEED_VENDOR_LEGAL_NAME",
  "HRM_SEED_VENDOR_NAME",
  "HRM_SEED_VENDOR_PHONE",
])

/** Test hook (Wave 11 regression guard — the 2026-10-26 WebAuthn hotfix):
 * every UNCOMMENTED HRM_/ZKTECO_/ADMS_ key documented in .env.example must
 * appear in this set or validateEnvKeys refuses to boot. The unit test
 * (tests/unit/wave11-env-allowlist.test.ts) cross-checks the two lists so a
 * future "documented but not allowlisted" drift fails CI instead of every
 * operator's boot. */
export const _KNOWN_ENV_KEYS_FOR_TESTS: ReadonlySet<string> = KNOWN_ENV_KEYS

const DEPRECATED_ENV_KEYS: Record<string, string> = {
  JOBS_ENABLED: "renamed → HRM_JOBS_ENABLED",
  ZKTECO_SWEEPER_ENABLED: "renamed → ZKTECO_ADMS_ENABLED",
  // C-03 update (2026-09-22) — the 7-day keyless grace window and the lab-only
  // ALLOW_OPEN override were removed. Keyless-device acceptance is now the
  // per-vendor admin setting "Allow Keyless Devices" (Settings → Devices).
  HRM_DEVICE_GRACE_PERIOD_DAYS: "removed — use Settings → Devices → Allow Keyless Devices",
  ATTENDANCE_GATEWAY_ALLOW_OPEN: "removed — use Settings → Devices → Allow Keyless Devices",
}

/** CRIT-1 + SEC-1 (Phase 1, this audit) — known-leaked secret values shipped in
 *  the 2026-10 shared artifact. Stored as sha256(value) — the blocklist never
 *  carries key material itself. Compared against sha256(configured value).
 *  Entries cover both rotation generations found in the archive (.env and
 *  .env.orig-backup carry DIFFERENT live values — evidence the operator rotated
 *  once, then the new values rode in the artifact again):
 *    - HRM_MFA_KEY: the three values from the original remediation round, the
 *      two 2026-10 archive values, and the docker-compose 64-zero default.
 *    - HRM_INTERNAL_TOKEN / HRM_BACKUP_KEY: both archive generations.
 *
 *  FORENSIC AUDIT 2026-11-10, FIN-001 (Phase 0): the 2026-11-09 release
 *  archive shipped the THIRD generation — the post-2026-10-rotation .env
 *  itself plus a 4.06 MB encrypted production backup, so all three values
 *  below are compromised regardless of rotation history. They are blocklisted
 *  here and in scripts/scan-secrets.ts (kept in sync deliberately); the boot
 *  guard now refuses this generation exactly as it refuses the earlier ones. */
const KNOWN_LEAKED_SECRET_HASHES = new Set<string>([
  // HRM_MFA_KEY (sha256 of the raw value)
  "b8f01a834645413e99392e08a1fe35b62755a6982e7cba1bfd2a7d2161e9a313", // pre-2026-10 rotation — .env(live)+.env(Old)
  "7f9ea0d510b3a4eb0b92505e39824d494fadebaa3825876f2ffed2cda3d6ad0c", // pre-2026-10 rotation — .env.example
  "8e04c706ec45df381ebd7b8059a4164dc0c4f9c7d0ec51ae0b30309711ed8810", // pre-2026-10 rotation — comment-block sample
  "a4bb462cb50f814da8dd907cf4cfaff5676e199abf13a425f7091cd35d849eb7", // 2026-10 archive — .env (current live value)
  "8c781767da50bf46bb394322bd20094b6798da8c13f8d4875df28a0bd573dc1b", // 2026-10 archive — .env.orig-backup (previous rotation)
  "60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55", // docker-compose 64-zero default (SEC-2)
  // HRM_INTERNAL_TOKEN
  "6e2487d9aa95ae2cc9613cd5b3b2d005eee727dcc21e2bf6cecde853fb0137b9", // 2026-10 archive — .env (current live value)
  "e3bd5718a7b5f3e10980e29369dfb25e4c600c2fb68e0a19cda6a53bf91acd77", // 2026-10 archive — .env.orig-backup (previous rotation)
  // HRM_BACKUP_KEY
  "9495920afd1332adf3225066d003e34395fa5b9bcc325c2b0b32863499746857", // 2026-10 archive — .env (current live value)
  "3959bffc9326a72eb6fc044c96bd53fcc2ebc638979a52c9ef2c83a9465a7343", // 2026-10 archive — .env.orig-backup (previous rotation)
  // ---- THIRD generation — 2026-11-09 release archive (forensic audit
  // FIN-001, Phase 0 2026-11-10). The .env that rode in that archive is
  // byte-identical to the working-tree .env at audit time; rotated out by
  // scripts/rotate-secrets.ts during Phase 0 and blocklisted here so the
  // server refuses to boot with any of them ever again.
  // HRM_MFA_KEY (third generation)
  "980ec3ff66c49874d39fc0062b15138b8497f9506aeba4bf3e3c0c63ee90cad8", // 2026-11-09 archive — .env (third-generation live value)
  // HRM_INTERNAL_TOKEN (third generation)
  "2971e92ff85f332ded28472a49ef03434a34e573d191dd45a45561774e46c590", // 2026-11-09 archive — .env (third-generation live value)
  // HRM_BACKUP_KEY (third generation)
  "62fd65dfd236bda5bc9cdb58e08977ad0cf21763343923c51fa898240294493f", // 2026-11-09 archive — .env (third-generation live value; decrypts the shipped 4.06 MB backup)
])

/** SHA-256 hex digest — injected from register() (node:crypto is dynamically
 * imported there so this file stays Edge-runtime-compilable; see header). */
type Sha256Hex = (value: string) => string

/** SEC-1 — true when the configured value's sha256 is on the leaked list. */
function isKnownLeakedSecret(value: string, sha256hex: Sha256Hex): boolean {
  if (!value) return false
  return KNOWN_LEAKED_SECRET_HASHES.has(sha256hex(value))
}

const ROTATION_HINT = "Rotate immediately: bun run scripts/rotate-secrets.ts (generates fresh values and rewrites .env in place), then restart."

const HEX64 = /^[0-9a-fA-F]{64}$/
const PLACEHOLDER_PATTERNS = /^(GENERATE_WITH_|CHANGE_ME_|<).*$/i

/** M-06 — boot-time fail-fast: unknown HRM_ / ZKTECO_ / ADMS_ prefixed keys
 *  mean the .env and the code have drifted apart (a typo'd name silently
 *  disables whatever it was supposed to configure). Refuse to start instead. */
function validateEnvKeys(): void {
  const offenders: string[] = []
  for (const name of Object.keys(process.env)) {
    if (DEPRECATED_ENV_KEYS[name]) {
      offenders.push(`${name} (${DEPRECATED_ENV_KEYS[name]})`)
    } else if ((name.startsWith("HRM_") || name.startsWith("ZKTECO_") || name.startsWith("ADMS_")) && !KNOWN_ENV_KEYS.has(name)) {
      offenders.push(name)
    }
  }
  if (offenders.length) {
    throw new Error(
      `[env] Unknown or renamed environment variable(s): ${offenders.join(", ")}. ` +
      `Check .env.example for the accepted names — the server refuses to start with a drifted configuration.`,
    )
  }
}

/** CRIT-1 / HIGH-2 — boot-time VALUE validation (zod-equivalent, hand-rolled
 *  to avoid a hard zod dependency at boot before modules resolve). */
function validateEnvValues(sha256hex: Sha256Hex, log?: { warn: (m: string) => void; info: (m: string) => void }): void {
  const errors: string[] = []
  const warnings: string[] = []
  const isProd = process.env.NODE_ENV === "production"

  // CRIT-1/SEC-1: HRM_MFA_KEY must be 64-char hex AND must not be a known-leaked value.
  const mfaKey = process.env.HRM_MFA_KEY || ""
  if (!mfaKey) {
    errors.push(
      "HRM_MFA_KEY is not set — TOTP enrollment and camera-credential storage will crash lazily.\n" +
      "  Generate one with: openssl rand -hex 32",
    )
  } else if (PLACEHOLDER_PATTERNS.test(mfaKey)) {
    errors.push(
      `HRM_MFA_KEY is a placeholder ("${mfaKey}") — replace with a real 64-char hex key.\n` +
      "  Generate one with: openssl rand -hex 32",
    )
  } else if (isKnownLeakedSecret(mfaKey, sha256hex)) {
    errors.push(
      "HRM_MFA_KEY matches a known-leaked value (2026-10 / 2026-11 archives, or the docker-compose 64-zero default).\n" +
      "  " + ROTATION_HINT,
    )
  } else if (!HEX64.test(mfaKey)) {
    errors.push(
      `HRM_MFA_KEY must be a 64-char hex string (got ${mfaKey.length} chars). ` +
      "A typo'd key silently produces a DIFFERENT key and every encrypted field becomes unreadable on revert.",
    )
  }

  // HIGH-1: HRM_SEED_PASSWORD must not be "Pass@123" in production.
  const seedPwd = process.env.HRM_SEED_PASSWORD || ""
  if (isProd && (seedPwd === "Pass@123" || seedPwd === "" || PLACEHOLDER_PATTERNS.test(seedPwd))) {
    errors.push(
      "HRM_SEED_PASSWORD must be overridden in production (current value is the well-known default or empty).\n" +
      "  This password protects the owner@<vendor> superuser with full TENANT_ADMIN_PERMS.",
    )
  }

  // HIGH-2/SEC-1: HRM_INTERNAL_TOKEN — warn when missing (fail-open is a
  // deliberate availability choice: only the ops sweep trigger and metrics
  // endpoint consume it), but REFUSE boot when it is a known-leaked value.
  const internalToken = process.env.HRM_INTERNAL_TOKEN || ""
  if (!internalToken) {
    warnings.push(
      "HRM_INTERNAL_TOKEN is not set — ADMS health POST sweep trigger and restore-drill will be disabled, and /api/metrics answers 503 (fail-closed).",
    )
  } else if (PLACEHOLDER_PATTERNS.test(internalToken)) {
    warnings.push(`HRM_INTERNAL_TOKEN is a placeholder ("${internalToken}") — replace with a real 32-char hex token.`)
  } else if (isKnownLeakedSecret(internalToken, sha256hex)) {
    errors.push(
      "HRM_INTERNAL_TOKEN matches a known-leaked value (2026-10 / 2026-11 archives). Anyone holding an archive can drive the metrics endpoint and the ops sweep.\n" +
      "  " + ROTATION_HINT,
    )
  }

  // OPS-7-09/SEC-1: HRM_BACKUP_KEY — warn when missing, refuse when leaked.
  // FORENSIC AUDIT 2026-11-10, FIN-038 (Phase 0): the backup key NO LONGER
  // lives in the runtime .env at all. scripts/backup.sh reads it from the
  // dedicated backup channel (deploy/backup.service →
  // /etc/systemd/system/hrm-backup.env, mode 600 — or a KMS/secret-manager
  // injection in hardened deployments). The runtime plane and the backup
  // plane are separate injection surfaces: whoever reads the app's .env must
  // NOT gain backup-decrypt capability (the FIN-001 amplifier). A missing
  // key here is the EXPECTED steady state for the app server; this warning
  // exists for operators who run scripts/backup.sh from an app-shaped
  // environment.
  const backupKey = process.env.HRM_BACKUP_KEY || ""
  if (!backupKey || PLACEHOLDER_PATTERNS.test(backupKey)) {
    warnings.push(
      "HRM_BACKUP_KEY is not set in this environment — that is expected on the app server (FIN-038: the key lives ONLY in the backup channel). " +
      "scripts/backup.sh run from this shell will be refused; to run it manually, source /etc/systemd/system/hrm-backup.env first " +
      "(see deploy/backup.service and docs/runbooks/secret-rotation.md).",
    )
  } else if (isKnownLeakedSecret(backupKey, sha256hex)) {
    errors.push(
      "HRM_BACKUP_KEY matches a known-leaked value (2026-10 / 2026-11 archives). Anyone holding an archive can decrypt every backup.\n" +
      "  " + ROTATION_HINT,
    )
  }

  // CRIT-1: DATABASE_URL asserted (deferred to first DB query otherwise — fail-fast here).
  const dbUrl = process.env.DATABASE_URL || ""
  if (!dbUrl) {
    errors.push("DATABASE_URL is not set — the server would boot clean and return 500 per request.")
  }

  // HIGH-16: warn if HRM_DEPLOYMENT_MODE=multi without Redis backing (advisory).
  if (process.env.HRM_DEPLOYMENT_MODE === "multi") {
    warnings.push(
      "HRM_DEPLOYMENT_MODE=multi — multi-instance requires Redis for rate limit, BgJob queue, and camera token cache. " +
      "See DEPLOYMENT-GUIDE.md §Multi-Instance.",
    )
  }

  // AUDIT H-4 (2026-11-07) — production deployments behind the shipped Caddy
  // reverse proxy MUST set HRM_TRUST_PROXY=1: without it resolveClientIp
  // returns null, every IP-keyed throttle collapses into a shared "unknown"
  // bucket (the payment-IPN endpoint once throttled the ENTIRE platform to 30
  // notifications per 10 minutes), and audit rows lose their client IP. A
  // warning (not a boot refusal): a deployment that genuinely terminates
  // traffic directly, without any proxy, is legitimate — but it must be a
  // conscious choice. The per-(provider, ref) IPN keys introduced with this
  // remediation keep revenue confirmations safe either way.
  if (isProd && process.env.HRM_TRUST_PROXY !== "1") {
    warnings.push(
      "HRM_TRUST_PROXY is not set to \"1\" while NODE_ENV=production — the deployment appears to run behind a reverse proxy " +
      "(see deploy/ Caddyfile) but will NOT trust X-Forwarded-For. Every IP-based throttle key collapses into a shared bucket, " +
      "and audit rows lose the client IP. Set HRM_TRUST_PROXY=\"1\" UNLESS the app terminates traffic directly with no proxy in front.",
    )
  }

  // MED-17: warn if MFA is not enforced for VENDOR_OWNER / HR_ADMIN (advisory).
  // (Actual enforcement is at the Role template level in types.ts.)

  if (warnings.length) {
    log?.warn("[env] configuration warnings:\n  - " + warnings.join("\n  - "))
  }
  if (errors.length) {
    throw new Error(
      "[env] configuration errors — refusing to start:\n  - " +
      errors.join("\n  - ") +
      "\n  See .env.example for the accepted values.",
    )
  }
  if (mfaKey && HEX64.test(mfaKey)) {
    log?.info("[env] HRM_MFA_KEY configured (64-char hex) — MFA + camera encryption key OK.")
  }
}

// ============ R-26 (W1) — boot-time multi-company schema assertion ============
// The five M1 columns (9_wave9zza_mc_expand_20261103) are the W1+ runtime
// contract: W1 code reads UserCompanyAccess delta columns and W2+ writers
// stamp AuditLog/BgJob/AttendancePolicyAssignment.companyId. A database that
// predates M1 (a missed deploy, a restored old backup, a replayed chain that
// stopped short) would otherwise boot fine and fail later at the first
// company-scoped write. Boot REFUSES instead — fail-closed, naming every
// missing column pair and the migration that supplies them. The check is
// read-only (information_schema only); it never modifies the database.
//
// The optional `client` parameter is the W1-AC-07 test hook (negative tests
// run against a scratch database built without M1); the production path
// resolves the app's own client and is unchanged.
const MC_REQUIRED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["AuditLog", "companyId"], // S1
  ["BgJob", "companyId"], // S2
  ["AttendancePolicyAssignment", "companyId"], // S3
  ["UserCompanyAccess", "permissions"], // S4a
  ["UserCompanyAccess", "excludedPermissions"], // S4b
]
const MC_REQUIRED_MIGRATION = "9_wave9zza_mc_expand_20261103"

// Structural $queryRaw contract (tag-form only — matches Prisma's signature so
// both the app client and a scratch-database PrismaClient satisfy it).
type RawClient = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T> }

export async function assertMultiCompanySchema(client?: RawClient): Promise<void> {
  const db: RawClient = client ?? (await import("./lib/db")).db as unknown as RawClient
  const rows = await db.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
        (table_name = 'AuditLog' AND column_name = 'companyId')
        OR (table_name = 'BgJob' AND column_name = 'companyId')
        OR (table_name = 'AttendancePolicyAssignment' AND column_name = 'companyId')
        OR (table_name = 'UserCompanyAccess' AND column_name IN ('permissions', 'excludedPermissions'))
      )
  `
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))
  const missing = MC_REQUIRED_COLUMNS.filter(([t, c]) => !present.has(`${t}.${c}`))
  if (missing.length > 0) {
    throw new Error(
      `[R-26] The database is missing the multi-company W1 schema — apply migration ${MC_REQUIRED_MIGRATION}. ` +
      `Missing column(s): ${missing.map(([t, c]) => `${t}.${c}`).join(", ")}. ` +
      "Refusing to boot (fail-closed): the server never starts against a schema it cannot serve safely.",
    )
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // node:crypto is imported HERE (Node runtime only) — see the header note:
    // a static import breaks the Edge compile of this file.
    const { createHash } = await import("node:crypto")
    const sha256hex: Sha256Hex = (v) => createHash("sha256").update(v).digest("hex")
    // FIN-032 (Phase 3) — boot diagnostics ride the structured logger too.
    // Dynamically imported (like node:crypto above) so the Edge compile of
    // this file stays clean: log.ts touches process.stdout, a Node-only global.
    const { loggerFor } = await import("./hrm-server/log")
    const boot = loggerFor("instrumentation")
    validateEnvKeys()
    validateEnvValues(sha256hex, boot)
    // R-26 (W1) — fail-closed schema assertion BEFORE any background worker
    // starts: the sweeper and the job runner are company-context writers in
    // W2+; they must never begin against a pre-M1 database.
    try {
      await assertMultiCompanySchema()
      boot.info("R-26 multi-company schema assertion passed (M1 columns present)")
    } catch (e) {
      boot.error("R-26 multi-company schema assertion failed", e)
      throw e
    }
    // HIGH-4: register SIGTERM/SIGINT handlers for graceful shutdown.
    // The handlers are idempotent — safe to register from every boot path.
    try {
      const { registerShutdownHandlers, setProcessHandler } = await import("./hrm-server/lifecycle")
      registerShutdownHandlers()
      // M-32 — logrotate reopen protocol: `systemctl reload hrm.service`
      // (ExecReload=/bin/kill -USR2) lands here after logrotate renames the
      // log file. Node cannot dup2 onto fd 1 from JS, so console output is
      // re-bound to a fresh append stream on the new path — the renamed inode
      // stops receiving writes and no log lines are lost.
      // 2026-10-07 — registered through the process-wide registry (replaced,
      // never stacked, on dev reloads); skipped on Windows, which has no
      // SIGUSR2 and no logrotate.
      if (process.platform !== "win32") setProcessHandler("SIGUSR2", () => {
        void (async () => {
          try {
            const logPath = process.env.HRM_LOG_FILE || "/opt/hrm/logs/hrm.log"
            const fs = await import("node:fs")
            if (!fs.existsSync(logPath)) return // not a file-redirect deployment (e.g. dev) — nothing to reopen
            const stream = fs.createWriteStream(logPath, { flags: "a" })
            const target = process as unknown as { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream }
            target.stdout = stream as unknown as NodeJS.WriteStream
            target.stderr = stream as unknown as NodeJS.WriteStream
            stream.write(`[hrm] log stream re-bound after rotation (${logPath})\n`)
          } catch (e) {
            // last-resort: the old stream is still functional (just pointing
            // at the rotated file) — never crash the server over log rotation
            boot.error("log reopen failed after rotation", e)
          }
        })()
      })
    } catch (e) {
      boot.warn("graceful-shutdown handler not registered", e instanceof Error ? e.message : e)
    }
    if ((process.env.ZKTECO_ADMS_ENABLED ?? "true") !== "false") {
      const { startSweeper } = await import("./hrm-server/zkteco/sweeper")
      startSweeper()
    }
    if ((process.env.HRM_JOBS_ENABLED ?? "true") !== "false") {
      const { startJobs } = await import("./hrm-server/jobs")
      startJobs()
    }
  }
}
