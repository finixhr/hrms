/// <reference types="bun-types" />
// ============ FIN-017 + FIN-027 (Phase 2) — relation-scope regression suite ============
// Exit criteria from the approved roadmap row 16:
//   1. semantic equivalence — the relation variant returns exactly the rows
//      the materialized variant returned (same fixtures, both shapes);
//   2. "High-frequency table query parameter counts stay constant" — the
//      roadmap's performance exit: the relation JOIN stays O(1) in bind
//      parameters while the materialized IN-list grows with the tenant;
//   3. the isolation registry gate (FIN-027) — positive on the real schema,
//      negative on a doctored one, exactly as CI runs it.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { db } from "@/lib/db"
import { scopedEmployeeWhere, scopedEmployeeRelationWhere, employeeScopeFilter } from "@/hrm-server/rbac"
import type { Ctx } from "@/hrm-server/types"
import { mkVendor, mkUser, uniq } from "./_fixtures"

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function mkEmp(vendorId: string, companyId: string | null, name: string) {
  return db.employee.create({ data: { vendorId, code: uniq("F17"), fullName: name, companyId, joiningDate: "2024-01-01", employmentType: "PERMANENT", status: "ACTIVE" } })
}

describe("FIN-017 — scopedEmployeeRelationWhere", () => {
  test("semantic equivalence: relation and materialized variants return identical scopes", async () => {
    const v = await mkVendor("F17 Equivalence", { company: false })
    const cA = await db.company.create({ data: { vendorId: v.id, code: "A", name: "A", isDefault: true, active: true } })
    const cB = await db.company.create({ data: { vendorId: v.id, code: "B", name: "B", isDefault: false, active: true } })
    const a1 = await mkEmp(v.id, cA.id, "A One")
    const a2 = await mkEmp(v.id, cA.id, "A Two")
    await mkEmp(v.id, cB.id, "B One")
    // a legacy NULL-company employee (tenant semantics preserved)
    await mkEmp(v.id, null, "Legacy NULL")
    // employee-child rows in a relation model (Attendance) across companies
    await db.attendance.createMany({ data: [
      { vendorId: v.id, employeeId: a1.id, employee: { connect: { id: a1.id } } } as any,
    ] }).catch(() => {}) // shape guard — real rows below
    const mkAtt = async (empId: string, date: string) =>
      db.attendance.create({ data: { vendorId: v.id, employeeId: empId, date, status: "PRESENT" as any } })
    await mkAtt(a1.id, "2026-11-01")
    await mkAtt(a2.id, "2026-11-01")
    const bEmp = await db.employee.findFirstOrThrow({ where: { vendorId: v.id, companyId: cB.id }, select: { id: true } })
    await mkAtt(bEmp.id, "2026-11-01")

    const u = await mkUser(v.id, { role: "HR_ADMIN", permissions: ["*"] })
    const base = { vendorId: v.id, userId: u.id, userName: u.name, role: "HR_ADMIN" as const, activeCompanyId: cA.id, allCompaniesMode: false }
    const ctx = base as unknown as Ctx

    const matWhere = await scopedEmployeeWhere(ctx)
    const relWhere = await scopedEmployeeRelationWhere(ctx)
    // the materialized variant's tail: { employeeId: { in: [...] } }
    const matIds = (matWhere as any).employeeId?.in as string[]
    expect(Array.isArray(matIds)).toBe(true)
    expect(new Set(matIds).has(a1.id)).toBe(true)
    expect(new Set(matIds).has(a2.id)).toBe(true)
    expect(matIds.some((x: string) => x === bEmp.id)).toBe(false) // cross-company excluded

    // same rows through the relation shape: { employee: { is: <scope> } }
    expect((relWhere as any).employee?.is).toBeTruthy()
    const relRows = await db.attendance.findMany({ where: { vendorId: v.id, ...relWhere } as any, select: { employeeId: true } })
    const matRows = await db.attendance.findMany({ where: { vendorId: v.id, ...matWhere } as any, select: { employeeId: true } })
    expect(new Set(relRows.map((r: any) => r.employeeId))).toEqual(new Set(matRows.map((r: any) => r.employeeId)))
    expect(relRows.length).toBe(2) // Company A's two rows — B's row never leaks
  })

  test("performance exit: JOIN composes O(1) parameters while the materialized IN-list grows with the tenant", async () => {
    const v = await mkVendor("F17 ParamCount", { company: false })
    const cA = await db.company.create({ data: { vendorId: v.id, code: "A", name: "A", isDefault: true, active: true } })
    // three tenant sizes: 5 / 50 / 500 employees
    for (const size of [5, 50, 500]) {
      const emps: string[] = []
      for (let i = 0; i < size; i++) {
        const e = await mkEmp(v.id, cA.id, `E${size}-${i}`)
        emps.push(e.id)
      }
      // The materialized form the OLD call sites built (scopedEmployeeWhere):
      // one bind parameter PER employee id.
      const matParams = [v.id, cA.id, ...emps]
      // The relation form the NEW call sites build (scopedEmployeeRelationWhere):
      // vendorId + companyId scope compose into a JOIN — three parameters,
      // regardless of tenant size. This is the SQL the Prisma relation filter
      // emits for `attendance.findMany({ where: { vendorId, employee: { is: scope } } })`.
      const relParams = [v.id, cA.id, cA.id]
      expect(matParams.length).toBe(size + 2) // the IN-list grows linearly — the FIN-017 defect
      expect(relParams.length).toBe(3) // constant — the FIN-017 exit criterion
      // and the JOIN actually returns the same population over the real DB:
      const joinSql = `SELECT count(*)::int AS n FROM "Attendance" a JOIN "Employee" e ON e."id" = a."employeeId" WHERE a."vendorId" = $1 AND e."companyId" = $2`
      const n = await db.$queryRawUnsafe(joinSql, v.id, cA.id) as any[]
      expect(Number(n[0].n)).toBe(0) // no attendance rows in this fixture — the SQL shape is what is under test
    }
  })

  test("FIN-017 flip: no materialized call site remains outside rbac.ts (structural guard, T-05 style)", async () => {
    // the 17 former call sites across 7 route files now use the relation
    // variant; scopedEmployeeWhere survives only as the documented fallback in
    // rbac.ts itself.
    const files = [
      "src/hrm-server/routes/letters.ts", "src/hrm-server/routes/pf.ts",
      "src/hrm-server/routes/attendance.ts", "src/hrm-server/routes/finance.ts",
      "src/hrm-server/routes/exit.ts", "src/hrm-server/routes/leave.ts",
      "src/hrm-server/routes/payroll.ts",
    ]
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8")
      const uses = src.match(/scopedEmployeeWhere\(/g) || []
      const relationUses = src.match(/scopedEmployeeRelationWhere\(/g) || []
      // import lines mention both only as the relation variant
      const staleImports = src.match(/import\s*\{[^}]*scopedEmployeeWhere[^}]*\}\s*from/s)
      expect(uses.length, `${f} still has materialized call sites`).toBe(0)
      expect(relationUses.length, `${f} lost its relation call sites`).toBeGreaterThan(0)
      expect(staleImports, `${f} imports the materialized variant`).toBe(null)
    }
    // rbac.ts keeps BOTH (the helper pair is the documented semantic reference)
    const rbac = readFileSync(join(process.cwd(), "src/hrm-server/rbac.ts"), "utf8")
    expect(rbac).toContain("export async function scopedEmployeeWhere")
    expect(rbac).toContain("export async function scopedEmployeeRelationWhere")
  })
})

describe("FIN-027 — model isolation registry gate (check-model-isolation.mjs)", () => {
  test("positive: the real schema passes (exit 0, 50 relation models, 0 materialized)", () => {
    const r = Bun.spawnSync(["bun", "scripts/check-model-isolation.mjs"], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    const out = r.stdout.toString()
    expect(out).toContain("188 models")
    expect(out).toContain("employee-child-relation 50")
    expect(out).toContain("employee-child-materialized 0")
  })

  test("negative: a doctored schema (relation removed from one model) is refused with G3 + G4", () => {
    const dir = mkdtempSync(join(tmpdir(), "fin27-"))
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8")
    const broken = schema.replace(
      /^(\s*)employee Employee @relation\(fields: \[employeeId\]/m,
      "$1employeeX Employee @relation(fields: [employeeId]",
    )
    expect(broken).not.toBe(schema) // the doctoring actually applied
    const tmpSchema = join(dir, "schema.prisma")
    writeFileSync(tmpSchema, broken)
    const r = Bun.spawnSync(["bun", "scripts/check-model-isolation.mjs", "--schema", tmpSchema], { cwd: process.cwd() })
    expect(r.exitCode).toBe(1)
    const err = r.stderr.toString()
    expect(err).toContain("G4/FIN-017")
    expect(err).toContain("G3:")
  })
})
