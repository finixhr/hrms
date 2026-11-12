# FIN-013 Runbook — Procurement → Inventory → Asset Ledger Posting (Phase 2)

**Finding:** FIN-013 (High, remediated in Phase 2 per roadmap row 15) — the
procurement → inventory → asset chain never posted to the ledger; the GL
lacked inventory / payables / fixed-asset accounts.
**Exit criterion:** trial balance includes inventory / payables /
fixed-asset accounts.
**Status:** closed 2026-11-10. Forward hooks live in the four write paths; the
historical tail is covered by `scripts/fin13-ledger-backfill.mjs`.

## The GL event matrix

| # | Module event | Source hook | Journal (default chart) | refType | Idempotency key |
|---|---|---|---|---|---|
| 1 | Goods received on a purchase (`procurement.receiveStock`) | `routes/procurement.ts` after `postStockEntry` | DR 1300 Inventory / CR 2110 Accounts Payable — Suppliers, at Σ lines qty × unitCost (quotation price, else estimate) | `PROCURE_RECEIPT` | `fin13:procurement:receive:{stockEntryId}` |
| 2 | Manual stock adjustment (`inventory.stock.adjust`) | `routes/inventory.ts` after the StockTransaction commits | gain: DR 1300 / CR 5310 · loss: DR 5310 / CR 1300, at \|delta\| × item lastCost | `INVENTORY_ADJUST` | `fin13:adjust:{stockTxId}` |
| 3 | Stock issued as company property (`inventory.issueAsAsset` → approval → `executeAssetIssue`) | `routes/inventory.ts` inside the same transaction as the stock decrement | DR 1400 Fixed Assets / CR 1300 Inventory, at qty × item lastCost | `STOCK_ASSET_ISSUE` | `fin13:assetissue:{requestId}` |
| 4a | Asset retired (`assets.retire`) | `routes/assets.ts` inside the status-change transaction | DR 6200 Asset Disposal Loss / CR 1400, at carrying value (purchaseCost) | `ASSET_RETIRE` | `fin13:asset:retire:{assetId}` |
| 4b | Asset marked lost (`assets.lose`) — a write-off | `routes/assets.ts`, same shape | DR 6200 / CR 1400 | `ASSET_LOSE` | `fin13:asset:lose:{assetId}` |

### Deliberately NOT posted (and why)

- **Warehouse transfers** — same-account location moves within one company;
  net GL effect zero by construction.
- **Plain manual stock entries without a purchase link** (opening balances,
  first-aid top-ups) — no counterparty event exists to book; entering them
  requires an equity/capital decision that belongs to the vendor's own books.
- **Direct asset registrations (`assets.create`)** — the module records no
  supplier or invoice for them, so there is no honest counterparty entry.
  Register such acquisitions through a manual journal voucher instead.
- **Requisition issues (stock consumed by departments)** — a consumption
  booking needs a cost-center/expense-account decision the inventory module
  does not carry. Recorded as the follow-up item; not part of this phase.

### Known basis limitations (recorded, never silently smoothed)

- No depreciation module exists: carrying value = `purchaseCost`. The
  disposal entries therefore write off full cost. When a depreciation module
  lands, `assets.retire/lose` should re-derive carrying value.
- The historical ADJUST backfill values rows at the item's **current**
  `lastCost` (the module keeps no per-movement cost on StockTransaction).
  The journal memo of every backfilled adjustment states this.

## Toggles (Settings → Payroll → Accounting)

| Setting | Default | Controls |
|---|---|---|
| `accounting.autoPostProcurement` | ON | GL #1 |
| `accounting.autoPostInventory` | ON | GL #2 |
| `accounting.autoPostAssets` | ON | GL #3, #4a, #4b |

Each toggle reads `undefined` as ON (settings written before Phase 2 keep
posting). Account mapping is the same tenant-editable mechanism payroll uses
(`resolveAccountMapping`, `Settings → Payroll → Accounting`); the five new
roles are `inventoryAsset`, `supplierPayable`, `fixedAssets`,
`stockAdjustment`, `assetDisposalLoss`.

## Historical backfill plan

`scripts/fin13-ledger-backfill.mjs` — operator-run, journaled
(`_fin13_backfill_runs` / `_fin13_backfill_journal`), `--dry-run` default,
`--confirm` requires `FIN13_EXECUTION_GATE_ACK=BACKFILL-POST-DEPLOY`
(acknowledging the Phase 2 forward hooks are live on every instance).
`--restore <runId>` reverses exactly that run's rows. Every journal row
carries `source: "FIN13-BACKFILL"` and an idempotency key from the SAME
keyspace as the forward hooks — re-runs and forward/backfill collisions are
impossible by construction. Rows with no cost basis are skipped and counted,
never fabricated.

Run order (mirrors the class list):

```bash
DATABASE_URL=… bun scripts/fin13-ledger-backfill.mjs --dry-run   # survey first
FIN13_EXECUTION_GATE_ACK=BACKFILL-POST-DEPLOY \
DATABASE_URL=… bun scripts/fin13-ledger-backfill.mjs --confirm   # real run
```

## Verification

- Unit tests: `tests/unit/fin13-ledger-loop.test.ts` (hook shapes, toggles,
  idempotency, skip honesty) and the backfill script's synthetic-fixture lane.
- Live gate: after the backfill, `accounting.trialBalance` lists accounts
  1300 / 2110 / 1400 / 5310 / 6200 with non-zero balances wherever the
  historical data carried a cost basis.
