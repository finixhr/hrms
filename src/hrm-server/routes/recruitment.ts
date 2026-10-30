// ============ Wave 2 WP-P — Recruitment routes ============
// Tenant-plane admin RPCs (openings CRUD + applicant pipeline) PLUS the ONE
// public route: recruitment.apply (no session — the public /careers page
// submits applications through it).
//
// Multi-tenant scoping (H-10):
//   - every admin query is { vendorId: ctx.vendorId } (+ compound id lookups
//     resolve to 404, never 403, so cross-tenant ids give no oracle);
//   - the PUBLIC apply action has no session, so the tenant context is
//     resolved from the submitted reference — exactly the mechanism the
//     existing public forms use (public.register resolves the plan from the
//     submitted planId; public.registrationStatus resolves the application
//     from the submitted applicationNumber). Here the openingId resolves the
//     JobOpening row, and the application is created with THAT row's
//     vendorId. The submission can therefore never choose or spoof a tenant —
//     it can only attach to an opening the tenant itself published.
//
// CV storage: the schema (frozen) gives JobApplication a plain `cvFileId`
// String column and the codebase has no generic file-blob model — employee
// documents store their base64 bytes INLINE on the row (EmployeeDocument.
// fileData). The CV follows that convention: cvFileId carries a compact JSON
// envelope {v, fileName, mime, bytes, data} (base64 payload). It never rides
// along with list payloads — only recruitment.applications.cv returns it,
// behind recruitment.view + an audit row, mirroring employeeDocs.download.
import { db } from "@/lib/db"
import { z } from "zod"
import { route } from "./registry"
import { Deny, require } from "../rbac"
import { audit, notify } from "../audit"
import { rateLimit, resolveClientIp } from "../security"
import { decodeBase64Payload } from "../uploads"
import { getSettings } from "../settings"
import { eventChannels } from "../delivery"
import { sendLogged } from "../jobs"
import { effectiveMessageTemplate, renderMessageTemplate } from "../message-templates"
import type { Ctx } from "../types"

// ---------- enums (mirror schema.prisma — frozen) ----------
const OPENING_STATUS = z.enum(["DRAFT", "OPEN", "PAUSED", "CLOSED"])
const EMPLOYMENT_TYPE = z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"])
const APP_STATUS = z.enum(["NEW", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED", "REJECTED"])

const todayKey = () => new Date().toISOString().slice(0, 10)

/** Deadline strings are normalized to YYYY-MM-DD on save, so lexical
 *  comparison against the local today key is chronologically correct. */
const deadlineSchema = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((v) => !Number.isNaN(new Date(v.length === 10 ? `${v}T00:00:00` : v).getTime()), "Deadline must be a valid date")
  .transform((v) => v.slice(0, 10))

const phoneSchema = z
  .string()
  .trim()
  .max(24)
  .regex(/^[+\d\s()-]*$/, "Invalid phone number")
  .optional()
  .or(z.literal(""))

// ============================ OPENINGS ============================
// R6 (2026-10-12) — server-side twin of the shared rich-text sanitizer
// (src/hrm/shared/rich-text-editor.tsx). The Job Description / Requirements
// fields are authored in a rich-text editor; the CLIENT sanitizes before
// sending, but the SERVER repeats the whitelist here so a crafted client
// can never persist XSS into the public careers page. Contract: formatting
// tags only (p/br/b/strong/i/em/u/s/ul/ol/li/a/h3/h4/blockquote), anchors
// keep ONLY safe hrefs, everything else is unwrapped/stripped.
const RICH_ALLOWED = new Set(["P", "BR", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "A", "H3", "H4", "BLOCKQUOTE"])
function sanitizeRichTextServer(html: string | null | undefined): string | null {
  if (html == null) return null
  let out = String(html)
  if (!out.trim()) return null
  out = out
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(iframe|object|embed|form|svg|math|template)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
  out = out.replace(/<\s*(\/?)\s*([a-zA-Z0-9-]+)((?:\s+[^<>]*)?)>/g, (_m, slash: string, rawTag: string, attrs: string) => {
    const t = String(rawTag).toUpperCase()
    if (!RICH_ALLOWED.has(t)) return ""
    const norm = t === "B" ? "strong" : t === "I" ? "em" : String(rawTag).toLowerCase() // canonical lowercase, b/i normalized
    if (slash) return `</${norm}>`
    if (t === "A") {
      const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(attrs))
      const raw = href ? (href[2] ?? href[3] ?? href[4] ?? "") : ""
      const safe = /^(https?:|mailto:)/i.test(raw.trim()) ? raw.trim() : ""
      return safe ? `<a href="${safe.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">` : "<a>"
    }
    return `<${norm}>`
  })
  return out
}

route("recruitment.openings.list", {
  perm: ["recruitment", "view"],
  schema: z.object({
    status: OPENING_STATUS.optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p.status) where.status = p.status
    const [rows, branches, departments, counts] = await Promise.all([
      db.jobOpening.findMany({ where, orderBy: [{ createdAt: "desc" }] }),
      db.branch.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.department.findMany({ where: { vendorId: ctx.vendorId }, select: { id: true, name: true } }),
      db.jobApplication.groupBy({ by: ["openingId"], where: { vendorId: ctx.vendorId }, _count: { _all: true } }),
    ])
    const branchById = new Map(branches.map((b) => [b.id, b.name]))
    const deptById = new Map(departments.map((d) => [d.id, d.name]))
    const countByOpening = new Map(counts.map((c) => [c.openingId, c._count._all]))
    return rows.map((o) => ({
      ...o,
      branchName: o.branchId ? branchById.get(o.branchId) ?? null : null,
      departmentName: o.departmentId ? deptById.get(o.departmentId) ?? null : null,
      applicationCount: countByOpening.get(o.id) ?? 0,
    }))
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02): the def below carries the view-level dispatcher gate; the handler requires the PRECISE verb (recruitment.edit for updates, recruitment.create for new rows).
route("recruitment.openings.save", {
  // dispatcher gate is view-level; the handler requires the PRECISE verb
  // (edit for updates, create for new rows) so custom roles scoped to only
  // one of the two keep exactly the access they were granted.
  //
  // PARTIAL updates: the quick actions (open / pause / close / publish) send
  // { id, status? } or { id, isPublic? } alone — every field is optional and
  // only the PRESENT keys are written (defaults are applied by Prisma on
  // create, never forced over existing rows on update). Title is required
  // only when creating.
  perm: ["recruitment", "view"],
  schema: z.object({
    id: z.string().trim().max(40).optional(),
    title: z.string().trim().min(2).max(120).optional(),
    departmentId: z.string().trim().max(40).optional(),
    branchId: z.string().trim().max(40).optional(),
    employmentType: EMPLOYMENT_TYPE.optional(),
    description: z.string().max(20000).optional(), // R6: rich text (sanitized server-side)
    requirements: z.string().max(20000).optional(),
    openings: z.number().int().min(1).max(999).optional(),
    salaryRange: z.string().trim().max(120).optional(),
    deadline: z.union([deadlineSchema, z.literal("")]).optional(),
    status: OPENING_STATUS.optional(),
    isPublic: z.boolean().optional(),
  }).strict(),
  handler: async (ctx: Ctx, p) => {
    require(ctx, "recruitment", p.id ? "edit" : "create")
    if (!p.id && !p.title) throw new Deny("Title is required")
    // FK sanity: department/branch must belong to THIS tenant (cross-tenant
    // ids are rejected, not silently ignored)
    if (p.departmentId) {
      const dept = await db.department.findFirst({ where: { id: p.departmentId, vendorId: ctx.vendorId }, select: { id: true } })
      if (!dept) throw new Deny("Department not found", 404)
    }
    if (p.branchId) {
      const branch = await db.branch.findFirst({ where: { id: p.branchId, vendorId: ctx.vendorId }, select: { id: true } })
      if (!branch) throw new Deny("Branch not found", 404)
    }
    // sparse write set: undefined = keep the stored value, "" = clear
    const data: Record<string, unknown> = {}
    if (p.title !== undefined) data.title = p.title
    if (p.departmentId !== undefined) data.departmentId = p.departmentId || null
    if (p.branchId !== undefined) data.branchId = p.branchId || null
    if (p.employmentType !== undefined) data.employmentType = p.employmentType
    if (p.description !== undefined) data.description = sanitizeRichTextServer(p.description)
    if (p.requirements !== undefined) data.requirements = sanitizeRichTextServer(p.requirements)
    if (p.openings !== undefined) data.openings = p.openings
    if (p.salaryRange !== undefined) data.salaryRange = p.salaryRange || null
    if (p.deadline !== undefined) data.deadline = p.deadline || null
    if (p.status !== undefined) data.status = p.status
    if (p.isPublic !== undefined) data.isPublic = p.isPublic
    if (Object.keys(data).length === 0) throw new Deny("Nothing to save")
    if (p.id) {
      const existing = await db.jobOpening.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Opening not found", 404)
      const rec = await db.jobOpening.update({ where: { id: p.id }, data })
      await audit(ctx, "recruitment.openings.save", "JobOpening", rec.id,
        `Updated opening ${rec.title}${rec.isPublic && rec.status === "OPEN" ? " (published to the careers page)" : ""}`,
        { oldValue: existing, newValue: rec })
      return rec
    }
    // create — title is runtime-enforced above; the sparse write set is
    // intentionally open-keyed (Prisma applies column defaults for the rest)
    const rec = await db.jobOpening.create({ data: { ...data, vendorId: ctx.vendorId } as any })
    await audit(ctx, "recruitment.openings.save", "JobOpening", rec.id,
      `Created opening ${rec.title} (${rec.status}${rec.isPublic ? ", public" : ""})`)
    return rec
  },
})

route("recruitment.openings.delete", {
  perm: ["recruitment", "delete"],
  schema: z.object({
    id: z.string().trim().min(1).max(40),
  }).strict(),
  handler: async (ctx, p) => {
    const rec = await db.jobOpening.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Opening not found", 404)
    // Applications are the hiring record — deleting an opening that received
    // any would destroy candidate history. Close it instead.
    const apps = await db.jobApplication.count({ where: { vendorId: ctx.vendorId, openingId: rec.id } })
    if (apps > 0) {
      throw new Deny(`This opening has ${apps} application(s) on record — close it instead of deleting, so the hiring history is preserved`, 409)
    }
    await db.jobOpening.delete({ where: { id: rec.id } })
    await audit(ctx, "recruitment.openings.delete", "JobOpening", rec.id, `Deleted opening ${rec.title}`, { oldValue: rec })
    return { deleted: true }
  },
})

// ============================ APPLICATIONS ============================

route("recruitment.applications.list", {
  perm: ["recruitment", "view"],
  schema: z.object({
    openingId: z.string().trim().max(40).optional(),
    status: APP_STATUS.optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p.openingId) {
      // 404 for a cross-tenant (or unknown) opening id — no oracle
      const opening = await db.jobOpening.findFirst({ where: { id: p.openingId, vendorId: ctx.vendorId }, select: { id: true } })
      if (!opening) throw new Deny("Opening not found", 404)
      where.openingId = p.openingId
    }
    if (p.status) where.status = p.status
    const rows = await db.jobApplication.findMany({ where, orderBy: { createdAt: "desc" } })
    const openings = await db.jobOpening.findMany({
      where: { vendorId: ctx.vendorId },
      select: { id: true, title: true, departmentId: true, branchId: true, employmentType: true },
    })
    const byOpening = new Map(openings.map((o) => [o.id, o]))
    // REC-01 (R7) — candidate contact PII is masked for viewers: the audit
    // caught full emails/phones shipping to every recruitment.view holder
    // (branch managers, payroll officers…). Editors (recruitment.edit) keep
    // the clear values — contacting candidates is the recruiter's job.
    const canSeeContact = ctx.permissions.has("recruitment.edit") || ctx.permissions.has("*")
    const mask = (v: string | null | undefined) => (v ? `${String(v).slice(0, 2)}${"•".repeat(Math.max(2, String(v).length - 3))}${String(v).slice(-1)}` : null)
    // cvFileId holds the full CV bytes — NEVER ride along with list payloads
    return rows.map(({ cvFileId: _cv, ...app }) => ({
      ...app,
      email: canSeeContact ? app.email : mask(app.email),
      phone: canSeeContact ? app.phone : mask(app.phone),
      openingTitle: byOpening.get(app.openingId)?.title ?? "—",
      openingDepartmentId: byOpening.get(app.openingId)?.departmentId ?? null,
      hasCv: !!_cv,
    }))
  },
})

/** Allowed pipeline transitions: any move between NEW → SHORTLISTED →
 *  INTERVIEW → OFFERED → HIRED / REJECTED EXCEPT out of HIRED — a hired
 *  applicant is an employment fact; reverting would corrupt the hiring
 *  record that prefilled the employee wizard. */
route("recruitment.applications.status", {
  perm: ["recruitment", "edit"],
  schema: z.object({
    id: z.string().trim().min(1).max(40),
    status: APP_STATUS,
    notes: z.string().trim().max(4000).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const app = await db.jobApplication.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    if (app.status === "HIRED") {
      throw new Deny("This applicant is already HIRED — the hiring record is locked (an employment fact was created from it)", 409)
    }
    if (app.status === p.status && p.notes === undefined) {
      return { ok: true, unchanged: true }
    }
    const rec = await db.jobApplication.update({
      where: { id: app.id },
      data: { status: p.status, ...(p.notes !== undefined ? { notes: p.notes || null } : {}) },
    })
    await audit(ctx, "recruitment.applications.status", "JobApplication", rec.id,
      `Moved ${app.name} from ${app.status} to ${p.status} (${rec.openingId})`, { oldValue: { status: app.status, notes: app.notes }, newValue: { status: p.status, notes: p.notes } })
    if (p.status !== "HIRED") return { ok: true }
    // HIRED → hand the UI everything it needs to prefill the employee wizard
    const opening = await db.jobOpening.findFirst({ where: { id: rec.openingId, vendorId: ctx.vendorId } })
    return {
      ok: true,
      hired: {
        id: rec.id,
        name: rec.name,
        email: rec.email || null,
        phone: rec.phone || null,
        openingTitle: opening?.title ?? null,
        departmentId: opening?.departmentId ?? null,
      },
    }
  },
})

/** CV download — base64 + filename + sniffed mime, behind an audit row
 *  (mirrors employeeDocs.download / letters.download discipline). */
route("recruitment.applications.cv", {
  perm: ["recruitment", "view"],
  schema: z.object({
    id: z.string().trim().min(1).max(40),
  }).strict(),
  handler: async (ctx, p) => {
    const app = await db.jobApplication.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!app) throw new Deny("Application not found", 404)
    if (!app.cvFileId) throw new Deny("No CV was attached to this application", 404)
    let file: { fileName?: string; mime?: string; data?: string }
    try {
      file = JSON.parse(app.cvFileId)
    } catch {
      throw new Deny("The stored CV record is unreadable — re-request it from the applicant", 500)
    }
    if (!file.data) throw new Deny("No CV was attached to this application", 404)
    await audit(ctx, "recruitment.applications.cv", "JobApplication", app.id, `Downloaded the CV of applicant ${app.name}`)
    return { fileName: file.fileName || "cv", mime: file.mime || "application/octet-stream", data: file.data }
  },
})

/** Manual (back-office) application entry — e.g. a walk-in candidate or an
 *  email application the HR team logs into the same pipeline. */
route("recruitment.applications.create", {
  perm: ["recruitment", "create"],
  schema: z.object({
    openingId: z.string().trim().min(1).max(40),
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(160).optional(),
    phone: phoneSchema,
    expectedSalary: z.number().min(0).max(1_000_000_000).optional(),
    coverNote: z.string().trim().max(2000).optional(),
    notes: z.string().trim().max(4000).optional(),
  }).strict(),
  handler: async (ctx, p) => {
    const opening = await db.jobOpening.findFirst({ where: { id: p.openingId, vendorId: ctx.vendorId } })
    if (!opening) throw new Deny("Opening not found", 404)
    const rec = await db.jobApplication.create({
      data: {
        vendorId: ctx.vendorId,
        openingId: opening.id,
        name: p.name,
        email: p.email || null,
        phone: p.phone || null,
        expectedSalary: p.expectedSalary ?? null,
        coverNote: p.coverNote || null,
        notes: p.notes || null,
        source: "MANUAL",
        status: "NEW",
      },
    })
    await audit(ctx, "recruitment.applications.create", "JobApplication", rec.id,
      `Logged a manual application from ${rec.name} for ${opening.title}`)
    return rec
  },
})

// ============================ PUBLIC APPLY ============================
// The ONE public route in this module (dispatcher: def.public bypasses the
// 401-for-no-session gate; schema validation still applies). Security stack:
//   - zod strict payload (unknown fields dropped by the whitelist)
//   - honeypot: any non-empty value = bot → {ok:true} silently, nothing stored
//   - per-IP rate limit + per-opening rate limit (Throttle table, M-16/M-06)
//   - the opening must be OPEN + isPublic + not past its deadline
//     (server-enforced — the public listing applies the same filter)
//   - CV bytes are magic-byte sniffed (PDF / DOC / DOCX) AND cross-checked
//     against the file-name extension; decoded size ≤ 2 MB (uploads.ts cap)
const MAX_CV_BYTES = 2 * 1024 * 1024 // mirrors uploads.ts MAX_DOC_BYTES
const CV_EXT_BY_MAGIC: { mime: string; exts: string[]; label: string }[] = [
  { mime: "application/pdf", exts: [".pdf"], label: "PDF" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", exts: [".docx"], label: "DOCX" },
  { mime: "application/msword", exts: [".doc"], label: "DOC" },
]

/** Byte-level CV sniff + extension cross-check (never trust the client
 *  filename alone — mirrors uploads.ts sniffMime discipline). */
function validateCv(fileName: string, buf: Buffer): { ok: true; mime: string } | { ok: false; reason: string } {
  const name = fileName.toLowerCase()
  let sniffed: { mime: string; exts: string[]; label: string } | null = null
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) {
    sniffed = CV_EXT_BY_MAGIC[0] // %PDF-
  } else if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    sniffed = CV_EXT_BY_MAGIC[1] // PK\x03\x04 (OOXML zip container)
  } else if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1) {
    sniffed = CV_EXT_BY_MAGIC[2] // OLE2 compound document
  }
  if (!sniffed) {
    return { ok: false, reason: "Unsupported CV file — allowed types: PDF, DOC, DOCX" }
  }
  if (!sniffed.exts.some((ext) => name.endsWith(ext))) {
    return { ok: false, reason: `The file content does not match its name — a ${sniffed.label} document must have a ${sniffed.exts.join("/")} extension` }
  }
  return { ok: true, mime: sniffed.mime }
}

// INTENTIONALLY_PUBLIC (M-02): public Careers application form — anonymous applicants upload CVs against published openings (rate-limited, payload-zodded, virus-sniffed, never tenant-scoped).
route("recruitment.apply", {
  public: true,
  schema: z.object({
    openingId: z.string().trim().min(1).max(40),
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(160).optional().or(z.literal("")),
    phone: phoneSchema,
    expectedSalary: z.number().min(0).max(1_000_000_000).optional(),
    coverNote: z.string().trim().max(2000).optional(),
    cvFileName: z.string().trim().max(200).optional(),
    cvBase64: z.string().max(3_500_000).optional(), // 2 MB decoded ≈ 2.8 M base64 chars
    honeypot: z.string().max(200).optional(),
  }).strict(),
  handler: async (ctx: Ctx | null, p, req) => {
    void ctx // no session context is used — the opening row decides the tenant
    // ---- honeypot: a filled hidden field is a bot. Pretend success, store nothing.
    if (p.honeypot && p.honeypot.trim() !== "") return { ok: true }

    // ---- rate limits (Throttle table, fixed window — security.ts M-16/M-06)
    // H-7 discipline: XFF is only honored behind a trusted proxy; without an
    // IP the bucket falls back to the (optional) email — identity-bound, not
    // a spoofable shared bucket.
    const ip = resolveClientIp(req)
    const identityKey = ip || (p.email ? `email:${p.email}` : "unknown")
    if (await rateLimit(`recruitment:apply:ip:${identityKey}`, 5, 10 * 60_000)) {
      throw new Deny("Too many applications from this connection — please wait a few minutes and try again", 429)
    }
    if (await rateLimit(`recruitment:apply:opening:${p.openingId}`, 20, 10 * 60_000)) {
      throw new Deny("This opening has received too many applications just now — please try again shortly", 429)
    }

    // ---- opening must be OPEN + published + not past its deadline
    // (deadline is normalized to YYYY-MM-DD on save → lexical compare is
    // chronological; the public careers page listing applies the SAME filter)
    const opening = await db.jobOpening.findFirst({
      where: {
        id: p.openingId,
        status: "OPEN",
        isPublic: true,
        OR: [{ deadline: null }, { deadline: { gte: todayKey() } }],
      },
    })
    if (!opening) throw new Deny("This opening is no longer accepting applications", 404)

    // ---- CV validation (optional but, when present, byte-checked)
    let cvEnvelope: string | null = null
    if (p.cvBase64 && p.cvBase64.trim() !== "") {
      if (!p.cvFileName || !p.cvFileName.trim()) {
        throw new Deny("The CV file name is missing", 400)
      }
      const buf = decodeBase64Payload(p.cvBase64)
      if (!buf || buf.length === 0) throw new Deny("The CV file could not be decoded — please re-attach it", 400)
      if (buf.length > MAX_CV_BYTES) {
        throw new Deny(`The CV is too large — ${Math.round(buf.length / 1024)} KB decoded, the limit is ${Math.round(MAX_CV_BYTES / 1024)} KB`, 400)
      }
      // strip any path components from the client-supplied name
      const safeName = p.cvFileName.replace(/[\\/]/g, "").replace(/[\r\n\x00-\x1f]/g, "").trim().slice(0, 200)
      const check = validateCv(safeName, buf)
      if (!check.ok) throw new Deny(check.reason, 400)
      cvEnvelope = JSON.stringify({ v: 1, fileName: safeName, mime: check.mime, bytes: buf.length, data: buf.toString("base64") })
    }

    // ---- persist (tenant = the opening's tenant — see module header)
    const app = await db.jobApplication.create({
      data: {
        vendorId: opening.vendorId,
        openingId: opening.id,
        name: p.name,
        email: p.email || null,
        phone: p.phone || null,
        expectedSalary: p.expectedSalary ?? null,
        coverNote: p.coverNote || null,
        cvFileId: cvEnvelope,
        source: "WEBSITE",
        status: "NEW",
      },
    })

    // ---- tenant audit trail (public actor, mirroring the saasAudit
    // "Public website" actor convention on the platform plane)
    await audit(
      { userId: null, userName: "Public website", vendorId: opening.vendorId, ip: ip || undefined },
      "recruitment.apply", "JobApplication", app.id,
      `Website application from ${app.name} for ${opening.title}`,
      { newValue: { openingId: opening.id, source: "WEBSITE", hasCv: !!cvEnvelope } },
    )

    // ---- notify HR (in-app always; email/SMS per the job_application_received
    // template + notification-matrix fallback — the jobs.ts attendance_alert
    // fan-out pattern: roles HR_ADMIN + HR_MANAGER, best-effort sends logged
    // into CommunicationLog via sendLogged)
    notifyHrOfApplication(opening.vendorId, opening.title, app, ip || null).catch(() => { /* never fail the submit */ })

    return { ok: true, reference: `APP-${app.id.slice(0, 8).toUpperCase()}` }
  },
})

/** Fan an application out to the tenant's HR users (WP-P). In-app is always
 *  delivered; email/SMS render from the job_application_received system
 *  template (tenant-editable in HR Settings → Templates) when the channel is
 *  enabled. Channel resolution mirrors eventChannels() with a legacy default
 *  (email on) because the notification matrix predates this event. */
async function notifyHrOfApplication(
  vendorId: string,
  openingTitle: string,
  app: { name: string; email: string | null; phone: string | null },
  ip: string | null,
): Promise<void> {
  const settings = await getSettings(vendorId)
  const ch = eventChannels(settings, "job_application_received", { email: true, sms: false })
  const title = "New Job Application"
  const message = `${app.name} applied for ${openingTitle} via the careers page${app.email ? ` (${app.email})` : ""}. Review it in the Recruitment pipeline.`
  if (ch.inApp) {
    await notify(vendorId, { role: "HR_ADMIN" }, title, message, "SYSTEM", "recruitment")
    await notify(vendorId, { role: "HR_MANAGER" }, title, message, "SYSTEM", "recruitment")
  }
  if (!ch.email && !ch.sms) return
  const tpl = effectiveMessageTemplate((settings as any).messageTemplates, "job_application_received")
  const vars = {
    company: settings.general.companyName,
    date: todayKey(),
    applicant: app.name,
    jobTitle: openingTitle,
    email: app.email || "no email",
    phone: app.phone || "no phone",
    source: "careers page",
  }
  const subject = tpl ? renderMessageTemplate(tpl.emailSubject, vars) || title : title
  const text = tpl ? renderMessageTemplate(tpl.emailBody, vars) || message : message
  const smsText = tpl ? renderMessageTemplate(tpl.smsBody, vars) || `${title}: ${message}`.slice(0, 300) : `${title}: ${message}`.slice(0, 300)
  const hrUsers = await db.user.findMany({
    where: { vendorId, role: { in: ["HR_ADMIN", "HR_MANAGER"] }, status: "ACTIVE" },
    select: { email: true, phone: true },
  })
  const { sendEmail, sendSms } = await import("../gateway")
  for (const u of hrUsers) {
    if (ch.email && u.email) {
      const em = u.email
      await sendLogged(vendorId, "EMAIL", subject, () => sendEmail(vendorId, em, subject, text))
    }
    if (ch.sms && u.phone) {
      const ph = u.phone
      await sendLogged(vendorId, "SMS", `New application — ${openingTitle}`, () => sendSms(vendorId, ph, smsText.slice(0, 300)))
    }
  }
  void ip // reserved for diagnostics; never surfaced in messages
}
