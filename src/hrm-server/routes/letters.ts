// ============ HR Letters & Document Management routes (spec §13) ============
// Dynamic vendor templates with {{variables}}, lifecycle-linked generation,
// approval via reusable engine, issuance history with audit.
import crypto from "crypto"
import { db } from "@/lib/db"
import { route } from "./registry"
import { Deny, assertEmployeeVisible, scopedEmployeeWhere, can } from "../rbac"
import { audit, notify } from "../audit"
import { resolveEntitlements, featureBlocked } from "../saas/entitlements"
import { fmtDate, nextFormattedSeq, today, withinDuplicateWindow } from "../utils"
import { escapeHtml, escapeAttrUrl, sanitizeHtml, safePayload } from "../security"

const VARIABLES = [
  "employee_name", "employee_name_bn", "employee_id", "designation", "department", "branch",
  "joining_date", "salary", "basic_salary", "gross_salary", "manager_name", "effective_date",
  "company_name", "date", "employee_code", "address", "probation_months", "employment_type",
]

function buildVars(emp: any, extra: Record<string, string> = {}, vendorName = "Company") {
  const v: Record<string, string> = {
    employee_name: emp?.fullName || "",
    employee_name_bn: emp?.nameBn || emp?.fullName || "",
    employee_id: emp?.code || "",
    employee_code: emp?.code || "",
    designation: emp?.designationName || "",
    department: emp?.departmentName || "",
    branch: emp?.branchName || "",
    joining_date: fmtDate(emp?.joiningDate),
    address: emp?.presentAddress || "",
    probation_months: String(emp?.probationMonths ?? 3),
    employment_type: (emp?.employmentType || "").replace(/_/g, " ").toLowerCase(),
    company_name: vendorName,
    date: fmtDate(today()),
    ...extra,
  }
  return v
}

async function renderTemplate(body: string, vars: Record<string, string>) {
  let out = body
  for (const [k, val] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"), val)
  }
  return out
}

// ---------- Templates ----------
route("templates.list", {
  perm: ["letters", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId }
    if (p?.type) where.type = p.type
    return db.letterTemplate.findMany({ where, orderBy: { type: "asc" } })
  },
})
route("templates.save", {
  perm: ["letters", "edit"],
  handler: async (ctx, p) => {
    // H-5 — explicit whitelist: vendorId/id are server-controlled; the body is
    // sanitized at RENDER time (keeps formatting, strips the attack surface).
    const data = safePayload<any>(p, ["type", "name", "subject", "body", "active", "requiresApproval", "signatoryName"],
      { boolFields: ["active", "requiresApproval"] })
    if (p.id) {
      const existing = await db.letterTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
      if (!existing) throw new Deny("Template not found", 404)
      const rec = await db.letterTemplate.update({ where: { id: p.id }, data })
      await audit(ctx, "templates.update", "LetterTemplate", data.id, `Updated template ${data.name || existing.name}`, { oldValue: existing, newValue: data })
      return rec
    }
    if (!data.type || !data.name || !data.body) throw new Deny("Template type, name and body are required")
    const rec = await db.letterTemplate.create({ data: { ...data, vendorId: ctx.vendorId } })
    await audit(ctx, "templates.create", "LetterTemplate", rec.id, `Created template ${data.name}`)
    return rec
  },
})
route("templates.delete", {
  perm: ["letters", "edit"],
  handler: async (ctx, p) => {
    const rec = await db.letterTemplate.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!rec) throw new Deny("Not found", 404)
    const used = await db.hrLetter.count({ where: { vendorId: ctx.vendorId, templateId: p.id } })
    if (used > 0) throw new Deny("Template has issued letters — deactivate instead")
    await db.letterTemplate.delete({ where: { id: p.id } })
    await audit(ctx, "templates.delete", "LetterTemplate", p.id, `Deleted template ${rec.name}`)
    return { deleted: true }
  },
})
route("templates.variables", {
  perm: ["letters", "view"],
  handler: async () => ({ variables: VARIABLES }),
})

// ---------- Letter generation ----------
route("letters.generate", {
  perm: ["letters", "generate"],
  handler: async (ctx, p) => {
    const emp = await assertEmployeeVisible(ctx, p.employeeId)
    const template = p.templateId
      ? await db.letterTemplate.findFirst({ where: { id: p.templateId, vendorId: ctx.vendorId } })
      : await db.letterTemplate.findFirst({ where: { vendorId: ctx.vendorId, type: p.type, active: true } })
    if (!template) throw new Deny("Letter template not found", 404)

    // lifecycle-linked data (spec §13.3): increment letters pull revision, promotion letters pull designations
    const extra: Record<string, string> = {}
    const structure = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" } })
    if (structure) {
      extra.basic_salary = structure.basic.toLocaleString("en-IN")
      extra.salary = structure.gross.toLocaleString("en-IN")
      extra.gross_salary = structure.gross.toLocaleString("en-IN")
    }
    if (p.effectiveDate) extra.effective_date = fmtDate(p.effectiveDate)
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const branch = emp.branchId ? await db.branch.findFirst({ where: { id: emp.branchId } }) : null
    const dept = emp.departmentId ? await db.department.findFirst({ where: { id: emp.departmentId } }) : null
    const desig = emp.designationId ? await db.designation.findFirst({ where: { id: emp.designationId } }) : null
    const manager = emp.reportingManagerId ? await db.employee.findFirst({ where: { id: emp.reportingManagerId } }) : null
    const vars = buildVars({ ...emp, designationName: desig?.name, departmentName: dept?.name, branchName: branch?.name }, extra, vendor?.name || "Company")
    vars.manager_name = manager?.fullName || ""

    const content = await renderTemplate(template.body, vars)
    // M-14 — double-submit guard: regenerating the same letter type for the
    // same employee within 90s is a duplicate click, not intent.
    const dup = await db.hrLetter.findFirst({
      where: { vendorId: ctx.vendorId, employeeId: emp.id, type: template.type, status: "DRAFT", createdBy: ctx.userId },
      orderBy: { createdAt: "desc" },
    })
    if (dup && withinDuplicateWindow(dup.createdAt)) {
      throw new Deny(`A ${template.type.replace(/_/g, " ").toLowerCase()} draft for ${emp.fullName} was just generated (${dup.letterNumber}) — submit or edit it first`, 409)
    }
    // M-22 — race-safe letter numbering (count+1 duplicated codes under concurrency)
    const letterNumber = await nextFormattedSeq(ctx.vendorId, `letters:${new Date().getFullYear()}`,
      (n) => `L-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`)

    const rec = await db.hrLetter.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id, type: template.type, templateId: template.id,
        letterNumber, subject: template.subject, content,
        signatoryName: template.signatoryName || vendor?.name, status: "DRAFT",
        dataJson: JSON.stringify({ vars, extra, effectiveDate: p.effectiveDate || null, reason: p.reason || null }),
        createdBy: ctx.userId,
      },
    })
    await audit(ctx, "letters.generate", "HrLetter", rec.id, `Generated ${template.type} letter for ${emp.fullName} (${letterNumber})`)
    return rec
  },
})

route("letters.list", {
  perm: ["letters", "view"],
  handler: async (ctx, p) => {
    // H-04/H-05 — manager-facing list: scope-limited by default; explicit
    // employeeId must be inside the caller's branch/department scope.
    const where: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    if (p?.status) where.status = p.status
    if (p?.type) where.type = p.type
    // MOD-16 (Phase 2 WS4) — optional server-side pagination (legacy callers
    // keep the full array) + name decoration from the PAGE's ids only
    const paged = p?.page != null || p?.pageSize != null
    const pageSize = Math.min(500, Math.max(1, Number(p?.pageSize) || 200))
    const page = Math.max(1, Number(p?.page) || 1)
    const [list, total] = paged
      ? await Promise.all([
          db.hrLetter.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
          db.hrLetter.count({ where }),
        ])
      : [await db.hrLetter.findMany({ where, orderBy: { createdAt: "desc" } }), null]
    const pageIds = [...new Set(list.map((l) => l.employeeId).filter((x): x is string => !!x))]
    const employees = pageIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: pageIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    const items = list.map((l) => ({
      ...l,
      employeeName: empById.get(l.employeeId)?.fullName || "—",
      employeeCode: empById.get(l.employeeId)?.code,
    }))
    return paged ? { items, total, page, pageSize } : items
  },
})

route("letters.submit", {
  perm: ["letters", "generate"],
  handler: async (ctx, p) => {
    const letter = await db.hrLetter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!letter) throw new Deny("Letter not found", 404)
    if (letter.status !== "DRAFT") throw new Deny("Only draft letters can be submitted")
    const template = letter.templateId ? await db.letterTemplate.findUnique({ where: { id: letter.templateId } }) : null
    const emp = await db.employee.findUnique({ where: { id: letter.employeeId } })
    // Mandatory approval types (spec §13.5)
    const needsApproval = template?.requiresApproval !== false &&
      ["APPOINTMENT", "INCREMENT", "PROMOTION", "TERMINATION", "WARNING", "SUSPENSION", "CONFIRMATION", "PROBATION_EXT", "TRANSFER"].includes(letter.type)
    if (needsApproval) {
      const { submitForApproval } = await import("../approval")
      const approvalId = await submitForApproval(ctx, "LETTER", "HrLetter", letter.id,
        `${letter.type.replace("_", " ")} letter — ${emp?.fullName || ""}`, { employeeId: letter.employeeId, letterId: letter.id, amount: 0 })
      await db.hrLetter.update({ where: { id: letter.id }, data: { status: "PREPARED", approvalRequestId: approvalId } })
    } else {
      await db.hrLetter.update({ where: { id: letter.id }, data: { status: "APPROVED" } })
    }
    await audit(ctx, "letters.submit", "HrLetter", letter.id, `Submitted letter ${letter.letterNumber} for approval`)
    return { ok: true }
  },
})

/** LETTER finalize hook. */
export async function applyLetterDecision(ctx: { userId: string; userName: string; vendorId: string }, letterId: string, decision: string) {
  const letter = await db.hrLetter.findFirst({ where: { id: letterId, vendorId: ctx.vendorId } })
  if (!letter || !["DRAFT", "PREPARED", "HR_REVIEW", "MANAGEMENT_APPROVAL"].includes(letter.status)) return
  const status = decision === "APPROVED" ? "APPROVED" : "REJECTED"
  await db.hrLetter.update({ where: { id: letter.id }, data: { status, approvedBy: status === "APPROVED" ? ctx.userName : null } })
  if (status === "APPROVED") {
    await notify(ctx.vendorId, { employeeId: letter.employeeId }, "HR Letter Issued",
      `A ${letter.type.replace("_", " ").toLowerCase()} (${letter.letterNumber}) has been issued to you. Check My Documents.`, "LETTER", "ess")
    await db.employeeHistory.create({
      data: { vendorId: ctx.vendorId, employeeId: letter.employeeId, eventType: "LETTER",
        title: `${letter.type.replace(/_/g, " ")} letter issued`, description: letter.letterNumber, dataJson: JSON.stringify({ letterId: letter.id }) },
    })
  }
}

route("letters.issue", {
  perm: ["letters", "generate"],
  handler: async (ctx, p) => {
    const letter = await db.hrLetter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, status: "APPROVED" } })
    if (!letter) throw new Deny("Approved letter not found", 404)
    let emailStatus: string | null = null
    if (p.deliveryMethod === "EMAIL") {
      // REAL email delivery of the print-ready letter (spec §13.5)
      const html = await buildLetterHtml(ctx.vendorId, letter)
      const { emailLetter } = await import("../delivery")
      const res = await emailLetter(ctx.vendorId, letter.id, html, `${letter.subject || letter.type.replace(/_/g, " ")} — ${letter.letterNumber}`, letter.employeeId)
      emailStatus = res.status
    }
    // LTR-02 (R7) — the anti-forgery verification code is minted ONCE at
    // issue and stored; the printed letter carries it and third parties
    // verify it on the public page (/verify/letter).
    const verificationCode = letter.verificationCode || letterVerificationCode(letter)
    await db.hrLetter.update({
      where: { id: letter.id },
      data: { status: "ISSUED", issuedAt: new Date(), deliveryMethod: p.deliveryMethod || "PORTAL", emailStatus, verificationCode },
    })
    await audit(ctx, "letters.issue", "HrLetter", letter.id, `Issued letter ${letter.letterNumber} via ${p.deliveryMethod || "PORTAL"}${emailStatus ? ` (email: ${emailStatus})` : ""} — verification code ${verificationCode}`)
    if (p.deliveryMethod === "EMAIL") {
      const emp = await db.employee.findUnique({ where: { id: letter.employeeId } })
      await notify(ctx.vendorId, { employeeId: letter.employeeId }, "Letter Emailed",
        `${letter.letterNumber} was emailed to ${emp?.officialEmail || emp?.personalEmail || "your email address"}.`, "LETTER", "ess")
    }
    return { issued: true, emailStatus, verificationCode }
  },
})

/** The public verification base URL (same-origin by default — the printed
 *  instruction points at this deployment's own /verify/letter page). */
export function letterVerifyBaseUrl(): string {
  return process.env.HRM_PUBLIC_BASE_URL || ""
}
const verifyBaseUrl = letterVerifyBaseUrl()

/** Shared print-ready letter document renderer (used by download + email — spec §13.5).
 *  H-1 — admin-authored letter bodies are sanitized to a formatting whitelist
 *  (no scripts/iframes/handlers/javascript: URLs), all other values are
 *  HTML-escaped, and the document carries a script-blocking CSP meta. */
export async function buildLetterHtml(vendorId: string, letter: any): Promise<string> {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } })
  const { getSettings } = await import("../settings")
  const settings = await getSettings(vendorId)
  const e = escapeHtml
  const signatoryName = e(letter.signatoryName || vendor?.signatoryName || vendor?.name || settings.general.companyName)
  const signatoryDesignation = e(vendor?.signatoryDesignation || "Authorized Signatory")
  const logoUrl = escapeAttrUrl(settings.general.logoUrl)
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="" style="height:52px;object-fit:contain" />`
    : ""
  const signatureUrl = escapeAttrUrl(vendor?.signatureUrl)
  const signatureHtml = signatureUrl
    ? `<img src="${signatureUrl}" alt="signature" style="height:56px;object-fit:contain" />`
    : `<div>______________________</div>`
  const sealUrl = escapeAttrUrl(vendor?.sealUrl)
  const sealHtml = sealUrl
    ? `<img src="${sealUrl}" alt="seal" style="height:96px;width:96px;object-fit:contain;transform:rotate(-8deg);opacity:.9" />`
    : `<div class="seal">OFFICIAL<br>SEAL</div>`
  // H-1 — letter bodies keep their formatting but lose the attack surface
  const bodyHtml = sanitizeHtml(String(letter.content || ""))
  // LTR-02 (R7) — verification footer on issued letters: the printed code +
  // where a third party can confirm it. Issued letters only (drafts never
  // leave the building, and the code is minted at issue).
  const verifyFooter = letter.verificationCode && letter.status === "ISSUED"
    ? `<div class="verify"><div class="vtitle">Letter Verification</div>
<div>This letter carries verification code <b>${e(letter.verificationCode)}</b>.</div>
<div class="vsmall">To confirm its authenticity, enter the code at <b>${verifyBaseUrl ? e(verifyBaseUrl) + "/verify/letter" : "this company's HR portal → Letter Verification (/verify/letter)"}</b> — no account required.</div></div>`
    : ""
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(letter.letterNumber)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'">
<style>body{font-family:Georgia,'Times New Roman',serif;color:#111;margin:0;padding:48px;max-width:760px;margin:0 auto;line-height:1.7}
.head{text-align:center;border-bottom:3px double #059669;padding-bottom:16px;margin-bottom:24px}
.co{font-size:24px;font-weight:700;color:#065f46;letter-spacing:.04em;display:flex;align-items:center;justify-content:center;gap:12px}
.co small{display:block;font-weight:400;color:#555;font-size:11px;font-family:Arial}
.meta{font-size:12px;color:#555;display:flex;justify-content:space-between;margin-bottom:24px}
.body{font-size:14px;white-space:pre-wrap}
.sig{margin-top:48px} .sig .line{margin-top:6px;font-size:13px}
.verify{margin-top:40px;border:1px dashed #059669;border-radius:8px;padding:10px 14px;font-size:11px;color:#335;max-width:420px;font-family:Arial}
.verify .vtitle{font-weight:700;color:#065f46;letter-spacing:.05em;text-transform:uppercase;font-size:10px;margin-bottom:4px}
.verify .vsmall{color:#777;margin-top:2px}
.seal{position:relative;float:right;margin-top:8px;border:2px solid #059669;color:#059669;border-radius:50%;width:92px;height:92px;display:flex;align-items:center;justify-content:center;font-size:10px;transform:rotate(-12deg);opacity:.8;text-align:center}
@media print{body{padding:0}}</style></head><body>
<div class="head"><div class="co">${logoHtml}<span>${e(vendor?.name || "Company")}<small>${e(vendor?.address || "")} · ${e(vendor?.phone || "")}</small></span></div></div>
<div class="meta"><span>Ref: ${e(letter.letterNumber)}</span><span>Date: ${e(fmtDate(letter.issuedAt ? letter.issuedAt.toISOString().slice(0, 10) : today()))}</span></div>
<div class="body">${bodyHtml}</div>
<div class="seal-wrap" style="display:flex;justify-content:space-between;align-items:flex-end">${sealHtml}
<div class="sig">${signatureHtml}<div class="line"><b>${signatoryName}</b></div><div class="line">${signatoryDesignation}</div></div></div>
${verifyFooter}
</body></html>`
}

// Sensitive letter classes — downloads require an audited reason (spec §13.4)
const SENSITIVE_LETTER_TYPES = ["TERMINATION", "SUSPENSION", "WARNING", "SHOW_CAUSE"]

// ---------- LTR-02 (R7) — anti-forgery verification codes ----------
// Issued letters carry a printed verification code. A third party (typically
// a bank asking for a salary certificate) enters the code on the public
// verification page and gets the letter's verifiable facts — no login needed.
// The code is HMAC-derived at ISSUE time and STORED on the row: verification
// compares the submitted value against the stored one, so rotating
// HRM_LETTER_KEY only affects codes minted afterwards (old letters keep
// verifying — the stored code is the source of truth, not recomputation).
function letterVerifyKey(): string {
  const key = process.env.HRM_LETTER_KEY || process.env.HRM_MFA_KEY
  // R2a-011 — never fall back to a hardcoded constant; refuse to mint a code
  // without a proper key. Existing stored codes still verify against their
  // stored value (letterCodeMatches compares stored vs submitted, not recomputed).
  if (!key) throw new Error("HRM_LETTER_KEY (or HRM_MFA_KEY) must be configured to issue letter verification codes")
  return key
}

/** Deterministic 12-hex-char code for a letter row: "A1B2-C3D4-E5F6". */
export function letterVerificationCode(letter: { vendorId: string; id: string; letterNumber: string }): string {
  const mac = crypto.createHmac("sha256", letterVerifyKey())
    .update(`${letter.vendorId}:${letter.id}:${letter.letterNumber}`)
    .digest("hex")
  return (mac.slice(0, 12).toUpperCase().match(/.{1,4}/g) || []).join("-")
}

/** Constant-time comparison of a submitted code against a stored one. */
export function letterCodeMatches(stored: string | null | undefined, submitted: string): boolean {
  if (!stored || !submitted) return false
  const a = Buffer.from(stored.trim().toUpperCase())
  const b = Buffer.from(submitted.trim().toUpperCase())
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- LTR-01 (R7) — employee-initiated letter requests ----------
// Employees request salary certificates / experience letters / NOCs from ESS;
// HR approves (a letter is generated from the active template and linked —
// the normal submit/issue workflow then applies) or rejects with a note.
const REQUESTABLE_LETTER_TYPES = ["SALARY_CERT", "EXPERIENCE", "EMPLOYMENT_CERT", "NOC"]

// INTENTIONALLY_SELF_SCOPED (M-02 / LTR-01 R7): the caller's OWN letter
// requests — create (whitelisted types) + list, nothing else.
route("ess.letterRequests", {
  handler: async (ctx, p) => {
    if (!ctx.employeeId) throw new Deny("Your account has no linked employee profile", 400)
    if (p?.type) {
      // create — a request per type while one is still PENDING is a duplicate
      if (!REQUESTABLE_LETTER_TYPES.includes(p.type)) {
        throw new Deny("This letter type cannot be self-requested — contact HR", 400)
      }
      const dup = await db.letterRequest.findFirst({
        where: { vendorId: ctx.vendorId, employeeId: ctx.employeeId, type: p.type, status: "PENDING" },
      })
      if (dup) throw new Deny(`You already have a pending ${p.type.replace(/_/g, " ").toLowerCase()} request (${new Date(dup.createdAt).toLocaleDateString()})`, 409)
      const rec = await db.letterRequest.create({
        data: {
          vendorId: ctx.vendorId, employeeId: ctx.employeeId, requestedBy: ctx.userId,
          type: p.type, reason: p.reason ? String(p.reason).slice(0, 500) : null, status: "PENDING",
        },
      })
      const emp = await db.employee.findUnique({ where: { id: ctx.employeeId } })
      await audit(ctx, "ess.letterRequests", "LetterRequest", rec.id, `Requested a ${p.type} letter`)
      // HR gets an actionable notification
      await notify(ctx.vendorId, { role: "HR_ADMIN" }, "Letter Request",
        `${emp?.fullName || "An employee"} requested a ${p.type.replace(/_/g, " ").toLowerCase()}. Review it in HR Letters → Requests.`, "LETTER", "documents")
      return rec
    }
    const rows = await db.letterRequest.findMany({
      where: { vendorId: ctx.vendorId, employeeId: ctx.employeeId },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    const letterIds = [...new Set(rows.map((r) => r.letterId).filter((x): x is string => !!x))]
    const letters = letterIds.length
      ? await db.hrLetter.findMany({ where: { vendorId: ctx.vendorId, id: { in: letterIds } }, select: { id: true, letterNumber: true, status: true, issuedAt: true } })
      : []
    const letterById = new Map(letters.map((l) => [l.id, l]))
    return rows.map((r) => ({
      ...r,
      letterNumber: r.letterId ? letterById.get(r.letterId)?.letterNumber : null,
      letterStatus: r.letterId ? letterById.get(r.letterId)?.status : null,
    }))
  },
})

route("letters.requests.list", {
  perm: ["letters", "view"],
  handler: async (ctx, p) => {
    const where: any = { vendorId: ctx.vendorId, ...await scopedEmployeeWhere(ctx, p) }
    if (p?.status) where.status = p.status
    const rows = await db.letterRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 })
    const empIds = [...new Set(rows.map((r) => r.employeeId))]
    const employees = empIds.length
      ? await db.employee.findMany({ where: { vendorId: ctx.vendorId, id: { in: empIds } }, select: { id: true, fullName: true, code: true } })
      : []
    const empById = new Map(employees.map((e) => [e.id, e]))
    return rows.map((r) => ({ ...r, employeeName: empById.get(r.employeeId)?.fullName || "—", employeeCode: empById.get(r.employeeId)?.code }))
  },
})

route("letters.requests.decide", {
  perm: ["letters", "generate"],
  handler: async (ctx, p) => {
    const req = await db.letterRequest.findFirst({ where: { id: p.id, vendorId: ctx.vendorId, status: "PENDING" } })
    if (!req) throw new Deny("Pending letter request not found", 404)
    const emp = await db.employee.findUnique({ where: { id: req.employeeId } })
    if (!emp) throw new Deny("Employee not found", 404)

    if (p.decision === "REJECT") {
      await db.letterRequest.update({
        where: { id: req.id },
        data: { status: "REJECTED", decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: p.note ? String(p.note).slice(0, 500) : null },
      })
      await audit(ctx, "letters.requests.decide", "LetterRequest", req.id, `Rejected ${req.type} request for ${emp.fullName}`)
      await notify(ctx.vendorId, { employeeId: emp.id }, "Letter Request Rejected",
        `Your ${req.type.replace(/_/g, " ").toLowerCase()} request was rejected${p.note ? `: ${String(p.note).slice(0, 200)}` : ""}.`, "LETTER", "ess")
      return { ok: true, status: "REJECTED" }
    }

    // APPROVE → generate the letter from the active template (same flow as
    // letters.generate) and link it back; the request is FULFILLED once the
    // draft exists. HR then submits/issues it through the normal workflow.
    const template = await db.letterTemplate.findFirst({ where: { vendorId: ctx.vendorId, type: req.type, active: true } })
    if (!template) throw new Deny(`No active ${req.type} template — create one in Settings → Templates first`, 400)
    const structure = await db.salaryStructure.findFirst({ where: { employeeId: emp.id, status: "ACTIVE" } })
    const extra: Record<string, string> = {}
    if (structure) {
      extra.basic_salary = structure.basic.toLocaleString("en-IN")
      extra.salary = structure.gross.toLocaleString("en-IN")
      extra.gross_salary = structure.gross.toLocaleString("en-IN")
    }
    const vendor = await db.vendor.findUnique({ where: { id: ctx.vendorId } })
    const branch = emp.branchId ? await db.branch.findFirst({ where: { id: emp.branchId } }) : null
    const dept = emp.departmentId ? await db.department.findFirst({ where: { id: emp.departmentId } }) : null
    const desig = emp.designationId ? await db.designation.findFirst({ where: { id: emp.designationId } }) : null
    const vars = buildVars({ ...emp, designationName: desig?.name, departmentName: dept?.name, branchName: branch?.name }, extra, vendor?.name || "Company")
    const content = await renderTemplate(template.body, vars)
    const letterNumber = await nextFormattedSeq(ctx.vendorId, `letters:${new Date().getFullYear()}`,
      (n) => `L-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`)
    const letter = await db.hrLetter.create({
      data: {
        vendorId: ctx.vendorId, employeeId: emp.id, type: template.type, templateId: template.id,
        letterNumber, subject: template.subject, content,
        signatoryName: template.signatoryName || vendor?.name, status: "DRAFT",
        dataJson: JSON.stringify({ vars, extra, sourceRequest: req.id, reason: req.reason }),
        createdBy: ctx.userId,
      },
    })
    await db.letterRequest.update({
      where: { id: req.id },
      data: { status: "FULFILLED", decidedBy: ctx.userId, decidedAt: new Date(), letterId: letter.id, decisionNote: p.note ? String(p.note).slice(0, 500) : null },
    })
    await audit(ctx, "letters.requests.decide", "LetterRequest", req.id, `Approved ${req.type} request for ${emp.fullName} → draft ${letterNumber} created`)
    await notify(ctx.vendorId, { employeeId: emp.id }, "Letter Request Approved",
      `Your ${req.type.replace(/_/g, " ").toLowerCase()} request was approved — the letter (${letterNumber}) is being prepared.`, "LETTER", "ess")
    return { ok: true, status: "FULFILLED", letterId: letter.id, letterNumber }
  },
})

// INTENTIONALLY_SELF_SCOPED (M-02 / HRM-001, re-ported R3-2): ESS employees
// download their OWN ISSUED letters without holding letters.download (the
// perm gate 403'd the ESS button for every standard EMPLOYEE). Holders keep
// the manager path; everyone else is limited to their own ISSUED letters
// (ess.documents' listing rule). The fix was present in the round-2
// remediated tree and lost in the v3 branch — this is the re-port.
// INTENTIONALLY_SELF_SCOPED (M-02): HRM-001 re-port — holders keep the letters.download path; everyone else is scoped to their OWN ISSUED letters only.
route("letters.download", {
  handler: async (ctx, p) => {
    const letter = await db.hrLetter.findFirst({ where: { id: p.id, vendorId: ctx.vendorId } })
    if (!letter) throw new Deny("Letter not found", 404)
    // Preserve the dispatcher-level gates this action used to inherit from its
    // perm key: the per-tenant "letters" module override still applies to the
    // privileged path, and the ESS feature gate to the self-service path.
    const ent = await resolveEntitlements(ctx.vendorId)
    if (featureBlocked(ent, "letters")) {
      throw new Deny("HR Letters is not included in your current plan. Contact your platform administrator to upgrade.", 403)
    }
    const privileged = can(ctx, "letters", "download")
    if (privileged) {
      if (SENSITIVE_LETTER_TYPES.includes(letter.type) && !p.reason) {
        throw new Deny(`A reason is required to download a ${letter.type.replace("_", " ").toLowerCase()} letter`)
      }
    } else {
      // HRM-001 — self-scoped branch: own record only, ISSUED only. The ESS
      // listing plane (ess.documents) is gated on the ESS feature, so the
      // self-download branch honors the same gate.
      if (featureBlocked(ent, "ess")) {
        throw new Deny("Employee Self-Service is not included in your current plan. Contact your platform administrator to upgrade.", 403)
      }
      if (letter.employeeId !== ctx.employeeId) {
        throw new Deny("You can only download your own letters", 403)
      }
      if (letter.status !== "ISSUED") {
        throw new Deny("Only letters issued to you are available for download — drafts and pending approvals are not", 403)
      }
    }
    const emp = await db.employee.findUnique({ where: { id: letter.employeeId } })
    const html = await buildLetterHtml(ctx.vendorId, letter)
    await db.hrLetter.update({ where: { id: letter.id }, data: { downloadCount: { increment: 1 } } })
    await audit(ctx, "letters.download", "HrLetter", letter.id, `Downloaded letter ${letter.letterNumber}${privileged ? "" : " (self-service, own record)"}`, { reason: p.reason })
    return { html, letterNumber: letter.letterNumber, employeeName: emp?.fullName }
  },
})
