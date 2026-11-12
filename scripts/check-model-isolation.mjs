#!/usr/bin/env bun
// ============ check-model-isolation.mjs — FIN-027 (Phase 2) ============
// The model-isolation REGISTRY GATE. The registry
// (deploy/model-isolation-registry.json) declares HOW every Prisma model is
// tenant-isolated; this script re-derives the same classification from
// prisma/schema.prisma and enforces three invariants:
//
//   G1  every model in the schema has a registry entry (an unregistered
//       model is an unreviewed isolation decision — fail),
//   G2  every registry entry has a model (stale entries after a rename/
//       removal drift the registry — fail),
//   G3  the declared strategy matches the schema's physical structure
//       (a model that gained/lost companyId/employeeId/relations without a
//       registry amendment fails — the registry is a reviewed artifact,
//       not a mirror).
//
// Plus the FIN-017 policy rule, standing since the Phase 2 remediation:
//
//   G4  employee-child-materialized is FORBIDDEN. An employeeId column
//       without the Employee relation routes its scope through
//       scopedEmployeeWhere's materialized id IN-lists (thousands of bind
//       parameters per query at 5k-50k employees — the FIN-017 defect).
//       Every employee-child model must carry the relation
//       (`employee Employee @relation(...)`; nullable employeeId ⇒
//       `Employee?`) so its scope composes through
//       scopedEmployeeRelationWhere's JOIN instead.
//
// Strategy derivation (single source of truth mirrored from
// fin17_registry_regen.py v2 — the classifier fix that counts nullable
// `Employee?` relations):
//   direct-company            — has a companyId column
//   employee-child-relation   — has employeeId AND the Employee relation
//   employee-child-materialized — has employeeId, NO relation   [G4: fail]
//   vendor-plane              — vendorId only (isolation by per-query
//                                composition; every read/write path must
//                                carry its scope)
//   saas-plane                — no vendorId (platform tables outside the
//                                tenant plane)
//
// Usage: bun scripts/check-model-isolation.mjs [--registry path] [--schema path]
// Exit 0 = registry honest; exit 1 = violations (one line each, filed by gate).

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const SCHEMA = opt("--schema") || join(ROOT, "prisma", "schema.prisma")
const REGISTRY = opt("--registry") || join(ROOT, "deploy", "model-isolation-registry.json")

const schema = readFileSync(SCHEMA, "utf8")
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"))

// ---- parse models out of the schema --------------------------------------
// Each field entry is [fieldName, fullTypeAndAttributes] — the FULL text
// after the name (type + @relation/@default/...), so relation checks see
// the attributes the way Prisma writes them.
const models = {}
for (const m of schema.matchAll(/^model (\w+) \{([^]*?)^\}/gm)) {
  const name = m[1]
  const body = m[2]
  const fields = []
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("//") || t.startsWith("@@")) continue
    const f = t.match(/^(\w+)\s+(.+)$/) // name + rest-of-line (type AND attrs)
    if (f) fields.push([f[1], f[2].trim()])
  }
  models[name] = fields
}

// ---- derive each model's isolation strategy -------------------------------
const derived = {}
for (const [name, fields] of Object.entries(models)) {
  const names = new Set(fields.map((f) => f[0]))
  // `employee Employee @relation(...)` / `employee Employee? @relation(...)` —
  // a nullable relation is still a relation (registry v2 classifier fix).
  const rel = fields.some((f) => f[0] === "employee" && /^Employee\??\s+@relation/.test(f[1]))
  derived[name] = {
    vendorId: names.has("vendorId"),
    companyId: names.has("companyId"),
    employeeId: names.has("employeeId"),
    employeeRelation: rel,
  }
  if (derived[name].companyId) derived[name].strategy = "direct-company"
  else if (derived[name].employeeId && rel) derived[name].strategy = "employee-child-relation"
  else if (derived[name].employeeId) derived[name].strategy = "employee-child-materialized"
  else if (derived[name].vendorId) derived[name].strategy = "vendor-plane"
  else derived[name].strategy = "saas-plane"
}

// ---- run the gates --------------------------------------------------------
const violations = []

// G4 first (the FIN-017 policy) — derived from the SCHEMA alone
for (const [name, d] of Object.entries(derived)) {
  if (d.strategy === "employee-child-materialized") {
    violations.push(
      `G4/FIN-017: model ${name} carries employeeId WITHOUT the Employee relation — ` +
      `materialized scopedEmployeeWhere id-lists are forbidden since Phase 2. ` +
      `Add the relation (nullable employeeId ⇒ Employee?) + a migration + registry entry.`
    )
  }
}

// G1: schema model without a registry entry
for (const name of Object.keys(derived)) {
  if (!registry.models[name]) {
    violations.push(`G1: model ${name} exists in schema.prisma but has no registry entry in ${REGISTRY}`)
  }
}

// G2: registry entry without a schema model
for (const name of Object.keys(registry.models || {})) {
  if (!derived[name]) {
    violations.push(`G2: registry entry ${name} has no model in schema.prisma (renamed/removed — amend the registry)`)
  }
}

// G3: declared strategy ≠ derived structure
for (const [name, entry] of Object.entries(registry.models || {})) {
  const d = derived[name]
  if (!d) continue // already filed by G2
  if (entry.strategy !== d.strategy) {
    violations.push(
      `G3: ${name} declares strategy "${entry.strategy}" but the schema derives "${d.strategy}" — ` +
      `amend the registry (a reviewed artifact), not the derivation`
    )
  }
  for (const flag of ["vendorId", "companyId", "employeeId", "employeeRelation"]) {
    if (flag in entry && Boolean(entry[flag]) !== Boolean(d[flag])) {
      violations.push(`G3: ${name} registry flag ${flag}=${entry[flag]} does not match the schema (${d[flag]})`)
    }
  }
}

// ---- report ---------------------------------------------------------------
if (violations.length) {
  console.error(`check-model-isolation: ${violations.length} violation(s) — the registry is NOT honest:`)
  for (const v of violations) console.error("  · " + v)
  process.exit(1)
}
const counts = {}
for (const d of Object.entries(derived)) counts[d[1].strategy] = (counts[d[1].strategy] || 0) + 1
console.log(
  `check-model-isolation: OK — ${Object.keys(derived).length} models, ` +
  `direct-company ${counts["direct-company"] || 0}, employee-child-relation ${counts["employee-child-relation"] || 0}, ` +
  `employee-child-materialized ${counts["employee-child-materialized"] || 0} (forbidden, none present), ` +
  `vendor-plane ${counts["vendor-plane"] || 0}, saas-plane ${counts["saas-plane"] || 0}`
)
process.exit(0)
