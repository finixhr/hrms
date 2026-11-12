// ============ Public SaaS API dispatcher — POST /api/saas ============
// Serves the PUBLIC website only (no session): plan list for /pricing,
// registration submission, application status lookup, contact inquiries.
//
// Security posture (mirrors the /api/hrm discipline where it applies):
//   - strict content-type, per-IP rate limits, zod validation on every write
//   - a honeypot field on the registration form (bots that fill it are dropped)
//   - no session, no tenant data — this endpoint can never leak tenant rows;
//     every read is from the platform tables only, and only the SAFE
//     projections (approved plan names, application status by number+email).
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { hashPasswordAsync, validatePasswordPolicy } from "@/hrm-server/auth"
import { rateLimit, resolveClientIp, requestPublicOrigin, identityThrottleKey } from "@/hrm-server/security"
import { getSaasSettings } from "@/hrm-server/saas/settings"
import { nextApplicationNumber } from "@/hrm-server/saas/sequences"
import { saasAudit } from "@/hrm-server/saas/audit"
import { REGISTRATION_MODULES } from "@/hrm-server/saas/constants"
import { notifyRegistrationSubmitted, notifyInquiryReceived, notifyApplicantReceived } from "@/hrm-server/saas/notify"
import { loggerFor } from "@/hrm-server/log"
const log = loggerFor("saas:route")

export const dynamic = "force-dynamic"

const BODY_CAP_BYTES = 512 * 1024 // public writes are small forms — no reason to accept MBs

// ---- shared validation --------------------------------------------------------
const email = z.string().trim().toLowerCase().email().max(160)
const phone = z.string().trim().max(24).regex(/^[+\d\s()-]*$/, "Invalid phone number").optional().or(z.literal(""))
const url = z.string().trim().max(200).refine((v) => !v || /^https?:\/\/.+/i.test(v), "Website must be a http(s) URL")

const registrationSchema = z.object({
  // organization
  organizationName: z.string().trim().min(2).max(120),
  organizationType: z.enum(["PRIVATE_LTD", "PLC", "GOV", "NGO", "PARTNERSHIP", "PROPRIETORSHIP", "OTHER"]).optional(),
  industry: z.string().trim().max(80).optional(),
  website: url.optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).default("Bangladesh"),
  contactNumber: phone.optional(),
  officialEmail: email,
  // administrator
  adminName: z.string().trim().min(2).max(120),
  adminDesignation: z.string().trim().max(80).optional(),
  adminEmail: email,
  adminPhone: phone.optional(),
  password: z.string().min(10).max(128),
  confirmPassword: z.string().min(10).max(128),
  // scale
  employeeCount: z.number().int().min(0).max(500000),
  branchCount: z.number().int().min(1).max(5000),
  deviceCount: z.number().int().min(0).max(5000),
  // requirements — subset keys only
  requiredModules: z.array(z.enum(REGISTRATION_MODULES.map((m) => m.key) as [string, ...string[]])).max(REGISTRATION_MODULES.length).default([]),
  // plan preference
  planId: z.string().trim().max(40).optional(),
  billingCycle: z.enum(["MONTHLY", "YEARLY"]).default("MONTHLY"),
  agreedToTerms: z.literal(true),
  // honeypot — must be empty; any value means "bot"
  companyWebsiteField: z.string().max(0).optional(),
})

const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email,
  phone: phone.optional(),
  company: z.string().trim().max(120).optional(),
  inquiryType: z.enum(["SALES", "SUPPORT", "PARTNERSHIP", "OTHER"]).default("SALES"),
  organizationSize: z.enum(["1-10", "11-50", "51-200", "201-500", "500+"]).optional(),
  modulesRequested: z.array(z.string().max(40)).max(12).default([]),
  message: z.string().trim().min(10).max(2000),
  companyWebsiteField: z.string().max(0).optional(),
})

const statusSchema = z.object({
  applicationNumber: z.string().trim().max(40).regex(/^HRM-\d{4}-\d{6}$/, "Application ID looks like HRM-2026-000123"),
  email,
})

type Handler = (payload: any, req: NextRequest, ip: string | null) => Promise<unknown>

const routes: Record<string, { handler: Handler }> = {}

function action(name: string, handler: Handler) {
  routes[name] = { handler }
}

// ---- public.plans: active, public plans for the pricing page ------------------
action("public.plans", async () => {
  const plans = await db.saasPlan.findMany({
    where: { active: true, isPublic: true },
    orderBy: [{ sortOrder: "asc" }, { monthlyPrice: "asc" }],
  })
  return {
    plans: plans.map((p: any) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      description: p.description,
      monthlyPrice: Number(p.monthlyPrice),
      yearlyPrice: Number(p.yearlyPrice),
      currency: p.currency,
      badge: p.badge,
      isTrialPlan: p.isTrialPlan,
      limits: {
        employeeLimit: p.employeeLimit,
        userLimit: p.userLimit,
        companyLimit: p.companyLimit,
        branchLimit: p.branchLimit,
        departmentLimit: p.departmentLimit,
        deviceLimit: p.deviceLimit,
        storageGb: p.storageGb,
        trackingEmployeeLimit: p.trackingEmployeeLimit,
      },
      features: {
        payroll: p.payrollEnabled,
        ait: p.aitEnabled,
        inventory: p.inventoryEnabled,
        procurement: p.procurementEnabled,
        performance: p.performanceEnabled,
        ess: p.essEnabled,
        camera: p.cameraEnabled,
        tracking: p.trackingEnabled,
        geofence: p.geofenceEnabled,
        api: p.apiAccess,
        advancedReports: p.advancedReports,
        fieldForce: p.fieldForceEnabled,
      },
      supportLevel: p.supportLevel,
    })),
  }
})

// ---- public.register: submit a registration application -----------------------
action("public.register", async (p, req, ip) => {
  const settings = await getSaasSettings()
  if (!settings.registration.enabled) {
    throw Object.assign(new Error("New registrations are currently closed. Please contact support."), { code: 403 })
  }

  const parsed = registrationSchema.parse(p)

  // AUDIT M-3 (2026-11-07) — per-IDENTITY throttle (5 applications / hour per
  // admin email, IP-bound when the deployment resolves a trusted IP). This
  // endpoint previously relied on the dispatcher's per-IP limit, which
  // collapsed into ONE shared "saas:public:unknown" bucket (30 / 5 min for
  // the whole internet) whenever HRM_TRUST_PROXY was unset — the shipped
  // default — while a spoofable x-real-ip header could mint fresh buckets.
  if (await rateLimit(identityThrottleKey("saas-register", parsed.adminEmail, ip), 5, 3600_000)) {
    throw Object.assign(new Error("Too many registration attempts — please wait a while and try again."), { code: 429 })
  }

  if (parsed.password !== parsed.confirmPassword) {
    throw Object.assign(new Error("Passwords do not match."), { code: 400, fieldErrors: { confirmPassword: "Passwords do not match." } })
  }
  // policy check — the platform layer applies the standard strong policy
  const policyError = validatePasswordPolicy(parsed.password, {
    minLength: 10, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true,
    expiryDays: 90, historyCount: 3, lockoutThreshold: 5, lockoutMinutes: 15,
  })
  if (policyError) throw Object.assign(new Error(policyError), { code: 400, fieldErrors: { password: policyError } })

  // ---- AUDIT M-3 (2026-11-07) — NO account-existence oracle. The old
  // branches threw explicit "already being reviewed" / "already an
  // administrator of an active organization" errors for ANY active tenant
  // user email (not just administrators), letting an unauthenticated
  // attacker enumerate every user email on the platform — exactly the
  // oracle the login and forgot-password flows are hardened against
  // (comments L-2, GAP-309). Both cases now return the NEUTRAL
  // application-received response:
  //   • an OPEN application already exists → its tracking data is returned
  //     again (no new row, no queue spam) — byte-identical success shape;
  //   • the email is already an ACTIVE platform user → the application IS
  //     stored with an internal DUPLICATE_EMAIL flag so the review queue can
  //     verify identity before ever approving (the audit's recommended
  //     handling); the applicant sees the same "received" response as anyone
  //     else. Both duplicate attempts land in the (server-side only) audit
  //     log.
  const existingOpen = await db.saasRegistration.findFirst({
    where: { adminEmail: parsed.adminEmail, status: { in: ["PENDING", "UNDER_REVIEW"] } },
    orderBy: { createdAt: "desc" },
  })
  const existingUser = await db.user.findFirst({ where: { email: parsed.adminEmail, status: "ACTIVE" }, select: { id: true } })

  if (existingOpen) {
    await saasAudit(
      { name: "Public website", ip: ip || undefined },
      "REGISTRATION_DUPLICATE_SUBMISSION",
      "SaaSRegistration",
      existingOpen.id,
      `Repeat submission for ${existingOpen.applicationNumber} (open application) — neutral "received" response returned, no new row`,
      { metadata: { adminEmail: parsed.adminEmail, applicationNumber: existingOpen.applicationNumber } },
    ).catch(() => {})
    // The original thank-you email already went out on first submission; a
    // second one would leak that this submission was treated differently.
    return {
      applicationNumber: existingOpen.applicationNumber,
      status: existingOpen.status,
      submittedAt: existingOpen.createdAt,
      planName: existingOpen.planName,
      message: settings.registration.messageOnSubmit,
      confirmationEmail: "SKIPPED",
    }
  }

  // resolve plan: explicit choice, else the platform default
  let planId: string | null = parsed.planId || null
  let planName: string | null = null
  if (planId) {
    const plan = await db.saasPlan.findFirst({ where: { id: planId, active: true } })
    if (!plan) throw Object.assign(new Error("The selected plan is not available. Please choose another plan."), { code: 400 })
    if (!settings.registration.allowedBillingCycles.includes(parsed.billingCycle)) {
      throw Object.assign(new Error(`The ${parsed.billingCycle.toLowerCase()} billing cycle is not currently offered. Please choose the other cycle.`), { code: 400 })
    }
    planName = plan.name
  } else if (settings.registration.defaultPlanId) {
    const plan = await db.saasPlan.findFirst({ where: { id: settings.registration.defaultPlanId, active: true } })
    if (plan) { planId = plan.id; planName = plan.name }
  }

  const applicationNumber = await nextApplicationNumber()
  const reg = await db.saasRegistration.create({
    data: {
      applicationNumber,
      organizationName: parsed.organizationName,
      organizationType: parsed.organizationType || null,
      industry: parsed.industry || null,
      website: parsed.website || null,
      address: parsed.address || null,
      city: parsed.city || null,
      country: parsed.country || "Bangladesh",
      contactNumber: parsed.contactNumber || null,
      officialEmail: parsed.officialEmail,
      adminName: parsed.adminName,
      adminDesignation: parsed.adminDesignation || null,
      adminEmail: parsed.adminEmail,
      adminPhone: parsed.adminPhone || null,
      // MOD-8 (Phase 1) — async scrypt: public.register is an unauthenticated
      // request path; the sync form let a burst of registrations block every
      // tenant's traffic behind one scrypt call each.
      adminPasswordHash: await hashPasswordAsync(parsed.password),
      employeeCount: parsed.employeeCount,
      branchCount: parsed.branchCount,
      deviceCount: parsed.deviceCount,
      requestedModules: JSON.stringify(parsed.requiredModules),
      planId,
      planName,
      billingCycle: parsed.billingCycle,
      status: "PENDING",
      source: "WEBSITE",
      submitIp: ip,
      // SEC-3 (P0 audit wave, 2026-11-09) — the duplicate-email signal now
      // lives in a DEDICATED NON-PUBLIC column (SaasRegistration.duplicateEmail)
      // plus the reviewer-facing internalNote. The old write stuffed a
      // DUPLICATE_EMAIL marker into reviewNote — which the public
      // registrationStatus tracker returned VERBATIM, giving unauthenticated
      // callers an account-existence oracle ("this email already belongs to
      // an active platform user") and leaking every free-form reviewer note
      // to applicants. reviewNote is internal-only now; the public projection
      // never returns it.
      ...(existingUser ? {
        duplicateEmail: true,
        internalNote: `${parsed.adminEmail} is already an active user of an existing workspace — verify the applicant's identity (and whether they meant to register a NEW organization) before approving.`,
      } : {}),
    },
  })

  await saasAudit(
    { name: "Public website", ip },
    "REGISTRATION_CREATED",
    "SaaSRegistration",
    reg.id,
    `New application ${applicationNumber} from ${reg.organizationName}${existingUser ? " (FLAGGED: admin email already belongs to an active platform user)" : ""}`,
    { metadata: { applicationNumber, organization: reg.organizationName, adminEmail: reg.adminEmail, plan: planName, cycle: reg.billingCycle, duplicateEmail: !!existingUser } }
  )

  // platform gateway — alert the owner team (best-effort; SKIPPED transparently
  // when the gateway is not configured, always visible in the console feed)
  await notifyRegistrationSubmitted({
    applicationNumber, organizationName: reg.organizationName,
    adminEmail: reg.adminEmail, adminName: reg.adminName,
    employeeCount: reg.employeeCount, branchCount: reg.branchCount,
    planName, billingCycle: reg.billingCycle,
  }).catch(() => {})

  // applicant thank-you / application-received email with the tracking number
  // and tracking link. Strictly best-effort: the application is ALREADY created
  // and committed — a gateway failure must never surface as a failed
  // registration. The attempt (SKIPPED/FAILED) is logged into the owner
  // console notification feed by notifyExternalEmail → logPlatformNotification.
  // 2026-10-26: shared sanitized origin (proxy headers honored, 0.0.0.0 bind
  // host → localhost, no https fabrication on direct HTTP) so the tracking
  // link in the applicant email is actually reachable regardless of which
  // host the registration form was served from.
  const origin = requestPublicOrigin(req)
  const applicantNotify = await notifyApplicantReceived({
    adminEmail: reg.adminEmail, adminName: reg.adminName,
    organizationName: reg.organizationName, applicationNumber,
    planName, origin,
  }).catch((err) => {
    log.error("[api/saas] applicant confirmation email failed:", err)
    return { status: "FAILED" as const, detail: "unexpected send failure" }
  })

  return {
    applicationNumber,
    status: reg.status,
    submittedAt: reg.createdAt,
    planName,
    message: settings.registration.messageOnSubmit,
    // surfaced (not thrown) so the success screen can tell the applicant
    // whether the confirmation email actually went out
    confirmationEmail: applicantNotify?.status || "SKIPPED",
  }
})

// ---- public.registrationStatus: track an application (number + email) --------
action("public.registrationStatus", async (p) => {
  const parsed = statusSchema.parse(p)
  const reg = await db.saasRegistration.findUnique({
    where: { applicationNumber: parsed.applicationNumber },
  })
  // U2-003 — identical error for both "not found" and "email mismatch" to
  // prevent enumeration of valid application IDs.
  const NOT_FOUND_MSG = "No application found for this ID and email combination. Check both fields, or register first."
  if (!reg) {
    throw Object.assign(new Error(NOT_FOUND_MSG), { code: 404 })
  }
  const emailMatch =
    reg.adminEmail.toLowerCase() === parsed.email ||
    reg.officialEmail.toLowerCase() === parsed.email
  if (!emailMatch) {
    throw Object.assign(new Error(NOT_FOUND_MSG), { code: 404 })
  }
  // SAFE projection only — internal notes, reviewer identity and password
  // hashes are never exposed to the public status page.
  // SEC-3 (P0 audit wave, 2026-11-09) — reviewNote is NO LONGER projected:
  // it is free-form reviewer text on the internal plane (the register path
  // used to write a DUPLICATE_EMAIL marker into it, and any note an owner
  // writes flows straight to this public endpoint). Applicants get the
  // status-driven nextStep guidance below; rejection reasons are already
  // folded into nextStep deliberately.
  const nextStep =
    reg.status === "PENDING" ? "Waiting for the platform team to pick up your application."
    : reg.status === "UNDER_REVIEW" ? "Your application is being reviewed. You may be contacted for clarification."
    : reg.status === "APPROVED" ? "Approved! Sign in to your HR workspace with your administrator email and the password you chose at registration."
    : reg.status === "REJECTED" ? `Application rejected${reg.rejectionReason ? `: ${reg.rejectionReason}` : "."} You may register again with corrected information.`
    : reg.status === "SUSPENDED" ? "Your approved workspace is suspended. Contact platform support."
    : "This application was cancelled."
  return {
    applicationNumber: reg.applicationNumber,
    organizationName: reg.organizationName,
    status: reg.status,
    submittedAt: reg.createdAt,
    reviewedAt: reg.reviewedAt,
    planName: reg.planName,
    billingCycle: reg.billingCycle,
    requestedEmployees: reg.employeeCount,
    requestedBranches: reg.branchCount,
    requestedDevices: reg.deviceCount,
    nextStep,
  }
})

// ---- public.contact: sales/support inquiry ------------------------------------
action("public.contact", async (p, _req, ip) => {
  const parsed = contactSchema.parse(p)
  // AUDIT M-3/H-4 — per-identity throttle (10 / hour per inquirer email,
  // IP-bound when trusted): no shared global bucket, no spoofable fallback.
  if (await rateLimit(identityThrottleKey("saas-contact", parsed.email, ip), 10, 3600_000)) {
    throw Object.assign(new Error("Too many inquiries — please wait a while and try again."), { code: 429 })
  }
  const inq = await db.saasContactInquiry.create({
    data: {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone || null,
      company: parsed.company || null,
      inquiryType: parsed.inquiryType,
      organizationSize: parsed.organizationSize || null,
      modulesRequested: JSON.stringify(parsed.modulesRequested),
      message: parsed.message,
      submitIp: ip,
    },
  })
  await saasAudit(
    { name: "Public website", ip },
    "INQUIRY_RECEIVED",
    "SaaSContactInquiry",
    inq.id,
    `${parsed.inquiryType} inquiry from ${parsed.name} <${parsed.email}>`,
    { metadata: { inquiryType: parsed.inquiryType, company: parsed.company } }
  )
  // platform gateway — alert the inquiries team (best-effort)
  await notifyInquiryReceived({
    name: parsed.name, email: parsed.email, inquiryType: parsed.inquiryType,
    company: parsed.company || null, message: parsed.message,
  }).catch(() => {})
  return { ok: true, reference: `INQ-${inq.id.slice(0, 8).toUpperCase()}` }
})

// ---- dispatcher ---------------------------------------------------------------
function clientError(e: any): { message: string; code: number; fieldErrors?: Record<string, string> } {
  if (e instanceof z.ZodError) {
    const first = e.issues[0]
    const where = first?.path?.length ? ` (${first.path.join(".")})` : ""
    // Field-level projection of EVERY issue (first message per field wins) so
    // the long registration form can mark each invalid input inline instead of
    // only showing a top-of-form summary the user may never scroll back to.
    const fieldErrors: Record<string, string> = {}
    for (const issue of e.issues) {
      const key = issue.path.join(".")
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message
    }
    return { message: `${first?.message || "Invalid input"}${where}`, code: 400, fieldErrors }
  }
  if (typeof e?.message === "string" && Number.isFinite(e?.code) && e.code >= 400 && e.code < 500) {
    return { message: e.message, code: e.code, fieldErrors: e.fieldErrors }
  }
  log.error("[api/saas] unexpected:", e)
  return { message: "Unexpected server error. Please try again or contact support.", code: 500 }
}

export async function POST(req: NextRequest) {
  try {
    const contentType = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    if (contentType !== "application/json") {
      return NextResponse.json({ ok: false, error: "Unsupported content type", code: 415 }, { status: 415 })
    }
    const contentLength = Number(req.headers.get("content-length") || 0)
    if (contentLength > BODY_CAP_BYTES) {
      return NextResponse.json({ ok: false, error: "Payload too large", code: 413 }, { status: 413 })
    }
    const ip = resolveClientIp(req)
    let body: { action?: string; payload?: unknown }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ ok: false, error: "Malformed JSON body", code: 400 }, { status: 400 })
    }
    if (typeof body?.action !== "string" || !body.action.startsWith("public.")) {
      return NextResponse.json({ ok: false, error: "Unknown action", code: 404 }, { status: 404 })
    }
    const def = routes[body.action]
    if (!def) {
      return NextResponse.json({ ok: false, error: "Unknown action", code: 404 }, { status: 404 })
    }
    // AUDIT H-4 (2026-11-07) — the raw x-real-ip fallback is GONE (any client
    // could rotate that header to mint fresh throttle buckets), and the
    // per-IP cap now applies ONLY when the deployment actually resolves a
    // trusted client IP (HRM_TRUST_PROXY=1 — resolveClientIp returns null
    // otherwise). The old `saas:public:${ip || "unknown"}` key collapsed into
    // ONE literal "saas:public:unknown" bucket — 30 requests / 5 minutes for
    // the whole internet, so public registration and contact could be
    // blocked for everyone. Per-action IDENTITY throttles (email-bound when
    // the IP is unknown) inside the handlers now carry the abuse protection.
    if (ip && (await rateLimit(`saas:public:${ip}`, 60, 5 * 60_000))) {
      return NextResponse.json(
        { ok: false, error: "Too many requests. Please wait a minute and try again.", code: 429 },
        { status: 429 }
      )
    }
    const out = await def.handler(body.payload ?? {}, req, ip)
    return NextResponse.json({ ok: true, ...(out as any) })
  } catch (e: any) {
    const { message, code, fieldErrors } = clientError(e)
    return NextResponse.json({ ok: false, error: message, code, ...(fieldErrors ? { fieldErrors } : {}) }, { status: code })
  }
}
