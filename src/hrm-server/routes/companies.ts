// ============ Company routes: multi-company management + access + switching ============
// (2026-11-03 — master prompt Parts B/D/E/G)
//
// Surface:
//   companies.list / options / get        — directory (tenant-scoped)
//   companies.create / update / setDefault / deactivate — company CRUD
//   companies.activate                    — switch THIS session's active company
//   companies.access.list / save / remove — UserCompanyAccess administration
//
// Security invariants:
//   · companyId is NEVER trusted from the client without assertCompany
//     (vendor ownership + active + caller access).
//   · The active company lives on the SESSION row — switching re-validates
//     access server-side and is audited; two sessions of one user can work
//     in different companies.
//   · Company deactivation never deletes history; a company with business
//     records cannot be deleted (FK Restrict at the DB layer).
//   · A company admin cannot grant themselves tenant-owner capabilities:
//     access assignment requires the tenant-level companies.assign permission.
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { invalidateCompanyAccessCache, resolveCompanyAccess } from "../company"
import { requireCapacity, resolveEntitlements, usageSnapshot } from "../saas/entitlements"
import type { Prisma } from "@prisma/client"
import { z } from "zod"

const COMPANY_FIELDS = {
  id: true, vendorId: true, code: true, name: true, legalName: true, shortName: true,
  registrationNumber: true, taxIdentificationNumber: true, binVatReg: true, logoUrl: true,
  website: true, email: true, phone: true, alternatePhone: true, address: true, city: true,
  district: true, country: true, currency: true, timezone: true, dateFormat: true,
  fiscalYearStart: true, signatoryName: true, signatoryDesignation: true, signatureUrl: true,
  sealUrl: true, active: true, isDefault: true, createdAt: true, updatedAt: true,
} as const

const profilePatch = z.object({
  id: z.string().optional(),
  code: z.string().trim().min(1).max(24).regex(/^[A-Za-z0-9_-]+$/, "Code may contain letters, digits, - and _ only").optional(),
  name: z.string().trim().min(1).max(160).optional(),
  legalName: z.string().trim().max(200).optional().nullable(),
  shortName: z.string().trim().max(80).optional().nullable(),
  registrationNumber: z.string().trim().max(80).optional().nullable(),
  taxIdentificationNumber: z.string().trim().max(40).optional().nullable(),
  binVatReg: z.string().trim().max(40).optional().nullable(),
  logoUrl: z.string().optional().nullable(),
  website: z.string().trim().max(200).optional().nullable(),
  email: z.string().trim().max(160).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  alternatePhone: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(400).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  district: z.string().trim().max(80).optional().nullable(),
  country: z.string().trim().max(80).optional().nullable(),
  currency: z.string().trim().max(8).optional().nullable(),
  timezone: z.string().trim().max(64).optional().nullable(),
  dateFormat: z.string().trim().max(20).optional().nullable(),
  fiscalYearStart: z.string().trim().max(20).optional().nullable(),
  signatoryName: z.string().trim().max(120).optional().nullable(),
  signatoryDesignation: z.string().trim().max(120).optional().nullable(),
  signatureUrl: z.string().optional().nullable(),
  sealUrl: z.string().optional().nullable(),
}).strict()

// ---------- directory ----------
route("companies.list", {
  perm: ["companies", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.active !== undefined) where.active = p.active
    const rows = await db.company.findMany({
      where,
      select: {
        ...COMPANY_FIELDS,
        _count: { select: { branches: true, employees: true } },
      },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    })
    // annotate the caller's access + active state
    const access = ctx.companyAccess || []
    const activeId = ctx.activeCompanyId
    return rows.map((r) => ({
      ...r,
      branchCount: r._count.branches,
      employeeCount: r._count.employees,
      accessible: access.some((a) => a.companyId === r.id) || ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER",
      isActiveContext: r.id === activeId,
    }))
  },
})

/** Lightweight id/code/name list for the global switcher (only companies the
 *  caller can actually switch to). */
route("companies.options", {
  perm: ["companies", "view"],
  handler: async (ctx) => {
    const access = ctx.companyAccess || []
    const adminFull = ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER"
    const rows = await db.company.findMany({
      where: { vendorId: ctx.vendorId, active: true },
      select: { id: true, code: true, name: true, logoUrl: true, isDefault: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    })
    return rows
      .filter((r) => adminFull || access.some((a) => a.companyId === r.id))
      .map((r) => ({ ...r, isActiveContext: r.id === ctx.activeCompanyId }))
  },
})

route("companies.get", {
  perm: ["companies", "view"],
  schema: z.object({ id: z.string() }).strict(),
  handler: async (ctx, p) => {
    const company = await db.company.findFirst({ where: { id: p.id, vendorId: ctx.vendorId }, select: COMPANY_FIELDS })
    if (!company) throw new Deny("Company not found", 404)
    const [branchCount, employeeCount] = await Promise.all([
      db.branch.count({ where: { companyId: company.id } }),
      db.employee.count({ where: { companyId: company.id } }),
    ])
    return { ...company, branchCount, employeeCount }
  },
})

/** The plan's company allowance, for the Companies page. null limit = unlimited. */
route("companies.capacity", {
  perm: ["companies", "view"],
  handler: async (ctx) => {
    const [ent, usage] = await Promise.all([resolveEntitlements(ctx.vendorId), usageSnapshot(ctx.vendorId)])
    return { used: usage.companies, limit: ent.limits.COMPANIES ?? null, planName: ent.planName ?? null }
  },
})

/** Check the plan's company limit inside the caller's transaction. The lock makes
 *  two simultaneous requests take turns, so they can't both claim the last slot. */
async function claimCompanySlot(tx: Prisma.TransactionClient, vendorId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`company-limit:${vendorId}`}))`
  await requireCapacity(vendorId, "COMPANIES", 1)
}

// ---------- CRUD ----------

route("companies.create", {
  perm: ["companies", "create"],
  schema: profilePatch.extend({
    // wizard step 3: initial configuration source
    initMode: z.enum(["copyTenant", "systemDefaults"]).default("copyTenant"),
    // wizard step 4: initial administrators [{userId, role}]
    administrators: z.array(z.object({ userId: z.string(), role: z.string().min(1).max(40) })).default([]),
  }).strict(),
  handler: async (ctx, p) => {
    const { id: _drop, initMode, administrators, ...fields } = p as any
    if (!fields.name) throw new Deny("Company name is required", 400)
    // unique code within the vendor
    const code = fields.code || String(fields.name).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase() || "CO"
    const dup = await db.company.findFirst({ where: { vendorId: ctx.vendorId, code } })
    if (dup) throw new Deny(`Company code "${code}" is already used in this workspace`, 400)
    const nameDup = await db.company.findFirst({ where: { vendorId: ctx.vendorId, name: fields.name } })
    if (nameDup) throw new Deny(`A company named "${fields.name}" already exists`, 400)

    const company = await db.$transaction(async (tx) => {
      await claimCompanySlot(tx, ctx.vendorId)
      const created = await tx.company.create({
        data: {
          vendorId: ctx.vendorId,
          code,
          name: fields.name,
          legalName: fields.legalName ?? fields.name,
          shortName: fields.shortName ?? null,
          registrationNumber: fields.registrationNumber ?? null,
          taxIdentificationNumber: fields.taxIdentificationNumber ?? null,
          binVatReg: fields.binVatReg ?? null,
          logoUrl: fields.logoUrl ?? null,
          website: fields.website ?? null,
          email: fields.email ?? null,
          phone: fields.phone ?? null,
          alternatePhone: fields.alternatePhone ?? null,
          address: fields.address ?? null,
          city: fields.city ?? null,
          district: fields.district ?? null,
          country: fields.country || "Bangladesh",
          currency: fields.currency || "BDT",
          timezone: fields.timezone || "Asia/Dhaka",
          dateFormat: fields.dateFormat || "DD/MM/YYYY",
          fiscalYearStart: fields.fiscalYearStart || "July",
          signatoryName: fields.signatoryName ?? null,
          signatoryDesignation: fields.signatoryDesignation ?? null,
          signatureUrl: fields.signatureUrl ?? null,
          sealUrl: fields.sealUrl ?? null,
        },
      })
      // wizard step 3 — copy the company-overridable settings groups from the
      // TENANT defaults so a new company starts from the tenant's baseline
      // (systemDefaults leaves the CompanySetting table empty = pure defaults).
      if (initMode === "copyTenant") {
        const groups = ["attendance", "geofence", "leave", "payroll", "ait", "shift", "accounting", "employeeSettings"]
        const rows = await tx.hrSetting.findMany({ where: { vendorId: ctx.vendorId, group: { in: groups } } })
        if (rows.length) {
          await tx.companySetting.createMany({
            data: rows.map((r) => ({ vendorId: ctx.vendorId, companyId: created.id, group: r.group, key: r.key, value: r.value })),
          })
        }
        // R-09 (W2) — copy the DEFAULT COMPANY's workflows (with their steps)
        // into the new company: the new company starts with the same approval
        // routing instead of silently falling back to the tenant-default rows.
        // Only the default company's COMPANY-SPECIFIC workflows are copied —
        // the NULL-company tenant-default workflows stay shared (the approved
        // fallback policy), so a vendor that never split keeps one workflow
        // set and a vendor that customized its default company propagates
        // those customizations to each new company.
        const defaultCompany = await tx.company.findFirst({
          where: { vendorId: ctx.vendorId, isDefault: true },
          select: { id: true },
        })
        if (defaultCompany && defaultCompany.id !== created.id) {
          const srcWorkflows = await tx.approvalWorkflow.findMany({
            where: { vendorId: ctx.vendorId, companyId: defaultCompany.id },
            orderBy: { createdAt: "asc" },
          })
          for (const src of srcWorkflows) {
            const cloned = await tx.approvalWorkflow.create({
              data: { vendorId: ctx.vendorId, companyId: created.id, processType: src.processType, name: src.name, active: src.active },
            })
            const srcSteps = await tx.approvalStep.findMany({
              where: { workflowId: src.id },
              orderBy: { sequence: "asc" },
            })
            if (srcSteps.length) {
              await tx.approvalStep.createMany({
                data: srcSteps.map((s) => ({
                  vendorId: ctx.vendorId, // DB-02 (R5)
                  workflowId: cloned.id, sequence: s.sequence, name: s.name,
                  approverRole: s.approverRole, approverUserId: s.approverUserId,
                  departmentScope: s.departmentScope, branchScope: s.branchScope,
                  amountThreshold: s.amountThreshold, required: s.required,
                  rejectBehavior: s.rejectBehavior, allowDelegation: s.allowDelegation,
                })),
              })
            }
          }
        }
        // R-10 (W2) — copy the DEFAULT COMPANY's AIT fiscal years (with
        // categories + slabs) into the new company. Required by the R-10
        // fallback restriction (loadAitConfig resolves only the company's OWN
        // rows or the intentional NULL-company tenant-level rows): a new
        // company must start with its own tax configuration instead of
        // silently inheriting the default company's slabs.
        if (defaultCompany && defaultCompany.id !== created.id) {
          const srcFys = await tx.aitFiscalYear.findMany({
            where: { vendorId: ctx.vendorId, companyId: defaultCompany.id },
            orderBy: { createdAt: "asc" },
          })
          for (const src of srcFys) {
            const clonedFy = await tx.aitFiscalYear.create({
              data: {
                vendorId: ctx.vendorId, companyId: created.id,
                label: src.label, incomeYear: src.incomeYear, assessmentYear: src.assessmentYear,
                tdsSectionRef: src.tdsSectionRef, exemptionFraction: src.exemptionFraction,
                exemptionCap: src.exemptionCap, minimumTax: src.minimumTax,
                newTaxpayerMinimumTax: src.newTaxpayerMinimumTax,
                rebateRatePercent: src.rebateRatePercent, rebateIncomeCapPercent: src.rebateIncomeCapPercent,
                rebateCapFraction: src.rebateCapFraction, rebateCapAmount: src.rebateCapAmount,
                festivalBonusCount: src.festivalBonusCount, active: src.active, notes: src.notes,
                surchargeJson: src.surchargeJson,
              },
            })
            const [srcCats, srcSlabs] = await Promise.all([
              tx.aitTaxpayerCategory.findMany({ where: { fiscalYearId: src.id } }),
              tx.aitTaxSlab.findMany({ where: { fiscalYearId: src.id }, orderBy: { order: "asc" } }),
            ])
            if (srcCats.length) {
              await tx.aitTaxpayerCategory.createMany({
                data: srcCats.map((c) => ({
                  vendorId: ctx.vendorId, fiscalYearId: clonedFy.id, key: c.key, label: c.label,
                  threshold: c.threshold, sortOrder: c.sortOrder,
                })),
              })
            }
            if (srcSlabs.length) {
              await tx.aitTaxSlab.createMany({
                data: srcSlabs.map((s) => ({
                  vendorId: ctx.vendorId, fiscalYearId: clonedFy.id, order: s.order,
                  slabLabel: s.slabLabel, upperLimit: s.upperLimit, ratePercent: s.ratePercent,
                })),
              })
            }
          }
        }
      }
      // wizard step 4 — initial administrator access
      for (const admin of administrators || []) {
        const user = await tx.user.findFirst({ where: { id: admin.userId, vendorId: ctx.vendorId } })
        if (!user) throw new Deny(`Administrator user ${admin.userId} not found in this tenant`, 400)
        const existing = await tx.userCompanyAccess.findFirst({ where: { userId: user.id, companyId: created.id } })
        if (!existing) {
          await tx.userCompanyAccess.create({
            data: {
              vendorId: ctx.vendorId, userId: user.id, companyId: created.id,
              role: admin.role, active: true, isDefault: false,
              grantedById: ctx.userId, grantedByName: ctx.userName,
            },
          })
        }
      }
      return created
    })
    await audit(ctx, "companies.create", "Company", company.id, `Created company ${company.name} (${company.code})`)
    invalidateCompanyAccessCache()
    return company
  },
})

route("companies.update", {
  perm: ["companies", "edit"],
  schema: profilePatch.extend({ id: z.string() }).strict(),
  handler: async (ctx, p) => {
    const { id, ...patch } = p
    const existing = await db.company.findFirst({ where: { id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Company not found", 404)
    // code changes must stay unique within the vendor
    if (patch.code && patch.code !== existing.code) {
      const dup = await db.company.findFirst({ where: { vendorId: ctx.vendorId, code: patch.code, id: { not: id } } })
      if (dup) throw new Deny(`Company code "${patch.code}" is already used in this workspace`, 400)
    }
    const data: any = {}
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) data[k] = v
    }
    delete data.id
    delete data.isDefault // default flag moves through companies.setDefault only
    delete data.active // status moves through companies.deactivate only
    const rec = await db.company.update({ where: { id }, data })
    await audit(ctx, "companies.update", "Company", id, `Updated company ${rec.name}`, { oldValue: existing, newValue: data })
    return rec
  },
})

route("companies.setDefault", {
  perm: ["companies", "edit"],
  schema: z.object({ id: z.string() }).strict(),
  handler: async (ctx, p) => {
    const company = await db.company.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, active: true } })
    if (!company) throw new Deny("Company not found", 404)
    await db.$transaction([
      db.company.updateMany({ where: { vendorId: ctx.vendorId, isDefault: true }, data: { isDefault: false } }),
      db.company.update({ where: { id: company.id }, data: { isDefault: true } }),
    ])
    await audit(ctx, "companies.setDefault", "Company", company.id, `Default company set to ${company.name}`)
    return { ok: true }
  },
})

/** Deactivate (never delete): historical records stay intact and queryable;
 *  sessions pinned to the company fall back at next request (fail-closed). */
route("companies.deactivate", {
  perm: ["companies", "edit"],
  schema: z.object({ id: z.string(), active: z.boolean().default(false) }).strict(),
  handler: async (ctx, p) => {
    const company = await db.company.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!company) throw new Deny("Company not found", 404)
    if (company.isDefault && p.active === false) {
      throw new Deny("The default company cannot be deactivated — set another company as default first", 400)
    }
    if (p.active && !company.active) {
      // reactivating takes a slot back, otherwise a tenant at its limit could
      // exceed it by rotating inactive companies back in
      await db.$transaction(async (tx) => {
        await claimCompanySlot(tx, ctx.vendorId)
        await tx.company.update({ where: { id: company.id }, data: { active: true } })
      })
    } else {
      await db.company.update({ where: { id: company.id }, data: { active: p.active } })
    }
    await audit(ctx, "companies.deactivate", "Company", company.id, `${p.active ? "Reactivated" : "Deactivated"} company ${company.name}`)
    invalidateCompanyAccessCache()
    return { ok: true }
  },
})

// ---------- the switcher ----------

/**
 * Switch THIS session's active company. The chosen company is validated
 * against the caller's live access rows and written to the SESSION row —
 * the context is server-verifiable on every later request (master prompt
 * §7: never only React state or localStorage). Audited.
 */
route("companies.activate", {
  perm: ["companies", "view"],
  // companyId: null (or omitted with allCompanies: true) → the All Companies
  // REPORTING context (master prompt Part D) — requires the tenant-level
  // companies.consolidated permission. Reads become tenant-wide for
  // consolidated dashboards/analytics; every MUTATING action of a
  // company-scoped module stays denied in that mode (dispatcher gate), so
  // it can never widen CRUD access.
  schema: z.object({ companyId: z.string().nullable().optional(), allCompanies: z.boolean().optional() }).strict(),
  handler: async (ctx, p, req) => {
    const wantsAllCompanies = p.allCompanies === true || (p.companyId === null && p.allCompanies !== false)
    if (wantsAllCompanies) {
      // D-2 (W1) — the consolidated reporting context is the tenant owner's
      // surface ONLY (a permission grant alone is not enough; the per-request
      // role re-check in auth.ts enforces the same rule for every subsequent
      // request).
      if (ctx.role !== "VENDOR_OWNER") {
        throw new Deny("The All Companies consolidated view is available to the tenant owner only.", 403)
      }
      const { require } = await import("../rbac")
      require(ctx, "companies", "consolidated")
    }

    let company: { id: string; code: string; name: string; logoUrl: string | null } | null = null
    let row: { role: string } | null = null
    if (!wantsAllCompanies) {
      const targetCompanyId = typeof p.companyId === "string" ? p.companyId : ""
      if (!targetCompanyId) throw new Deny("companyId is required", 400)
      const access = await resolveCompanyAccess(ctx.userId, ctx.vendorId)
      const isAdmin = ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER"
      const found = access.find((a) => a.companyId === targetCompanyId)
      if (!found && !isAdmin) {
        throw new Deny("You do not have access to this company", 403)
      }
      row = found ?? null
      company = await db.company.findFirst({ where: { id: targetCompanyId, vendorId: ctx.vendorId, active: true } })
      if (!company) throw new Deny("Company not found", 404)
    }

    // resolve the calling session row (cookie or bearer both resolve through
    // the token hash — the dispatcher passes the raw request)
    const authHeader = req?.headers?.get?.("authorization") || ""
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null
    const cookieHeader = req?.headers?.get?.("cookie") || ""
    const cookieToken = /(?:^|;\s*)hrm_session=([^;]+)/.exec(cookieHeader)?.[1] || null
    const token = bearer || cookieToken
    if (!token) throw new Deny("No session to switch the company of", 401)

    const { sessionTokenHash } = await import("../auth")
    const session = await db.session.findUnique({ where: { tokenHash: sessionTokenHash(token) } })
    if (!session || session.kind !== "FULL") throw new Deny("Session not found", 401)

    // R-04 (W1) — admin switch WITHOUT an access row: auto-create the row in
    // the SAME transaction as the session pin (SEC-19: without the row the
    // NEXT request's resolveActiveCompany silently reverted to the default
    // company — the switch "didn't stick"). Deltas '[]'/'[]' keep the
    // derived-baseline model (User.permissions stays the single inherited
    // source; the S4a/S4b columns hold deliberate deltas only, from W3).
    // Non-admins never reach here (fail-closed 403 above). Idempotent: a
    // re-switch finds the row via resolveCompanyAccess and skips creation.
    const autoCreateRow = !wantsAllCompanies && !row && (ctx.role === "HR_ADMIN" || ctx.role === "VENDOR_OWNER")
    await db.$transaction(async (tx) => {
      if (autoCreateRow && company) {
        await tx.userCompanyAccess.create({
          data: {
            vendorId: ctx.vendorId,
            userId: ctx.userId,
            companyId: company.id,
            role: ctx.role, // the admin's tenant role becomes the company role
            permissions: "[]", // S4a — derived-baseline delta: none
            excludedPermissions: "[]", // S4b — derived-baseline delta: none
            active: true,
            isDefault: false,
            grantedById: ctx.userId,
            grantedByName: `${ctx.userName} (auto — companies.activate)`,
          },
        })
      }
      await tx.session.update({
        where: { id: session.id },
        data: { activeCompanyId: company ? company.id : null, allCompaniesMode: wantsAllCompanies },
      })
    })
    // the auto-created row must be visible to the NEXT request (the 60s
    // access cache would otherwise serve the stale no-row view — the very
    // silent revert R-04 removes)
    if (autoCreateRow) invalidateCompanyAccessCache(ctx.userId)
    // `company` is non-null exactly when !wantsAllCompanies (validated above)
    const switched = company
    await audit(
      ctx, "companies.activate", "Company", switched ? switched.id : "ALL",
      wantsAllCompanies || !switched
        ? "Switched to the All Companies consolidated reporting context"
        : `Switched active company to ${switched.name} (${switched.code})` +
          (autoCreateRow
            ? " — company access row auto-created (admin switch, derived-baseline deltas '[]'/'[]')"
            : ""),
    )
    return {
      ok: true,
      allCompanies: wantsAllCompanies,
      company: switched && !wantsAllCompanies
        ? { id: switched.id, code: switched.code, name: switched.name, logoUrl: switched.logoUrl }
        : null,
      role: row?.role ?? ctx.role,
    }
  },
})

// ---------- access administration (UserCompanyAccess) ----------

route("companies.access.list", {
  perm: ["companies", "view"],
  schema: z.object({ companyId: z.string().optional(), userId: z.string().optional() }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.companyId) where.companyId = p.companyId
    if (p?.userId) where.userId = p.userId
    const rows = await db.userCompanyAccess.findMany({
      where,
      include: {
        company: { select: { code: true, name: true } },
        user: { select: { name: true, email: true, role: true, status: true } },
      },
      orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    })
    return rows
  },
})

/** Grant/update one user's access to one company (role + optional branch/
 *  department scope + default flag). Requires the tenant-level
 *  companies.assign permission — a company admin cannot self-escalate. */
route("companies.access.save", {
  perm: ["companies", "assign"],
  schema: z.object({
    userId: z.string(),
    companyId: z.string(),
    role: z.string().min(1).max(40),
    employeeId: z.string().nullable().optional(),
    branchScope: z.array(z.string()).nullable().optional(),
    departmentScope: z.array(z.string()).nullable().optional(),
    active: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  }).strict(),
  handler: async (ctx, p) => {
    const user = await db.user.findFirst({ where: { id: p.userId, vendorId: ctx.vendorId } })
    if (!user) throw new Deny("User not found", 404)
    const company = await db.company.findFirst({ where: { id: p.companyId, vendorId: ctx.vendorId } })
    if (!company) throw new Deny("Company not found", 404)

    // branch/department scope ids must belong to the same company
    if (p.branchScope?.length) {
      const foreign = await db.branch.count({ where: { id: { in: p.branchScope }, vendorId: ctx.vendorId, OR: [{ companyId: null }, { companyId: { not: p.companyId } }] } })
      if (foreign > 0) throw new Deny("Branch scope contains branches of another company", 400)
    }
    if (p.departmentScope?.length) {
      const foreign = await db.department.count({ where: { id: { in: p.departmentScope }, vendorId: ctx.vendorId, OR: [{ companyId: null }, { companyId: { not: p.companyId } }] } })
      if (foreign > 0) throw new Deny("Department scope contains departments of another company", 400)
    }

    const rec = await db.$transaction(async (tx) => {
      const existing = await tx.userCompanyAccess.findFirst({ where: { userId: p.userId, companyId: p.companyId } })
      const data = {
        vendorId: ctx.vendorId,
        userId: p.userId,
        companyId: p.companyId,
        role: p.role,
        employeeId: p.employeeId ?? null,
        branchScope: p.branchScope ? JSON.stringify(p.branchScope) : null,
        departmentScope: p.departmentScope ? JSON.stringify(p.departmentScope) : null,
        active: p.active,
        grantedById: ctx.userId,
        grantedByName: ctx.userName,
      }
      let row
      if (existing) {
        row = await tx.userCompanyAccess.update({ where: { id: existing.id }, data })
      } else {
        row = await tx.userCompanyAccess.create({ data: { ...data, isDefault: p.isDefault } })
      }
      if (p.isDefault) {
        // exactly one default per user
        await tx.userCompanyAccess.updateMany({
          where: { userId: p.userId, id: { not: row.id } },
          data: { isDefault: false },
        })
      }
      return row
    })
    await audit(ctx, "companies.access.save", "UserCompanyAccess", rec.id, `Access for ${user.email} → ${company.name} as ${p.role}${p.active ? "" : " (inactive)"}`)
    invalidateCompanyAccessCache(p.userId)
    return rec
  },
})

/** Revoke a user's access to a company (immediate — the 15s access cache is
 *  invalidated and every later request re-validates). */
route("companies.access.remove", {
  perm: ["companies", "assign"],
  schema: z.object({ id: z.string() }).strict(),
  handler: async (ctx, p) => {
    const rec = await db.userCompanyAccess.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Access assignment not found", 404)
    await db.userCompanyAccess.delete({ where: { id: rec.id } })
    await audit(ctx, "companies.access.remove", "UserCompanyAccess", rec.id, `Revoked access (user ${rec.userId}, company ${rec.companyId})`)
    invalidateCompanyAccessCache(rec.userId)
    return { ok: true }
  },
})
