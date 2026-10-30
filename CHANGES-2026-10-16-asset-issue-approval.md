# Asset Issue Approval Flow + Issue Qty (2026-10-16)

Stock Inventory → **Issue as asset** no longer moves stock immediately. Issuing is now a **request → approve → deduct** flow on the existing reusable approval engine, with a searchable employee picker and a validated Issue Qty. **No database migration required** (the approval request payload carries the request; no new tables/columns).

## 1. Issue dialog (Stock Inventory → Overview/Items → Issue as asset)
- **Issue to** is now a searchable combobox (name/employee-code search, `cmdk` Popover pattern) — ACTIVE/PROBATION employees only, same assignability rule the server enforces.
- New **Issue Qty** field beside it. Client validation: positive integer, and **≤ issueable**, where issueable = on hand − reserved − **qty pending approval**. The server re-validates (never frontend-only) and rejects with a breakdown message, e.g. `Cannot request 3 Pcs of "Laptop Core i5" — only 1 issueable now (2 on hand − 0 reserved − 1 pending approval)`.
- The helper line under the field shows the live breakdown: `Available: N of M on hand · P pending approval`.
- Submit button is **Send for approval**; a summary strip restates `Requesting X of Y issueable · stock and asset records are created only when the request is fully approved`.
- Overview "Issue as asset" buttons disable when nothing is **issueable** (not merely on hand = 0), and the Available column shows `−P pending approval` under the count.

## 2. Approval flow (new process type `ASSET_ISSUE`)
- Submitting calls the same route (`inventory.issueAsAsset`), which now **submits an ASSET_ISSUE approval request** instead of decrementing stock. Pending requests reserve nothing on `StockLevel` and write no `StockTransaction` — the ledger moves **only at final approval**.
- The request lands in the unified **Approval Queue** (role-routed steps, delegation, separation of duties, amount thresholds all inherited). `amount = qty × last cost` drives threshold auto-pass and the queue's Amount column; `employeeId` in the payload enables department/branch step scoping.
- On **full approval**, the finalize hook (`applyAssetIssueDecision` → `executeAssetIssue`) runs the original atomic transaction: conditional stock decrement (check-and-set, §16) + `StockTransaction` (ISSUE, qty −N, ref `ASSET_ISSUE` → approval request) + **one tracked Asset (auto AST-code) + AssetAssignment + AssetEvent per unit** + employee notification.
- On **rejection**, nothing moves (engine notifies the requester).
- The availability gate **re-runs at approval time** (stock may have moved while the request waited). If insufficient, the finalize fails **loudly** per the engine's M-9 contract: audit row + HR-admin notification, request stays visible — never a silent short-issue.
- Existing tenants keep working: if no ASSET_ISSUE workflow is configured, a default single-step **Owner Approval** workflow is auto-provisioned (audited) — fully editable in Settings → Approval Workflows.

## 3. Configuration & seeds (15th process type)
- `PROCESS_TYPES` lists now include `ASSET_ISSUE` in `seed-owner.ts` (clean tenant seed), `src/hrm-server/saas/provision.ts` (registration provisioning) and `scripts/seed-approval-workflows.ts` (repairs existing tenants: default `Store / HR Review → Final Approval`, owner-only for minimal vendors — safe to re-run).
- Demo seed (`seed.ts`): Asset Issue Approval workflows for both demo vendors.
- Settings → Approval Workflows: ASSET_ISSUE listed with default steps; Approval Queue: yellow `Asset Issue` process badge; Bangla labels for the new dialog strings.

## 4. Server routes touched
- `inventory.items.list` / `inventory.stock.overview` now return `pendingIssue` (qty in PENDING ASSET_ISSUE requests per item) and `issueable` alongside `onHand/reserved/available`.
- `inventory.issueAsAsset` response changed from `{ assetId, code, assignmentId, balanceAfter }` to `{ approvalId, status: "PENDING_APPROVAL", issueable }`.

## Files
`src/hrm-server/approval.ts`, `src/hrm-server/routes/inventory.ts`, `src/hrm-server/routes/hooks.ts`, `src/hrm/views/inventory.tsx`, `src/hrm/views/approvals.tsx`, `src/hrm-server/saas/provision.ts`, `scripts/seed-approval-workflows.ts`, `prisma/schema.prisma` (comment only).
