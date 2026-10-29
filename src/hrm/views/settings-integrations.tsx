"use client"
// ============ Settings → Integrations: API keys + webhooks (Wave 4 SG-E) ====
// Standalone component wired into the Settings view by main (do NOT edit
// settings.tsx from here). Two tabs:
//   API Keys — public REST API explainer, key table, create dialog, ONE-TIME
//              raw key display, revoke-with-typed-prefix confirm.
//   Webhooks — endpoint table (active switch, test ping), save dialog with
//              event checkboxes, ONE-TIME signing secret display, delivery
//              history (latest 20).
// Secrets shown once, immediately after creation — never re-displayable.
import { useState } from "react"
import {
  KeyRound, Webhook, Plus, Pencil, Trash2, Copy, CheckCircle2, Send,
  AlertTriangle, RefreshCw, ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useHrm } from "../store"
import { useApi, rpc } from "../api"
import { SectionTabs, SectionCard, fmtDateTime, FieldError } from "../shared/ui-kit"
import { DataTable, type Column } from "../shared/data-table"
import { FormDialog, ConfirmDialog, type FieldDef } from "../shared/form-dialog"

type KeyRow = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt?: string | null
  createdByName?: string | null
  createdAt: string
}

type EndpointRow = {
  id: string
  url: string
  events: string[]
  hasSecret: boolean
  active: boolean
  description?: string | null
  lastStatus?: string | null
  lastDeliveredAt?: string | null
  createdAt: string
}

type DeliveryRow = {
  id: string
  endpointId: string
  event: string
  status: string
  responseStatus?: number | null
  responseBody?: string | null
  attempts: number
  createdAt: string
}

/** Delivery/endpoint status chip (local twin of StatusBadge — DELIVERED and
 *  FAILED have no entry in the shared STATUS_COLORS map). */
function DeliveryBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
  const cls =
    status === "DELIVERED" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
    : status === "FAILED" ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
    : status === "PENDING" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
  return (
    <Badge variant="secondary" className={`font-medium whitespace-nowrap gap-1.5 ${cls}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80 shrink-0" />
      {status === "DELIVERED" ? "Delivered" : status === "FAILED" ? "Failed" : status === "PENDING" ? "Pending" : status}
    </Badge>
  )
}

/** One-time secret/key display — copy now, never shown again. Keyed remount
 *  by the parent so `copied` never leaks across different secrets. */
function SecretOnceDialog({ title, description, secret, caption, note, onClose }: {
  title: string
  description?: string
  secret: string
  caption?: string
  note?: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      // clipboard blocked — the text stays selectable for a manual copy
    }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description && <DialogDescription className="text-xs">{description}</DialogDescription>}
        </DialogHeader>
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300 mb-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Copy now — this value is shown only once and cannot be recovered
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 font-mono text-xs break-all select-all bg-white dark:bg-slate-900 border rounded px-2 py-1.5 text-slate-700 dark:text-slate-200">
              {secret}
            </code>
            <Button size="sm" variant="outline" className="h-9 shrink-0" onClick={copy} aria-label="Copy to clipboard">
              {copied ? <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {caption && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">{caption}</p>}
        </div>
        {note && <p className="text-[11px] text-slate-500 dark:text-slate-400">{note}</p>}
        <DialogFooter className="gap-2">
          <Button onClick={onClose}>I saved it — close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Revoke confirm — the user must TYPE the key prefix (destructive intent). */
function RevokeKeyDialog({ value, onClose, onDone }: { value: KeyRow; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useHrm((s) => s.toast)
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc("integrations.keys.revoke", { id: value.id })
      toast(`API key "${value.name}" revoked`)
      onDone()
    } catch (e: any) {
      setError(e?.message || "Could not revoke the key")
    } finally {
      setBusy(false)
    }
  }
  const matches = typed.trim() === value.prefix
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="text-base">Revoke API key</DialogTitle></DialogHeader>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Revoking <b>{value.name}</b> (<code className="font-mono text-xs">{value.prefix}…</code>) is permanent.
          Requests using it will fail immediately with 401 — there is no un-revoke.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="revoke-prefix" className="text-xs font-medium">
            Type the key prefix to confirm <span className="text-rose-500">*</span>
          </Label>
          <Input
            id="revoke-prefix"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={value.prefix}
            className="font-mono"
            autoComplete="off"
          />
        </div>
        <FieldError message={error} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={go} disabled={busy || !matches}>
            {busy ? "Revoking…" : "Revoke key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ================= API keys tab =================
function ApiKeysTab({ data, loading, error, reload, canCreate, canDelete }: {
  data: { scopes: string[]; keys: KeyRow[] } | null
  loading: boolean
  error: string | null
  reload: () => void
  canCreate: boolean
  canDelete: boolean
}) {
  const [createOpen, setCreateOpen] = useState(false)
  const [onceKey, setOnceKey] = useState<{ key: string; prefix: string; name: string } | null>(null)
  const [revokeKey, setRevokeKey] = useState<KeyRow | null>(null)

  const rows = data?.keys || []
  const scopeOptions = (data?.scopes || []).map((s) => ({ value: s, label: s }))

  const createFields: FieldDef[] = [
    { name: "name", label: "Key name", required: true, placeholder: "e.g. Slack integration", span: 2, help: "Shown in the key list and the audit trail" },
    { name: "scopes", label: "Scopes", type: "multiselect", span: 2, options: scopeOptions, help: "Grant the minimum this integration needs — scopes cannot be edited later (revoke + recreate)" },
  ]

  const columns: Column<KeyRow>[] = [
    {
      key: "name", label: "Name", sortValue: (r) => r.name, render: (r) => (
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{r.name}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{r.createdByName ? `created by ${r.createdByName}` : "created via console"}</p>
        </div>
      ),
    },
    {
      key: "prefix", label: "Key prefix", sortValue: (r) => r.prefix, render: (r) => (
        <code className="font-mono text-xs text-slate-600 dark:text-slate-300">{r.prefix}…</code>
      ),
    },
    {
      key: "scopes", label: "Scopes", searchValue: (r) => r.scopes.join(" "), render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.scopes.map((s) => (
            <Badge key={s} variant="outline" className="text-[10px] font-mono">{s}</Badge>
          ))}
        </div>
      ),
    },
    {
      key: "lastUsedAt", label: "Last used", sortValue: (r) => r.lastUsedAt || "", render: (r) => (
        r.lastUsedAt ? <span className="text-xs">{fmtDateTime(r.lastUsedAt)}</span> : <span className="text-xs text-slate-400 dark:text-slate-500">never</span>
      ),
    },
    { key: "createdAt", label: "Created", sortValue: (r) => r.createdAt, render: (r) => <span className="text-xs">{fmtDateTime(r.createdAt)}</span> },
    {
      key: "actions", label: "", align: "right", render: (r) => canDelete && (
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs text-rose-700 border-rose-200 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-900 dark:hover:bg-rose-950"
          onClick={() => setRevokeKey(r)}>
          <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden /> Revoke
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <SectionCard title={<span className="inline-flex items-center gap-1.5"><KeyRound className="h-4 w-4 text-slate-400" aria-hidden /> Public REST API (v1)</span>}>
        <div className="space-y-3 text-xs text-slate-600 dark:text-slate-300">
          <p>
            Machine-to-machine access to workspace data with a scoped <b>Bearer API key</b>. Keys are stored as a
            SHA-256 hash — the raw key is shown <b>once</b> at creation. Rate limit: 60 requests/minute per key.
          </p>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
            <div><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Scopes</p>
              <div className="flex flex-wrap gap-1">
                {(data?.scopes || []).map((s) => <Badge key={s} variant="outline" className="text-[10px] font-mono">{s}</Badge>)}
              </div>
            </div>
            <div><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Endpoints</p>
              <ul className="space-y-0.5 font-mono text-[11px]">
                <li>GET&nbsp; /api/v1/employees</li>
                <li>GET&nbsp; /api/v1/employees/&#123;id&#125;</li>
                <li>GET&nbsp; /api/v1/attendance</li>
                <li>POST /api/v1/attendance</li>
                <li>GET&nbsp; /api/v1/leave-balances</li>
                <li>POST /api/v1/leave-requests</li>
              </ul>
            </div>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Example</p>
            <pre className="font-mono text-[11px] bg-slate-50 dark:bg-slate-800/60 border rounded-md p-2.5 text-slate-600 dark:text-slate-300 overflow-x-auto">{"curl -s \"https://your-domain/api/v1/employees?page=1&pageSize=50\" \\\n  -H \"Authorization: Bearer fk_YOUR_KEY\""}</pre>
          </div>
        </div>
      </SectionCard>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        searchPlaceholder="Search keys…"
        emptyTitle="No API keys"
        emptyHint={canCreate ? "Create a key to call the REST API from your own tools" : "Ask an administrator to create an API key"}
        csvName="api-keys"
        toolbar={canCreate && (
          <Button size="sm" className="h-8 text-xs" onClick={() => setCreateOpen(true)} disabled={loading && !scopeOptions.length}>
            <Plus className="h-3.5 w-3.5 mr-1" aria-hidden /> Create API key
          </Button>
        )}
      />

      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create API key"
        description="The raw key is displayed ONCE after creation — store it in a secret manager immediately."
        fields={createFields}
        submitLabel="Create key"
        onSubmit={async (v) => {
          const scopes: string[] = v.scopes || []
          if (!scopes.length) throw new Error("Grant at least one scope")
          const r = await rpc<{ id: string; key: string; prefix: string }>("integrations.keys.create", { name: v.name, scopes })
          setOnceKey({ key: r.key, prefix: r.prefix, name: String(v.name || "") })
          reload()
        }}
      />

      {onceKey && (
        <SecretOnceDialog
          key={onceKey.key}
          title="API key created"
          description={`Key "${onceKey.name}" is live — use it as a Bearer token.`}
          secret={onceKey.key}
          caption={`Prefix ${onceKey.prefix}… identifies the key in lists and audit entries.`}
          note="The server keeps only a SHA-256 hash of this key. If you lose it, revoke the key and create a new one."
          onClose={() => setOnceKey(null)}
        />
      )}

      {revokeKey && (
        <RevokeKeyDialog
          key={revokeKey.id}
          value={revokeKey}
          onClose={() => setRevokeKey(null)}
          onDone={() => { setRevokeKey(null); reload() }}
        />
      )}
    </div>
  )
}

// ================= Webhooks tab =================
function WebhooksTab({ data, loading, error, reload, canEdit, canDelete }: {
  data: { events: string[]; endpoints: EndpointRow[]; deliveries: DeliveryRow[] } | null
  loading: boolean
  error: string | null
  reload: () => void
  canEdit: boolean
  canDelete: boolean
}) {
  const toast = useHrm((s) => s.toast)
  const [saveOpen, setSaveOpen] = useState(false)
  const [editEp, setEditEp] = useState<EndpointRow | null>(null)
  const [deleteEp, setDeleteEp] = useState<EndpointRow | null>(null)
  const [onceSecret, setOnceSecret] = useState<{ secret: string; url: string } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; status: number | null; detail: string }>>({})
  // M-03 pattern — optimistic ONLY until the RPC confirms; failure rolls back
  const [activeOverride, setActiveOverride] = useState<Record<string, boolean>>({})

  const endpoints = data?.endpoints || []
  const deliveries = data?.deliveries || []
  const eventOptions = (data?.events || []).map((e) => ({ value: e, label: e }))

  const saveFields: FieldDef[] = [
    { name: "url", label: "Endpoint URL", required: true, span: 2, placeholder: "https://example.com/webhooks/finix", help: "HTTPS only — private/internal hosts are blocked" },
    { name: "events", label: "Events", type: "multiselect", span: 2, options: eventOptions, help: "Deliveries are signed POSTs; retries back off 1m → 5m → 30m → 2h → 6h (5 attempts)" },
    { name: "description", label: "Description", span: 2, placeholder: "e.g. Slack workflow — new joiner announcements" },
    { name: "active", label: "Active (deliver events)", type: "switch", defaultValue: true },
  ]

  const runTest = async (ep: EndpointRow) => {
    setTestingId(ep.id)
    try {
      const r = await rpc<{ ok: boolean; status: number | null; detail: string }>("integrations.webhooks.test", { id: ep.id })
      setTestResult((m) => ({ ...m, [ep.id]: r }))
      toast(r.ok ? `Test delivered — endpoint answered HTTP ${r.status}` : `Test failed — ${r.detail}`, r.ok ? "ok" : "err")
      reload()
    } catch (e: any) {
      toast(e?.message || "Test ping failed", "err")
    } finally {
      setTestingId(null)
    }
  }

  const endpointColumns: Column<EndpointRow>[] = [
    {
      key: "url", label: "Endpoint", sortValue: (r) => r.url, render: (r) => (
        <div className="min-w-0 max-w-[340px]" title={r.url}>
          <p className="font-mono text-xs text-slate-700 dark:text-slate-200 truncate">{r.url}</p>
          {r.description && <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{r.description}</p>}
        </div>
      ),
    },
    {
      key: "events", label: "Events", searchValue: (r) => r.events.join(" "), render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.events.map((e) => (
            <Badge key={e} variant="outline" className="text-[10px] font-mono">{e}</Badge>
          ))}
        </div>
      ),
    },
    {
      key: "active", label: "Active", align: "center", render: (r) => (
        <Switch
          checked={activeOverride[r.id] ?? r.active}
          disabled={!canEdit}
          aria-label={`Toggle event delivery for ${r.url}`}
          onCheckedChange={async (c) => {
            setActiveOverride((m) => ({ ...m, [r.id]: c }))
            try {
              await rpc("integrations.webhooks.save", { id: r.id, url: r.url, events: r.events, description: r.description || "", active: c })
              setActiveOverride((m) => { const n = { ...m }; delete n[r.id]; return n })
              reload()
            } catch (e: any) {
              // surface the failure and snap the switch back — nothing was saved
              setActiveOverride((m) => { const n = { ...m }; delete n[r.id]; return n })
              toast(e?.message || "Could not toggle the endpoint — nothing was saved", "err")
            }
          }}
        />
      ),
    },
    {
      key: "lastStatus", label: "Last status", render: (r) => <DeliveryBadge status={r.lastStatus} />,
    },
    {
      key: "lastDeliveredAt", label: "Last delivered", sortValue: (r) => r.lastDeliveredAt || "", render: (r) => (
        r.lastDeliveredAt ? <span className="text-xs">{fmtDateTime(r.lastDeliveredAt)}</span> : <span className="text-xs text-slate-400 dark:text-slate-500">never</span>
      ),
    },
    {
      key: "actions", label: "", align: "right", render: (r) => (
        <div className="flex items-center gap-1">
          {testResult[r.id] && (
            <span className={`text-[10px] font-mono mr-1 ${testResult[r.id].ok ? "text-emerald-600" : "text-rose-600"}`} title={testResult[r.id].detail}>
              → {testResult[r.id].status ?? "ERR"}
            </span>
          )}
          {canEdit && (
            <>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={testingId === r.id} onClick={() => runTest(r)}>
                <Send className="h-3.5 w-3.5 mr-1" aria-hidden /> {testingId === r.id ? "Pinging…" : "Test"}
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit endpoint" aria-label="Edit endpoint" onClick={() => { setEditEp(r); setSaveOpen(true) }}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {canDelete && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950" title="Delete endpoint" aria-label="Delete endpoint" onClick={() => setDeleteEp(r)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  const deliveryColumns: Column<DeliveryRow>[] = [
    {
      key: "event", label: "Event", sortValue: (r) => r.event, render: (r) => (
        <Badge variant="outline" className="text-[10px] font-mono">{r.event}</Badge>
      ),
    },
    {
      key: "endpointId", label: "Endpoint", render: (r) => {
        const ep = endpoints.find((e) => e.id === r.endpointId)
        const label = ep ? ep.url : "(deleted endpoint)"
        return <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300 truncate inline-block max-w-[240px]" title={label}>{label}</span>
      },
    },
    { key: "status", label: "Status", render: (r) => <DeliveryBadge status={r.status} /> },
    { key: "attempts", label: "Attempts", align: "right", sortValue: (r) => r.attempts, render: (r) => <span className="text-xs tabular-nums">{r.attempts}/5</span> },
    {
      key: "responseStatus", label: "HTTP", align: "right", render: (r) => (
        <span className="text-xs tabular-nums" title={r.responseBody || undefined}>
          {r.responseStatus ?? "—"}
        </span>
      ),
    },
    { key: "createdAt", label: "Created", sortValue: (r) => r.createdAt, render: (r) => <span className="text-xs">{fmtDateTime(r.createdAt)}</span> },
  ]

  return (
    <div className="space-y-4">
      <SectionCard title="Outbound webhooks">
        <div className="space-y-3 text-xs text-slate-600 dark:text-slate-300">
          <p>
            Signed HTTPS POSTs to your endpoint when workspace events happen. Each delivery carries the headers
            <code className="font-mono text-[11px] mx-1">x-finx-event</code>,
            <code className="font-mono text-[11px] mx-1">x-finx-delivery</code> and
            <code className="font-mono text-[11px] mx-1">x-finx-signature</code>.
          </p>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Verifying the signature</p>
            <pre className="font-mono text-[11px] bg-slate-50 dark:bg-slate-800/60 border rounded-md p-2.5 text-slate-600 dark:text-slate-300 overflow-x-auto">{"// secret = the signing secret shown once at creation\nconst expected = \"sha256=\" + crypto\n  .createHmac(\"sha256\", secret)\n  .update(rawBody)              // exact request bytes\n  .digest(\"hex\")\nif (expected !== req.headers[\"x-finx-signature\"]) return 401"}</pre>
          </div>
          <ul className="space-y-1 list-disc list-inside text-[11px] text-slate-500 dark:text-slate-400">
            <li>Failures retry with backoff 1m → 5m → 30m → 2h → 6h; after 5 attempts the delivery is marked failed</li>
            <li>Deliveries are drained every minute; a manual <b>Test</b> ping fires immediately (6 per hour)</li>
            <li>Endpoints without a stored secret send unsigned — receivers that enforce signatures will reject them</li>
          </ul>
        </div>
      </SectionCard>

      <DataTable
        columns={endpointColumns}
        rows={endpoints}
        loading={loading}
        error={error}
        searchPlaceholder="Search endpoints…"
        emptyTitle="No webhook endpoints"
        emptyHint={canEdit ? "Add an HTTPS endpoint to receive event deliveries" : "Ask an administrator to configure endpoints"}
        csvName="webhook-endpoints"
        toolbar={canEdit && (
          <Button size="sm" className="h-8 text-xs" onClick={() => { setEditEp(null); setSaveOpen(true) }} disabled={loading && !eventOptions.length}>
            <Plus className="h-3.5 w-3.5 mr-1" aria-hidden /> Add endpoint
          </Button>
        )}
      />

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 tracking-tight flex items-center gap-1.5">
            <Webhook className="h-4 w-4 text-slate-400" aria-hidden /> Recent deliveries
            <span className="text-[11px] font-normal text-slate-400">(latest 20)</span>
          </h3>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={reload} aria-label="Refresh deliveries">
            <RefreshCw className="h-3.5 w-3.5 mr-1" aria-hidden /> Refresh
          </Button>
        </div>
        <DataTable
          columns={deliveryColumns}
          rows={deliveries}
          loading={loading}
          error={error}
          searchPlaceholder="Search deliveries…"
          emptyTitle="No deliveries yet"
          emptyHint="Deliveries appear here the moment an event fires or a test ping is sent"
          dense
        />
      </div>

      <FormDialog
        open={saveOpen}
        onOpenChange={(o) => { setSaveOpen(o); if (!o) setEditEp(null) }}
        title={editEp ? "Edit webhook endpoint" : "Add webhook endpoint"}
        description={editEp ? "The signing secret is kept — rotating it requires deleting and recreating the endpoint." : "A signing secret is generated and shown ONCE after saving."}
        fields={saveFields}
        initial={editEp ? { url: editEp.url, events: editEp.events, description: editEp.description || "", active: editEp.active } : undefined}
        submitLabel={editEp ? "Save endpoint" : "Add endpoint"}
        onSubmit={async (v) => {
          const events: string[] = v.events || []
          if (!events.length) throw new Error("Subscribe to at least one event")
          const payload = { url: String(v.url || "").trim(), events, description: String(v.description || "").trim(), active: !!v.active }
          const r = await rpc<{ id: string; secret?: string }>("integrations.webhooks.save", editEp ? { id: editEp.id, ...payload } : payload)
          if (!editEp && r.secret) setOnceSecret({ secret: r.secret, url: payload.url })
          reload()
        }}
      />

      {onceSecret && (
        <SecretOnceDialog
          key={onceSecret.secret}
          title="Webhook signing secret"
          description={`For ${onceSecret.url} — verify deliveries with the x-finx-signature header.`}
          secret={onceSecret.secret}
          caption="Store it with the endpoint configuration — receivers that enforce signatures will reject unsigned deliveries."
          note="The secret is encrypted at rest and cannot be shown again. Losing it means deleting and re-creating the endpoint."
          onClose={() => setOnceSecret(null)}
        />
      )}

      <ConfirmDialog
        open={!!deleteEp}
        onOpenChange={(o) => { if (!o) setDeleteEp(null) }}
        title="Delete webhook endpoint"
        message={deleteEp ? `Delete ${deleteEp.url}? Event deliveries to it stop immediately. The delivery history is kept as the audit record.` : ""}
        confirmLabel="Delete endpoint"
        danger
        onConfirm={async () => {
          if (!deleteEp) return
          await rpc("integrations.webhooks.delete", { id: deleteEp.id })
          reload()
        }}
      />
    </div>
  )
}

// ================= root =================
export default function IntegrationsSettings() {
  const { can } = useHrm()
  const allowed = can("integrations", "view")
  const keysQ = useApi<{ scopes: string[]; keys: KeyRow[] }>(allowed ? "integrations.keys.list" : null)
  const hooksQ = useApi<{ events: string[]; endpoints: EndpointRow[]; deliveries: DeliveryRow[] }>(allowed ? "integrations.webhooks.list" : null)

  if (!allowed) return null

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
        <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
        <p>
          API keys and webhook endpoints are tenant-wide integration assets. Secrets are shown once at creation,
          stored hashed (keys) or encrypted (signing secrets), and every action is audited.
        </p>
      </div>
      <SectionTabs tabs={[
        {
          value: "apikeys",
          label: "API Keys",
          badge: keysQ.data?.keys.length,
          content: (
            <ApiKeysTab
              data={keysQ.data}
              loading={keysQ.loading}
              error={keysQ.error}
              reload={keysQ.reload}
              canCreate={can("integrations", "create")}
              canDelete={can("integrations", "delete")}
            />
          ),
        },
        {
          value: "webhooks",
          label: "Webhooks",
          badge: hooksQ.data?.endpoints.length,
          content: (
            <WebhooksTab
              data={hooksQ.data}
              loading={hooksQ.loading}
              error={hooksQ.error}
              reload={hooksQ.reload}
              canEdit={can("integrations", "edit")}
              canDelete={can("integrations", "delete")}
            />
          ),
        },
      ]} />
    </div>
  )
}
