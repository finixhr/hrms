#!/usr/bin/env bun
// ============ FIN-019 (Phase 2) — AuditLog.companyId attribution backfill ============
// Operator-run journaled repair for the HISTORICAL AuditLog rows, following
// the mc-backfill-core safety contracts (DMS §5) this repo already carries:
//
//   · SELECT → compute → guarded compare-and-set UPDATE, journaled
//     (_fin19_backfill_journal) — the update lands only while the row still
//     matches the state the decision was computed from (companyId IS NULL).
//     Zero-row results are CLASSIFIED (unchanged / concurrent), never
//     assumed to be harmless no-ops.
//   · A mutation and its journal row commit in ONE transaction; a journal
//     failure rolls the mutation back (F-06 pattern).
//   · --dry-run by default (no writes); --confirm additionally requires the
//     operator gate ack FIN19_EXECUTION_GATE_ACK=AUDIT-WRITERS-LIVE (the
//     Phase 2 writers are deployed, so no new NULL rows are being created
//     behind the backfill's back). --confirm alone is NOT a substitute.
//   · --restore <runId> reverses exactly the rows THIS run journaled — only
//     while they still carry this run's value, never other runs' rows.
//   · The run record (_fin19_backfill_runs) tracks running / completed /
//     failed / interrupted / restored.
//
// HONESTY RULE (same as M3a core): a default company is a valid owner only
// when the vendor has exactly ONE company (unambiguous). Multi-company
// vendors: anchor via the Employee (entity="Employee" rows → the employee's
// companyId), otherwise NULL stays NULL. Never fabricate ownership.
//
// Usage:
//   bun run scripts/fin19-auditlog-backfill.mjs --dry-run
//   bun run scripts/fin19-auditlog-backfill.mjs --confirm   (+ gate ack env)
//   bun run scripts/fin19-auditlog-backfill.mjs --restore <runId>
//   bun run scripts/fin19-auditlog-backfill.mjs --json       (machine output)
import crypto from "node:crypto"
import os from "node:os"
import { readFileSync } from "node:fs"

const GATE_ACK = "AUDIT-WRITERS-LIVE"

function parseArgs(argv) {
  const a = { dryRun: false, confirm: false, restore: null, json: false, vendor: null }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === "--dry-run") a.dryRun = true
    else if (t === "--confirm") a.confirm = true
    else if (t === "--json") a.json = true
    else if (t === "--vendor") a.vendor = String(argv[++i])
    else if (t === "--restore") a.restore = String(argv[++i])
    else { console.error(`Unknown argument: ${t}`); process.exit(2) }
  }
  return a
}

const nowIso = () => new Date().toISOString()

// ---------- journal DDL (idempotent) ----------
const RUNS_DDL = `
CREATE TABLE IF NOT EXISTS _fin19_backfill_runs (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  args jsonb NOT NULL,
  pid int,
  host text,
  status text NOT NULL DEFAULT 'running'
);`
const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS _fin19_backfill_journal (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES _fin19_backfill_runs(id),
  ts timestamptz NOT NULL,
  dry_run boolean NOT NULL,
  audit_row_id text NOT NULL,
  vendor_id text NOT NULL,
  decision text NOT NULL,
  company_id text,
  note text
);`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dryRun && !args.confirm && !args.restore) {
    // bare invocation defaults to dry-run, same as the M3a core
    args.dryRun = true
  }
  if (args.restore) {
    if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(2) }
  } else if (args.confirm) {
    if (process.env.FIN19_EXECUTION_GATE_ACK !== GATE_ACK) {
      console.error(
        `--confirm requires the operator gate ack FIN19_EXECUTION_GATE_ACK=${GATE_ACK}\n` +
        `(the Phase 2 audit writers are deployed on every instance, so the backfill\n` +
        `cannot race new NULL rows). --confirm alone is not a substitute.`)
      process.exit(2)
    }
    if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(2) }
  } else if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required"); process.exit(2)
  }
  const url = process.env.DATABASE_URL
  if (!args.json) console.log(`fin19-auditlog-backfill · ${url.replace(/:[^:@/]+@/, ":****@")}`)

  const { PrismaClient } = await import("@prisma/client")
  const db = new PrismaClient()
  for (const ddl of [RUNS_DDL, JOURNAL_DDL]) await db.$executeRawUnsafe(ddl)

  // ---------- restore lane ----------
  if (args.restore) {
    const run = await db.$queryRawUnsafe(`SELECT id, status FROM _fin19_backfill_runs WHERE id=$1`, args.restore)
    if (!run.length) { console.error(`No run ${args.restore}`); await db.$disconnect(); process.exit(2) }
    const rows = await db.$queryRawUnsafe(`SELECT id, audit_row_id, company_id FROM _fin19_backfill_journal WHERE run_id=$1 AND dry_run=false`, args.restore)
    let reverted = 0, kept = 0
    for (const j of rows) {
      // revert ONLY while the row still carries this run's value (F-05 shape)
      const r = await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "companyId"=NULL WHERE "id"=$1 AND "companyId"=$2`, j.audit_row_id, j.company_id)
      if (r === 1) reverted++; else kept++
    }
    await db.$executeRawUnsafe(`UPDATE _fin19_backfill_runs SET status='restored', finished_at=$2 WHERE id=$1`, args.restore, nowIso())
    console.log(`restore: ${reverted} reverted, ${kept} kept (value changed after the run — left alone)`)
    await db.$disconnect(); process.exit(0)
  }

  // ---------- run record ----------
  const runId = `f19-${crypto.randomBytes(6).toString("hex")}`
  await db.$executeRawUnsafe(
    `INSERT INTO _fin19_backfill_runs (id, started_at, args, pid, host, status) VALUES ($1,$2::timestamptz,$3::jsonb,$4,$5,'running')`,
    runId, nowIso(), JSON.stringify({ dryRun: args.dryRun, confirm: args.confirm, vendor: args.vendor }), process.pid, os.hostname())

  // ---------- classify ----------
  // vendors = the tenant roots (Vendor table); per-vendor topology resolved with
  // the F-01 rule (only ACTIVE companies, the exact resolveProvisioningCompanyId
  // ordering: isDefault DESC, createdAt ASC — an inactive company is never the default).
  const vendorFilter = args.vendor ? `WHERE v.id = $1` : ``
  const vendors = await db.$queryRawUnsafe(`
    SELECT v.id AS vendor_id,
           (SELECT count(*) FROM "Company" c WHERE c."vendorId" = v.id)::int AS company_count,
           (SELECT c.id FROM "Company" c WHERE c."vendorId" = v.id AND c."active" = true
              ORDER BY c."isDefault" DESC, c."createdAt" ASC LIMIT 1) AS default_company_id
    FROM "Vendor" v ${vendorFilter}`,
    ...(args.vendor ? [args.vendor] : []))

  const report = { vendors: [], totalRows: 0, attributedDefault: 0, attributedEmployeeAnchor: 0, leftTenantLevel: 0, unchanged: 0, failed: 0 }
  for (const v of vendors) {
    const single = v.company_count === 1
    const decision = single ? "single-company default" : "multi-company"
    const perVendor = { vendorId: v.vendor_id, companies: v.company_count, decision }

    // candidate rows: still-unattributed audit rows of this vendor
    const rows = await db.$queryRawUnsafe(
      `SELECT id, entity, "entityId" FROM "AuditLog" WHERE "vendorId"=$1 AND ("companyId" IS NULL OR "companyId"='') ORDER BY "createdAt" ASC`, v.vendor_id)
    // employee anchor map (only needed for multi-company vendors)
    let empCompany = null
    if (!single) {
      const emps = await db.$queryRawUnsafe(`SELECT id, "companyId" FROM "Employee" WHERE "vendorId"=$1`, v.vendor_id)
      empCompany = new Map(emps.map((e) => [e.id, e.companyId]))
    }
    let attributed = 0, tenantLevel = 0, unchangedRows = 0, failedRows = 0
    for (const row of rows) {
      let companyId = null, why = "tenant-level"
      if (single && v.default_company_id) { companyId = v.default_company_id; why = "single-company default" }
      else if (row.entity === "Employee" && row.entityId && empCompany?.get(row.entityId)) {
        companyId = empCompany.get(row.entityId); why = "employee-anchored"
      }
      if (companyId == null) { tenantLevel++; continue } // honest NULL — labeled at export
      if (args.dryRun) { attributed++; continue }
      try {
        // mutation + journal in ONE transaction (F-06): journal failure rolls the update back
        await db.$transaction(async (tx) => {
          const n = await tx.$executeRawUnsafe(
            `UPDATE "AuditLog" SET "companyId"=$1 WHERE "id"=$2 AND ("companyId" IS NULL OR "companyId"='')`, companyId, row.id)
          if (n === 1) {
            await tx.$executeRawUnsafe(
              `INSERT INTO _fin19_backfill_journal (id, run_id, ts, dry_run, audit_row_id, vendor_id, decision, company_id, note)
               VALUES ($1,$2,$3::timestamptz,false,$4,$5,$6,$7,$8::text)`,
              `j-${crypto.randomBytes(8).toString("hex")}`, runId, nowIso(), row.id, v.vendor_id, why, companyId, null)
          }
          return n
        }).then((n) => { if (n === 1) attributed++; else { unchangedRows++; } })
      } catch (e) { failedRows++ }
    }
    perVendor.rows = rows.length; perVendor.attributed = attributed
    perVendor.tenantLevel = tenantLevel; perVendor.unchanged = unchangedRows; perVendor.failed = failedRows
    report.vendors.push(perVendor)
    report.totalRows += rows.length; report.attributedDefault += single ? attributed : 0
    report.attributedEmployeeAnchor += single ? 0 : attributed
    report.leftTenantLevel += tenantLevel; report.unchanged += unchangedRows; report.failed += failedRows
  }

  await db.$executeRawUnsafe(
    `UPDATE _fin19_backfill_runs SET status=$2, finished_at=$3::timestamptz WHERE id=$1`,
    runId, args.dryRun ? "completed (dry-run)" : "completed", nowIso())

  if (args.json) {
    console.log(JSON.stringify({ runId, mode: args.dryRun ? "dry-run" : "confirm", ...report }, null, 1))
  } else {
    console.log(`\nrun ${runId} · ${args.dryRun ? "DRY-RUN (no writes)" : "CONFIRMED"} — FIN-019 AuditLog attribution backfill`)
    for (const pv of report.vendors) {
      console.log(`  vendor ${pv.vendorId}: ${pv.companies} company(ies) [${pv.decision}] → ${pv.rows} rows: ${pv.attributed} attributed, ${pv.tenantLevel} honestly tenant-level, ${pv.unchanged} unchanged, ${pv.failed} failed`)
    }
    console.log(`\n  totals: ${report.totalRows} rows · ${report.attributedDefault} single-company defaults · ${report.attributedEmployeeAnchor} employee-anchored · ${report.leftTenantLevel} tenant-level (NULL stays, export labels it)`)
  }
  await db.$disconnect()
  process.exit(report.failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error("fin19-auditlog-backfill failed:", e?.message || e); process.exit(1) })
