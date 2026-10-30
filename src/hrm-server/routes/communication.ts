// ============ Communication routes: calendar, notifications, announcements, wishes, email/SMS blasts ============
import { db } from "@/lib/db"
import { route } from "./registry"
import { getSettings } from "../settings"
import { getCalendarEvents } from "../calendar"
import { notify, audit } from "../audit"
import { j, today } from "../utils"
import { sendEmail, emailConfigured, smsConfigured } from "../gateway"
import { Deny } from "../rbac"

route("calendar.events", {
  // M-02 — gated: every role template carries calendar.view (nav visibility
  // already assumes it); an unauthenticated session cannot read the feed.
  perm: ["calendar", "view"],
  handler: async (ctx, p) => {
    const scope: any = {}
    if (ctx.role === "BRANCH_MANAGER" && ctx.branchId) scope.branchId = ctx.branchId
    if (ctx.role === "DEPT_MANAGER" && ctx.departmentId) scope.departmentId = ctx.departmentId
    // COM-03 (R5) — EMPLOYEE viewers see sensitive per-person events only for
    // themselves; company-wide culture events stay shared.
    if (ctx.role === "EMPLOYEE" && ctx.employeeId) scope.selfEmployeeId = ctx.employeeId
    const events = await getCalendarEvents(ctx.vendorId, p?.month || new Date().getMonth() + 1, p?.year || new Date().getFullYear(), scope)
    const kinds = p?.kinds?.length ? new Set(p.kinds) : null
    return kinds ? events.filter((e) => kinds.has(e.kind)) : events
  },
})

// ---------- Notifications ----------
// 2026-10-13 — ONE visibility scope for list/read/unreadCount. Previously
// only `notifications.list` matched employee-addressed rows (userId null +
// employeeId set — e.g. the seeded "Salary Processed" payslip notification),
// while `notifications.read`/`unreadCount` filtered on userId alone: those
// rows were VISIBLE but could never be marked read and never counted in the
// badge. All three actions now share the exact same self-scoped filter, so
// anything a user can see, they can acknowledge — and nothing else (M-02).
function notifScope(ctx: any) {
  return {
    vendorId: ctx.vendorId,
    OR: [{ userId: ctx.userId }, { userId: null, employeeId: ctx.employeeId || "__none__" }],
  }
}

  // INTENTIONALLY_SELF_SCOPED (M-02): returns only notifications addressed to the caller (userId / own employeeId filter)
route("notifications.list", {
  handler: async (ctx) => {
    const list = await db.notification.findMany({
      where: notifScope(ctx),
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return list
  },
})
  // INTENTIONALLY_SELF_SCOPED (M-02): marks only the caller's own notifications read
route("notifications.read", {
  handler: async (ctx, p) => {
    if (p?.all) {
      await db.notification.updateMany({ where: { ...notifScope(ctx), readAt: null }, data: { readAt: new Date() } })
      return { ok: true }
    }
    // M-02 — a user can only mark notifications they can SEE read (own-user
    // rows + userless rows addressed to their own employee profile); the old
    // vendor-only filter let any tenant user ack other users' notifications.
    await db.notification.updateMany({ where: { id: p.id, ...notifScope(ctx) }, data: { readAt: new Date() } })
    return { ok: true }
  },
})
  // INTENTIONALLY_SELF_SCOPED (M-02): counts only the caller's own unread notifications
route("notifications.unreadCount", {
  handler: async (ctx) => {
    const raw = await db.notification.count({ where: { ...notifScope(ctx), readAt: null } })
    // COM-04 (R6) — the badge never claims more than the capped list (take:
    // 100) can display; the client renders 99+ beyond that.
    return { count: Math.min(raw, 100), total: raw }
  },
})

// ---------- Announcements ----------
  // INTENTIONALLY_SELF_SCOPED (M-02): company-wide announcements feed — visible to every authenticated employee
route("announcements.list", {
  // INTENTIONALLY_SELF_SCOPED (M-02) + COM-01 (R5): the feed is visible to every
  // authenticated employee, but EMPLOYEE viewers now see only what was
  // addressed TO THEM — audience-ALL notices plus those targeting their own
  // branch / department / designation / person. Branch-confidential and
  // specific-person notices (with target names) are no longer readable
  // tenant-wide; HR/manager roles (with announcements.view) keep the admin view.
  handler: async (ctx) => {
    const list = await db.announcement.findMany({ where: { vendorId: ctx.vendorId, active: true }, orderBy: [{ pinned: "desc" }, { createdAt: "desc" }] })
    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const emps = await db.employee.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, fullName: true, branchId: true, departmentId: true, designationId: true } })

    // COM-01 — the EMPLOYEE persona's own-audience resolution
    let self: { employeeId: string | null; branchId: string | null; departmentId: string | null; designationId: string | null } | null = null
    if (ctx.role === "EMPLOYEE") {
      const me = ctx.employeeId
        ? await db.employee.findFirst({ where: { id: ctx.employeeId, vendorId: ctx.vendorId }, select: { id: true, branchId: true, departmentId: true, designationId: true } })
        : null
      self = { employeeId: me?.id ?? null, branchId: me?.branchId ?? null, departmentId: me?.departmentId ?? null, designationId: me?.designationId ?? null }
    }
    const visibleToSelf = (a: { audienceType: string; audienceIds: string | null }) => {
      if (!self) return true // non-EMPLOYEE roles see the admin feed
      if (a.audienceType === "ALL") return true
      const ids = j(a.audienceIds, [] as string[])
      if (a.audienceType === "BRANCH") return !!self.branchId && ids.includes(self.branchId)
      if (a.audienceType === "DEPARTMENT") return !!self.departmentId && ids.includes(self.departmentId)
      if (a.audienceType === "DESIGNATION") return !!self.designationId && ids.includes(self.designationId)
      if (a.audienceType === "SPECIFIC") return !!self.employeeId && ids.includes(self.employeeId)
      return true
    }

    const visible = list.filter(visibleToSelf)
    const visibleIds = visible.map((a) => a.id)

    // COM-02 (R7) — read receipts. Every caller learns which notices THEY
    // have read (readAt); the admin feed additionally gets per-notice read
    // stats: how many of the audience have read it (readCount / audienceSize).
    const [myReads, readCounts] = await Promise.all([
      visibleIds.length
        ? db.announcementRead.findMany({ where: { vendorId: ctx.vendorId, userId: ctx.userId, announcementId: { in: visibleIds } }, select: { announcementId: true, readAt: true } })
        : Promise.resolve([] as { announcementId: string; readAt: Date }[]),
      !self && visibleIds.length
        ? db.announcementRead.groupBy({ by: ["announcementId"], where: { vendorId: ctx.vendorId, announcementId: { in: visibleIds } }, _count: { _all: true } })
        : Promise.resolve([] as { announcementId: string; _count: { _all: number } }[]),
    ])
    const readAtByAnnouncement = new Map(myReads.map((r) => [r.announcementId, r.readAt]))
    const readCountByAnnouncement = new Map(readCounts.map((r) => [r.announcementId, r._count._all]))
    const audienceSizeOf = (a: { audienceType: string; audienceIds: string | null }) => {
      if (a.audienceType === "ALL") return emps.length
      const ids = j(a.audienceIds, [] as string[])
      if (!ids.length) return 0
      if (a.audienceType === "BRANCH") return emps.filter((e) => ids.includes((e as any).branchId || "")).length
      if (a.audienceType === "DEPARTMENT") return emps.filter((e) => ids.includes((e as any).departmentId || "")).length
      if (a.audienceType === "DESIGNATION") return emps.filter((e) => ids.includes((e as any).designationId || "")).length
      if (a.audienceType === "SPECIFIC") return ids.filter((id) => emps.some((e) => e.id === id)).length
      return emps.length
    }

    return visible.map((a) => {
      const ids = j(a.audienceIds, [] as string[])
      let audience = "All Employees"
      if (a.audienceType === "BRANCH") audience = "Branches: " + ids.map((id) => branches.find((b) => b.id === id)?.name).filter(Boolean).join(", ")
      if (a.audienceType === "DEPARTMENT") audience = "Departments: " + ids.map((id) => depts.find((d) => d.id === id)?.name).filter(Boolean).join(", ")
      if (a.audienceType === "DESIGNATION") audience = "Designations: " + ids.map((id) => desigs.find((d) => d.id === id)?.name).filter(Boolean).join(", ")
      if (a.audienceType === "SPECIFIC") audience = "Employees: " + ids.map((id) => emps.find((e) => e.id === id)?.fullName).filter(Boolean).join(", ")
      return {
        ...a,
        audienceLabel: audience,
        readAt: readAtByAnnouncement.get(a.id) || null,
        // COM-02 — admin-plane read stats (readCount of the intended audience)
        ...(self ? {} : { readCount: readCountByAnnouncement.get(a.id) || 0, audienceSize: audienceSizeOf(a) }),
      }
    })
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): the caller's own read receipt only.
route("announcements.read", {
  // COM-02 (R7) — mark a notice as read (idempotent upsert). Self-scoped:
  // an EMPLOYEE can only mark notices they can actually see; other roles
  // mark any active notice in their tenant (their read state powers the
  // admin feed's read receipts too).
  handler: async (ctx, p) => {
    const a = await db.announcement.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, active: true } })
    if (!a) throw new Deny("Announcement not found", 404)
    if (ctx.role === "EMPLOYEE") {
      const me = ctx.employeeId
        ? await db.employee.findFirst({ where: { id: ctx.employeeId, vendorId: ctx.vendorId }, select: { id: true, branchId: true, departmentId: true, designationId: true } })
        : null
      const ids = j(a.audienceIds, [] as string[])
      const ok = a.audienceType === "ALL"
        || (a.audienceType === "BRANCH" && !!me?.branchId && ids.includes(me.branchId))
        || (a.audienceType === "DEPARTMENT" && !!me?.departmentId && ids.includes(me.departmentId))
        || (a.audienceType === "DESIGNATION" && !!me?.designationId && ids.includes(me.designationId))
        || (a.audienceType === "SPECIFIC" && !!me?.id && ids.includes(me.id))
      if (!ok) throw new Deny("Announcement not found", 404)
    }
    await db.announcementRead.upsert({
      where: { vendorId_announcementId_userId: { vendorId: ctx.vendorId, announcementId: a.id, userId: ctx.userId } },
      create: { vendorId: ctx.vendorId, announcementId: a.id, userId: ctx.userId },
      update: {},
    })
    return { ok: true }
  },
})
/** L-26 — announcement in-app fan-out planner (pure, exported for tests):
 *  the cap is a safety valve against unbounded notify() loops; the caller
 *  MUST report exactly what was delivered plus the truncation count (the old
 *  code capped at 200 while returning targets.length, hiding the cut). */
export const ANNOUNCEMENT_FANOUT_CAP = 2000
export function planAnnouncementFanout(targets: string[], cap: number = ANNOUNCEMENT_FANOUT_CAP): { delivered: string[]; truncated: number } {
  const delivered = targets.slice(0, cap)
  return { delivered, truncated: Math.max(0, targets.length - delivered.length) }
}

route("announcements.create", {
  perm: ["announcements", "create"],
  handler: async (ctx, p) => {
    const rec = await db.announcement.create({
      data: {
        vendorId: ctx.vendorId, title: p.title, body: p.body,
        audienceType: p.audienceType || "ALL", audienceIds: JSON.stringify(p.audienceIds || []),
        pinned: !!p.pinned, publishedAt: new Date(), createdBy: ctx.userId,
      },
    })
    // fan-out notifications to targeted employees
    let targets: string[] = []
    const emps = await db.employee.findMany({ where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION"] } } })
    if (p.audienceType === "ALL") targets = emps.map((e) => e.id)
    if (p.audienceType === "BRANCH") targets = emps.filter((e) => (p.audienceIds || []).includes(e.branchId || "")).map((e) => e.id)
    if (p.audienceType === "DEPARTMENT") targets = emps.filter((e) => (p.audienceIds || []).includes(e.departmentId || "")).map((e) => e.id)
    if (p.audienceType === "DESIGNATION") targets = emps.filter((e) => (p.audienceIds || []).includes(e.designationId || "")).map((e) => e.id)
    // Audit Low — SPECIFIC audience ids are validated against THIS tenant's employees
    if (p.audienceType === "SPECIFIC") targets = (p.audienceIds || []).filter((id: string) => emps.some((e: any) => e.id === id))
    // L-26 — cap + HONEST reporting via the shared planner
    const { delivered, truncated } = planAnnouncementFanout(targets)
    // WP-A — large audiences deliver asynchronously through the job queue
    // (progress + retry + cancellation in the Job Center); small audiences
    // keep the synchronous path so the announcement is instantly visible.
    const ANNOUNCE_ASYNC_THRESHOLD = 200
    if (delivered.length > ANNOUNCE_ASYNC_THRESHOLD) {
      const { submitJob } = await import("../jobs")
      const jobId = await submitJob(ctx, "ANNOUNCEMENT_DELIVERY",
        { announcementId: rec.id, title: p.title, body: p.body, targetIds: delivered },
        { total: delivered.length, priority: 6 })
      return { ...rec, notified: 0, pending: delivered.length, truncated, jobId, async: true }
    }
    for (const t of delivered) {
      await notify(ctx.vendorId, { employeeId: t }, "HR Announcement: " + p.title, p.body.slice(0, 200), "ANNOUNCEMENT", "ess")
    }
    return { ...rec, notified: delivered.length, truncated }
  },
})
route("announcements.delete", {
  perm: ["announcements", "delete"],
  handler: async (ctx, p) => {
    const rec = await db.announcement.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    await db.announcement.update({ where: { id: p.id }, data: { active: false } })
    // Audit Low — announcement deletes were previously unaudited
    await audit(ctx, "announcements.delete", "Announcement", p.id, `Archived announcement "${rec.title}"`, { oldValue: { title: rec.title, active: rec.active } })
    return { deleted: true }
  },
})

// ---------- Birthday & joining anniversary wishes (spec §12.2) ----------
  // INTENTIONALLY_SELF_SCOPED (M-02): birthday/anniversary feed: EMPLOYEE callers see only their own events; HR scopes per H-03
route("wishes.today", {
  handler: async (ctx) => {
    const settings = await getSettings(ctx.vendorId)
    const date = today()
    const mmdd = date.slice(5)
    // H-03 — privacy gate (mirrors ess.wishes, routes/ess.ts): the whole
    // tenant's birthday/anniversary board is visible only to non-EMPLOYEE
    // roles holding employees.view. Employees see only their OWN events.
    const canSeeAll = ctx.role !== "EMPLOYEE" && ctx.permissions.has("employees.view")
    const emps = await db.employee.findMany({
      where: canSeeAll
        ? { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION"] } }
        : { vendorId: ctx.vendorId, id: ctx.employeeId || "__none__", status: { in: ["ACTIVE", "PROBATION"] } },
    })
    const year = Number(date.slice(0, 4))
    const birthdays: { employeeId: string; name: string; message: string }[] = []
    const anniversaries: { employeeId: string; name: string; years: number; message: string }[] = []
    for (const e of emps) {
      if (settings.wishes.birthdayEnabled && e.dob && e.dob.slice(5) === mmdd) {
        birthdays.push({
          employeeId: e.id, name: e.preferredName || e.fullName,
          message: settings.wishes.birthdayTemplate
            .replace(/{{name}}/g, e.preferredName || e.fullName)
            .replace(/{{company}}/g, settings.general.companyName),
        })
      }
      if (settings.wishes.anniversaryEnabled && e.joiningDate && e.joiningDate.slice(5) === mmdd && e.joiningDate.slice(0, 4) < String(year)) {
        const years = year - Number(e.joiningDate.slice(0, 4))
        const ordinal = years === 1 ? "st" : years === 2 ? "nd" : years === 3 ? "rd" : "th"
        anniversaries.push({
          employeeId: e.id, name: e.preferredName || e.fullName, years,
          message: settings.wishes.anniversaryTemplate
            .replace(/{{name}}/g, e.preferredName || e.fullName)
            .replace(/{{years}}/g, String(years))
            .replace(/{{ordinal}}/g, ordinal)
            .replace(/{{company}}/g, settings.general.companyName),
        })
      }
    }
    return { date, birthdays, anniversaries }
  },
})

// ---------- Communication Center: email & SMS blasts (spec §12) ----------
route("communications.send", {
  perm: ["communication", "create"],
  handler: async (ctx, p) => {
    const channel = ["EMAIL", "SMS", "BOTH"].includes(p.channel) ? p.channel : "BOTH"
    const message = String(p.message || "").trim()
    const subject = String(p.subject || "").trim() || "Message from your HR team"
    if (!message) throw new Deny("Message is required")
    if (message.length > 5000) throw new Deny("Message too long (max 5000 characters)")
    if (channel === "EMAIL" || channel === "BOTH") {
      if (!(await emailConfigured(ctx.vendorId))) throw new Deny("Email gateway is not configured — set it up in HR Settings → Email Gateway first")
    }
    if (channel === "SMS" || channel === "BOTH") {
      if (!(await smsConfigured(ctx.vendorId))) throw new Deny("SMS gateway is not configured — set it up in HR Settings → SMS Gateway first")
    }

    // Resolve audience (same fan-out semantics as announcements)
    const audienceType = ["ALL", "BRANCH", "DEPARTMENT", "DESIGNATION", "SPECIFIC"].includes(p.audienceType) ? p.audienceType : "ALL"
    const audienceIds: string[] = Array.isArray(p.audienceIds) ? p.audienceIds : []
    const emps = await db.employee.findMany({
      where: { vendorId: ctx.vendorId, status: { in: ["ACTIVE", "PROBATION", "ON_LEAVE"] } },
      select: { id: true, fullName: true, preferredName: true, officialEmail: true, personalEmail: true, mobile: true, altMobile: true, branchId: true, departmentId: true, designationId: true },
    })
    let targets = emps
    if (audienceType === "BRANCH") targets = emps.filter((e) => audienceIds.includes(e.branchId || ""))
    if (audienceType === "DEPARTMENT") targets = emps.filter((e) => audienceIds.includes(e.departmentId || ""))
    if (audienceType === "DESIGNATION") targets = emps.filter((e) => audienceIds.includes(e.designationId || ""))
    if (audienceType === "SPECIFIC") targets = emps.filter((e) => audienceIds.includes(e.id))
    if (targets.length === 0) throw new Deny("No employees matched the selected audience")

    // M-17 — audience cap: silent mass sends are capped at 200 recipients;
    // anything larger needs an explicit typed confirmation and is hard-capped at 1000.
    if (targets.length > 200 && p.confirm !== "SEND") {
      throw new Deny(`This send targets ${targets.length} employees. Bulk sends above 200 require explicit confirmation — re-send with confirm='SEND'. Consider queuing smaller batches.`)
    }
    if (targets.length > 1000) {
      throw new Deny(`Audience of ${targets.length} exceeds the 1000-recipient hard cap — split the send into smaller batches`)
    }

    const branches = await db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const depts = await db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    const desigs = await db.designation.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } })
    let audienceLabel = "All Employees"
    if (audienceType === "BRANCH") audienceLabel = "Branches: " + audienceIds.map((id) => branches.find((b) => b.id === id)?.name).filter(Boolean).join(", ")
    if (audienceType === "DEPARTMENT") audienceLabel = "Departments: " + audienceIds.map((id) => depts.find((d) => d.id === id)?.name).filter(Boolean).join(", ")
    if (audienceType === "DESIGNATION") audienceLabel = "Designations: " + audienceIds.map((id) => desigs.find((d) => d.id === id)?.name).filter(Boolean).join(", ")
    if (audienceType === "SPECIFIC") audienceLabel = `${targets.length} specific employees`

    const log = await db.communicationLog.create({
      data: {
        vendorId: ctx.vendorId, channel, subject, message,
        audienceType, audienceLabel, recipientCount: targets.length,
        // M-17 — SENT is set only after the gateway acks, never before delivery
        status: "SENDING", sentBy: ctx.userId, sentByName: ctx.userName,
      },
    })

    // M-04/M-05 — delivery runs as a BACKGROUND JOB: the request returns a
    // jobId immediately (up to 1,000 sequential gateway calls never hold the
    // request thread); the client polls jobs.get for progress and counts.
    const { submitJob } = await import("../jobs")
    const jobId = await submitJob(ctx, "COMMUNICATION_SEND", {
      logId: log.id, targetIds: targets.map((e) => e.id), channel,
      subject, message, inApp: p.inApp !== false, audienceLabel,
    }, targets.length)
    return { jobId, id: log.id, recipientCount: targets.length, status: "QUEUED" }
  },
})

route("communications.list", {
  perm: ["communication", "view"],
  handler: async (ctx) => {
    const list = await db.communicationLog.findMany({ where: { vendorId: ctx.vendorId }, orderBy: { createdAt: "desc" }, take: 100 })
    return list
  },
})

route("communications.recipients", {
  perm: ["communication", "view"],
  handler: async (ctx, p) => {
    const log = await db.communicationLog.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!log) throw new Deny("Not found", 404)
    const rows = await db.communicationRecipient.findMany({ where: { logId: log.id }, orderBy: { employeeName: "asc" } })
    return { log, recipients: rows }
  },
})

route("communications.testEmail", {
  perm: ["settings", "edit"],
  handler: async (ctx, p) => {
    const to = String(p.to || "").trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Deny("Provide a valid destination email address")
    const settings = await getSettings(ctx.vendorId)
    const r = await sendEmail(ctx.vendorId, to, `${settings.general.companyName} HRM — test email`, `This is a test email sent from ${settings.general.companyName} HRM at ${new Date().toISOString()}. If you can read this, your email gateway works.`)
    await audit(ctx, "communications.testEmail", "Vendor", ctx.vendorId, `Test email to ${to}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`)
    return r
  },
})

route("communications.status", {
  perm: ["communication", "view"],
  handler: async (ctx) => {
    return {
      email: { configured: await emailConfigured(ctx.vendorId), enabled: true },
      sms: { configured: await smsConfigured(ctx.vendorId), enabled: true },
    }
  },
})
