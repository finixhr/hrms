// ============ ATS depth routes (Wave 4 WP-D, 2026-10-08) ============
// Interview scheduling, offer letters and the post-hire onboarding checklist
// for the recruitment pipeline.
//
// Multi-tenant scoping (H-10): every query is { vendorId: ctx.vendorId } —
// cross-tenant ids resolve to plain 404s, never 403 (no existence oracle).
// Every mutation is audited under the ATS_* action family.
//
// Pipeline semantics stay consistent with routes/recruitment.ts:
//   - an interview PASSED bumps a NEW/SHORTLISTED application to INTERVIEW
//     (the pipeline's own advance semantics); FAILED deliberately does NOT
//     auto-reject — the recruiter decides (retry another round / reject);
//   - an ACCEPTED offer bumps the application to OFFERED (unless it already
//     moved beyond — HIRED/REJECTED are employment facts that stay put) and
//     auto-seeds the 3 starter onboarding tasks when the application has
//     none yet (ONE ATS_ONBOARDING_AUTOCREATE summary audit row);
//   - ONE LIVE OFFER per application: creating a second offer while one is
//     DRAFT or SENT (or was already ACCEPTED) is refused with a clear
//     message — no auto-superseding, no new statuses.
import { z } from "zod"
import { route } from "./registry"
import { db } from "@/lib/db"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { isoDate } from "../validation"
import { getSettings } from "../settings"
import { sendEmail } from "../gateway"

// ---------- enums (mirror schema.prisma — frozen) ----------
const ROUND = z.enum(["R1", "R2", "R3", "HR", "FINAL"])
const MODE = z.enum(["ONSITE", "PHONE", "VIDEO"])
const OUTCOME = z.enum(["PASSED", "FAILED", "CANCELLED"])
const OFFER_STATUS = z.enum(["DRAFT", "SENT", "ACCEPTED", "DECLINED"])

// ---------- FormDialog-tolerant primitives ----------
// validation.ts's blank-tolerant helpers are module-private — local twins with
// the same contract: "" → null/undefined, numeric strings coerced.
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), schema)
const idBlank = blank(z.string().trim().min(1).max(40).nullish())
const textBlank = (max: number) => blank(z.string().trim().max(max).nullish())
const dateBlank = blank(isoDate.nullish())
const numIn = (max: number) =>
  z.preprocess(
    (v) => {
      if (v === "" || v === null || v === undefined) return undefined
      if (typeof v === "string") return v.trim() === "" ? undefined : Number(v)
      return v
    },
    z.number().finite().min(0).max(max).nullish(),
  )
const intIn = (max: number) =>
  z.preprocess(
    (v) => {
      if (v === "" || v === null || v === undefined) return undefined
      if (typeof v === "string") return v.trim() === "" ? undefined : Number(v)
      return v
    },
    z.number().int().min(0).max(max).nullish(),
  )

/** https-only URL (blank → null) — meeting links must never be http:, data:
 *  or javascript:. Mirrors the photoUrl https rule in validation.ts. */
const httpsUrl = blank(
  z.string().trim().max(500).nullish().refine((v) => {
    if (v == null) return true
    return /^https:\/\/[^\s"'<>]+$/i.test(v)
  }, { message: "Meeting link must be an https:// URL" }),
)

/** datetime-local value ("YYYY-MM-DDTHH:MM") or one with seconds — normalized
 *  to "YYYY-MM-DDTHH:MM:SS" so lexical range filters (list from/to) compare
 *  chronologically correct strings. */
const scheduledAt = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Expected a date-time (YYYY-MM-DDTHH:MM)")
  .transform((v) => (v.length === 16 ? `${v}:00` : v))

const SALARY_CAP = 10_000_000

const STARTER_ONBOARDING_TASKS = [
  "Prepare appointment letter",
  "Collect joining documents",
  "Create employee profile & assign assets",
] as const

const offerGross = (o: { basicSalary: number; houseRent: number; medical: number; transport: number; otherAllowance: number }) =>
  o.basicSalary + o.houseRent + o.medical + o.transport + o.otherAllowance

// ============================ INTERVIEWS ============================

route("ats.interviews.list", {
  perm: ["recruitment", "view"],
  schema: z.object({
    applicationId: z.string().trim().max(40).nullish(),
    from: isoDate.nullish(),
    to: isoDate.nullish(),
    // "PENDING" is the client-friendly alias for the null column value
    outcome: z.enum(["PENDING", "PASSED", "FAILED", "CANCELLED"]).nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p.applicationId) where.applicationId = p.applicationId
    if (p.from || p.to) {
      where.scheduledAt = {
        ...(p.from ? { gte: `${p.from}T00:00:00` } : {}),
        ...(p.to ? { lte: `${p.to}T23:59:59` } : {}),
      }
    }
    if (p.outcome) where.outcome = p.outcome === "PENDING" ? null : p.outcome
    const rows = await db.jobInterview.findMany({ where, orderBy: { scheduledAt: "desc" }, take: 200 })
    // denormalize applicant + opening in two bounded queries (never per-row)
    const apps = rows.length
      ? await db.jobApplication.findMany({
          where: { vendorId: ctx.vendorId, id: { in: rows.map((r) => r.applicationId) } },
          select: { id: true, name: true, openingId: true },
        })
      : []
    const openingIds = [...new Set(apps.map((a) => a.openingId))]
    const openings = openingIds.length
      ? await db.jobOpening.findMany({ where: { vendorId: ctx.vendorId, id: { in: openingIds } }, select: { id: true, title: true } })
      : []
    const appById = new Map(apps.map((a) => [a.id, a]))
    const openingTitleById = new Map(openings.map((o) => [o.id, o.title]))
    return rows.map((r) => {
      const app = appById.get(r.applicationId)
      return {
        ...r,
        applicantName: app?.name ?? null,
        openingTitle: app ? openingTitleById.get(app.openingId) ?? null : null,
      }
    })
  },
})

// ---------- REC-01 (R7) — the interviewer's own surface ----------
// Named interviewers (regular employees, often with NO recruitment perms)
// previously had no way to see the interviews assigned to them — scheduling
// talked to HR, and the interviewee list was HR-only. Self-scoped: the
// caller's OWN interviews (interviewerId = their user id) with the candidate
// name, opening, schedule and outcome. Candidate CONTACT details stay masked
// (the "reveal" decision belongs to the recruiting team, not every
// interviewer); recording outcomes still needs recruitment.edit.
// INTENTIONALLY_SELF_SCOPED (M-02 / REC-01 R7): the interviewer's OWN
// interviews — interviewerId = ctx.userId; candidate contacts masked.
route("ats.interviews.mine", {
  handler: async (ctx) => {
    const rows = await db.jobInterview.findMany({
      where: { vendorId: ctx.vendorId, interviewerId: ctx.userId },
      orderBy: { scheduledAt: "desc" },
      take: 100,
    })
    const apps = rows.length
      ? await db.jobApplication.findMany({
          where: { vendorId: ctx.vendorId, id: { in: rows.map((r) => r.applicationId) } },
          select: { id: true, name: true, email: true, phone: true, status: true, openingId: true },
        })
      : []
    const openingIds = [...new Set(apps.map((a) => a.openingId))]
    const openings = openingIds.length
      ? await db.jobOpening.findMany({ where: { vendorId: ctx.vendorId, id: { in: openingIds } }, select: { id: true, title: true } })
      : []
    const appById = new Map(apps.map((a) => [a.id, a]))
    const openingTitleById = new Map(openings.map((o) => [o.id, o.title]))
    const mask = (v: string | null | undefined) => (v ? `${String(v).slice(0, 2)}${"•".repeat(Math.max(2, String(v).length - 3))}${String(v).slice(-1)}` : null)
    return rows.map((r) => {
      const app = appById.get(r.applicationId)
      return {
        id: r.id,
        round: r.round,
        mode: r.mode,
        scheduledAt: r.scheduledAt,
        durationMin: r.durationMin,
        location: r.location,
        link: r.link,
        notes: r.notes,
        outcome: r.outcome,
        score: r.score,
        applicantName: app?.name ?? null,
        applicantEmailMasked: mask(app?.email),
        applicantPhoneMasked: mask(app?.phone),
        applicationStatus: app?.status ?? null,
        openingTitle: app ? openingTitleById.get(app.openingId) ?? null : null,
      }
    })
  },
})

route("ats.interviews.save", {
  perm: ["recruitment", "edit"],
  schema: z.object({
    id: z.string().trim().min(1).max(40).optional(),
    applicationId: z.string().trim().min(1).max(40),
    round: ROUND,
    mode: MODE,
    scheduledAt,
    durationMin: intIn(600),
    interviewerId: idBlank,
    location: textBlank(200),
    link: httpsUrl,
    notes: textBlank(4000),
  }).strict(),
  handler: async (ctx, p) => {
    // application must belong to THIS tenant (cross-tenant ids → 404)
    const app = await db.jobApplication.findFirst({ where: { id: p.applicationId, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    // interviewer must be a user of THIS tenant — resolve the denormalized name
    let interviewerName: string | null = null
    if (p.interviewerId) {
      const u = await db.user.findFirst({ where: { id: p.interviewerId, vendorId: ctx.vendorId }, select: { name: true } })
      if (!u) throw new Deny("Interviewer not found", 404)
      interviewerName = u.name
    }
    const data: Record<string, unknown> = {
      applicationId: app.id,
      round: p.round,
      mode: p.mode,
      scheduledAt: p.scheduledAt,
      durationMin: p.durationMin ?? null,
      interviewerId: p.interviewerId ?? null,
      interviewerName,
      location: p.location ?? null,
      link: p.link ?? null,
      notes: p.notes ?? null,
      // outcome/score are NEVER written here — only ats.interviews.outcome
      // decides an interview (create leaves the column null = PENDING).
    }
    if (p.id) {
      const existing = await db.jobInterview.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Interview not found", 404)
      // a decided interview is a fact — reschedule by creating a new round
      // (mirrors the HIRED lock on applications)
      if (existing.outcome && existing.outcome !== "PENDING") {
        throw new Deny(`This interview was already recorded as ${existing.outcome} — schedule a new round instead of editing the decided one`, 409)
      }
      const rec = await db.jobInterview.update({ where: { id: existing.id }, data })
      await audit(ctx, "ATS_INTERVIEW_SAVE", "JobInterview", rec.id,
        `Updated ${rec.round} interview for ${app.name} (${rec.scheduledAt})`,
        { oldValue: existing, newValue: rec })
      return rec
    }
    const rec = await db.jobInterview.create({ data: { ...data, vendorId: ctx.vendorId } as any })
    await audit(ctx, "ATS_INTERVIEW_SAVE", "JobInterview", rec.id,
      `Scheduled ${rec.round} ${rec.mode} interview for ${app.name} at ${rec.scheduledAt}${interviewerName ? ` (interviewer ${interviewerName})` : ""}`)
    return rec
  },
})

route("ats.interviews.outcome", {
  perm: ["recruitment", "edit"],
  schema: z.object({
    id: z.string().trim().min(1).max(40),
    outcome: OUTCOME,
    score: numIn(100),
    notes: textBlank(4000),
  }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.jobInterview.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Interview not found", 404)
    if (existing.outcome && existing.outcome !== "PENDING") {
      throw new Deny(`This interview was already recorded as ${existing.outcome}`, 409)
    }
    const app = await db.jobApplication.findFirst({ where: { id: existing.applicationId, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    const rec = await db.jobInterview.update({
      where: { id: existing.id },
      data: {
        outcome: p.outcome,
        ...(p.score !== undefined ? { score: p.score ?? null } : {}),
        ...(p.notes !== undefined ? { notes: p.notes ?? null } : {}),
      },
    })
    // PASSED on a NEW/SHORTLISTED application advances it to INTERVIEW — the
    // pipeline's own advance semantics. FAILED deliberately does NOT
    // auto-reject: the recruiter decides (a failed round can still end in a
    // different-round retry or a reject).
    let applicationMoved = false
    if (p.outcome === "PASSED" && (app.status === "NEW" || app.status === "SHORTLISTED")) {
      await db.jobApplication.update({ where: { id: app.id }, data: { status: "INTERVIEW" } })
      applicationMoved = true
      await audit(ctx, "recruitment.applications.status", "JobApplication", app.id,
        `Moved ${app.name} from ${app.status} to INTERVIEW (${existing.round} interview passed)`,
        { oldValue: { status: app.status }, newValue: { status: "INTERVIEW" } })
    }
    await audit(ctx, "ATS_INTERVIEW_OUTCOME", "JobInterview", rec.id,
      `Recorded ${rec.outcome} for the ${rec.round} interview of ${app.name}${rec.score != null ? ` (score ${rec.score}/100)` : ""}`,
      { oldValue: existing, newValue: rec })
    return { interview: rec, applicationMoved }
  },
})

// ============================ OFFERS ============================

route("ats.offers.list", {
  perm: ["recruitment", "view"],
  schema: z.object({
    applicationId: z.string().trim().max(40).nullish(),
    status: OFFER_STATUS.nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p.applicationId) where.applicationId = p.applicationId
    if (p.status) where.status = p.status
    const rows = await db.offerLetter.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 })
    const apps = rows.length
      ? await db.jobApplication.findMany({
          where: { vendorId: ctx.vendorId, id: { in: rows.map((r) => r.applicationId) } },
          select: { id: true, name: true, openingId: true },
        })
      : []
    const openingIds = [...new Set(apps.map((a) => a.openingId))]
    const openings = openingIds.length
      ? await db.jobOpening.findMany({ where: { vendorId: ctx.vendorId, id: { in: openingIds } }, select: { id: true, title: true } })
      : []
    const appById = new Map(apps.map((a) => [a.id, a]))
    const openingTitleById = new Map(openings.map((o) => [o.id, o.title]))
    return rows.map((o) => {
      const app = appById.get(o.applicationId)
      return {
        ...o,
        applicantName: app?.name ?? null,
        openingTitle: app ? openingTitleById.get(app.openingId) ?? null : null,
        gross: offerGross(o),
      }
    })
  },
})

/** One-live-offer rule: an application may have at most one DRAFT/SENT offer
 *  and at most one ACCEPTED offer (ever). Existing rows can be ignored
 *  (edit-in-place of the same row). */
async function assertNoLiveOffer(vendorId: string, applicationId: string, ignoreId?: string) {
  const scope = { vendorId, applicationId, ...(ignoreId ? { id: { not: ignoreId } } : {}) }
  const [live, accepted] = await Promise.all([
    db.offerLetter.findFirst({ where: { ...scope, status: { in: ["DRAFT", "SENT"] } } }),
    db.offerLetter.findFirst({ where: { ...scope, status: "ACCEPTED" } }),
  ])
  if (live) {
    throw new Deny(
      `A ${live.status === "DRAFT" ? "draft" : "sent"} offer already exists for this application — send or decide it before creating another`,
      409,
    )
  }
  if (accepted) {
    throw new Deny("An offer was already ACCEPTED for this application — its terms are final", 409)
  }
}

route("ats.offers.save", {
  perm: ["recruitment", "edit"],
  schema: z.object({
    id: z.string().trim().min(1).max(40).optional(),
    applicationId: z.string().trim().min(1).max(40),
    title: z.string().trim().min(2).max(160),
    grade: textBlank(60),
    department: textBlank(120),
    joiningDate: dateBlank,
    basicSalary: numIn(SALARY_CAP),
    houseRent: numIn(SALARY_CAP),
    medical: numIn(SALARY_CAP),
    transport: numIn(SALARY_CAP),
    otherAllowance: numIn(SALARY_CAP),
    notes: textBlank(4000),
  }).strict(),
  handler: async (ctx, p) => {
    const app = await db.jobApplication.findFirst({ where: { id: p.applicationId, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    const data: Record<string, unknown> = {
      applicationId: app.id,
      title: p.title,
      grade: p.grade ?? null,
      department: p.department ?? null,
      joiningDate: p.joiningDate ?? null,
      basicSalary: p.basicSalary ?? 0,
      houseRent: p.houseRent ?? 0,
      medical: p.medical ?? 0,
      transport: p.transport ?? 0,
      otherAllowance: p.otherAllowance ?? 0,
      notes: p.notes ?? null,
    }
    if (p.id) {
      const existing = await db.offerLetter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Offer not found", 404)
      // terms are frozen once the letter leaves DRAFT — a SENT/decided offer
      // is a communication fact (decline + new offer supersedes it)
      if (existing.status !== "DRAFT") {
        throw new Deny(`Only draft offers can be edited — this one is already ${existing.status}`, 409)
      }
      // switching the application on a draft must respect the one-live-offer
      // rule on the NEW application too (the edited row itself is ignored)
      await assertNoLiveOffer(ctx.vendorId, app.id, existing.id)
      const rec = await db.offerLetter.update({ where: { id: existing.id }, data })
      await audit(ctx, "ATS_OFFER_SAVE", "OfferLetter", rec.id,
        `Updated draft offer "${rec.title}" for ${app.name} (gross ${offerGross(rec)}/month)`,
        { oldValue: existing, newValue: rec })
      return { ...rec, gross: offerGross(rec) }
    }
    await assertNoLiveOffer(ctx.vendorId, app.id)
    const rec = await db.offerLetter.create({
      data: { ...data, vendorId: ctx.vendorId, createdById: ctx.userId ?? null, createdByName: ctx.userName ?? null } as any,
    })
    await audit(ctx, "ATS_OFFER_SAVE", "OfferLetter", rec.id,
      `Drafted offer "${rec.title}" for ${app.name} (gross ${offerGross(rec)}/month)`)
    return { ...rec, gross: offerGross(rec) }
  },
})

route("ats.offers.send", {
  perm: ["recruitment", "edit"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const offer = await db.offerLetter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!offer) throw new Deny("Offer not found", 404)
    if (offer.status !== "DRAFT") throw new Deny(`Only draft offers can be sent — this one is already ${offer.status}`, 409)
    const app = await db.jobApplication.findFirst({ where: { id: offer.applicationId, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    const rec = await db.offerLetter.update({ where: { id: offer.id }, data: { status: "SENT", sentAt: new Date() } })
    // best-effort email to the applicant (SKIPPED when there is no address or
    // the gateway is not configured — the state transition still stands and
    // the delivery result is surfaced to the recruiter in the UI/audit row)
    let email: { status: string; detail?: string } | null = null
    if (app.email) {
      const settings = await getSettings(ctx.vendorId)
      const gross = offerGross(offer)
      const body = [
        `Dear ${app.name},`,
        "",
        `We are pleased to offer you the position of ${offer.title}${offer.department ? ` in our ${offer.department} department` : ""}${offer.grade ? ` (grade ${offer.grade})` : ""}.`,
        offer.joiningDate ? `Your proposed joining date is ${offer.joiningDate}.` : "",
        `Monthly gross remuneration: BDT ${gross.toLocaleString("en-US")}.`,
        // REC-04 — the notes ride the email like they already do the
        // printable letter (the old ternary rendered an EMPTY line whenever
        // notes existed, so the field never reached the candidate).
        offer.notes ? `Notes: ${offer.notes}` : null,
        "Please confirm your acceptance with our HR team.",
        "",
        "Regards,",
        settings.general.companyName || "HR Team",
      ]
        .filter((l) => l !== null)
        .join("\n")
      email = await sendEmail(ctx.vendorId, app.email, `Offer of Employment — ${offer.title}`, body)
    }
    await audit(ctx, "ATS_OFFER_SEND", "OfferLetter", rec.id,
      `Sent offer "${rec.title}" to ${app.name}${email ? ` (email: ${email.status}${email.detail ? ` — ${email.detail}` : ""})` : " — applicant has no email on file"}`,
      { oldValue: offer, newValue: rec })
    return { offer: { ...rec, gross: offerGross(rec) }, email }
  },
})

route("ats.offers.decide", {
  perm: ["recruitment", "edit"],
  schema: z.object({
    id: z.string().trim().min(1).max(40),
    decision: z.enum(["ACCEPTED", "DECLINED"]),
  }).strict(),
  handler: async (ctx, p) => {
    const offer = await db.offerLetter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!offer) throw new Deny("Offer not found", 404)
    if (offer.status !== "SENT") throw new Deny(`Only sent offers can be decided — this one is ${offer.status}`, 409)
    const app = await db.jobApplication.findFirst({ where: { id: offer.applicationId, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    const rec = await db.offerLetter.update({ where: { id: offer.id }, data: { status: p.decision, decidedAt: new Date() } })
    // ACCEPTED → application OFFERED (unless it already moved beyond — a
    // HIRED/REJECTED application is an employment fact that stays put).
    // DECLINED leaves the application untouched: the recruiter decides the
    // next move (reopen, new offer, reject).
    let applicationStatus = app.status
    if (p.decision === "ACCEPTED" && ["NEW", "SHORTLISTED", "INTERVIEW"].includes(app.status)) {
      await db.jobApplication.update({ where: { id: app.id }, data: { status: "OFFERED" } })
      applicationStatus = "OFFERED"
      await audit(ctx, "recruitment.applications.status", "JobApplication", app.id,
        `Moved ${app.name} from ${app.status} to OFFERED (offer "${offer.title}" accepted)`,
        { oldValue: { status: app.status }, newValue: { status: "OFFERED" } })
    }
    // bonus integration: seed the 3 starter onboarding tasks when the
    // application has none yet — ONE summary audit row, not one per task
    let onboardingCreated = 0
    if (p.decision === "ACCEPTED") {
      const existing = await db.onboardingTask.count({ where: { vendorId: ctx.vendorId, applicationId: app.id } })
      if (existing === 0) {
        await db.onboardingTask.createMany({
          data: STARTER_ONBOARDING_TASKS.map((title) => ({ vendorId: ctx.vendorId, applicationId: app.id, title })),
        })
        onboardingCreated = STARTER_ONBOARDING_TASKS.length
        await audit(ctx, "ATS_ONBOARDING_AUTOCREATE", "OnboardingTask", app.id,
          `Auto-created ${onboardingCreated} starter onboarding tasks for ${app.name} (offer "${offer.title}" accepted)`,
          { newValue: { tasks: STARTER_ONBOARDING_TASKS } })
      }
    }
    await audit(ctx, "ATS_OFFER_DECIDE", "OfferLetter", rec.id,
      `Offer "${rec.title}" for ${app.name} was ${p.decision === "ACCEPTED" ? "accepted" : "declined"}${onboardingCreated ? ` — ${onboardingCreated} onboarding task${onboardingCreated === 1 ? "" : "s"} created` : ""}`,
      { oldValue: offer, newValue: rec })
    return { offer: rec, applicationStatus, onboardingCreated }
  },
})

route("ats.offers.letter", {
  perm: ["recruitment", "view"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const offer = await db.offerLetter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!offer) throw new Deny("Offer not found", 404)
    const app = await db.jobApplication.findFirst({ where: { id: offer.applicationId, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    const opening = await db.jobOpening.findFirst({ where: { id: app.openingId, vendorId: ctx.vendorId }, select: { title: true } })
    const settings = await getSettings(ctx.vendorId)
    const components = [
      { label: "Basic Salary", amount: offer.basicSalary },
      { label: "House Rent Allowance", amount: offer.houseRent },
      { label: "Medical Allowance", amount: offer.medical },
      { label: "Transport Allowance", amount: offer.transport },
      { label: "Other Allowance", amount: offer.otherAllowance },
    ]
    // viewing/printing an offer letter is audit-logged (letters.download
    // discipline — every access to a printable letter leaves a trail)
    await audit(ctx, "ATS_OFFER_LETTER", "OfferLetter", offer.id,
      `Generated the printable offer letter "${offer.title}" for ${app.name}`)
    return {
      applicantName: app.name,
      openingTitle: opening?.title ?? null,
      title: offer.title,
      grade: offer.grade,
      department: offer.department,
      joiningDate: offer.joiningDate,
      components,
      gross: components.reduce((s, c) => s + c.amount, 0),
      notes: offer.notes,
      generatedAt: new Date().toISOString(),
      status: offer.status,
      company: {
        companyName: settings.general.companyName,
        address: settings.general.address,
        phone: settings.general.phone,
        email: settings.general.email,
        signatoryName: settings.general.signatoryName,
        signatoryDesignation: settings.general.signatoryDesignation,
      },
    }
  },
})

// ============================ ONBOARDING ============================

route("ats.onboarding.list", {
  perm: ["recruitment", "view"],
  schema: z.object({
    applicationId: z.string().trim().max(40).nullish(),
    employeeId: z.string().trim().max(40).nullish(),
    open: z.boolean().nullish(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p.applicationId) where.applicationId = p.applicationId
    if (p.employeeId) where.employeeId = p.employeeId
    if (p.open) where.doneAt = null
    const rows = await db.onboardingTask.findMany({
      where,
      // dueDate asc, undated tasks last (explicit nulls-last — the Postgres
      // ASC default, spelled out so the intent survives any engine change)
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 200,
    })
    const appIds = [...new Set(rows.map((r) => r.applicationId).filter((v): v is string => !!v))]
    const empIds = [...new Set(rows.map((r) => r.employeeId).filter((v): v is string => !!v))]
    const [apps, emps] = await Promise.all([
      appIds.length
        ? db.jobApplication.findMany({ where: { vendorId: ctx.vendorId, id: { in: appIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      empIds.length
        ? db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
        : Promise.resolve([]),
    ])
    const appById = new Map(apps.map((a) => [a.id, a.name]))
    const empById = new Map(emps.map((e) => [e.id, e]))
    return rows.map((r) => ({
      ...r,
      applicantName: r.applicationId ? appById.get(r.applicationId) ?? null : null,
      employeeName: r.employeeId ? empById.get(r.employeeId)?.fullName ?? null : null,
      employeeCode: r.employeeId ? empById.get(r.employeeId)?.code ?? null : null,
    }))
  },
})

route("ats.onboarding.save", {
  perm: ["recruitment", "edit"],
  schema: z.object({
    id: z.string().trim().min(1).max(40).optional(),
    applicationId: idBlank,
    employeeId: idBlank,
    title: z.string().trim().min(1).max(120),
    assigneeId: idBlank,
    dueDate: dateBlank,
  }).strict(),
  handler: async (ctx, p) => {
    // a checklist row must hang off SOMETHING — a hired applicant or an
    // existing employee (both vendor-scoped below)
    if (!p.applicationId && !p.employeeId) {
      throw new Deny("Link the task to a hired applicant or an existing employee", 400)
    }
    let applicantName: string | null = null
    if (p.applicationId) {
      const app = await db.jobApplication.findFirst({ where: { id: p.applicationId, vendorId: ctx.vendorId } })
      if (!app) throw new Deny("Application not found", 404)
      applicantName = app.name
    }
    let employeeName: string | null = null
    if (p.employeeId) {
      const emp = await db.employee.findFirst({ where: { id: p.employeeId, vendorId: ctx.vendorId } })
      if (!emp) throw new Deny("Employee not found", 404)
      employeeName = emp.fullName
    }
    let assigneeName: string | null = null
    if (p.assigneeId) {
      const u = await db.user.findFirst({ where: { id: p.assigneeId, vendorId: ctx.vendorId }, select: { name: true } })
      if (!u) throw new Deny("Assignee not found", 404)
      assigneeName = u.name
    }
    const forWho = applicantName || employeeName
    const data: Record<string, unknown> = {
      applicationId: p.applicationId ?? null,
      employeeId: p.employeeId ?? null,
      title: p.title,
      assigneeId: p.assigneeId ?? null,
      assigneeName,
      dueDate: p.dueDate ?? null,
    }
    if (p.id) {
      const existing = await db.onboardingTask.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Onboarding task not found", 404)
      // doneAt/doneBy* are managed exclusively by ats.onboarding.toggle —
      // a save never flips completion state
      const rec = await db.onboardingTask.update({ where: { id: existing.id }, data })
      await audit(ctx, "ATS_ONBOARDING_SAVE", "OnboardingTask", rec.id,
        `Updated onboarding task "${rec.title}"${forWho ? ` (for ${forWho})` : ""}`,
        { oldValue: existing, newValue: rec })
      return rec
    }
    const rec = await db.onboardingTask.create({ data: { ...data, vendorId: ctx.vendorId } as any })
    await audit(ctx, "ATS_ONBOARDING_SAVE", "OnboardingTask", rec.id,
      `Created onboarding task "${rec.title}"${forWho ? ` for ${forWho}` : ""}${assigneeName ? ` (assignee ${assigneeName})` : ""}`)
    return rec
  },
})

route("ats.onboarding.toggle", {
  perm: ["recruitment", "edit"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.onboardingTask.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Onboarding task not found", 404)
    const done = !existing.doneAt
    const rec = await db.onboardingTask.update({
      where: { id: existing.id },
      data: done
        ? { doneAt: new Date(), doneById: ctx.userId ?? null, doneByName: ctx.userName ?? null }
        : { doneAt: null, doneById: null, doneByName: null },
    })
    await audit(ctx, "ATS_ONBOARDING_TOGGLE", "OnboardingTask", rec.id,
      done ? `Completed onboarding task "${rec.title}"` : `Reopened onboarding task "${rec.title}"`,
      { oldValue: { doneAt: existing.doneAt, doneBy: existing.doneByName }, newValue: { doneAt: rec.doneAt, doneBy: rec.doneByName } })
    return rec
  },
})

route("ats.onboarding.delete", {
  perm: ["recruitment", "delete"],
  schema: z.object({ id: z.string().trim().min(1).max(40) }).strict(),
  handler: async (ctx, p) => {
    const existing = await db.onboardingTask.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!existing) throw new Deny("Onboarding task not found", 404)
    await db.onboardingTask.delete({ where: { id: existing.id } })
    await audit(ctx, "ATS_ONBOARDING_DELETE", "OnboardingTask", existing.id,
      `Deleted onboarding task "${existing.title}"`, { oldValue: existing })
    return { deleted: true }
  },
})
