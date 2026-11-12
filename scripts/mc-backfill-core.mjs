#!/usr/bin/env bun
// ============ M3a core attribution backfill — mc-backfill-core.mjs ============
// AUTHORED in the M3a-preparation session (2026-11-04/05 UTC), HARDENED in the
// M3a script-hardening session (2026-11-05) resolving findings F-03, F-04,
// F-05, F-06 and F-07. This script is the operator-run journaled attribution
// repair defined by the authoritative documents (FINAL REMEDIATION PLAN §4.5,
// DEPLOYMENT MIGRATION STRATEGY §5 (Revision 3.1), FINAL DEPLOYMENT STRATEGY
// §2.2, PRODUCTION DATA READINESS PDR-1/7/8/9).
//
// PHASE COMPOSITION (DMS §5.2 — the documented run order):
//   R-ORP → R-ROL(--reset-roles, post-sign-off only) → R-JRN/R-ADJ →
//   R-SHF/R-HOL (class A) → R-TSK (class B) → R-APA → R-WFS → R-DUP (survey)
//
// EVERY repair follows the standing contract (DMS §5):
//   SELECT → compute → guarded UPDATE, journaled (_mc_backfill_journal),
//   --dry-run-aware, re-runnable. No business record is ever deleted.
//   Ambiguity never resolves silently — it lands in the report/manual list.
//
// HONESTY RULE (DMS §5.1 — applies to every phase): a default company is a
// valid owner only when the vendor has exactly ONE company (unambiguous).
// Multi-company vendors: anchor or NULL, never a guessed default. Never
// fabricate ownership to satisfy a constraint.
//
// F-01 RULE (inactive companies): an inactive company is NEVER treated as the
// active default anywhere in this script (vendorTopology resolves the default
// ACTIVE company with the exact runtime ordering of
// resolveProvisioningCompanyId: isDefault DESC, createdAt ASC). R-ORP imports
// the same helper the R-G provisioning patch uses; R-APA/R-WFS resolve their
// defaults through the same F-01-consistent topology.
//
// SCRIPT-SAFETY CONTRACTS (hardening session):
//   F-04 — every guarded UPDATE is a compare-and-set: it succeeds only while
//          the row still matches the state the repair decision was computed
//          from (expected old value + vendor ownership + the original repair
//          predicate). Zero-row results are CLASSIFIED (unchanged /
//          concurrent modification / missing / wrong vendor / predicate
//          mismatch) — never assumed to be harmless no-ops. Conflicts land
//          in the manual-review register.
//   F-05 — script-created UserCompanyAccess rows are journaled with their
//          EXACT primary key and full evidence (vendorId/userId/companyId/
//          role); --restore deletes only that exact row and only while it
//          still matches the script-created state. Pre-existing rows and
//          other runs' rows can never be deleted.
//   F-06 — a business mutation and its journal record commit in ONE
//          transaction (journal failure rolls the mutation back); R-WFS
//          workflow + copied steps commit atomically; the run record
//          (_mc_backfill_runs) distinguishes running / completed / failed /
//          interrupted / restored.
//   F-03 — phaseRAPA reads companyId from the query (a missing selected
//          property is never treated as a database NULL) and never silently
//          overwrites an unexpected existing company assignment.
//
// DEPLOYMENT GATE (unchanged, NOT satisfied in this session): M3a executes
// only after R2 is live on ALL application instances
// (B-7 decision → W1-AC-08 PASS → R1 deploy → R2 deploy → M3a execution).
// A real run therefore requires BOTH --confirm AND the operator gate
// acknowledgment M3A_EXECUTION_GATE_ACK=R2-LIVE-ON-ALL-INSTANCES (see the
// M3a operator runbook). --confirm alone is NOT a substitute for the gate.
// Until the gate is satisfied this script must not be run against any real
// operational database. Delivered with SYNTHETIC-fixture validation only.
//
// Usage:
//   bun run scripts/mc-backfill-core.mjs --dry-run            (no writes)
//   bun run scripts/mc-backfill-core.mjs --confirm             (real run — also needs the gate ack)
//   bun run scripts/mc-backfill-core.mjs --confirm --phase R-ORP
//   bun run scripts/mc-backfill-core.mjs --confirm --reset-roles [--deliberate <ids|file.json>]
//   bun run scripts/mc-backfill-core.mjs --restore <runId>
//
// Environment: DATABASE_URL (operator-supplied; the script prints it and
// refuses to write without --confirm). All timestamps are explicit UTC.

import crypto from "node:crypto"
import os from "node:os"
import { readFileSync } from "node:fs"

// The Prisma client is imported LAZILY (after the CLI's environment/safety
// checks) so a missing DATABASE_URL produces the script's own refusal message
// instead of a PrismaClient constructor crash (script-safety requirement).
let _db = null
async function getDb() {
  if (!_db) _db = (await import("../src/lib/db.ts")).db
  return _db
}

// ---------- small shared helpers ----------

const nowIso = () => new Date().toISOString() // explicit UTC, F-02 policy
const readText = (p) => readFileSync(p, "utf8")

// JS-side equality with SQL "IS NOT DISTINCT FROM" semantics for the values
// this script touches (TEXT or NULL). undefined is normalized to null — a
// missing selected property must never be treated as a database NULL (F-03).
function notDistinctFrom(a, b) {
  return (a ?? null) === (b ?? null)
}

// Two-int advisory-lock key (pg_advisory_xact_lock(int, int)) — FNV-1a split.
function advisoryKey(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0
    h2 = Math.imul(h2 + s.charCodeAt(i) * (i + 1), 16777619) >>> 0
  }
  return [h1 | 0, h2 | 0]
}

function parseArgs(argv) {
  const a = {
    dryRun: false, confirm: false, phases: [], resetRoles: false,
    deliberate: [], restore: null, vendor: null, json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === "--dry-run") a.dryRun = true
    else if (t === "--confirm") a.confirm = true
    else if (t === "--reset-roles") a.resetRoles = true
    else if (t === "--json") a.json = true
    else if (t === "--phase") a.phases.push(String(argv[++i]))
    else if (t === "--vendor") a.vendor = String(argv[++i])
    else if (t === "--deliberate") {
      const v = String(argv[++i])
      if (v.endsWith(".json")) {
        let parsed
        try { parsed = JSON.parse(readText(v)) } catch (e) { console.error(`Cannot read --deliberate file ${v}: ${e.message}`); process.exit(2) }
        if (!Array.isArray(parsed)) { console.error("--deliberate file must be a JSON array of access-row ids"); process.exit(2) }
        a.deliberate = parsed.map(String)
      } else a.deliberate = v.split(",").map((s) => s.trim()).filter(Boolean)
    } else if (t === "--restore") a.restore = String(argv[++i])
    else { console.error(`Unknown argument: ${t}`); process.exit(2) }
  }
  return a
}

const BUILTIN_ROLES = ["HR_ADMIN", "HR_MANAGER", "PAYROLL_OFFICER", "BRANCH_MANAGER", "DEPT_MANAGER", "EMPLOYEE", "VENDOR_OWNER", "SUPPORT"]

// ---------- guarded-UPDATE target registry (F-04) ----------
// Every table this script may mutate, its vendor-ownership column and the
// predicate columns its repairs are allowed to re-verify. guardedUpdate
// REFUSES unknown tables/columns (fail-safe — no string ever reaches SQL
// unvalidated).
const TARGET_TABLES = {
  "AccountJournal":             { vendorCol: "vendorId", predicateCols: ["refType", "refId", "status"] },
  "PayrollRun":                 { vendorCol: "vendorId", predicateCols: ["runType", "adjustRunId"] },
  "Shift":                      { vendorCol: "vendorId", predicateCols: ["branchId"] },
  "Holiday":                    { vendorCol: "vendorId", predicateCols: ["branchId"] },
  "Task":                       { vendorCol: "vendorId", predicateCols: ["assigneeId"] },
  "AttendancePolicyAssignment": { vendorCol: "vendorId", predicateCols: ["scopeType", "scopeId", "policyId"] },
  "UserCompanyAccess":          { vendorCol: "vendorId", predicateCols: ["userId", "role"] },
}
const MUTABLE_COLUMNS = new Set(["companyId", "role"]) // the only columns the script mutates

// ---------- journal + runs (progress) tables ----------

const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS _mc_backfill_journal (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  phase       TEXT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  dry_run     BOOLEAN NOT NULL DEFAULT false,
  target_table TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  column_name TEXT,
  old_value   JSONB,
  new_value   JSONB,
  note        TEXT,
  seq         BIGSERIAL
)`
const RUNS_DDL = `
CREATE TABLE IF NOT EXISTS _mc_backfill_runs (
  run_id     TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  dry_run    BOOLEAN NOT NULL DEFAULT false,
  phases     TEXT NOT NULL DEFAULT '',
  summary    JSONB,
  status     TEXT NOT NULL DEFAULT 'completed',
  pid        INTEGER,
  host       TEXT,
  error      TEXT
)`
// Upgrades for tables created by the pre-hardening format (idempotent).
const JOURNAL_UPGRADE_DDL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = '_mc_backfill_journal' AND column_name = 'seq') THEN
    ALTER TABLE _mc_backfill_journal ADD COLUMN seq BIGSERIAL;
  END IF;
END $$`
const RUNS_UPGRADE_DDL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = '_mc_backfill_runs' AND column_name = 'status') THEN
    ALTER TABLE _mc_backfill_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = '_mc_backfill_runs' AND column_name = 'pid') THEN
    ALTER TABLE _mc_backfill_runs ADD COLUMN pid INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = '_mc_backfill_runs' AND column_name = 'host') THEN
    ALTER TABLE _mc_backfill_runs ADD COLUMN host TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = '_mc_backfill_runs' AND column_name = 'error') THEN
    ALTER TABLE _mc_backfill_runs ADD COLUMN error TEXT;
  END IF;
END $$`

async function ensureJournalTables(client) {
  await client.$executeRawUnsafe(JOURNAL_DDL)
  await client.$executeRawUnsafe(RUNS_DDL)
  await client.$executeRawUnsafe(JOURNAL_UPGRADE_DDL)
  await client.$executeRawUnsafe(RUNS_UPGRADE_DDL)
}

// ---------- per-run context ----------

class RunCtx {
  constructor(runId, args, client) {
    this.runId = runId
    this.dryRun = args.dryRun
    this.args = args
    this.db = client // every phase reads/writes through THIS client (tests inject a failing one)
    this.vendorFilter = args.vendor || null
    // per-phase counters: { changed, unchanged, inserted, manual, skipped, conflict }
    this.counts = {}
    // manual-list entries: { phase, table, id, reason, detail }
    this.manual = []
  }
  phase(name) {
    if (!this.counts[name]) this.counts[name] = { changed: 0, unchanged: 0, inserted: 0, manual: 0, skipped: 0, conflict: 0 }
    return this.counts[name]
  }
}

/** Record one journal entry on the given client (the TRANSACTION client when
 *  the entry belongs to a mutation — F-06: journal + business row commit
 *  atomically). ALWAYS written (dry runs too, flagged) — the journal is the
 *  audit trail of intentions; --dry-run writes no business row but does
 *  record what it WOULD have done. */
async function journalOn(client, ctx, phase, table, id, action, column, oldValue, newValue, note) {
  await client.$executeRawUnsafe(
    `INSERT INTO _mc_backfill_journal (id, run_id, phase, ts, dry_run, target_table, target_id, action, column_name, old_value, new_value, note)
     VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    crypto.randomUUID(), ctx.runId, phase, ctx.dryRun, table, id, action, column ?? null,
    oldValue === undefined ? null : JSON.stringify(oldValue),
    newValue === undefined ? null : JSON.stringify(newValue),
    note ?? null,
  )
}

/** Classify the CURRENT database state of one row against the state a repair
 *  decision was computed from. Read-only; used by both the dry-run planner
 *  (so the dry-run plan equals the real-run plan — F-03/F-04) and by the
 *  zero-row classification after a compare-and-set that matched nothing.
 *  Returns { kind, ... } with kind one of:
 *    match            — vendor/predicate/old value all still as expected (the repair applies)
 *    alreadyAtTarget  — column already equals the proposed new value (idempotent no-op)
 *    concurrent       — column changed to a third value by someone else (CONFLICT)
 *    missing          — the row no longer exists (CONFLICT)
 *    wrongVendor      — the row is not owned by the expected vendor (CONFLICT)
 *    predicateMismatch— the original repair predicate no longer holds (CONFLICT)
 *    unexpected       — state matches yet the CAS matched nothing (defensive CONFLICT) */
async function classifyRow(client, table, id, vendorId, column, expectedOld, newValue, predicate = {}) {
  const spec = TARGET_TABLES[table]
  if (!spec) throw new Error(`guarded target table not registered: ${table}`)
  const predCols = Object.keys(predicate)
  for (const k of predCols) if (!spec.predicateCols.includes(k)) throw new Error(`predicate column ${k} not registered for ${table}`)
  const selPred = predCols.map((k) => `"${k}"`).join(", ")
  const rows = await client.$queryRawUnsafe(
    `SELECT "${spec.vendorCol}" AS vendor_id, "${column}" AS cur${selPred ? ", " + selPred : ""} FROM "${table}" WHERE "id" = $1`,
    id,
  )
  if (!rows.length) return { kind: "missing" }
  const r = rows[0]
  if (r.vendor_id !== vendorId) return { kind: "wrongVendor", currentVendorId: r.vendor_id }
  for (const k of predCols) {
    if (!notDistinctFrom(r[k], predicate[k])) return { kind: "predicateMismatch", field: k, expected: predicate[k] ?? null, current: r[k] ?? null }
  }
  const cur = r.cur ?? null
  if (notDistinctFrom(cur, newValue)) return { kind: "alreadyAtTarget" }
  if (notDistinctFrom(cur, expectedOld)) return { kind: "match" }
  return { kind: "concurrent", current: cur }
}

/** Guarded, journaled, compare-and-set UPDATE of one column (F-04).
 *
 *  The UPDATE succeeds ONLY while the row still satisfies ALL of:
 *    · the exact primary key,
 *    · vendor ownership (the vendor the repair decision was computed for),
 *    · the expected OLD column value (the state the decision came from),
 *    · the original repair predicate (e.g. branchId/scopeId/assigneeId).
 *  A concurrent modification is therefore a CONFLICT, never a successful
 *  repair — the mutation and its journal entry commit in ONE transaction,
 *  and zero-row results are classified (never assumed to be harmless).
 *
 *  Dry runs classify the same current state READ-ONLY and journal the intent,
 *  so a dry-run plan and a real-run plan are computed by the same rule.
 *
 *  Returns "changed" | "unchanged" | "conflict". */
async function guardedUpdate(ctx, phase, table, id, column, oldValue, newValue, note, opts = {}) {
  const c = ctx.phase(phase)
  const vendorId = opts.vendorId
  if (!vendorId) throw new Error(`guardedUpdate requires opts.vendorId (${table}:${id}) — vendor ownership is mandatory (F-04)`)
  const predicate = opts.predicate || {}
  const spec = TARGET_TABLES[table]
  if (!spec) throw new Error(`guarded target table not registered: ${table}`)
  if (!MUTABLE_COLUMNS.has(column)) throw new Error(`guarded target column not registered: ${table}.${column}`)
  for (const k of Object.keys(predicate)) {
    if (!spec.predicateCols.includes(k)) throw new Error(`predicate column ${k} not registered for ${table}`)
  }

  if (ctx.dryRun) {
    // Read-only classification — the SAME rule the real run applies (F-03:
    // dry-run and real-run behavior produce consistent plans).
    const cls = await classifyRow(ctx.db, table, id, vendorId, column, oldValue, newValue, predicate)
    if (cls.kind === "match") {
      c.changed++
      await journalOn(ctx.db, ctx, phase, table, id, "UPDATE", column, oldValue, newValue, note)
      return "changed"
    }
    if (cls.kind === "alreadyAtTarget") { c.unchanged++; return "unchanged" }
    c.conflict++
    manual(ctx, phase, table, id, `CONFLICT (dry-run classification: ${cls.kind}) — row does not match the state this repair was computed from`, { column, expectedOld: oldValue ?? null, ...cls })
    return "conflict"
  }

  // Compare-and-set + journal entry in ONE transaction (F-06: journal failure
  // can never leave an unrecorded business mutation; rollback leaves no
  // partially-applied repair).
  const predKeys = Object.keys(predicate)
  const predSql = predKeys.map((k, i) => ` AND "${k}" IS NOT DISTINCT FROM $${5 + i}::text`).join("")
  const predArgs = predKeys.map((k) => predicate[k] ?? null)
  let updated = 0
  await ctx.db.$transaction(async (tx) => {
    updated = await tx.$executeRawUnsafe(
      `UPDATE "${table}" SET "${column}" = $1::text
       WHERE "id" = $2 AND "${spec.vendorCol}" = $3 AND "${column}" IS NOT DISTINCT FROM $4::text${predSql}`,
      newValue ?? null, id, vendorId, oldValue ?? null, ...predArgs,
    )
    if (updated > 0) {
      await journalOn(tx, ctx, phase, table, id, "UPDATE", column, oldValue, newValue, note)
    }
  })
  if (updated > 0) { c.changed++; return "changed" }

  // Zero rows — classify accurately (F-04: never assume a harmless no-op).
  const cls = await classifyRow(ctx.db, table, id, vendorId, column, oldValue, newValue, predicate)
  if (cls.kind === "alreadyAtTarget") { c.unchanged++; return "unchanged" }
  c.conflict++
  const reason = {
    concurrent: "CONFLICT (concurrently modified): the column changed to a third value after this repair was computed",
    missing: "CONFLICT (missing): the target row no longer exists",
    wrongVendor: "CONFLICT (wrong vendor): the row is not owned by the vendor this repair was computed for",
    predicateMismatch: `CONFLICT (predicate mismatch): the original repair predicate no longer holds (${cls.field})`,
    match: "CONFLICT (unexpected zero-row CAS): state appears to match yet the compare-and-set matched nothing — treat as concurrently modified",
    alreadyAtTarget: "unchanged",
  }[cls.kind] || `CONFLICT (${cls.kind})`
  manual(ctx, phase, table, id, reason, { column, expectedOld: oldValue ?? null, proposed: newValue ?? null, ...cls })
  return "conflict"
}

function manual(ctx, phase, table, id, reason, detail) {
  ctx.phase(phase).manual++
  ctx.manual.push({ phase, table, id, reason, detail: detail ?? null })
}

// Exported for the synthetic test suites (direct CAS/classification tests and
// the target-table vendor-scoping verification).
export const GUARDED_TARGET_TABLES = TARGET_TABLES
export { RunCtx, classifyRow, guardedUpdate }

// ---------- vendor topology (F-07: F-01-consistent) ----------
/** vendorId → {
 *   companies             — all company rows (id, isDefault, active, createdAt)
 *   activeCompanies       — the ACTIVE subset
 *   singleCompany         — exactly ONE company row exists (any flags)
 *   singleActiveCompanyId — the only company's id when the vendor has exactly
 *                           one company AND it is ACTIVE (the honesty-rule
 *                           carve-out, F-01-consistent); null otherwise
 *   defaultActiveId       — the vendor's default ACTIVE company, resolved with
 *                           the EXACT runtime ordering of resolveProvisioning-
 *                           CompanyId (isDefault DESC, createdAt ASC); null
 *                           when the vendor has no active company
 *   duplicateActiveDefaults — more than one ACTIVE isDefault=true row (data
 *                           defect; callers must surface it for the operator)
 *   anyDefaultInactive    — an INACTIVE company carries the default flag (the
 *                           F-01 case: never treated as the active default)
 * } */
async function vendorTopology(client) {
  const companies = await client.company.findMany({ select: { id: true, vendorId: true, isDefault: true, active: true, createdAt: true } })
  const byVendor = new Map()
  for (const c of companies) {
    if (!byVendor.has(c.vendorId)) byVendor.set(c.vendorId, { companies: [], activeCompanies: [], singleCompany: false, singleActiveCompanyId: null, defaultActiveId: null, duplicateActiveDefaults: false, anyDefaultInactive: false })
    byVendor.get(c.vendorId).companies.push(c)
    if (c.active) byVendor.get(c.vendorId).activeCompanies.push(c)
  }
  for (const v of byVendor.values()) {
    v.singleCompany = v.companies.length === 1
    if (v.singleCompany && v.companies[0].active) v.singleActiveCompanyId = v.companies[0].id
    // F-01 runtime ordering: active companies, isDefault DESC, createdAt ASC.
    const sorted = [...v.activeCompanies].sort((a, b) =>
      (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    v.defaultActiveId = sorted[0]?.id ?? null
    v.duplicateActiveDefaults = v.activeCompanies.filter((c) => c.isDefault).length > 1
    v.anyDefaultInactive = v.companies.some((c) => c.isDefault && !c.active)
  }
  return byVendor
}

// ============================================================ R-ORP
/** Orphan users (zero UserCompanyAccess rows) receive the default row:
 *  company = the F-01-consistent rule (employment company when known AND
 *  active, else the vendor's default ACTIVE company — the same helper the
 *  R-G provisioning patch uses), role = User.role, deltas '[]'/'[]',
 *  active/isDefault = true. Vendors without an active company keep the
 *  row-less behavior (skipped, listed).
 *
 *  F-05/F-06: the creation runs in ONE SERIALIZABLE transaction with a
 *  per-user advisory lock and a re-check; the exact created primary key and
 *  full evidence are journaled atomically with the insert. A concurrent
 *  grant (another process creates the row first) is a classified no-op or a
 *  rolled-back conflict — never a duplicate row. */
async function phaseRORP(ctx) {
  const users = await ctx.db.user.findMany({
    where: {
      companyAccess: { none: {} }, // the R-ORP cohort: zero access rows
      ...(ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : {}),
    },
    select: { id: true, vendorId: true, role: true, email: true, employeeId: true },
  })
  for (const u of users) {
    let empCompanyId = null
    if (u.employeeId) {
      const emp = await ctx.db.employee.findFirst({ where: { id: u.employeeId, vendorId: u.vendorId }, select: { companyId: true } })
      empCompanyId = emp?.companyId ?? null
    }
    // resolveProvisioningCompanyId is imported lazily (module-safety) — the
    // SAME helper the R-G runtime patch uses (F-01 rule, decision D-M3a-2).
    const { resolveProvisioningCompanyId } = await import("../src/hrm-server/company.ts")
    const target = await resolveProvisioningCompanyId(u.vendorId, empCompanyId)
    if (!target) {
      manual(ctx, "R-ORP", "User", u.id, "vendor has no active company — row-less behavior preserved", { email: u.email })
      continue
    }
    const c = ctx.phase("R-ORP")
    if (ctx.dryRun) {
      c.inserted++
      await journalOn(ctx.db, ctx, "R-ORP", "UserCompanyAccess", `user:${u.id}`, "INSERT", null, null,
        { vendorId: u.vendorId, userId: u.id, companyId: target, role: u.role, permissions: "[]", excludedPermissions: "[]", active: true, isDefault: true, grantedByName: "M3a/R-ORP auto-backfill" },
        "orphan user default access row (dry-run intent — exact row id assigned at real-run time)")
      continue
    }
    // Real run: advisory lock + re-check + create + verify, journaled — ONE
    // transaction. Deliberately READ COMMITTED (the Prisma default): every
    // statement then sees the LATEST committed state, so the in-transaction
    // re-check and the post-create verification genuinely observe a
    // concurrent grant that committed while this repair was in flight (a
    // SERIALIZABLE snapshot taken at the first statement would NOT — the
    // hardening test proved that hole). The advisory key serializes
    // concurrent script instances; the post-verify rolls our insert back if
    // a non-cooperating writer still lands one first.
    // RESIDUAL (documented, not closable without a schema unique on
    // (userId, companyId) — M4 territory): a grant committing in the window
    // between the post-verify count and this transaction's COMMIT can still
    // produce a duplicate. The script never duplicates on its own retries.
    const [k1, k2] = advisoryKey(`m3a:uca:${u.vendorId}:${u.id}`)
    try {
      const outcome = await ctx.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock($1::int, $2::int) AS locked) sub`, k1, k2)
        // guard: still no row? (idempotent re-run / concurrent grant)
        const still = await tx.userCompanyAccess.findFirst({ where: { userId: u.id }, select: { id: true } })
        if (still) return { kind: "unchanged" }
        const created = await tx.userCompanyAccess.create({
          data: {
            vendorId: u.vendorId, userId: u.id, companyId: target, role: u.role,
            permissions: "[]", excludedPermissions: "[]", active: true, isDefault: true,
            grantedByName: "M3a/R-ORP auto-backfill",
          },
        })
        // post-verify: if a concurrent grant landed, roll our insert back —
        // never leave a duplicate row.
        const n = await tx.userCompanyAccess.count({ where: { userId: u.id } })
        if (n > 1) throw new Error("M3A_CONCURRENT_GRANT")
        // F-05: journal the EXACT created primary key + full evidence,
        // atomically with the insert.
        await journalOn(tx, ctx, "R-ORP", "UserCompanyAccess", `uca:${created.id}`, "INSERT", null, null,
          { id: created.id, vendorId: u.vendorId, userId: u.id, companyId: target, role: u.role },
          "orphan user default access row")
        return { kind: "inserted", id: created.id }
      })
      if (outcome.kind === "inserted") c.inserted++
      else c.unchanged++
    } catch (e) {
      if (e && (e.message === "M3A_CONCURRENT_GRANT" || e.code === "P2034")) {
        // Concurrent grant / serialization failure — classified conflict.
        c.conflict++
        manual(ctx, "R-ORP", "UserCompanyAccess", `user:${u.id}`, "CONFLICT (concurrent access-row creation): another process granted a row while this repair was in flight — the script's own insert was rolled back", { email: u.email, vendorId: u.vendorId })
        continue
      }
      throw e
    }
  }
}

// ============================================================ R-JRN / R-ADJ
/** refType → anchor resolution for a NULL-company journal. Returns the target
 *  companyId or null (→ manual list). All lookups are vendor-scoped.
 *  EXPORTED — mc-remediation-report.mjs reuses the SAME map so the report's
 *  dead-ref list can never drift from the repair's anchor rules. */
export async function journalAnchor(client, vendorId, refType, refId) {
  if (!refId) return { target: null, reason: "refId is NULL (manual voucher/unknown origin)" }
  switch (refType) {
    case "PAYROLL": case "SALARY_PAYOUT": case "PAYROLL_REVERSAL": {
      const run = await client.payrollRun.findFirst({ where: { id: refId, vendorId }, select: { companyId: true } })
      if (!run) return { target: null, reason: "dead ref: PayrollRun not found (or belongs to another vendor)" }
      if (!run.companyId) return { target: null, reason: "dead anchor: source PayrollRun is NULL-company" }
      return { target: run.companyId }
    }
    case "LOAN_DISBURSE": {
      const loan = await client.loan.findFirst({ where: { id: refId, vendorId }, select: { employeeId: true } })
      if (!loan) return { target: null, reason: "dead ref: Loan not found (or belongs to another vendor)" }
      const emp = await client.employee.findFirst({ where: { id: loan.employeeId, vendorId }, select: { companyId: true } })
      if (!emp || !emp.companyId) return { target: null, reason: "dead anchor: employee missing or NULL-company" }
      return { target: emp.companyId }
    }
    case "LOAN_RECOVERY": {
      const inst = await client.loanInstallment.findFirst({ where: { id: refId, vendorId }, select: { loanId: true } })
      if (!inst) return { target: null, reason: "dead ref: LoanInstallment not found (or belongs to another vendor)" }
      const loan = await client.loan.findFirst({ where: { id: inst.loanId, vendorId }, select: { employeeId: true } })
      if (!loan) return { target: null, reason: "dead ref: Loan not found" }
      const emp = await client.employee.findFirst({ where: { id: loan.employeeId, vendorId }, select: { companyId: true } })
      if (!emp || !emp.companyId) return { target: null, reason: "dead anchor: employee missing or NULL-company" }
      return { target: emp.companyId }
    }
    case "ADVANCE_PAY": case "ADVANCE_RECOVER": {
      const adv = await client.advance.findFirst({ where: { id: refId, vendorId }, select: { employeeId: true } })
      if (!adv) return { target: null, reason: "dead ref: Advance not found (or belongs to another vendor)" }
      const emp = await client.employee.findFirst({ where: { id: adv.employeeId, vendorId }, select: { companyId: true } })
      if (!emp || !emp.companyId) return { target: null, reason: "dead anchor: employee missing or NULL-company" }
      return { target: emp.companyId }
    }
    case "EXPENSE_REIMBURSEMENT": {
      const claim = await client.expenseClaim.findFirst({ where: { id: refId, vendorId }, select: { employeeId: true } })
      if (!claim) return { target: null, reason: "dead ref: ExpenseClaim not found (or belongs to another vendor)" }
      const emp = await client.employee.findFirst({ where: { id: claim.employeeId, vendorId }, select: { companyId: true } })
      if (!emp || !emp.companyId) return { target: null, reason: "dead anchor: employee missing or NULL-company" }
      return { target: emp.companyId }
    }
    case "SETTLEMENT": {
      const fs = await client.finalSettlement.findFirst({ where: { id: refId, vendorId }, select: { resignationId: true } })
      if (!fs) return { target: null, reason: "dead ref: FinalSettlement not found (or belongs to another vendor)" }
      const res = await client.resignation.findFirst({ where: { id: fs.resignationId, vendorId }, select: { employeeId: true } })
      if (!res) return { target: null, reason: "dead ref: Resignation not found" }
      const emp = await client.employee.findFirst({ where: { id: res.employeeId, vendorId }, select: { companyId: true } })
      if (!emp || !emp.companyId) return { target: null, reason: "dead anchor: employee missing or NULL-company" }
      return { target: emp.companyId }
    }
    default:
      return { target: null, reason: `no anchor rule for refType ${refType} (manual voucher / unmapped type)` }
  }
}

async function phaseRJRN(ctx) {
  const journals = await ctx.db.accountJournal.findMany({
    where: { companyId: null, ...(ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : {}) },
    select: { id: true, vendorId: true, refType: true, refId: true, status: true },
  })
  for (const j of journals) {
    const { target, reason } = await journalAnchor(ctx.db, j.vendorId, j.refType, j.refId)
    if (!target) {
      manual(ctx, "R-JRN", "AccountJournal", j.id, reason, { refType: j.refType, refId: j.refId, status: j.status })
      continue
    }
    await guardedUpdate(ctx, "R-JRN", "AccountJournal", j.id, "companyId", null, target,
      `anchor via ${j.refType} ref`, { vendorId: j.vendorId, predicate: { refType: j.refType, refId: j.refId } })
  }
}

async function phaseRADJ(ctx) {
  const runs = await ctx.db.payrollRun.findMany({
    where: { runType: "ADJUSTMENT", companyId: null, ...(ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : {}) },
    select: { id: true, vendorId: true, adjustRunId: true },
  })
  for (const r of runs) {
    if (!r.adjustRunId) { manual(ctx, "R-ADJ", "PayrollRun", r.id, "dead ref: no source run (adjustRunId NULL)"); continue }
    const src = await ctx.db.payrollRun.findFirst({ where: { id: r.adjustRunId, vendorId: r.vendorId }, select: { companyId: true } })
    if (!src) { manual(ctx, "R-ADJ", "PayrollRun", r.id, "dead ref: source run not found (or belongs to another vendor)"); continue }
    if (!src.companyId) { manual(ctx, "R-ADJ", "PayrollRun", r.id, "dead anchor: source run is NULL-company"); continue }
    await guardedUpdate(ctx, "R-ADJ", "PayrollRun", r.id, "companyId", null, src.companyId, "anchor via source run",
      { vendorId: r.vendorId, predicate: { runType: "ADJUSTMENT", adjustRunId: r.adjustRunId } })
  }
}

// ============================================================ R-SHF / R-HOL (class A)
/** Class A anchor rule (DMS §5.1): branchId present → branch's company.
 *  branchId NULL → PRESERVE NULL (class A). Under the honesty rule a
 *  migration default-stamp is only valid for single-company vendors, so a
 *  default-stamped branchId-NULL row of a MULTI-company vendor is reset to
 *  NULL (preserved class A) and listed; single-company vendors keep the
 *  unambiguous stamp (ownership uniqueness is a count fact — the active flag
 *  governs provisioning/default selection, not who owns the row). */
async function classAAnchorRow(ctx, phase, row, topo, kind) {
  // kind: "Shift" | "Holiday" — both carry branchId ("null = all branches")
  if (row.branchId) {
    const branch = await ctx.db.branch.findFirst({ where: { id: row.branchId, vendorId: row.vendorId }, select: { companyId: true } })
    if (!branch || !branch.companyId) {
      manual(ctx, phase, kind, row.id, "dead anchor: branch missing or NULL-company", { branchId: row.branchId })
      return
    }
    if (row.companyId === branch.companyId) { ctx.phase(phase).unchanged++; return }
    await guardedUpdate(ctx, phase, kind, row.id, "companyId", row.companyId, branch.companyId, "anchor via branch",
      { vendorId: row.vendorId, predicate: { branchId: row.branchId } })
    return
  }
  // branchId NULL → class A target: NULL companyId
  if (row.companyId == null) { ctx.phase(phase).unchanged++; return } // already preserved class A
  const vendor = topo.get(row.vendorId)
  if (vendor?.singleCompany) {
    // single-company vendor: the default stamp was unambiguous → keep (no write)
    ctx.phase(phase).unchanged++
    return
  }
  await guardedUpdate(ctx, phase, kind, row.id, "companyId", row.companyId, null, "multi-company vendor: migration default-stamp reset to preserved-NULL class A",
    { vendorId: row.vendorId, predicate: { branchId: null } })
}

async function phaseRSHF(ctx, topo) {
  const rows = await ctx.db.shift.findMany({
    where: ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : undefined,
    select: { id: true, vendorId: true, companyId: true, branchId: true, name: true },
  })
  for (const s of rows) await classAAnchorRow(ctx, "R-SHF", s, topo, "Shift")
}

async function phaseRHOL(ctx, topo) {
  const rows = await ctx.db.holiday.findMany({
    where: ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : undefined,
    select: { id: true, vendorId: true, companyId: true, branchId: true, name: true, date: true },
  })
  for (const h of rows) await classAAnchorRow(ctx, "R-HOL", h, topo, "Holiday")
}

// ============================================================ R-TSK (class B)
/** Class B rule (DMS §5.1): assignee resolvable to an employee with a
 *  company → that company. Dangling assignee (or NULL-company employee) →
 *  PRESERVE NULL (class B) — target NULL in every vendor: dead evidence is
 *  unattributable by design (D8); the default-stamped form of such a row is
 *  reset to NULL and listed. */
async function phaseRTSK(ctx) {
  const rows = await ctx.db.task.findMany({
    where: ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : undefined,
    select: { id: true, vendorId: true, companyId: true, assigneeId: true, title: true, status: true },
  })
  for (const t of rows) {
    const emp = await ctx.db.employee.findFirst({ where: { id: t.assigneeId, vendorId: t.vendorId }, select: { companyId: true } })
    if (emp && emp.companyId) {
      if (t.companyId === emp.companyId) { ctx.phase("R-TSK").unchanged++; continue }
      await guardedUpdate(ctx, "R-TSK", "Task", t.id, "companyId", t.companyId, emp.companyId, "anchor via assignee employment",
        { vendorId: t.vendorId, predicate: { assigneeId: t.assigneeId } })
      continue
    }
    // class B: unattributable → target NULL
    const reason = !emp
      ? "class B: dangling assignee — preserved NULL (tasks.orphans.* is the remediation path)"
      : "class B: assignee exists but employment is NULL-company (dead anchor) — preserved NULL"
    if (t.companyId == null) {
      ctx.phase("R-TSK").unchanged++
      manual(ctx, "R-TSK", "Task", t.id, reason, { assigneeId: t.assigneeId, title: t.title, status: t.status })
      continue
    }
    await guardedUpdate(ctx, "R-TSK", "Task", t.id, "companyId", t.companyId, null, "class B: unattributable — default-stamp reset to preserved-NULL",
      { vendorId: t.vendorId, predicate: { assigneeId: t.assigneeId } })
  }
}

// ============================================================ R-APA
/** AttendancePolicyAssignment backfill (F-03/F-07): scope row's company for
 *  BRANCH/DEPARTMENT/EMPLOYEE scopes, resolved through vendor-owned source
 *  records only (a cross-vendor scopeId is a dead ref, never an anchor).
 *  companyId is SELECTED (a missing selected property is never treated as a
 *  database NULL — F-03) and an unexpected existing assignment on an
 *  ALL_EMPLOYEES row is NEVER silently overwritten (operator decision).
 *  ALL_EMPLOYEES is tenant-wide by construction: single-ACTIVE-company
 *  vendors stamp the (only) company; a single company that is INACTIVE is
 *  never treated as the valid active default (F-01/F-07 — kept NULL,
 *  listed); multi-company vendors keep NULL (honesty rule — never a guessed
 *  default) and are listed for the operator. */
async function phaseRAPA(ctx, topo) {
  const rows = await ctx.db.attendancePolicyAssignment.findMany({
    where: ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : undefined,
    select: { id: true, vendorId: true, companyId: true, scopeType: true, scopeId: true, policyId: true },
  })
  for (const a of rows) {
    if (a.scopeType === "ALL_EMPLOYEES") {
      const vendor = topo.get(a.vendorId)
      if (vendor && vendor.singleCompany) {
        const only = vendor.companies[0]
        if (!only.active) {
          // F-07: an inactive company is never the active default — even
          // when it is the only company. Kept NULL, listed for the operator.
          manual(ctx, "R-APA", "AttendancePolicyAssignment", a.id, "ALL_EMPLOYEES on a single-company vendor whose only company is INACTIVE — never treated as the active default (F-01); kept NULL for the operator", { policyId: a.policyId, companyId: only.id })
          ctx.phase("R-APA").skipped++
          continue
        }
        if (a.companyId === only.id) { ctx.phase("R-APA").unchanged++; continue }
        if (a.companyId == null) {
          // single-ACTIVE-company vendor: unambiguous owner
          await guardedUpdate(ctx, "R-APA", "AttendancePolicyAssignment", a.id, "companyId", null, only.id,
            "ALL_EMPLOYEES single-company vendor: unambiguous default (active)", { vendorId: a.vendorId, predicate: { scopeType: "ALL_EMPLOYEES" } })
          continue
        }
        // stamped to some other company — NEVER silently overwritten (F-03)
        manual(ctx, "R-APA", "AttendancePolicyAssignment", a.id, "unexpected existing companyId on ALL_EMPLOYEES row — operator decision (not overwritten)", { policyId: a.policyId, currentCompanyId: a.companyId })
        continue
      }
      if (a.companyId != null) {
        // F-03: a multi-company vendor's ALL_EMPLOYEES row that already
        // carries a companyId is kept AS-IS (never overwritten, never reset
        // to NULL) and listed distinctly from the NULL rows.
        manual(ctx, "R-APA", "AttendancePolicyAssignment", a.id, "unexpected existing companyId on ALL_EMPLOYEES row (multi-company vendor) — kept as-is for the operator (never overwritten, never guessed)", { policyId: a.policyId, currentCompanyId: a.companyId })
        continue
      }
      manual(ctx, "R-APA", "AttendancePolicyAssignment", a.id, "ALL_EMPLOYEES on a multi-company vendor — tenant-wide by construction; kept NULL for the operator (never a guessed default)", { policyId: a.policyId })
      ctx.phase("R-APA").skipped++
      continue
    }
    if (!a.scopeId) { manual(ctx, "R-APA", "AttendancePolicyAssignment", a.id, "dead anchor: scopeId NULL for a scoped row", { scopeType: a.scopeType }); continue }
    let target = null
    if (a.scopeType === "BRANCH") {
      const b = await ctx.db.branch.findFirst({ where: { id: a.scopeId, vendorId: a.vendorId }, select: { companyId: true } })
      target = b?.companyId ?? null
    } else if (a.scopeType === "DEPARTMENT") {
      const d = await ctx.db.department.findFirst({ where: { id: a.scopeId, vendorId: a.vendorId }, select: { companyId: true } })
      target = d?.companyId ?? null
    } else if (a.scopeType === "EMPLOYEE") {
      const e = await ctx.db.employee.findFirst({ where: { id: a.scopeId, vendorId: a.vendorId }, select: { companyId: true } })
      target = e?.companyId ?? null
    }
    if (!target) { manual(ctx, "R-APA", "AttendancePolicyAssignment", a.id, `dead anchor: ${a.scopeType} scope row missing, NULL-company, or belongs to another vendor`, { scopeId: a.scopeId }); continue }
    if (a.companyId === target) { ctx.phase("R-APA").unchanged++; continue }
    // Scoped rows: the vendor-owned source record is the authoritative anchor
    // (the documented safe correction — journaled, compare-and-set, and thus
    // reversible; a concurrent scope re-point is a classified conflict).
    await guardedUpdate(ctx, "R-APA", "AttendancePolicyAssignment", a.id, "companyId", a.companyId, target, `anchor via ${a.scopeType} scope`,
      { vendorId: a.vendorId, predicate: { scopeType: a.scopeType, scopeId: a.scopeId } })
  }
}

// ============================================================ R-WFS
/** Re-seed the tenant NULL-fallback approval workflow (SEC-04): for every
 *  (vendor, processType) that has workflow rows but NO NULL-company row,
 *  INSERT exactly one NULL-company workflow + copied steps. F-06/F-07:
 *  creation (workflow + ALL steps + journal) commits in ONE SERIALIZABLE
 *  transaction guarded by a per-(vendor, processType) advisory lock and a
 *  post-create verification — a partially-created workflow or a duplicate
 *  NULL-fallback row can never be left behind. Template selection is
 *  EXPLICIT and F-01-consistent: the vendor's default ACTIVE company's row
 *  (isDefault DESC, createdAt ASC — the same ordering as the runtime
 *  resolver), else the earliest row among ACTIVE companies; a vendor whose
 *  only candidate rows live on INACTIVE companies is listed for the operator
 *  (an inactive default is never silently assumed valid). Vendors ×
 *  processTypes with no rows at all are left unconfigured (nothing to copy —
 *  pre-existing state, listed). Multiple existing NULL rows are listed,
 *  never auto-merged. No approval chain is ever invented. */
async function phaseRWFS(ctx, topo) {
  const wf = await ctx.db.approvalWorkflow.findMany({
    where: ctx.vendorFilter ? { vendorId: ctx.vendorFilter } : undefined,
    select: { id: true, vendorId: true, companyId: true, processType: true, name: true, active: true, description: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })
  const groups = new Map()
  for (const w of wf) {
    const k = `${w.vendorId}\u0000${w.processType}`
    if (!groups.has(k)) groups.set(k, { vendorId: w.vendorId, processType: w.processType, rows: [] })
    groups.get(k).rows.push(w)
  }
  for (const g of groups.values()) {
    const nullRows = g.rows.filter((r) => r.companyId == null)
    if (nullRows.length > 1) {
      manual(ctx, "R-WFS", "ApprovalWorkflow", `vendor:${g.vendorId}/${g.processType}`, "multiple NULL-fallback rows exist (NULLS DISTINCT race) — operator must merge; never auto-merged", { count: nullRows.length })
      continue
    }
    if (nullRows.length === 1) { ctx.phase("R-WFS").unchanged++; continue }

    // ---- explicit, F-01-consistent template selection ----
    const vendor = topo.get(g.vendorId)
    const activeCos = new Map((vendor?.activeCompanies || []).map((c) => [c.id, c]))
    const candidates = g.rows.filter((r) => r.companyId != null && activeCos.has(r.companyId))
    if (!candidates.length) {
      manual(ctx, "R-WFS", "ApprovalWorkflow", `vendor:${g.vendorId}/${g.processType}`,
        vendor?.defaultActiveId
          ? "no workflow row on an ACTIVE company to copy from — never copied from an inactive company silently (F-01); operator decides"
          : "no workflow row on an ACTIVE company to copy from (vendor has no active company) — operator decides")
      continue
    }
    // Order by the F-01 runtime rule: default-flagged ACTIVE company first,
    // then earliest-created workflow. Deterministic; matches the company the
    // runtime resolver treats as the default.
    candidates.sort((a, b) =>
      ((activeCos.get(b.companyId)?.isDefault ? 1 : 0) - (activeCos.get(a.companyId)?.isDefault ? 1 : 0)) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    const templateRow = candidates[0]
    if (vendor?.duplicateActiveDefaults) {
      manual(ctx, "R-WFS", "ApprovalWorkflow", `vendor:${g.vendorId}/${g.processType}`, "duplicate default flags among ACTIVE companies (data defect) — template chosen deterministically by the F-01 ordering (isDefault DESC, createdAt ASC); operator should fix the flags", { templateWorkflowId: templateRow.id })
    }

    const steps = await ctx.db.approvalStep.findMany({ where: { workflowId: templateRow.id }, orderBy: { sequence: "asc" } })
    const c = ctx.phase("R-WFS")
    if (ctx.dryRun) {
      c.inserted++
      await journalOn(ctx.db, ctx, "R-WFS", "ApprovalWorkflow", `vendor:${g.vendorId}/${g.processType}`, "INSERT", null, null,
        { processType: g.processType, templateWorkflowId: templateRow.id, steps: steps.length, companyId: null }, "NULL-fallback workflow seed (dry-run intent)")
      continue
    }
    // ONE transaction: advisory lock → re-check → workflow + steps + journal
    // → verify. A partial creation or a concurrent NULL-fallback seed rolls
    // everything back (F-06). READ COMMITTED for the same reason as R-ORP:
    // the re-check and the post-create verification must see the LATEST
    // committed state, not a stale snapshot. The advisory lock serializes
    // concurrent script instances. RESIDUAL (M4's NULLS NOT DISTINCT unique
    // on (companyId, processType) closes it): an app-process seed committing
    // between the post-verify and this transaction's COMMIT could still
    // produce a second NULL row — reported by the next run's manual list,
    // never auto-merged.
    const [k1, k2] = advisoryKey(`m3a:wf:${g.vendorId}:${g.processType}`)
    try {
      const outcome = await ctx.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock($1::int, $2::int) AS locked) sub`, k1, k2)
        const nullNow = await tx.approvalWorkflow.count({ where: { vendorId: g.vendorId, processType: g.processType, companyId: null } })
        if (nullNow > 0) return { kind: "unchanged" } // a concurrent run seeded it first
        const created = await tx.approvalWorkflow.create({
          data: {
            vendorId: g.vendorId, companyId: null, processType: g.processType,
            name: templateRow.name, active: templateRow.active, description: templateRow.description,
          },
        })
        for (const s of steps) {
          await tx.approvalStep.create({
            data: {
              vendorId: s.vendorId, workflowId: created.id, sequence: s.sequence, name: s.name,
              approverRole: s.approverRole, approverUserId: s.approverUserId, departmentScope: s.departmentScope,
              branchScope: s.branchScope, amountThreshold: s.amountThreshold, required: s.required,
              allowDelegation: s.allowDelegation, rejectBehavior: s.rejectBehavior,
            },
          })
        }
        const n = await tx.approvalWorkflow.count({ where: { vendorId: g.vendorId, processType: g.processType, companyId: null } })
        if (n > 1) throw new Error("M3A_CONCURRENT_WF_SEED") // rolls the whole creation back
        await journalOn(tx, ctx, "R-WFS", "ApprovalWorkflow", `wf:${created.id}`, "INSERT", null, null,
          { id: created.id, workflowId: created.id, vendorId: g.vendorId, processType: g.processType, templateWorkflowId: templateRow.id, steps: steps.length, companyId: null },
          "NULL-fallback workflow seed (+steps)")
        return { kind: "inserted", id: created.id }
      })
      if (outcome.kind === "inserted") c.inserted++
      else c.unchanged++
    } catch (e) {
      if (e && (e.message === "M3A_CONCURRENT_WF_SEED" || e.code === "P2034")) {
        c.conflict++
        manual(ctx, "R-WFS", "ApprovalWorkflow", `vendor:${g.vendorId}/${g.processType}`, "CONFLICT (concurrent NULL-fallback workflow creation): another process seeded a row while this repair was in flight — this script's creation was rolled back", {})
        continue
      }
      throw e
    }
  }
}

// ============================================================ R-ROL (--reset-roles)
/** The audited reset pass — ONLY after the reviewed report sign-off:
 *  C4/C5 always reset to User.role; C2/C3 reset unless the row id is in the
 *  --deliberate set (the written sign-off). Every reset is a compare-and-set
 *  on the role the decision was computed from (F-04: a concurrently modified
 *  role is a classified conflict, never an overwrite) and is journaled +
 *  reversible. */
async function phaseResetRoles(ctx) {
  const rows = await ctx.db.$queryRawUnsafe(`
    SELECT a."id" AS access_id, a."vendorId" AS vendor_id, a."userId" AS user_id,
           a."role" AS access_role, u."role" AS user_role, u."email",
           CASE
             WHEN a."role" = u."role" THEN 'C1'
             WHEN a."role" = 'SUPPORT' THEN 'C5'
             WHEN a."role" = ANY($1) THEN 'C2'
             WHEN r."id" IS NOT NULL THEN 'C3'
             ELSE 'C4'
           END AS category
    FROM "UserCompanyAccess" a
    JOIN "User" u ON u."id" = a."userId"
    LEFT JOIN "Role" r ON r."vendorId" = a."vendorId" AND r."key" = a."role"
    ${ctx.vendorFilter ? 'WHERE a."vendorId" = $2' : ''}`,
    BUILTIN_ROLES, ...(ctx.vendorFilter ? [ctx.vendorFilter] : []))
  const deliberate = new Set(ctx.args.deliberate)
  for (const row of rows) {
    if (row.category === "C1") { ctx.phase("R-ROL").unchanged++; continue }
    if (row.category === "C2" || row.category === "C3") {
      if (deliberate.has(row.access_id)) {
        ctx.phase("R-ROL").skipped++
        continue // the written sign-off keeps the deliberate company role
      }
    }
    // C2/C3 (unmarked) and C4/C5 (always): reset to User.role
    await guardedUpdate(ctx, "R-ROL", "UserCompanyAccess", row.access_id, "role", row.access_role, row.user_role,
      `${row.category} reset to User.role (${row.email})`,
      { vendorId: row.vendor_id, predicate: { userId: row.user_id } })
  }
}

// ============================================================ R-DUP (survey only — never a write)
async function phaseRDUP(client, vendorFilter) {
  // PDR-8 pattern over the 11 M4 conversions. GROUP BY treats NULLs as
  // equal (matching the NULLS NOT DISTINCT target semantics).
  const specs = [
    ["ApprovalWorkflow", '"processType"', '"processType"'],
    ["Branch", '"code"', '"code"'],
    ["Department", '"code"', '"code"'],
    ["Designation", '"code"', '"code"'],
    ["Employee", '"code"', '"code"'],
    ["LeaveType", '"code"', '"code"'],
    ["CostCenter", '"code"', '"code"'],
    ["AccountingPeriod", '"name"', '"name"'],
    ["ItemCategory", '"name"', '"name"'],
    ["VisitLocation", '"name"', '"name"'],
    ["PayrollRun",
      '("periodYear"::text||\'-\'||"periodMonth"::text||\'-\'||"periodWeek"::text||\'-\'||"runType"||\'-\'||"adjustSeq"::text)',
      '"periodYear","periodMonth","periodWeek","runType","adjustSeq"'],
  ]
  const out = []
  for (const [table, keyExpr, groupCols] of specs) {
    const where = vendorFilter ? `WHERE "vendorId" = '${vendorFilter.replace(/'/g, "''")}'` : ""
    const rows = await client.$queryRawUnsafe(
      `SELECT "vendorId", "companyId", ${keyExpr} AS k, count(*) AS n FROM "${table}" ${where}
       GROUP BY "vendorId", "companyId", ${groupCols} HAVING count(*) > 1 ORDER BY n DESC`)
    for (const r of rows) out.push({ table, vendorId: r.vendorId, companyId: r.companyId, key: r.k, count: Number(r.n) })
  }
  return out
}

// ============================================================ --restore
/** Journal-reconstructable restore of one run (non-dry). Idempotent and safe
 *  to repeat (F-05/F-06):
 *  - UPDATE entries → old_value restored in ONE transaction with a
 *    RESTORE_UPDATE journal entry, guarded: only when the current value
 *    still equals the applied new_value. A zero-row revert is CLASSIFIED:
 *    already-reverted (idempotent repeat), missing row, or diverged
 *    (flagged, never forced);
 *  - INSERT UserCompanyAccess entries created by the script → deleted ONLY
 *    by their EXACT journaled primary key, and only while the row still
 *    matches the script-created evidence (vendorId/userId/companyId/role).
 *    A changed, foreign or pre-existing row is reported as a conflict and
 *    never deleted. Legacy-format entries (pre-hardening journals) are
 *    listed for MANUAL removal — they carry no exact row identity;
 *  - INSERT ApprovalWorkflow/ApprovalStep rows → listed for MANUAL removal
 *    (business records are never auto-deleted);
 *  - the run record is marked 'restored' (a run still marked 'running' is
 *    refused — a live run cannot be restored underneath itself).
 *  EXPORTED for the synthetic test suite. */
export async function restoreRun(runId, client = null) {
  const c = client ?? (await getDb())
  const entries = await c.$queryRawUnsafe(
    `SELECT * FROM _mc_backfill_journal WHERE run_id = $1 AND dry_run = false AND action IN ('UPDATE','INSERT')
     ORDER BY seq DESC NULLS LAST, ts DESC`, runId)
  const report = {
    runId, reverted: 0, alreadyReverted: 0, diverged: [], deletedAccessRows: 0,
    alreadyDeletedAccessRows: 0, accessConflicts: [], manualRemoval: [], skipped: 0,
  }
  // Refuse to restore a run that is still marked running (live process).
  const runRow = await c.$queryRawUnsafe(`SELECT status FROM _mc_backfill_runs WHERE run_id = $1`, runId)
  if (runRow.length && runRow[0].status === "running") {
    throw new Error(`Run ${runId} is still marked 'running' — restore refused (stop the run's process first; a stale 'running' row is auto-marked 'interrupted' by the next run on the same host)`)
  }
  for (const e of entries) {
    if (e.action === "UPDATE") {
      if (e.column_name !== "companyId" && e.column_name !== "role") { report.skipped++; continue }
      // JSONB scalars: #>> '{}' unwraps the stored value (string or JSON null)
      let n = 0
      await c.$transaction(async (tx) => {
        n = await tx.$executeRawUnsafe(
          `UPDATE "${e.target_table}" SET "${e.column_name}" = ($1::jsonb #>> '{}')
           WHERE "id" = $2 AND "${e.column_name}" IS NOT DISTINCT FROM ($3::jsonb #>> '{}')`,
          JSON.stringify(e.old_value ?? null), e.target_id, JSON.stringify(e.new_value ?? null))
        if (n > 0) {
          await tx.$executeRawUnsafe(
            `INSERT INTO _mc_backfill_journal (id, run_id, phase, ts, dry_run, target_table, target_id, action, column_name, old_value, new_value, note)
             VALUES ($1,$2,'RESTORE',now(),false,$3,$4,'RESTORE_UPDATE',$5,$6::jsonb,$7::jsonb,$8)`,
            crypto.randomUUID(), runId, e.target_table, e.target_id, e.column_name,
            JSON.stringify(e.new_value ?? null), JSON.stringify(e.old_value ?? null),
            `restore of run ${runId}: reverted ${e.column_name} to the pre-repair value`)
        }
      })
      if (n > 0) { report.reverted++; continue }
      // classify the zero-row revert (idempotent repeat vs divergence)
      const cur = await c.$queryRawUnsafe(`SELECT "${e.column_name}" AS cur FROM "${e.target_table}" WHERE "id" = $1`, e.target_id)
      if (!cur.length) report.diverged.push({ table: e.target_table, id: e.target_id, column: e.column_name, kind: "missing" })
      else if ((cur[0].cur ?? null) === (e.old_value ?? null)) report.alreadyReverted++
      else report.diverged.push({ table: e.target_table, id: e.target_id, column: e.column_name, kind: "diverged", current: cur[0].cur ?? null })
    } else if (e.action === "INSERT" && e.target_table === "UserCompanyAccess") {
      // F-05: exact-PK restore. New-format entries carry `uca:<primaryKey>`.
      const m = /^uca:(.+)$/.exec(e.target_id || "")
      const evidence = e.new_value || {}
      if (!m || !evidence.id) {
        // Legacy pre-hardening entry: no exact row identity — MANUAL only.
        report.manualRemoval.push({ table: e.target_table, id: e.target_id, detail: evidence, reason: "legacy journal entry without an exact created-row primary key — manual removal (F-05)" })
        continue
      }
      const rows = await c.$queryRawUnsafe(
        `SELECT "id", "vendorId", "userId", "companyId", "role" FROM "UserCompanyAccess" WHERE "id" = $1`, m[1])
      if (!rows.length) { report.alreadyDeletedAccessRows++; continue } // idempotent repeat
      const r = rows[0]
      const matches = notDistinctFrom(r.vendorId, evidence.vendorId) && notDistinctFrom(r.userId, evidence.userId) &&
        notDistinctFrom(r.companyId, evidence.companyId) && notDistinctFrom(r.role, evidence.role)
      if (!matches) {
        // changed after creation / wrong vendor / foreign row — NEVER deleted
        report.accessConflicts.push({ table: e.target_table, id: r.id, evidence, current: { vendorId: r.vendorId, userId: r.userId, companyId: r.companyId, role: r.role }, reason: "row no longer matches the script-created state — not deleted (F-05)" })
        continue
      }
      let n = 0
      await c.$transaction(async (tx) => {
        n = await tx.$executeRawUnsafe(`DELETE FROM "UserCompanyAccess" WHERE "id" = $1`, m[1])
        if (n > 0) {
          await tx.$executeRawUnsafe(
            `INSERT INTO _mc_backfill_journal (id, run_id, phase, ts, dry_run, target_table, target_id, action, column_name, old_value, new_value, note)
             VALUES ($1,$2,'RESTORE',now(),false,$3,$4,'RESTORE_DELETE',null,$5::jsonb,null,$6)`,
            crypto.randomUUID(), runId, "UserCompanyAccess", `uca:${m[1]}`, JSON.stringify(evidence),
            `restore of run ${runId}: deleted the script-created access row (exact primary key, verified against evidence)`)
        }
      })
      if (n > 0) report.deletedAccessRows++
      else report.alreadyDeletedAccessRows++ // vanished between read and delete
    } else if (e.action === "INSERT") {
      report.manualRemoval.push({ table: e.target_table, id: e.target_id, detail: e.new_value })
    }
  }
  await c.$executeRawUnsafe(
    `UPDATE _mc_backfill_runs SET status = 'restored', finished_at = now() WHERE run_id = $1 AND status <> 'running'`,
    runId)
  return report
}

// ============================================================ orchestration

export const ALL_PHASES = ["R-ORP", "R-JRN", "R-ADJ", "R-SHF", "R-HOL", "R-TSK", "R-APA", "R-WFS"]

/** Mark stale 'running' runs (same host, dead pid, not this process) as
 *  'interrupted' — a killed process leaves no other trace (F-06: the run
 *  record must distinguish interrupted runs). Runs from other hosts, runs
 *  with unknown pid provenance, and live runs are left untouched. */
async function markStaleRunningRunsInterrupted(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT run_id, pid FROM _mc_backfill_runs WHERE status = 'running' AND host = $1 AND pid IS NOT NULL AND pid <> $2`,
    os.hostname(), process.pid)
  for (const r of rows) {
    let alive = true
    try { process.kill(r.pid, 0) } catch (e) { alive = e.code === "EPERM" } // EPERM = exists
    if (!alive) {
      await client.$executeRawUnsafe(
        `UPDATE _mc_backfill_runs SET status = 'interrupted', error = COALESCE(error, 'process exited without completing — auto-marked by the next run on this host') WHERE run_id = $1 AND status = 'running'`,
        r.run_id)
    }
  }
}

/** Programmatic entry (used by the synthetic test suite and the CLI alike).
 *  opts.client lets tests inject a failing/interposing client (F-06 failure
 *  injection); opts.runId pins the run id (retry/testing). */
export async function runBackfill(opts) {
  const client = opts.client || (await getDb())
  const args = {
    dryRun: !!opts.dryRun, confirm: opts.confirm !== false, phases: opts.phases || [],
    resetRoles: !!opts.resetRoles, deliberate: opts.deliberate || [],
    vendor: opts.vendor || null, json: false,
  }
  const runId = opts.runId || crypto.randomUUID()
  await ensureJournalTables(client)
  const ctx = new RunCtx(runId, args, client)

  // F-06: the run record exists for the WHOLE run — 'running' from the start,
  // 'completed'/'failed' at the end (dry runs are recorded too, flagged).
  await markStaleRunningRunsInterrupted(client)
  await client.$executeRawUnsafe(
    `INSERT INTO _mc_backfill_runs (run_id, started_at, dry_run, phases, status, pid, host)
     VALUES ($1, now(), $2, $3, 'running', $4, $5)
     ON CONFLICT (run_id) DO UPDATE SET started_at = now(), finished_at = null, dry_run = $2, phases = $3, status = 'running', pid = $4, host = $5, error = null`,
    runId, args.dryRun, (args.phases.length ? args.phases : ALL_PHASES).join(","), process.pid, os.hostname())

  const topo = await vendorTopology(client)
  const wanted = args.phases.length ? args.phases : ALL_PHASES
  let failed = null
  try {
    for (const p of wanted) {
      if (p === "R-ORP") await phaseRORP(ctx)
      else if (p === "R-JRN") await phaseRJRN(ctx)
      else if (p === "R-ADJ") await phaseRADJ(ctx)
      else if (p === "R-SHF") await phaseRSHF(ctx, topo)
      else if (p === "R-HOL") await phaseRHOL(ctx, topo)
      else if (p === "R-TSK") await phaseRTSK(ctx)
      else if (p === "R-APA") await phaseRAPA(ctx, topo)
      else if (p === "R-WFS") await phaseRWFS(ctx, topo)
      else throw new Error(`Unknown phase: ${p}`)
    }
    if (args.resetRoles) await phaseResetRoles(ctx)
  } catch (e) {
    failed = e
  }
  const duplicates = await phaseRDUP(client, args.vendor)
  const summary = {
    runId, startedAt: null, finishedAt: nowIso() + " UTC", dryRun: args.dryRun,
    phases: wanted.join(","), counts: ctx.counts, manualListCount: ctx.manual.length,
    duplicateSurveyCount: duplicates.length,
    runStatus: failed ? "failed" : "completed",
  }
  await client.$executeRawUnsafe(
    `INSERT INTO _mc_backfill_runs (run_id, started_at, finished_at, dry_run, phases, summary, status, pid, host, error)
     VALUES ($1, now(), now(), $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (run_id) DO UPDATE SET finished_at = now(), summary = $4::jsonb, status = $5, error = $8`,
    runId, args.dryRun, wanted.join(","), JSON.stringify(summary), failed ? "failed" : "completed", process.pid, os.hostname(), failed ? String(failed.message || failed) : null)
  if (failed) throw failed
  return { runId, summary, counts: ctx.counts, manual: ctx.manual, duplicates, runStatus: "completed" }
}

// ---------- CLI ----------
if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  console.log(`mc-backfill-core — ${nowIso()} UTC (all timestamps in this tool are UTC)`)

  // SAFETY ORDER (script CLI/safety checks): every refusal happens BEFORE the
  // database client is even imported — a misconfigured environment can never
  // produce a half-initialized run.
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required (operator-supplied; the M3a gate must be satisfied before any real run).")
    process.exit(2)
  }
  if (args.restore) {
    const { db } = await import("../src/lib/db.ts")
    await ensureJournalTables(db)
    console.log(`Restoring run ${args.restore} …`)
    const rep = await restoreRun(args.restore, db)
    console.log(JSON.stringify(rep, null, 2))
    process.exit(0)
  }
  if (!args.dryRun && !args.confirm) {
    console.error(`Refusing to write. Target: ${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}\nPass --confirm for a real run, or --dry-run to preview.`)
    process.exit(2)
  }
  // The documented M3a execution gate is operational (B-7 decision →
  // W1-AC-08 PASS → R1 deploy → R2 live on ALL instances). --confirm is NOT
  // a substitute for it: a real run additionally requires the explicit gate
  // acknowledgment (see the M3a operator runbook).
  if (!args.dryRun && process.env.M3A_EXECUTION_GATE_ACK !== "R2-LIVE-ON-ALL-INSTANCES") {
    console.error(
      `Refusing to write: the documented M3a execution gate is not acknowledged.\n` +
      `The gate (B-7 decision → W1-AC-08 PASS → R1 release cut/deployment → R2 live on ALL\n` +
      `instances) must be satisfied and acknowledged by the operator before any real run.\n` +
      `If (and only if) it is satisfied, re-run with:  M3A_EXECUTION_GATE_ACK=R2-LIVE-ON-ALL-INSTANCES`)
    process.exit(2)
  }
  if (args.phases.length) {
    for (const p of args.phases) {
      if (!ALL_PHASES.includes(p)) { console.error(`Unknown phase: ${p}`); process.exit(2) }
    }
  }
  // runBackfill constructs the Prisma client lazily (getDb) — every safety
  // refusal above has already happened before any database work.
  const out = await runBackfill({
    dryRun: args.dryRun, confirm: true, phases: args.phases,
    resetRoles: args.resetRoles, deliberate: args.deliberate, vendor: args.vendor,
  })
  if (args.json) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    for (const [phase, c] of Object.entries(out.counts)) {
      console.log(`  ${phase}: changed=${c.changed} inserted=${c.inserted} unchanged=${c.unchanged} manual=${c.manual} skipped=${c.skipped} conflict=${c.conflict}`)
    }
    console.log(`  manual-list entries: ${out.manual.length} (see mc-remediation-report.mjs §manual)`)
    console.log(`  duplicate survey groups: ${out.duplicates.length}`)
    for (const m of out.manual) console.log(`  MANUAL ${m.phase} ${m.table} ${m.id}: ${m.reason}`)
  }
  console.log(`Run ${out.runId} ${args.dryRun ? "(dry-run — no business writes)" : "complete"}.`)
}
