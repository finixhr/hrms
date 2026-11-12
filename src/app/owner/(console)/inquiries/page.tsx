"use client"
// ============ /owner/inquiries — contact-form inbox (§36) ============
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, PageHeader, StatusChip, TableShell, Td, fmtDateTime, Loading } from "@/saas/owner/ui"

type Row = {
  id: string; name: string; email: string; phone: string | null; company: string | null
  inquiryType: string; organizationSize: string | null; modulesRequested: string[]
  message: string; status: string; createdAt: string
  handleNote: string | null; handledByName: string | null; handledAt: string | null
}

export default function InquiriesPage() {
  const [status, setStatus] = useState("ALL")
  const [search, setSearch] = useState("")
  const { data, loading, error, reload } = useOwnerApi<{ rows: Row[]; total: number }>(
    "owner.inquiries.list", { status, search: search || undefined, page: 1, pageSize: 100 }, [status, search]
  )
  const [selected, setSelected] = useState<Row | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const handle = async (newStatus: "IN_REVIEW" | "RESPONDED" | "CLOSED") => {
    if (!selected) return
    setBusy(true)
    try {
      await ownerRpc("owner.inquiries.handle", { id: selected.id, status: newStatus, note: note || undefined })
      setSelected(null); setNote("")
      await reload()
    } catch (e: any) { alert(e?.message || "Failed") } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Contact Inquiries" sub="Sales and support messages from the public website, stored in the platform database." />
      <div className="flex items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, company…" className="h-10 w-64 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-10 w-44 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["ALL", "NEW", "IN_REVIEW", "RESPONDED", "CLOSED"].map((s) => <SelectItem key={s} value={s}>{s === "ALL" ? "All" : s.replace("_", " ")}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-slate-500">{data ? `${data.total}` : ""}</span>
      </div>
      {error && <ErrorBanner message={error} />}
      {loading ? <Loading /> : (
        <TableShell headers={["From", "Type", "Size", "Modules", "Message", "Status", "Received", ""]} empty={data?.rows.length === 0}>
          {data?.rows.map((r) => (
            <tr key={r.id} className="cursor-pointer transition-colors hover:bg-white/[0.03] light:hover:bg-slate-100/60" onClick={() => { setSelected(r); setNote(r.handleNote || "") }}>
              <Td>
                <span className="font-medium text-white light:text-slate-900">{r.name}</span>
                <span className="block text-xs text-slate-500">{r.email}{r.company ? ` · ${r.company}` : ""}</span>
              </Td>
              <Td className="text-xs">{r.inquiryType.toLowerCase()}</Td>
              <Td className="text-xs">{r.organizationSize || "—"}</Td>
              <Td className="max-w-40 truncate text-xs text-slate-500">{r.modulesRequested.join(", ") || "—"}</Td>
              <Td className="max-w-72 truncate text-xs">{r.message}</Td>
              <Td><StatusChip status={r.status === "NEW" ? "PENDING" : r.status === "CLOSED" ? "CANCELLED" : "UNDER_REVIEW"} /></Td>
              <Td className="text-xs">{fmtDateTime(r.createdAt)}</Td>
              <Td><span className="text-xs text-indigo-300 light:text-indigo-700">open →</span></Td>
            </tr>
          ))}
        </TableShell>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 light:bg-black/30 p-4" onClick={() => setSelected(null)}>
          <div className="max-h-[80dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50 p-6" onClick={(e) => e.stopPropagation()}>
            <p className="text-lg font-bold text-white light:text-slate-900">{selected.name}</p>
            <p className="text-xs text-slate-500">{selected.email} · {selected.company || "no company"} · {fmtDateTime(selected.createdAt)}</p>
            <p className="mt-4 whitespace-pre-wrap rounded-xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-4 text-sm leading-relaxed text-slate-300 light:text-slate-700">{selected.message}</p>
            {selected.modulesRequested.length > 0 && (
              <p className="mt-3 text-xs text-slate-400 light:text-slate-600">Interested in: {selected.modulesRequested.join(", ")}</p>
            )}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Handling note (audited)…" className="mt-4 bg-white/5 light:bg-slate-100 border-white/10 light:border-slate-200" />
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setSelected(null)} className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Close</Button>
              <Button disabled={busy} onClick={() => handle("IN_REVIEW")} variant="outline" className="border-blue-400/30 bg-blue-500/10 text-blue-300 light:text-blue-700">In review</Button>
              <Button disabled={busy} onClick={() => handle("RESPONDED")} variant="outline" className="border-emerald-400/30 bg-emerald-500/10 text-emerald-300 light:text-emerald-700">Responded</Button>
              <Button disabled={busy} onClick={() => handle("CLOSED")} className="bg-white/10 light:bg-slate-200 text-white light:text-slate-900 hover:bg-white/20 light:hover:bg-slate-300">Mark closed</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
