"use client"
// ============ HR Letters: 3-step letter issuance + issued register ============
// 2026-10 restructure — renamed from "Letters & Templates"; the Templates tab
// moved to HR Settings → Templates → Letter Templates (shared/letter-templates-tab.tsx).
// Letter flow: generate (DRAFT) → submit (PREPARED/APPROVED) → issue (ISSUED) → download/print.
import { useState } from "react"
import {
  FileSignature, Search, Send, Printer, RotateCcw, Check, Clock, Stamp, Ban, UserRound, Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useHrm } from "../store"
import { useApi, rpc, useEmployeeDirectory } from "../api"
import { PageHeader, StatusBadge, fmtDate, titleCase, SectionTabs, SectionCard, EmptyState, LoadingRows , openPrintWindow } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"

// Types that always go through the approval workflow (server-side rule, spec §13.5)
const MANDATORY_APPROVAL_TYPES = ["APPOINTMENT", "CONFIRMATION", "PROBATION_EXT", "INCREMENT", "PROMOTION", "TRANSFER", "WARNING", "SUSPENSION", "TERMINATION"]
const DELIVERY_METHODS = ["PORTAL", "EMAIL", "PRINT"]

export default function DocumentsView() {
  const presetTab = useHrm((s) => (s.view?.key === "documents" && s.view?.params?.tab) || undefined)
  return (
    <div className="space-y-4">
      <PageHeader title="HR Letters" subtitle="Generate official letters from templates with the approval workflow, issuance and print-ready downloads — templates are managed in HR Settings → Templates" />
      <SectionTabs defaultValue={presetTab as string | undefined} tabs={[
        { value: "requests", label: "Requests", content: <LetterRequestsTab /> },
        { value: "issue", label: "Issue Letter", content: <IssueLetterTab /> },
        { value: "issued", label: "Issued Letters", content: <IssuedLettersTab /> },
      ]} />
    </div>
  )
}

// ================= ISSUE LETTER (3-step flow) =================
function IssueLetterTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const vendor = useHrm((s) => s.vendor)
  const { data: employees, loading: empLoading } = useEmployeeDirectory()
  const { data: templates, loading: tplLoading } = useApi<any[]>("templates.list", {})
  const [step, setStep] = useState(1)
  const [q, setQ] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [templateId, setTemplateId] = useState("")
  const [effectiveDate, setEffectiveDate] = useState("")
  const [letter, setLetter] = useState<any>(null)
  const [deliveryMethod, setDeliveryMethod] = useState("PORTAL")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const employee = (employees || []).find((e: any) => e.id === employeeId)
  const template = (templates || []).find((t: any) => t.id === templateId)
  const filteredEmployees = (employees || []).filter((e) =>
    !q || `${e.fullName} ${e.code} ${e.designationName || ""} ${e.departmentName || ""}`.toLowerCase().includes(q.toLowerCase())
  )

  const goto = (n: number) => {
    if (n === 1) setStep(1)
    else if (n === 2 && employeeId) setStep(2)
    else if (n === 3 && employeeId && templateId) setStep(3)
  }

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      const rec = await rpc("letters.generate", { employeeId, templateId, effectiveDate: effectiveDate || undefined })
      setLetter(rec)
      toast(`Letter ${rec.letterNumber} generated as draft`)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const submitForApproval = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc("letters.submit", { id: letter.id })
      const needsApproval = template ? template.requiresApproval !== false && MANDATORY_APPROVAL_TYPES.includes(letter.type) : true
      setLetter({ ...letter, status: needsApproval ? "PREPARED" : "APPROVED" })
      toast(needsApproval ? "Letter submitted for approval" : "Letter approved — approval not required for this type")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const issue = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc("letters.issue", { id: letter.id, deliveryMethod })
      setLetter({ ...letter, status: "ISSUED", deliveryMethod })
      toast(`Letter ${letter.letterNumber} issued via ${titleCase(deliveryMethod)}`)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const print = async () => {
    await downloadLetterWithReason(letter, toast)
  }

  const reset = () => {
    setStep(1)
    setQ("")
    setEmployeeId("")
    setTemplateId("")
    setEffectiveDate("")
    setLetter(null)
    setDeliveryMethod("PORTAL")
    setError(null)
  }

  const steps = [
    { n: 1, title: "Select Employee", hint: "Choose the recipient" },
    { n: 2, title: "Select Template", hint: "Template & effective date" },
    { n: 3, title: "Preview & Generate", hint: "Render, submit, issue" },
  ]

  return (
    <div className="space-y-4">
      {/* step indicator */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {steps.map((s) => {
          const active = step === s.n
          const done = (s.n === 1 && (step > 1 || !!employeeId)) || (s.n === 2 && (step > 2 || !!templateId)) || (s.n === 3 && !!letter)
          return (
            <button key={s.n} onClick={() => goto(s.n)}
              className={`text-left rounded-xl border p-3 transition-all ${active ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 ring-1 ring-emerald-500" : done ? "border-emerald-200 dark:border-emerald-900 bg-white dark:bg-slate-900 hover:border-emerald-400" : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 opacity-70"}`}>
              <div className="flex items-center gap-2">
                <span className={`h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${active ? "bg-primary text-primary-foreground" : done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                  {done && !active ? <Check className="h-3.5 w-3.5" /> : s.n}
                </span>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{s.title}</p>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate">{s.hint}</p>
            </button>
          )
        })}
      </div>

      <SectionCard title={step === 1 ? "Step 1 — Select Employee" : step === 2 ? "Step 2 — Select Template & Effective Date" : "Step 3 — Preview & Generate"}>
        {/* ---------------- STEP 1 ---------------- */}
        {step === 1 && (
          <div className="space-y-3">
            <div className="relative max-w-xs">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, department…" className="pl-8 h-9" />
            </div>
            {empLoading ? (
              <LoadingRows rows={3} />
            ) : filteredEmployees.length === 0 ? (
              <EmptyState icon={UserRound} title="No employees found" hint="Adjust the search to find the letter recipient." />
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-80 overflow-y-auto pr-1">
                {filteredEmployees.map((e: any) => (
                  <button key={e.id} onClick={() => setEmployeeId(e.id)}
                    className={`text-left rounded-lg border p-3 transition-all ${employeeId === e.id ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 ring-1 ring-emerald-500" : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-emerald-300"}`}>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{e.fullName}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{e.code} · {e.designationName || "—"} · {e.departmentName || "—"}</p>
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button size="sm" disabled={!employeeId} onClick={() => setStep(2)} className="h-8 ">Continue →</Button>
            </div>
          </div>
        )}

        {/* ---------------- STEP 2 ---------------- */}
        {step === 2 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2">
              <UserRound className="h-3.5 w-3.5 text-emerald-600" />
              <p className="text-xs text-slate-700 dark:text-slate-200">
                <span className="font-semibold">{employee?.fullName}</span> ({employee?.code}) · {employee?.designationName || "—"} · {employee?.departmentName || "—"}
              </p>
              <button onClick={() => setStep(1)} className="ml-auto text-xs text-emerald-700 dark:text-emerald-400 underline">Change</button>
            </div>
            {tplLoading ? (
              <LoadingRows rows={3} />
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto pr-1">
                {(templates || []).map((t: any) => (
                  <button key={t.id} onClick={() => setTemplateId(t.id)}
                    className={`text-left rounded-lg border p-3 transition-all ${templateId === t.id ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 ring-1 ring-emerald-500" : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-emerald-300"}`}>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{t.name}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <Badge variant="outline" className="text-[9px]">{titleCase(t.type)}</Badge>
                      {t.requiresApproval !== false && <span>· approval</span>}
                      {t.active === false && <span className="text-amber-600">· inactive</span>}
                    </p>
                  </button>
                ))}
                {(templates || []).length === 0 && <EmptyState icon={FileSignature} title="No templates" hint="Create a template first under HR Settings → Templates → Letter Templates." />}
              </div>
            )}
            <div className="max-w-xs space-y-1.5">
              <Label className="text-xs font-medium">Effective Date (optional)</Label>
              <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className="h-9" />
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Renders as {"{{effective_date}}"} — used by increment, promotion & transfer letters.</p>
            </div>
            <div className="flex justify-between">
              <Button size="sm" variant="outline" onClick={() => setStep(1)} className="h-8 text-xs">← Back</Button>
              <Button size="sm" disabled={!templateId} onClick={() => setStep(3)} className="h-8 ">Continue →</Button>
            </div>
          </div>
        )}

        {/* ---------------- STEP 3 ---------------- */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 rounded-lg border px-3 py-2">
              <span>Employee: <b className="text-slate-700 dark:text-slate-200">{employee?.fullName}</b></span>
              <span>Template: <b className="text-slate-700 dark:text-slate-200">{template?.name}</b></span>
              <span>Type: <b className="text-slate-700 dark:text-slate-200">{titleCase(template?.type)}</b></span>
              <span>Effective: <b className="text-slate-700 dark:text-slate-200">{effectiveDate ? fmtDate(effectiveDate) : "—"}</b></span>
            </div>

            {!letter ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <FileSignature className="h-10 w-10 text-slate-300 dark:text-slate-600" />
                {can("letters", "generate") ? (
                  <>
                    <Button onClick={generate} disabled={busy}>
                      <FileSignature className="h-4 w-4 mr-1.5" /> {busy ? "Generating…" : "Generate Letter"}
                    </Button>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Generates a DRAFT letter with variables rendered from the employee record.</p>
                  </>
                ) : (
                  <p className="text-xs text-amber-600">You don&apos;t have permission to generate letters (letters.generate required).</p>
                )}
              </div>
            ) : (
              <>
                {/* paper preview */}
                <div className="rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white p-6 sm:p-10 max-w-2xl mx-auto shadow-sm"
                  style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
                  <div className="text-center border-b-[3px] border-double border-emerald-600 pb-3 mb-5">
                    <p className="text-xl font-bold text-emerald-800 tracking-wide">{vendor?.name || "Company"}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: "Arial, sans-serif" }}>Human Resources Department</p>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-500 mb-4">
                    <span>Ref: {letter.letterNumber}</span>
                    <span>Date: {fmtDate(letter.createdAt)}</span>
                  </div>
                  <p className="text-sm font-bold text-slate-800 mb-3">{letter.subject}</p>
                  <p className="text-[13px] leading-[1.9] text-slate-800 whitespace-pre-wrap">{letter.content}</p>
                  <div className="mt-12">
                    <p className="text-slate-400">______________________</p>
                    <p className="text-sm font-bold text-slate-800">{letter.signatoryName || vendor?.name}</p>
                    <p className="text-[11px] text-slate-500">Authorized Signatory</p>
                  </div>
                </div>

                {/* actions */}
                <div className="flex flex-wrap items-center gap-2 justify-center">
                  {letter.status === "DRAFT" && (
                    <>
                      <Badge variant="outline" className="text-[10px] text-emerald-700 border-emerald-300">✓ Saved as Draft ({letter.letterNumber})</Badge>
                      {can("letters", "generate") && (
                        <Button onClick={submitForApproval} disabled={busy}>
                          <Send className="h-3.5 w-3.5 mr-1" /> {busy ? "Submitting…" : "Submit for Approval"}
                        </Button>
                      )}
                    </>
                  )}
                  {letter.status === "PREPARED" && (
                    <p className="text-xs text-amber-600 flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" /> Awaiting approval — track the request in the Approvals module.
                    </p>
                  )}
                  {letter.status === "APPROVED" && can("letters", "generate") && (
                    <>
                      <Select value={deliveryMethod} onValueChange={setDeliveryMethod}>
                        <SelectTrigger className="w-36 h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {DELIVERY_METHODS.map((m) => <SelectItem key={m} value={m}>{titleCase(m)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button onClick={issue} disabled={busy}>
                        <Stamp className="h-3.5 w-3.5 mr-1" /> {busy ? "Issuing…" : "Issue Letter"}
                      </Button>
                    </>
                  )}
                  {letter.status === "ISSUED" && (
                    <Badge className="bg-emerald-100 text-emerald-700 gap-1">
                      <Check className="h-3 w-3" /> Issued via {titleCase(letter.deliveryMethod || deliveryMethod)}
                    </Badge>
                  )}
                  {letter.status === "REJECTED" && (
                    <Badge className="bg-rose-100 text-rose-700 gap-1"><Ban className="h-3 w-3" /> Rejected</Badge>
                  )}
                  {can("letters", "download") && (
                    <Button variant="outline" onClick={print} className="h-9 text-xs">
                      <Printer className="h-3.5 w-3.5 mr-1" /> View / Print
                    </Button>
                  )}
                  <Button variant="outline" onClick={reset} className="h-9 text-xs">
                    <RotateCcw className="h-3.5 w-3.5 mr-1" /> Start New Letter
                  </Button>
                </div>

                {letter.status === "DRAFT" && MANDATORY_APPROVAL_TYPES.includes(letter.type) && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center">
                    Mandatory approval: Appointment, Increment, Promotion, Termination, Warning, Suspension.
                  </p>
                )}
              </>
            )}

            {error && <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950 rounded-md px-3 py-2 text-center">{error}</p>}
            <div className="flex justify-start">
              <Button size="sm" variant="outline" onClick={() => setStep(2)} className="h-8 text-xs">← Back</Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// Sensitive letter classes require an audited reason on download (spec §13.4)
const SENSITIVE_LETTER_TYPES = ["TERMINATION", "SUSPENSION", "WARNING", "SHOW_CAUSE"]

/** Download a letter — prompts for a reason on sensitive classes (spec §13.4). */
async function downloadLetterWithReason(l: any, toast: (t: string, k?: "ok" | "err") => void): Promise<void> {
  let reason: string | undefined
  if (SENSITIVE_LETTER_TYPES.includes(l.type)) {
    reason = window.prompt(`This is a sensitive ${titleCase(l.type)} letter. Enter the reason for this access (audit-logged):`) || undefined
    if (!reason) { toast("A reason is required to open a sensitive letter", "err"); return }
  }
  try {
    const res = await rpc("letters.download", { id: l.id, reason })
    const w = openPrintWindow(res.html)
    if (!w) toast("Popup blocked — allow popups to view the letter", "err")
  } catch (e: any) {
    toast(e.message, "err")
  }
}

// ================= ISSUED LETTERS =================
function IssuedLettersTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [status, setStatus] = useState("")
  const { data, loading, error, reload: _reload } = useApi<any[]>("letters.list", { status })

  const viewLetter = async (l: any) => downloadLetterWithReason(l, toast)

  const columns: Column<any>[] = [
    {
      key: "letterNumber", label: "Letter No", sortValue: (l) => l.letterNumber,
      render: (l) => (
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 tabular-nums">{l.letterNumber}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{fmtDate(l.createdAt)}</p>
        </div>
      ),
    },
    { key: "employeeName", label: "Employee", render: (l) => <div><p className="text-sm text-slate-800 dark:text-slate-100">{l.employeeName}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{l.employeeCode}</p></div> },
    { key: "type", label: "Type", sortValue: (l) => l.type, render: (l) => <Badge variant="outline" className="text-[10px]">{titleCase(l.type)}</Badge> },
    { key: "status", label: "Status", render: (l) => <StatusBadge status={l.status} /> },
    { key: "issuedAt", label: "Issued", sortValue: (l) => l.issuedAt || "", render: (l) => <span className="text-xs text-slate-500">{l.issuedAt ? fmtDate(l.issuedAt) : "—"}</span> },
    { key: "deliveryMethod", label: "Delivery", render: (l) => <span className="text-xs text-slate-600 dark:text-slate-300">{l.deliveryMethod ? titleCase(l.deliveryMethod) : "—"}</span> },
    // LTR-02 (R7) — printed verification code + public verify pointer
    { key: "verificationCode", label: "Verify code", render: (l) => l.verificationCode
      ? <span className="text-[11px] font-mono font-semibold text-emerald-700 dark:text-emerald-400 tracking-wider" title="Printed on the letter — verifiable at /verify/letter">{l.verificationCode}</span>
      : <span className="text-[11px] text-slate-400">{l.status === "ISSUED" ? "—" : "on issue"}</span> },
    { key: "downloadCount", label: "Downloads", align: "right", sortValue: (l) => l.downloadCount || 0, render: (l) => <span className="text-xs tabular-nums text-slate-500">{l.downloadCount || 0}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (l) => can("letters", "download") && (
        <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={(ev) => { ev.stopPropagation(); viewLetter(l) }}>
          <Printer className="h-3 w-3 mr-1" /> View / Print
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip label="All" active={!status} onClick={() => setStatus("")} />
        {["DRAFT", "PREPARED", "APPROVED", "ISSUED", "REJECTED"].map((s) => (
          <Chip key={s} label={titleCase(s)} active={status === s} onClick={() => setStatus(status === s ? "" : s)} />
        ))}
      </div>
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} csvName="hr-letters"
        searchPlaceholder="Search letter no, employee…" emptyTitle="No letters" emptyHint="Generate letters from the Issue Letter tab." />
      <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
        <Clock className="h-3 w-3" /> Flow: DRAFT → PREPARED → APPROVED → ISSUED. Viewing/printing is audit-logged.
      </p>
    </div>
  )
}

// ================= LETTER REQUESTS (LTR-01 R7) =================
/** Employee-initiated letter requests: approve (a letter draft is generated
 *  from the active template and the normal submit/issue flow takes over) or
 *  reject with a note. */
function LetterRequestsTab() {
  const { can } = useHrm()
  const toast = useHrm((s) => s.toast)
  const [status, setStatus] = useState("PENDING")
  const { data, loading, error, reload } = useApi<any[]>("letters.requests.list", { status: status || undefined })
  const [busy, setBusy] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState("")

  const decide = async (r: any, decision: "APPROVE" | "REJECT") => {
    setBusy(r.id)
    try {
      const res = await rpc<any>("letters.requests.decide", { id: r.id, decision, note: note || undefined })
      toast(decision === "APPROVE" ? `Request approved — draft ${res.letterNumber} created. Review and issue it from the Issued Letters tab.` : "Request rejected — the employee has been notified.", "ok")
      setNoteFor(null); setNote("")
      await reload()
    } catch (e: any) { toast(e.message || "Could not decide", "err") }
    finally { setBusy(null) }
  }

  const columns: Column<any>[] = [
    {
      key: "employeeName", label: "Employee", sortValue: (r) => r.employeeName,
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.employeeName}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.employeeCode} · requested {fmtDate(r.createdAt)}</p>
        </div>
      ),
    },
    { key: "type", label: "Letter", render: (r) => <Badge variant="outline" className="text-[10px]">{titleCase(r.type.replace(/_/g, " "))}</Badge> },
    { key: "reason", label: "Reason", render: (r) => <span className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 max-w-[260px]">{r.reason || "—"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "letterNumber", label: "Generated", render: (r) => r.letterNumber ? <span className="text-xs font-mono text-emerald-700 dark:text-emerald-400">{r.letterNumber}</span> : <span className="text-xs text-slate-400">—</span> },
    { key: "decisionNote", label: "Decision note", render: (r) => <span className="text-xs text-slate-500 line-clamp-1 max-w-[180px]">{r.decisionNote || "—"}</span> },
    {
      key: "actions", label: "", align: "right",
      render: (r) => r.status === "PENDING" && can("letters", "generate") && (
        <div className="flex items-center justify-end gap-1.5">
          {noteFor === r.id ? (
            <>
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the employee"
                className="h-7 w-44 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 text-xs" />
              <Button size="sm" className="h-7 text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busy === r.id} onClick={() => decide(r, "APPROVE")}>
                {busy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Approve"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[10px] text-rose-600 border-rose-200 hover:bg-rose-50" disabled={busy === r.id} onClick={() => decide(r, "REJECT")}>
                Reject
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={busy === r.id} onClick={() => { setNoteFor(r.id); setNote("") }}>
              Review request
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip label="Pending" active={status === "PENDING"} onClick={() => setStatus("PENDING")} />
        <Chip label="All" active={!status} onClick={() => setStatus("")} />
        {["FULFILLED", "REJECTED"].map((st) => (
          <Chip key={st} label={titleCase(st)} active={status === st} onClick={() => setStatus(status === st ? "" : st)} />
        ))}
      </div>
      <DataTable columns={columns} rows={data ?? undefined} loading={loading} error={error} csvName="letter-requests"
        searchPlaceholder="Search employee…" emptyTitle={status === "PENDING" ? "No pending requests" : "No letter requests"}
        emptyHint={status === "PENDING" ? "Employee-initiated requests (salary certificates, experience letters, NOCs) from the ESS portal appear here." : "Requests employees submit from My Documents → Request a Letter appear here."} />
      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        Approving a request generates a DRAFT letter from the active template — submit and issue it from the Issued Letters tab as usual.
      </p>
    </div>
  )
}

function Chip({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`h-7 rounded-full px-3 text-xs font-medium border transition-colors ${active ? "bg-primary text-primary-foreground border-primary" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400"}`}>
      {label}
    </button>
  )
}
