/// <reference types="bun-types" />
// ============ FIN-081 (Phase 1) — the reports six-permission split ============
// view · pii.view · export · pii.export · schedule · pii.schedule
//
// The audit's privacy gap: reports.pii gated the EXPORT twin only — any
// reports.view holder could render the biodata report ON SCREEN (parents'
// names, DOB, blood group, marital status, addresses). The split is enforced
// SERVER-SIDE in the reportRoute factory, and the legacy flat reports.pii is
// grandfathered by read-time expansion in getCtxFromToken so pre-split grants
// keep exactly the rights they had.
//
// This test drives the REAL dispatcher (POST /api/hrm) for every case:
//   1. reports.view alone CANNOT render a PII report on screen (403)
//   2. reports.pii.view CAN render it on screen
//   3. reports.pii.view alone CANNOT export it (needs reports.pii.export + confirm)
//   4. the legacy flat reports.pii expands to all three split verbs
//   5. reports.pii.schedule is required to schedule a PII report template
//   6. support sessions never receive the split verbs (like the flat verb)
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { getCtxFromToken } from "@/hrm-server/auth"
import { supportPermissionsFor } from "@/hrm-server/saas/support-access"

let v: any
let ownerToken: string
let viewerToken: string   // reports.view only
let piiViewerToken: string // reports.view + reports.pii.view
let legacyPiiToken: string // reports.view + legacy flat reports.pii

beforeAll(async () => {
  v = await mkVendor(uniq("fin081"))
  const owner = await mkUser(v.id, { role: "VENDOR_OWNER", name: "FIN-081 Owner" })
  ownerToken = await mkSession(owner.id, "FULL")
  await mkEmployee(v.id, { fullName: "FIN-085 Biodata Subject" })
})

describe("FIN-081 — PII view gating through the real dispatcher", () => {
  test("reports.view alone CANNOT render a PII report on screen", async () => {
    const viewer = await mkUser(v.id, { role: "HR_MANAGER", name: "Viewer", permissions: ["reports.view"] })
    viewerToken = await mkSession(viewer.id, "FULL")
    const r = await postHrm("reports.employeesBiodata", {}, { bearer: viewerToken })
    expect(r.status).toBe(403)
    expect(String(r.body.error || "")).toContain("reports.pii.view")
    // the SAME caller renders a non-PII report fine — the gate is PII-specific
    const ok = await postHrm("reports.employees", {}, { bearer: viewerToken })
    expect(ok.status).toBe(200)
  })

  test("reports.pii.view renders the PII report on screen", async () => {
    const piiViewer = await mkUser(v.id, { role: "HR_MANAGER", name: "PiiViewer", permissions: ["reports.view", "reports.pii.view"] })
    piiViewerToken = await mkSession(piiViewer.id, "FULL")
    const r = await postHrm("reports.employeesBiodata", {}, { bearer: piiViewerToken })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.data.rows)).toBe(true)
  })

  test("reports.pii.view alone CANNOT export — reports.pii.export + typed confirmation required", async () => {
    // no confirmation → 400 regardless of permission
    const noConfirm = await postHrm("reports.employeesBiodataCsv", {}, { bearer: piiViewerToken })
    expect([400, 403]).toContain(noConfirm.status)
    // with confirmation but only pii.view → 403 (needs pii.export)
    const r = await postHrm("reports.employeesBiodataCsv", { confirm: "EXPORT" }, { bearer: piiViewerToken })
    expect(r.status).toBe(403)
    // the owner (grandfathered split verbs) exports with confirmation
    const ok = await postHrm("reports.employeesBiodataCsv", { confirm: "EXPORT" }, { bearer: ownerToken })
    expect(ok.status).toBe(200)
    expect(typeof ok.body.data.csv).toBe("string")
  })

  test("the legacy flat reports.pii expands to all three split verbs (grandfathering)", async () => {
    const legacy = await mkUser(v.id, { role: "HR_MANAGER", name: "LegacyPii", permissions: ["reports.view", "reports.pii"] })
    legacyPiiToken = await mkSession(legacy.id, "FULL")
    // on screen (pii.view via expansion)
    const screen = await postHrm("reports.employeesBiodata", {}, { bearer: legacyPiiToken })
    expect(screen.status).toBe(200)
    // export (pii.export via expansion)
    const csv = await postHrm("reports.employeesBiodataCsv", { confirm: "EXPORT" }, { bearer: legacyPiiToken })
    expect(csv.status).toBe(200)
    // and the expansion is visible on the resolved context itself
    const ctx = await getCtxFromToken(legacyPiiToken)
    expect(ctx).not.toBeNull()
    expect(ctx!.permissions.has("reports.pii.view")).toBe(true)
    expect(ctx!.permissions.has("reports.pii.export")).toBe(true)
    expect(ctx!.permissions.has("reports.pii.schedule")).toBe(true)
  })

  test("scheduling a PII report template requires reports.pii.schedule", async () => {
    const recipient = { email: "recipients@example.test" }
    // a pii.schedule-less viewer cannot pin a PII template
    const denied = await postHrm("reports.templates.save", {
      reportKey: "employeesBiodata", name: "Nightly biodata", format: "CSV", schedule: "DAILY",
      recipients: [recipient], filters: {},
    }, { bearer: piiViewerToken })
    expect(denied.status).toBe(403)
    expect(String(denied.body.error || "")).toContain("reports.pii.schedule")
    // the owner (pii.schedule via the split verbs) can — but the recipient
    // must be a tenant member, so this save fails on membership, NOT on
    // permission (proves the permission gate passed)
    const memberCheck = await postHrm("reports.templates.save", {
      reportKey: "employeesBiodata", name: "Nightly biodata", format: "CSV", schedule: "DAILY",
      recipients: [recipient], filters: {},
    }, { bearer: ownerToken })
    expect(memberCheck.status).toBe(400)
    expect(String(memberCheck.body.error || "")).toContain("members of this organization")
  })

  test("support sessions never receive the split PII verbs", () => {
    const perms = supportPermissionsFor("CONTROLLED_WRITE", ["reports"])
    expect(perms.has("reports.view")).toBe(true) // read surface intact
    expect(perms.has("reports.pii.view")).toBe(false)
    expect(perms.has("reports.pii.export")).toBe(false)
    expect(perms.has("reports.pii.schedule")).toBe(false)
    expect(perms.has("reports.pii")).toBe(false)
  })

  test("the split verbs are in the ACTIONS catalog (roles.save can grant them)", async () => {
    const { MODULES, ACTIONS } = await import("@/hrm-server/types")
    expect(ACTIONS).toContain("pii.view")
    expect(ACTIONS).toContain("pii.export")
    expect(ACTIONS).toContain("pii.schedule")
    // permission-matrix sanity: every admin template carries the split
    const { ROLE_TEMPLATES } = await import("@/hrm-server/types")
    for (const role of ["HR_ADMIN", "VENDOR_OWNER"] as const) {
      expect(ROLE_TEMPLATES[role]).toContain("reports.pii.view")
      expect(ROLE_TEMPLATES[role]).toContain("reports.pii.export")
      expect(ROLE_TEMPLATES[role]).toContain("reports.pii.schedule")
    }
    // while the employee self-service template carries none of them
    expect(ROLE_TEMPLATES.EMPLOYEE.some((p) => p.startsWith("reports."))).toBe(false)
    void MODULES
  })
})

afterAllCleanup()
function afterAllCleanup() {
  // placeholder for symmetric file shape — no cleanup needed (isolated vendor)
}
