#!/usr/bin/env node
// ============ R-30 (W1) — release-artifact validator (V1–V10) ============
// Validates deploy/release-manifest.json against the approved multi-company
// release contract (FINAL DEPLOYMENT STRATEGY §5) in two modes:
//
//   --tree <repo-root>   working-copy check (V1–V7): the repository's
//                        prisma/migrations directory set must equal the
//                        manifest exactly, in lockstep at every commit.
//   --image <root>       artifact/image check (V1–V6, V8–V10): the extracted
//                        image root (…/app) carrying deploy/release-manifest.json
//                        and prisma/migrations — same equality rule (V6).
//
// Exit codes: 0 = valid; 1 = any violation (each printed as
// "FAIL V<n>: <detail>"). CI gates and the container entrypoint (V12) both
// run this script; a non-zero exit must block the deploy.
//
// Rules (deployment strategy §5.4):
//   V1  strict JSON — no comments, no trailing commas, no duplicate keys,
//       no BOM (the BOM check runs FIRST with its own message).
//   V2  exact key set {manifestVersion, release, releaseWave, migrations};
//       manifestVersion === 1; release ∈ R1..R5; releaseWave matches the
//       release→wave table.
//   V3  no placeholder tokens (*, …, ..., same-as:, baseline, <, >,
//       whitespace) — every entry is a plain directory-name string.
//   V4  no duplicate entries (case-sensitive).
//   V5  strict lexicographic ascending order.
//   V6  image mode: the artifact's migration directory set equals the
//       manifest exactly (missing AND unexpected are both fatal).
//   V7  tree mode: the repository's migration directory set equals the
//       manifest exactly (same rule).
//   V8  cumulative-equality against the approved contract: the manifest's
//       migration SET must equal the approved set for its release exactly
//       (R1 = R2 = R3 = R4 = the 58-entry chain; R5 = that + M4). No other
//       differences are legal; M3a/M3b are scripts and appear in no set.
//   V9  M4 containment: the M4 contract name (and any entry containing
//       "enforce") must be ABSENT from R1–R4.
//   V10 M4 presence: the R5 manifest MUST contain the M4 contract name.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

// ---------- the approved contract (deployment strategy §5.2/§5.3) ----------
// Stage B (B-7 Option 1 / 1(b), 2026-11-03) — the approved chain gained the two
// corrective migrations: 9_wave9zxz (B-7 fresh-install replay guard, sorts
// between 9_wave9zx and 9_wave9zy so the historical DROP INDEX in 9_wave9zy
// resolves) and 9_wave9zzab (normalize-then-exempt parity normalization).
// 9_wave9zzab deliberately sorts BETWEEN the previous tip 9_wave9zza and the
// reserved M4 name 9_wave9zzb_mc_enforce_20261103: the M4 release must remain
// a pure in-order append for every already-deployed database (investigated
// with the real migration runner on PG 16.4 + 18.6 — a post-zzb name such as
// zzc would force the future M4 to be applied out of order on upgraded
// databases while fresh installs apply it in order: divergent histories and
// divergent schema states observed by the M4 DDL. See the Stage B report,
// migration-ordering section).
// 2026-11-05 — the chain gained 9_wave9zzac (SaasPlan.companyLimit), approved by
// the product owner as a deliberate amendment; it sorts before the M4 name for the
// same reason as 9_wave9zzab, as does 9_wave9zzad (employee company transfer).
// R1 must be re-verified with both included.
// 2026-11-07 — deliberate amendment #3 (audit remediation + KPI Performance
// System): the chain gained 9_wave9zzae (audit H-3 MFA enrollment OTP backfill)
// and 9_wave9zzaf (KPI Performance System: templates/indicators/assignments/
// achievements/batches/approvals/revisions). Both sort AFTER 9_wave9zzad and
// BEFORE the reserved M4 name, so every already-deployed database keeps a pure
// in-order append. R1 re-verified with both included (62 migrations).
const M4_NAME = "9_wave9zzb_mc_enforce_20261103"
const RELEASE_WAVES = { R1: "W1", R2: "W2", R3: "W3", R4: "W4", R5: "W5" }
// The cumulative approved chain: 53 baseline (through 9_wave9zx) + the two
// existing 2026-11-03 release migrations + M1 + the two Stage B corrective
// migrations. R2–R4 add nothing; R5 adds M4 (which still sorts AFTER both
// corrective migrations — V5 ascending order holds in R1–R5 alike).
const APPROVED_CHAIN = [
  "0_init_postgresql", "1_requirements_round_20261002", "2_tracking_security_payout_20261002", "3_audit_remediation_20261002",
  "4_selfie_gaps_20261003", "5_saas_platform_20261003", "6_owner_mfa_recovery_20261004", "7_website_cms_20261005",
  "8_roles_and_password_flags_20261006", "9_wave10a_payroll_calc_epoch_20261022", "9_wave10b_usage_snapshot_metering_20261022", "9_wave11a_outbox_20261026",
  "9_wave11b_phase3_device_token_20261028", "9_wave11c_device_token_drop_sql_defaults_20261030", "9_wave2_jobs_20261008", "9_wave2_modules_20261008",
  "9_wave2_saas_ops_20261008", "9_wave3_a_voucher_approval_20261008", "9_wave3_b_plan_requests_20261008", "9_wave4_a_reports_20261008",
  "9_wave4_b_accounting_20261008", "9_wave4_c_integrations_20261008", "9_wave4_d_ats_20261008", "9_wave5_requirements_round_20261012",
  "9_wave6_paisa_bigint_20261013", "9_wave7_loan_guarantor_control_20261014", "9_wave8_ait_legal_audit_20261014", "9_wave9_present_address_fields_20261015",
  "9_wave9z_inventory_serials_20261018", "9_wave9za_commission_rule_setup_20261019", "9_wave9zb_commission_rule_eligible_statuses_20261020", "9_wave9zc_pf_contribution_dedupe_unique_20261021",
  "9_wave9zd_attendance_raw_event_sweeper_index_20261021", "9_wave9ze_attendance_raw_event_vendor_sweep_index_20261022", "9_wave9zf_employee_search_trigram_20261022", "9_wave9zg_session_expiry_indexes_20261022",
  "9_wave9zh_usage_rollup_20261022", "9_wave9zi_coordination_tokens_bounce_20261022", "9_wave9zj_push_subscriptions_20261022", "9_wave9zk_leave_type_gender_restriction_20261023",
  "9_wave9zl_child_vendor_backfill_20261023", "9_wave9zm_session_token_hash_20261023", "9_wave9zn_trigram_refresh_retention_20261023", "9_wave9zo_r7_feature_parity_20261023",
  "9_wave9zp_infra_support_payments_storage_sms_20261024", "9_wave9zq_support_billing_mfa_design_20261025", "9_wave9zr_billing_idempotency_invoice_unique_20261026", "9_wave9zs_invoice_vat_snapshot_20261026",
  "9_wave9zt_exit_cancel_20261101", "9_wave9zu_kpi_totals_20261101", "9_wave9zv_workforce_snapshots_20261101", "9_wave9zw_report_delivery_20261101",
  "9_wave9zx_money_paisa_backfill_20261102",
  "9_wave9zxz_payroll_run_index_name_guard_20261103",
  "9_wave9zy_multi_company_20261103", "9_wave9zz_all_companies_mode_20261103", "9_wave9zza_mc_expand_20261103",
  "9_wave9zzab_payroll_parity_normalization_20261103",
  "9_wave9zzac_plan_company_limit_20261105",
  "9_wave9zzad_employee_company_transfer_20261105",
  "9_wave9zzae_audit_h3_mfa_enroll_otp_20261107",
  "9_wave9zzaf_kpi_performance_system_20261107",
  // 2026-11-09 — deliberate amendment #4 (P0 remediation wave, audit report
  // Ch.16 Table 6): the chain gained 9_wave9zzag (SEC-3 non-public
  // SaaSRegistration.duplicateEmail flag + SEC-4 indexed
  // HrLetter.verificationCodePrefix with backfill). It sorts AFTER 9_wave9zzaf
  // and BEFORE the reserved M4 name, so every already-deployed database keeps
  // a pure in-order append. R1 re-verified with it included (63 migrations).
  "9_wave9zzag_p0_registration_flag_letter_prefix_20261109",
  // 2026-11-09 — drift repair (found by running the schema-drift gate on the
  // P0 tree): 9_wave9zzah restores the missing KpiAssignment.status DEFAULT
  // 'PENDING_APPROVAL' that the 2026-11-07 KPI redesign declared in the schema
  // but never migrated. Still sorts BEFORE the reserved M4 name (64 total).
  "9_wave9zzah_kpi_assignment_status_default_20261109",
  // 2026-11-09 — deliberate amendment #5 (P2 remediation wave, audit report
  // Ch.16 Table 8 — debt retirement): the chain gained 9_wave9zzai (DBD-2:
  // index coverage for six FK columns — SaasPayment.invoiceId,
  // SaaSInvoice.subscriptionId, Employee.designationId,
  // SaaSSubscription.vendorId, SaaSRegistration.planId,
  // CommissionThreshold.importId; additive CREATE INDEX IF NOT EXISTS) and
  // 9_wave9zzaj (DBD-1: guarded paisa backfill for the 28 legacy
  // Float↔BigInt column pairs — idempotent UPDATE ... WHERE paisa IS NULL).
  // Both ADDITIVE-ONLY, both sort BEFORE the reserved M4 name (66 total) so
  // every already-deployed database keeps a pure in-order append.
  // R1 re-verified with both included.
  "9_wave9zzai_fk_index_coverage_20261109",
  "9_wave9zzaj_paisa_backfill_20261109",
  // 2026-11-10 — deliberate amendment #6 (forensic-audit Phase 0 remediation,
  // finding FIN-002): the chain gains 9_wave9zzak (StockEntry.companyId — the
  // 2026-11-09 multi-company inventory scoping migration). It was merged to
  // disk WITHOUT a manifest entry, so the V7 tree check failed CI stage 15/15
  // and the docker entrypoint V12 assertion refused container start
  // ("manifest drift"). Registered here and in deploy/release-manifest.json
  // in lockstep; the T-05 unit guard is converted to a structural
  // manifest = disk-set assertion so future amendments cannot drift again.
  // Additive-only (nullable column + backfill + FK + index), sorts AFTER zzaj
  // and BEFORE the reserved M4 name (67 total).
  "9_wave9zzak_stock_entry_company_id_20261109",
  // 2026-11-10 — deliberate amendment #7 (forensic-audit Phase 1 remediation,
  // finding FIN-012): the chain gains 9_wave9zzal (StockLevel CHECK >= 0
  // constraints + negative-quantity data repair — the DB-level backstop the
  // inventory transfer path always CLAIMED it had but never did). Registered
  // here and in deploy/release-manifest.json in lockstep (the structural
  // T-05 guard needed no change — exactly the FIN-025 exit criterion:
  // adding a migration no longer touches the guard). Additive-only (two CHECK
  // constraints + idempotent UPDATE repairs), sorts AFTER zzak and BEFORE the
  // reserved M4 name (68 total).
  "9_wave9zzal_stock_level_nonneg_20261110",
  // 2026-11-10 — deliberate amendment #8 (forensic-audit Phase 2 remediation,
  // finding FIN-017): the chain gains 9_wave9zzam (Employee relations for the
  // 47 employee-child models — the FK constraints that let company scope
  // compose into JOINs instead of materialized employee-id IN-lists, plus
  // the (vendorId, employeeId) indexes for the six tables without an
  // employeeId probe path). Registered here and in deploy/release-manifest.json
  // in lockstep; additive-only (constraints + indexes after a fail-fast
  // orphan pre-flight), sorts AFTER zzal and BEFORE the reserved M4 name
  // (69 total).
  "9_wave9zzam_employee_child_relations_20261110",
  // 2026-11-11 — deliberate amendment #9 (forensic-audit Phase 3 remediation,
  // finding FIN-020): the chain gains 9_wave9zzan (the inventory/procurement/
  // assets periphery joins the paisa integer system — 14 nullable BigInt
  // *Paisa shadow columns across Item/StockTransaction/StockEntryItem/
  // InventoryItemSerial/PurchaseRequest(+Item)/PurchaseQuotation(+Item)/Asset,
  // each backfilled once from its Float column, same convention as the core
  // chain's 9_wave9zzaj). Registered here and in deploy/release-manifest.json
  // in lockstep; additive-only (nullable columns + idempotent backfills),
  // sorts AFTER zzam and BEFORE the reserved M4 name (70 total).
  "9_wave9zzan_periphery_paisa_shadows_20261110",
]
const APPROVED_SET_R1_R4 = new Set(APPROVED_CHAIN)
const APPROVED_SET_R5 = new Set([...APPROVED_CHAIN, M4_NAME])

// ---------- strict JSON (V1) ----------
function parseStrictJson(text, fail) {
  // V1 — BOM FIRST with its own specific message (a BOM otherwise surfaces
  // as a generic parse error and the diagnostic value is lost).
  if (text.charCodeAt(0) === 0xfeff) {
    fail("V1", "deploy/release-manifest.json starts with a byte-order mark (BOM) — save the file as UTF-8 WITHOUT BOM")
  }
  if (/^\s*\/\//.test(text) || /(^|[^:"'\\])\/\/[^\n]*$/.test(text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")) || /\/\*/.test(text)) {
    fail("V1", "deploy/release-manifest.json contains JSON comments — strict JSON only (no comments, no JSONC)")
  }
  if (/,\s*[}\]]/.test(text)) {
    fail("V1", "deploy/release-manifest.json contains a trailing comma — strict JSON only")
  }
  // duplicate keys: a hand-rolled scan of the raw object keys (JSON.parse
  // silently keeps the LAST value — no silent last-wins is allowed here)
  const dup = findDuplicateKeys(text)
  if (dup) {
    fail("V1", `deploy/release-manifest.json contains the duplicate key "${dup}" — JSON.parse would silently keep the last value`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    fail("V1", `deploy/release-manifest.json is not parseable strict JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Detect duplicate keys in the FIRST-LEVEL object (and any nesting) by a
 *  tolerant re-scan that respects string literals. */
function findDuplicateKeys(text) {
  const stack = []
  let i = 0
  const seen = [new Set()]
  let inString = false
  let escaped = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      // read the full key/val string
      let j = i + 1
      let s = ""
      while (j < text.length) {
        if (text[j] === "\\") { s += text[j] + text[j + 1]; j += 2; continue }
        if (text[j] === '"') break
        s += text[j]; j++
      }
      // is this a KEY (next non-space char is ':')?
      let k = j + 1
      while (k < text.length && /\s/.test(text[k])) k++
      if (text[k] === ":") {
        const top = seen[seen.length - 1]
        if (top.has(s)) return s
        top.add(s)
      }
      i = j + 1
      continue
    }
    if (c === "{") { stack.push("{"); seen.push(new Set()) }
    else if (c === "}") { stack.pop(); seen.pop() }
    i++
  }
  return null
}

// ---------- main ----------
const args = process.argv.slice(2)
const treeIdx = args.indexOf("--tree")
const imageIdx = args.indexOf("--image")
if ((treeIdx === -1) === (imageIdx === -1)) {
  console.error("usage: node scripts/check-release-artifact.mjs --tree <repo-root> | --image <extracted-image-root>")
  process.exit(1)
}
const mode = treeIdx !== -1 ? "tree" : "image"
const root = args[(treeIdx !== -1 ? treeIdx : imageIdx) + 1]
if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`FAIL V1: the given ${mode} root "${root}" does not exist or is not a directory`)
  process.exit(1)
}

const errors = []
const fail = (rule, detail) => {
  errors.push(`FAIL ${rule}: ${detail}`)
}

const manifestPath = join(root, "deploy", "release-manifest.json")
if (!existsSync(manifestPath)) {
  console.error(`FAIL V1: ${manifestPath} does not exist — the canonical manifest path is deploy/release-manifest.json (D-5)`)
  process.exit(1)
}

const manifest = parseStrictJson(readFileSync(manifestPath, "utf8"), fail)

// V2 — exact key set + values
if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
  const keys = Object.keys(manifest).sort()
  const expected = ["manifestVersion", "migrations", "release", "releaseWave"].join(",")
  if (keys.join(",") !== expected) {
    fail("V2", `unexpected key set [${keys.join(", ")}] — the exact schema is {manifestVersion, release, releaseWave, migrations}`)
  }
  if (manifest.manifestVersion !== 1) fail("V2", `manifestVersion must be 1 (got ${JSON.stringify(manifest.manifestVersion)})`)
  if (!/^R[1-5]$/.test(String(manifest.release))) fail("V2", `release must match ^R[1-5]$ (got ${JSON.stringify(manifest.release)})`)
  if (RELEASE_WAVES[manifest.release] !== manifest.releaseWave) {
    fail("V2", `releaseWave must be ${RELEASE_WAVES[manifest.release] ?? "?"} for release ${manifest.release} (got ${JSON.stringify(manifest.releaseWave)})`)
  }
} else {
  fail("V2", "the manifest must be a JSON object")
  console.error(errors.join("\n"))
  process.exit(1)
}

const migrations = manifest.migrations

// V3 — plain directory-name strings only
if (!Array.isArray(migrations)) {
  fail("V3", "migrations must be an array of migration directory names")
  console.error(errors.join("\n"))
  process.exit(1)
}
for (const m of migrations) {
  if (typeof m !== "string") { fail("V3", `entry ${JSON.stringify(m)} is not a string`); continue }
  if (/[*]/.test(m)) fail("V3", `placeholder token "*" in entry "${m}" — every entry is a plain directory name`)
  if (m.includes("…") || m.includes("...")) fail("V3", `ellipsis placeholder in entry "${m}" — every entry is a plain directory name`)
  if (m.includes("same-as:")) fail("V3", `reference placeholder in entry "${m}" — manifests never reference other releases`)
  if (m === "baseline" || m.includes("<") || m.includes(">")) fail("V3", `placeholder token in entry "${m}" — every entry is a plain directory name`)
  if (/\s/.test(m)) fail("V3", `whitespace in entry "${m}" — directory names carry no whitespace`)
}

// V4 — duplicates (case-sensitive)
const seen = new Set()
for (const m of migrations) {
  if (seen.has(m)) fail("V4", `duplicate entry "${m}" (case-sensitive)`)
  seen.add(m)
}

// V5 — strict lexicographic ascending order
for (let i = 1; i < migrations.length; i++) {
  if (!(migrations[i - 1] < migrations[i])) {
    fail("V5", `array is not in strict lexicographic ascending order: "${migrations[i - 1]}" is followed by "${migrations[i]}"`)
    break
  }
}

// V8 — cumulative-equality against the approved contract
const approvedSet = manifest.release === "R5" ? APPROVED_SET_R5 : APPROVED_SET_R1_R4
const manifestSet = new Set(migrations)
const missingFromManifest = [...approvedSet].filter((x) => !manifestSet.has(x))
const extraInManifest = [...manifestSet].filter((x) => !approvedSet.has(x))
if (missingFromManifest.length) fail("V8", `manifest is missing approved-contract entries: ${missingFromManifest.join(", ")}`)
if (extraInManifest.length) fail("V8", `manifest contains entries outside the approved contract: ${extraInManifest.join(", ")}`)

// V9 — M4 containment (absent from R1–R4)
if (manifest.release !== "R5") {
  if (migrations.includes(M4_NAME)) {
    fail("V9", `the M4 enforcement migration "${M4_NAME}" must be ABSENT from ${manifest.release} (M4 ships in R5 only, after gates G1–G4)`)
  }
  for (const m of migrations) {
    if (typeof m === "string" && m.includes("enforce")) {
      fail("V9", `entry "${m}" matches the enforcement pattern — enforcement migrations ship in R5 only`)
    }
  }
}

// V10 — M4 presence (in R5)
if (manifest.release === "R5" && !migrations.includes(M4_NAME)) {
  fail("V10", `the R5 manifest must contain the M4 enforcement migration "${M4_NAME}"`)
}

// V6/V7 — directory-set equality (tree = working copy; image = artifact)
const migrationsDir = join(root, "prisma", "migrations")
if (!existsSync(migrationsDir)) {
  fail(mode === "tree" ? "V7" : "V6", `${migrationsDir} does not exist`)
} else {
  const onDisk = new Set(
    readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  )
  for (const m of migrations) {
    if (!onDisk.has(m)) fail(mode === "tree" ? "V7" : "V6", `declared migration "${m}" has no directory in ${migrationsDir}`)
  }
  for (const d of onDisk) {
    if (!manifestSet.has(d)) fail(mode === "tree" ? "V7" : "V6", `migration directory "${d}" exists on disk but is NOT declared in the manifest`)
  }
}

if (errors.length) {
  console.error(errors.join("\n"))
  process.exit(1)
}
console.log(`OK — release ${manifest.release} (${manifest.releaseWave}): ${migrations.length} migrations, manifest ${mode === "tree" ? "and working tree" : "and image"} match exactly (V1–${mode === "tree" ? "V7" : "V6"}, V8–V10 clean)`)
process.exit(0)
