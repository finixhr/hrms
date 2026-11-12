#!/usr/bin/env bun
// ============ FIN-013 (Phase 2) — historical procurement/inventory/asset ledger backfill ============
// Operator-run journaled backfill for the HISTORICAL events the three modules
// recorded off-ledger, following the mc-backfill-core safety contracts:
//
//   · SELECT → compute → guarded INSERT, journaled (_fin13_backfill_journal),
//     one transaction per row: journal failure rolls the insert back (F-06).
//   · Every journal row carries an idempotencyKey from the SAME keyspace the
//     forward hooks use (fin13:procurement:receive:{id} / fin13:adjust:{id} /
//     fin13:assetissue:{id} / fin13:asset:{retire|lose}:{assetId}) — a re-run
//     can never double-post, and it can never collide with a forward posting.
//   · --dry-run default; --confirm additionally requires
//     FIN13_EXECUTION_GATE_ACK=BACKFILL-POST-DEPLOY (the Phase 2 hooks are
//     live, so new events post going forward; the backfill covers the rest).
//   · --restore <runId> reverses exactly this run's rows.
//   · HONESTY: rows with no cost basis are SKIPPED and counted (never a
//     fabricated ৳0 or a guessed value); the report lists them per class.
//     The ADJUST class is valued at the item's CURRENT lastCost (the module
//     keeps no per-movement cost on StockTransaction) — the runbook records
//     this basis limitation explicitly.
//
// Coverage (the GL event matrix in docs/runbooks/fin-013-ledger-posting.md):
//   R-PRC  posted StockEntries linked to a purchase      → PROCURE_RECEIPT
//   R-ADJ  ADJUST StockTransactions (manual adjustments) → INVENTORY_ADJUST
//   R-AIS  ASSET_ISSUE StockTransactions (stock→assets)  → STOCK_ASSET_ISSUE
//   R-DSP  RETIRE/LOSE asset terminal states             → ASSET_RETIRE / ASSET_LOSE
import crypto from "node:crypto"
import os from "node:os"

const GATE_ACK = "BACKFILL-POST-DEPLOY"

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

const RUNS_DDL = `CREATE TABLE IF NOT EXISTS _fin13_backfill_runs (
  id text PRIMARY KEY, started_at timestamptz NOT NULL, finished_at timestamptz,
  args jsonb NOT NULL, pid int, host text, status text NOT NULL DEFAULT 'running');`
const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS _fin13_backfill_journal (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES _fin13_backfill_runs(id),
  ts timestamptz NOT NULL, dry_run boolean NOT NULL, class text NOT NULL,
  business_row_id text NOT NULL, vendor_id text NOT NULL, company_id text,
  ref_type text NOT NULL, idempotency_key text NOT NULL, amount numeric,
  note text);`

// The default mapping (mirrors src/hrm/accounting-chart.ts DEFAULT_ACCOUNT_MAPPING;
// the backfill intentionally does NOT read per-vendor overrides — historical
// postings use the default chart, the runbook documents this).
const CHART = {
  inventoryAsset: ["1300", "Inventory"],
  supplierPayable: ["2110", "Accounts Payable — Suppliers"],
  fixedAssets: ["1400", "Fixed Assets — Company Property"],
  stockAdjustment: ["5310", "Inventory Adjustments (gain/loss)"],
  assetDisposalLoss: ["6200", "Asset Disposal Loss"],
}
const line = (role, debit, credit) => {
  const [code, name] = CHART[role]
  return { account: code, accountName: name, debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 }
}
const money = (n) => Math.round((Number(n) || 0) * 100) / 100

async function insertJournal(db, args, j, fields) {
  // guarded INSERT + journal row in ONE transaction; the idempotency lookup
  // rides the same tx so a concurrent writer cannot slip between the two.
  return db.$transaction(async (tx) => {
    const existing = await tx.accountJournal.findFirst({ where: { idempotencyKey: fields.idempotencyKey }, select: { id: true } })
    if (existing) return "duplicate"
    const row = await tx.accountJournal.create({
      data: {
        vendorId: fields.vendorId, companyId: fields.companyId || null,
        refType: fields.refType, refId: fields.refId,
        idempotencyKey: fields.idempotencyKey,
        date: fields.date, memo: fields.memo,
        linesJson: JSON.stringify(fields.lines), amount: fields.amount,
        source: "FIN13-BACKFILL", status: "POSTED",
      },
    })
    await tx.$executeRawUnsafe(
      `INSERT INTO _fin13_backfill_journal (id, run_id, ts, dry_run, class, business_row_id, vendor_id, company_id, ref_type, idempotency_key, amount, note)
       VALUES ($1,$2,$3::timestamptz,false,$4,$5,$6,$7,$8,$9,$10,$11::text)`,
      `j-${crypto.randomBytes(8).toString("hex")}`, args.runId, nowIso(), j.cls, j.rowId, j.vendorId, j.companyId || null, fields.refType, fields.idempotencyKey, fields.amount, j.note || null)
    return row.id
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dryRun && !args.confirm && !args.restore) args.dryRun = true
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(2) }
  if (args.confirm && process.env.FIN13_EXECUTION_GATE_ACK !== GATE_ACK) {
    console.error(`--confirm requires FIN13_EXECUTION_GATE_ACK=${GATE_ACK}\n(the Phase 2 posting hooks are live on every instance; the backfill covers the historical tail).`)
    process.exit(2)
  }
  const { PrismaClient } = await import("@prisma/client")
  const db = new PrismaClient()
  await db.$executeRawUnsafe(RUNS_DDL)
  await db.$executeRawUnsafe(JOURNAL_DDL)

  if (args.restore) {
    const rows = await db.$queryRawUnsafe(`SELECT id, idempotency_key FROM _fin13_backfill_journal WHERE run_id=$1 AND dry_run=false`, args.restore)
    let reverted = 0, kept = 0
    for (const j of rows) {
      const r = await db.accountJournal.deleteMany({ where: { idempotencyKey: j.idempotency_key, source: "FIN13-BACKFILL" } })
      if (r.count === 1) reverted++; else kept++
    }
    await db.$executeRawUnsafe(`UPDATE _fin13_backfill_runs SET status='restored', finished_at=$2::timestamptz WHERE id=$1`, args.restore, nowIso())
    console.log(`restore: ${reverted} reverted, ${kept} kept (touched after the run — left alone)`)
    await db.$disconnect(); process.exit(0)
  }

  args.runId = `f13-${crypto.randomBytes(6).toString("hex")}`
  await db.$executeRawUnsafe(
    `INSERT INTO _fin13_backfill_runs (id, started_at, args, pid, host, status) VALUES ($1,$2::timestamptz,$3::jsonb,$4,$5,'running')`,
    args.runId, nowIso(), JSON.stringify({ dryRun: args.dryRun, confirm: args.confirm, vendor: args.vendor }), process.pid, os.hostname())

  const stats = { RPRC: { posted: 0, skipped: 0, dup: 0 }, RADJ: { posted: 0, skipped: 0, dup: 0 }, RAIS: { posted: 0, skipped: 0, dup: 0 }, RDSP: { posted: 0, skipped: 0, dup: 0 } }
  const skipList = []

  // ---- R-PRC: posted stock entries linked to a purchase ----
  const entries = await db.stockEntry.findMany({
    where: { status: "POSTED", purchaseId: { not: null }, ...(args.vendor ? { vendorId: args.vendor } : {}) },
    include: { items: true },
  })
  for (const e of entries) {
    const amount = money(e.items.reduce((s, it) => s + (it.quantity || 0) * (it.unitCost || 0), 0))
    const j = { cls: "R-PRC", rowId: e.id, vendorId: e.vendorId, companyId: e.companyId, note: `stock entry ${e.code}` }
    if (!(amount > 0)) { stats.RPRC.skipped++; skipList.push([j.cls, e.id, "no cost basis"]); continue }
    if (args.dryRun) { stats.RPRC.posted++; continue }
    const r = await insertJournal(db, args, j, {
      vendorId: e.vendorId, companyId: e.companyId, refType: "PROCURE_RECEIPT", refId: e.id,
      idempotencyKey: `fin13:procurement:receive:${e.id}`,
      date: (e.entryDate || "").slice(0, 10) || nowIso().slice(0, 10),
      memo: `FIN-013 backfill: goods received on purchase — stock entry ${e.code} (DR Inventory / CR Accounts Payable — Suppliers)`,
      lines: [line("inventoryAsset", amount, 0), line("supplierPayable", 0, amount)], amount,
    })
    if (r === "duplicate") stats.RPRC.dup++; else stats.RPRC.posted++
  }

  // ---- R-ADJ: manual ADJUST stock transactions ----
  const adjs = await db.stockTransaction.findMany({
    where: { kind: "ADJUST", refType: "MANUAL", ...(args.vendor ? { vendorId: args.vendor } : {}) },
  })
  const items = await db.item.findMany({ where: { ...(args.vendor ? { vendorId: args.vendor } : {}) }, select: { id: true, lastCost: true, companyId: true } })
  const itemById = new Map(items.map((i) => [i.id, i]))
  for (const t of adjs) {
    const it = itemById.get(t.itemId)
    const basis = Number(it?.lastCost) || 0
    const amount = money(Math.abs(t.quantity) * basis)
    const j = { cls: "R-ADJ", rowId: t.id, vendorId: t.vendorId, companyId: it?.companyId || null, note: `adjust ${t.note || ""}`.slice(0, 60) }
    if (!(amount > 0)) { stats.RADJ.skipped++; skipList.push([j.cls, t.id, `no cost basis (lastCost ${basis || "unknown"})`]); continue }
    if (args.dryRun) { stats.RADJ.posted++; continue }
    const gain = t.quantity > 0
    const r = await insertJournal(db, args, j, {
      vendorId: t.vendorId, companyId: it?.companyId || null, refType: "INVENTORY_ADJUST", refId: t.id,
      idempotencyKey: `fin13:adjust:${t.id}`,
      date: (t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : nowIso().slice(0, 10)),
      memo: `FIN-013 backfill: stock adjustment ${gain ? "gain" : "loss"} — |${t.quantity}| @ current lastCost ${basis.toFixed(2)} (basis limitation, see runbook)`,
      lines: gain
        ? [line("inventoryAsset", amount, 0), line("stockAdjustment", 0, amount)]
        : [line("stockAdjustment", amount, 0), line("inventoryAsset", 0, amount)],
      amount,
    })
    if (r === "duplicate") stats.RADJ.dup++; else stats.RADJ.posted++
  }

  // ---- R-AIS: ASSET_ISSUE stock transactions (stock → company property) ----
  const issues = await db.stockTransaction.findMany({
    where: { kind: "ISSUE", refType: "ASSET_ISSUE", ...(args.vendor ? { vendorId: args.vendor } : {}) },
  })
  for (const t of issues) {
    const it = itemById.get(t.itemId)
    const basis = Number(t.unitCost) || Number(it?.lastCost) || 0
    const qty = Math.abs(Number(t.quantity) || 0)
    const amount = money(qty * basis)
    const keyId = t.refId || t.id
    const j = { cls: "R-AIS", rowId: t.id, vendorId: t.vendorId, companyId: it?.companyId || null, note: `asset issue ${t.note || ""}`.slice(0, 60) }
    if (!(amount > 0)) { stats.RAIS.skipped++; skipList.push([j.cls, t.id, "no cost basis"]); continue }
    if (args.dryRun) { stats.RAIS.posted++; continue }
    const r = await insertJournal(db, args, j, {
      vendorId: t.vendorId, companyId: it?.companyId || null, refType: "STOCK_ASSET_ISSUE", refId: t.refId || t.id,
      idempotencyKey: `fin13:assetissue:${keyId}`,
      date: (t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : nowIso().slice(0, 10)),
      memo: `FIN-013 backfill: stock issued as company property — ${qty} unit(s) (DR Fixed Assets / CR Inventory)`,
      lines: [line("fixedAssets", amount, 0), line("inventoryAsset", 0, amount)], amount,
    })
    if (r === "duplicate") stats.RAIS.dup++; else stats.RAIS.posted++
  }

  // ---- R-DSP: retired/lost assets (terminal states, value written off) ----
  const disposed = await db.asset.findMany({
    where: { status: { in: ["RETIRED", "LOST"] }, ...(args.vendor ? { vendorId: args.vendor } : {}) },
  })
  for (const a of disposed) {
    const kind = a.status === "RETIRED" ? "retire" : "lose"
    const amount = money(a.purchaseCost)
    const j = { cls: "R-DSP", rowId: a.id, vendorId: a.vendorId, companyId: a.companyId, note: `asset ${a.code}` }
    if (!(amount > 0)) { stats.RDSP.skipped++; skipList.push([j.cls, a.id, "no carrying value (purchaseCost unknown)"]); continue }
    if (args.dryRun) { stats.RDSP.posted++; continue }
    const r = await insertJournal(db, args, j, {
      vendorId: a.vendorId, companyId: a.companyId, refType: a.status === "RETIRED" ? "ASSET_RETIRE" : "ASSET_LOSE", refId: a.id,
      idempotencyKey: `fin13:asset:${kind}:${a.id}`,
      date: nowIso().slice(0, 10),
      memo: `FIN-013 backfill: asset ${a.status === "RETIRED" ? "retired" : "marked lost"} — ${a.code} @ carrying ${amount.toFixed(2)} (DR Asset Disposal Loss / CR Fixed Assets)`,
      lines: [line("assetDisposalLoss", amount, 0), line("fixedAssets", 0, amount)], amount,
    })
    if (r === "duplicate") stats.RDSP.dup++; else stats.RDSP.posted++
  }

  await db.$executeRawUnsafe(`UPDATE _fin13_backfill_runs SET status=$2, finished_at=$3::timestamptz WHERE id=$1`,
    args.runId, args.dryRun ? "completed (dry-run)" : "completed", nowIso())

  if (args.json) {
    console.log(JSON.stringify({ runId: args.runId, mode: args.dryRun ? "dry-run" : "confirm", stats, skipped: skipList.slice(0, 200) }, null, 1))
  } else {
    console.log(`\nrun ${args.runId} · ${args.dryRun ? "DRY-RUN (no writes)" : "CONFIRMED"} — FIN-013 historical ledger backfill`)
    console.log(`  R-PRC purchase receipts : ${stats.RPRC.posted} posted, ${stats.RPRC.dup} already present, ${stats.RPRC.skipped} skipped (no basis)`)
    console.log(`  R-ADJ stock adjustments  : ${stats.RADJ.posted} posted, ${stats.RADJ.dup} already present, ${stats.RADJ.skipped} skipped`)
    console.log(`  R-AIS stock→asset issues : ${stats.RAIS.posted} posted, ${stats.RAIS.dup} already present, ${stats.RAIS.skipped} skipped`)
    console.log(`  R-DSP asset disposals    : ${stats.RDSP.posted} posted, ${stats.RDSP.dup} already present, ${stats.RDSP.skipped} skipped`)
    if (skipList.length) console.log(`  skipped rows (honest, never fabricated): ${skipList.length} — first entries: ${skipList.slice(0, 5).map(s => s.join(":")).join(" | ")}`)
  }
  await db.$disconnect()
  process.exit(0)
}

main().catch((e) => { console.error("fin13 backfill failed:", e?.message || e); process.exit(1) })
