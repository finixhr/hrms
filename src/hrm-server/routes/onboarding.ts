// ============ Post-approval onboarding checklist (2026-10-04) ==================
// The approval flow provisions a fully-configured workspace (workflows, leave
// types, AIT config…), but the tenant still has REAL setup work: branches,
// departments, designations, employees, shifts, users, MFA. This RPC computes
// a live checklist from actual DB rows — no client-side guessing — plus a
// per-vendor dismissal stored in HrSetting (group "onboarding").
//
// The widget (home view) shows itself to VENDOR_OWNER / HR_ADMIN when the
// checklist is incomplete and not dismissed; every item links straight to the
// module that completes it.
import { db } from "@/lib/db"
import { route } from "./registry"
import { audit } from "../audit"

type Step = {
  key: string
  label: string
  description: string
  view: string // app-shell view key to navigate to
  done: boolean
  optional?: boolean
}

route("onboarding.status", {
  perm: ["dashboard", "view"],
  handler: async (ctx) => {
    const [branchCount, deptCount, desigCount, empCount, shiftCount, userCount, settingsRows, me] = await Promise.all([
      db.branch.count({ where: { vendorId: ctx.vendorId } }),
      db.department.count({ where: { vendorId: ctx.vendorId } }),
      db.designation.count({ where: { vendorId: ctx.vendorId } }),
      db.employee.count({ where: { vendorId: ctx.vendorId } }),
      db.shift.count({ where: { vendorId: ctx.vendorId } }),
      db.user.count({ where: { vendorId: ctx.vendorId } }),
      db.hrSetting.findMany({ where: { vendorId: ctx.vendorId, group: "onboarding" } }),
      db.user.findUnique({ where: { id: ctx.userId }, select: { mfaEnrolled: true } }),
    ])
    const onboardingSettings = new Map(settingsRows.map((r) => [r.key, r.value]))
    const dismissedRaw = onboardingSettings.get("dismissedAt")
    const dismissedAt = dismissedRaw ? JSON.parse(dismissedRaw) : null

    const steps: Step[] = [
      {
        key: "branch", label: "Create your first branch", view: "organization",
        description: "Every employee belongs to a branch — add your head office or first location.",
        done: branchCount > 0,
      },
      {
        key: "department", label: "Add a department", view: "organization",
        description: "Departments organize your workforce and scope manager visibility.",
        done: deptCount > 0,
      },
      {
        key: "designation", label: "Add a designation", view: "organization",
        description: "Job titles power payroll grades, the org chart and letters.",
        done: desigCount > 0,
      },
      {
        key: "employee", label: "Add your first employee", view: "employees",
        description: "One master record per person — attendance, leave and payroll all hang off it.",
        done: empCount > 0,
      },
      {
        key: "shift", label: "Configure a shift", view: "attendance",
        description: "Shifts define work windows for attendance, overtime and late rules.",
        done: shiftCount > 0,
      },
      {
        key: "colleague", label: "Invite an application user", view: "settings",
        description: "Create accounts for your HR team so sign-in is never single-person dependent.",
        done: userCount > 1, optional: true,
      },
      {
        key: "mfa", label: "Enable MFA on your account", view: "settings",
        description: "Protect administrative access with an authenticator app (account menu → Security & MFA).",
        done: !!me?.mfaEnrolled, optional: true,
      },
    ]

    return {
      steps,
      completed: steps.filter((s) => s.done).length,
      total: steps.length,
      dismissedAt,
      canDismiss: ctx.role === "VENDOR_OWNER" || ctx.role === "HR_ADMIN",
    }
  },
})

route("onboarding.dismiss", {
  // R2b-003 — was gated on settings.view (a read verb) while the handler writes
  // to HrSetting. Corrected to settings.edit so custom roles without edit cannot
  // dismiss the checklist.
  perm: ["settings", "edit"],
  handler: async (ctx) => {
    if (ctx.role !== "VENDOR_OWNER" && ctx.role !== "HR_ADMIN") {
      throw Object.assign(new Error("Only tenant admins can dismiss the onboarding checklist."), { code: 403 })
    }
    const now = new Date().toISOString()
    const existing = await db.hrSetting.findFirst({ where: { vendorId: ctx.vendorId, group: "onboarding", key: "dismissedAt" } })
    if (existing) {
      await db.hrSetting.update({ where: { id: existing.id }, data: { value: JSON.stringify(now) } })
    } else {
      await db.hrSetting.create({ data: { vendorId: ctx.vendorId, group: "onboarding", key: "dismissedAt", value: JSON.stringify(now) } })
    }
    await audit(ctx, "settings.save", "HrSetting", null, "Onboarding checklist dismissed")
    return { dismissedAt: now }
  },
})
