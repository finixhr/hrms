"use client"
// ============ Integrations panel (Wave 10) — payments gateways + cloud storage ============
// Consumed by the Platform Settings page ("Payments" and "Storage" tabs).
//   PaymentsTab — SINGLE-ACTIVE-GATEWAY card on top (owner.payments.activate:
//                 exactly one gateway serves every tenant checkout — tenants
//                 never choose; activating X replaces Y, "none" deactivates),
//                 then one card per gateway (SSLCommerz, bKash, Nagad,
//                 PayStation, EPS): enabled toggle, sandbox/live, credential
//                 fields with masked round-trips (blank secret = keep
//                 existing) → owner.payments.get / owner.payments.save
//                 (billing perms). Disabling the ACTIVE gateway also
//                 deactivates it server-side.
//   StorageTab  — Cloudflare R2 + Cloudinary cards, ACTIVATE one provider,
//                 live PUT/GET/DELETE probe (owner.storage.test), object
//                 stats + the StorageObject journal by kind (settings perms).
// Masking contract: the server NEVER returns a decrypted secret — only
// has<Secret> booleans; the UI round-trips blanks for "keep existing".
import { useEffect, useState } from "react"
import { AlertTriangle, Cloud, CreditCard, Database, HardDrive, Loader2, Save, ShieldCheck, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "@/hooks/use-toast"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { Glass } from "@/saas/owner/ui"
import { cn } from "@/lib/utils"

const inputCls = "h-10 border-white/10 light:border-slate-300 bg-white/5 light:bg-white light:text-slate-900"

type MaskedProvider = {
  id: string
  label: string
  enabled: boolean
  configured: boolean
  mode: string | null
  credentials: Record<string, unknown>
}

// ---------------- payments ----------------

const PAYMENT_FIELDS: Record<string, { key: string; label: string; placeholder?: string; secret?: boolean; type?: string }[]> = {
  sslcommerz: [
    { key: "storeId", label: "Store ID", placeholder: "abc_live" },
    { key: "storePassword", label: "Store password", secret: true },
    { key: "baseUrlOverride", label: "Base URL override (optional)" },
  ],
  bkash: [
    { key: "appKey", label: "App key" },
    { key: "appSecret", label: "App secret", secret: true },
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
    { key: "baseUrlOverride", label: "Base URL override (optional)" },
  ],
  nagad: [
    { key: "merchantId", label: "Merchant ID" },
    { key: "accountNumber", label: "Account number (mobile)" },
    { key: "privateKeyPem", label: "Merchant private key (PEM)", secret: true, type: "textarea" },
    { key: "publicKeyPem", label: "Nagad public key (PEM)", secret: true, type: "textarea" },
  ],
  paystation: [
    { key: "merchantId", label: "Merchant ID", placeholder: "204-16537301811" },
    { key: "password", label: "Password", secret: true },
  ],
  eps: [
    { key: "username", label: "Portal username" },
    { key: "password", label: "Portal password", secret: true },
    { key: "hashKey", label: "Hash key (x-hash HMAC-SHA512)", secret: true },
    { key: "merchantId", label: "Merchant ID" },
    { key: "storeId", label: "Store ID" },
    { key: "transactionTypeId", label: "Transaction type ID (optional, default 1)" },
  ],
}

const PAYMENT_HINTS: Record<string, string> = {
  sslcommerz: "Hosted checkout. Verify via the validation API; sandbox: sandbox.sslcommerz.com.",
  bkash: "Tokenized checkout (grant token → create → execute).",
  nagad: "Payment Init API v3 (RSA-OAEP sensitiveData + RSA-SHA256 signature).",
  paystation: "Hosted checkout via sandbox/api.paystation.com.bd — invoice = our payment id; IPN re-verified through transaction-status.",
  eps: "EPS engine (GetToken + InitializeEPS + CheckMerchantTransactionStatus) — x-hash = HMAC-SHA512(username/txnId, hash key).",
}

export function PaymentsTab() {
  const q = useOwnerApi<{
    providers: MaskedProvider[]
    activeProviderId: string | null
    encryptionKeyConfigured: boolean
  }>("owner.payments.get", {})
  const [drafts, setDrafts] = useState<Record<string, Record<string, string | number | boolean>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // single-active-gateway confirmation state (null = dialog closed)
  const [confirmActivate, setConfirmActivate] = useState<string | null>(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)

  useEffect(() => {
    if (!q.data?.providers) return
    const next: Record<string, Record<string, string | number | boolean>> = {}
    for (const p of q.data.providers) {
      const d: Record<string, string | number | boolean> = { enabled: p.enabled, mode: p.mode || "sandbox" }
      for (const f of PAYMENT_FIELDS[p.id] || []) {
        const stored = p.credentials[f.key]
        d[f.key] = f.secret ? "" : typeof stored === "string" ? stored : typeof stored === "number" ? stored : ""
        if (f.key === "payWithCharge") d[f.key] = typeof stored === "number" ? stored : 0
      }
      next[p.id] = d
    }
    setDrafts(next)
  }, [q.data])

  if (q.loading) return <LoadingStub />
  if (q.error) return <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-300">{q.error}</p>
  const providers = q.data?.providers || []
  const activeId = q.data?.activeProviderId ?? null
  const labelOf = (id: string | null) => providers.find((p) => p.id === id)?.label || id || ""
  // only enabled + configured gateways may be activated (server enforces too)
  const eligible = providers.filter((p) => p.enabled && p.configured)

  // ---- single-active-gateway (owner.payments.activate) ----
  const activate = async (provider: string) => {
    setBusy(`activate:${provider}`); setErr(null); setConfirmActivate(null)
    try {
      await ownerRpc<{ activeProviderId: string | null }>("owner.payments.activate", { provider, confirm: true })
      toast({
        title: `${labelOf(provider)} is now the active checkout gateway`,
        description: "All tenant subscription checkouts will use it — tenants cannot choose a gateway.",
      })
      void q.reload()
    } catch (e: any) {
      const msg = e?.message || "Activation failed"
      setErr(msg)
      toast({ title: "Activation failed", description: msg, variant: "destructive" })
    } finally { setBusy(null) }
  }

  const deactivate = async () => {
    setBusy("deactivate"); setErr(null); setConfirmDeactivate(false)
    try {
      await ownerRpc<{ activeProviderId: null }>("owner.payments.activate", { provider: "none", confirm: true })
      toast({
        title: "Checkout gateway deactivated",
        description: "Tenants cannot pay online until a gateway is activated — bank-transfer instructions are shown instead.",
      })
      void q.reload()
    } catch (e: any) {
      const msg = e?.message || "Deactivation failed"
      setErr(msg)
      toast({ title: "Deactivation failed", description: msg, variant: "destructive" })
    } finally { setBusy(null) }
  }

  const save = async (id: string) => {
    const d = drafts[id]
    if (!d) return
    setBusy(id); setErr(null)
    try {
      const credentials: Record<string, unknown> = { mode: d.mode }
      for (const f of PAYMENT_FIELDS[id] || []) {
        const v = d[f.key]
        if (v === "" || v === undefined) continue
        credentials[f.key] = v
      }
      if (id === "paystation") credentials.payWithCharge = Number(d.payWithCharge ?? 0) || 0
      await ownerRpc("owner.payments.save", { provider: id, enabled: !!d.enabled, credentials })
      setSavedId(id); setTimeout(() => setSavedId(null), 3000)
      void q.reload()
    } catch (e: any) { setErr(`${id}: ${e?.message || "save failed"}`) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      {q.data?.encryptionKeyConfigured === false && (
        <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          The server encryption key (HRM_MFA_KEY) is not configured — gateway credentials cannot be stored until it is.
        </p>
      )}

      {/* ---- SINGLE-ACTIVE-GATEWAY (master prompt §8.1) ---- */}
      <Glass className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CreditCard className="h-4 w-4 text-slate-400" />
            <p className="text-sm font-bold text-white light:text-slate-900">Active Checkout Gateway</p>
            {activeId ? (
              <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                <ShieldCheck className="mr-1 inline h-3 w-3" />{labelOf(activeId).toUpperCase()}
              </span>
            ) : (
              <span className="rounded-md bg-white/10 light:bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-400">NONE — ONLINE CHECKOUT DISABLED</span>
            )}
          </div>
          {activeId && (
            <Button size="sm" variant="outline" disabled={busy === "deactivate"} onClick={() => setConfirmDeactivate(true)}
              className="border-rose-400/30 text-rose-300 hover:bg-rose-500/10">
              {busy === "deactivate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Deactivate"}
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          Exactly ONE gateway serves every tenant subscription checkout — tenants never choose. Activating a gateway
          replaces the current one; disabling the active gateway below also deactivates it.
        </p>
        <div className="mt-3 space-y-2">
          {eligible.length === 0 ? (
            <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3 text-xs text-slate-500">
              No gateway is both enabled and configured yet — save credentials and enable a gateway below to make it activatable.
            </p>
          ) : (
            eligible.map((p) => {
              const isActive = p.id === activeId
              return (
                <div key={p.id}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border p-3",
                    isActive ? "border-emerald-400/40 bg-emerald-500/5" : "border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", isActive ? "border-emerald-400" : "border-slate-600 light:border-slate-400")}>
                      {isActive && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-white light:text-slate-900">{p.label}</p>
                      <p className="text-[11px] text-slate-500">{p.mode ? `${p.mode} mode` : "mode not set"}</p>
                    </div>
                  </div>
                  {isActive ? (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-emerald-300">Active</span>
                  ) : (
                    <Button size="sm" disabled={busy === `activate:${p.id}`} onClick={() => setConfirmActivate(p.id)}
                      className="shrink-0 bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-400 hover:to-teal-400">
                      {busy === `activate:${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Activate"}
                    </Button>
                  )}
                </div>
              )
            })
          )}
        </div>
      </Glass>

      {!activeId && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200 light:text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Tenants cannot pay online until a gateway is activated — bank-transfer instructions are shown instead.
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {providers.map((p) => {
          const d = drafts[p.id] || {}
          return (
            <Glass key={p.id} className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-slate-400" />
                  <p className="text-sm font-bold text-white light:text-slate-900">{p.label}</p>
                  {p.configured ? (
                    <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300"><ShieldCheck className="mr-1 inline h-3 w-3" />CONFIGURED</span>
                  ) : (
                    <span className="rounded-md bg-white/10 light:bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-400">NOT SET</span>
                  )}
                </div>
                <Button size="sm" disabled={busy === p.id} onClick={() => save(p.id)}
                  className="bg-white/10 light:bg-slate-900 text-white light:text-white hover:bg-white/20 light:hover:bg-slate-800">
                  {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : savedId === p.id ? <ShieldCheck className="h-3.5 w-3.5" /> : <><Save className="h-3.5 w-3.5" /> Save</>}
                </Button>
              </div>
              <div className="mt-4 space-y-3">
                <label className="flex items-center justify-between rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                  <span className="pr-3 text-xs">Enabled for tenant checkouts</span>
                  <Switch checked={!!d.enabled} onCheckedChange={(v) => setDrafts({ ...drafts, [p.id]: { ...d, enabled: v } })} />
                </label>
                <div>
                  <Label className="text-xs text-slate-400">Mode</Label>
                  <Select value={String(d.mode || "sandbox")} onValueChange={(v) => setDrafts({ ...drafts, [p.id]: { ...d, mode: v } })}>
                    <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="sandbox">Sandbox (test)</SelectItem><SelectItem value="live">Live</SelectItem></SelectContent>
                  </Select>
                </div>
                {(PAYMENT_FIELDS[p.id] || []).map((f) => {
                  const has = typeof p.credentials[`has${f.key.charAt(0).toUpperCase()}${f.key.slice(1)}`] === "boolean"
                    ? p.credentials[`has${f.key.charAt(0).toUpperCase()}${f.key.slice(1)}`]
                    : false
                  if (f.key === "payWithCharge") {
                    return (
                      <div key={f.key}>
                        <Label className="text-xs text-slate-400">Gateway charge bearer</Label>
                        <Select value={String(d.payWithCharge ?? 0)} onValueChange={(v) => setDrafts({ ...drafts, [p.id]: { ...d, payWithCharge: Number(v) } })}>
                          <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="0">Merchant pays the charge</SelectItem><SelectItem value="1">Customer pays the charge</SelectItem></SelectContent>
                        </Select>
                      </div>
                    )
                  }
                  return (
                    <div key={f.key}>
                      <Label className="text-xs text-slate-400">
                        {f.label}
                        {f.secret && has ? " (saved — leave blank to keep)" : f.secret ? "" : ""}
                      </Label>
                      <Input
                        type={f.secret ? "password" : "text"}
                        value={String(d[f.key] ?? "")}
                        placeholder={f.secret && has ? "•••••••• (unchanged)" : f.placeholder || ""}
                        onChange={(e) => setDrafts({ ...drafts, [p.id]: { ...d, [f.key]: e.target.value } })}
                        className={f.type === "textarea" ? `${inputCls} h-24` : inputCls}
                      />
                    </div>
                  )
                })}
                {p.id in PAYMENT_HINTS && <p className="text-[11px] leading-relaxed text-slate-500">{PAYMENT_HINTS[p.id]}</p>}
              </div>
            </Glass>
          )
        })}
      </div>
      {err && <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-300">{err}</p>}
      <p className="text-[11px] leading-relaxed text-slate-500">
        Credentials are AES-256-GCM encrypted at rest under a dedicated key context (saas-payments::v1). Redirect callbacks and IPNs are never trusted — every completion is verified server-to-server before a single paisa is recorded, and settlement is idempotent per provider transaction.
      </p>

      {/* activate confirmation — the one-way switch for every tenant checkout */}
      <AlertDialog open={!!confirmActivate} onOpenChange={(o) => !o && setConfirmActivate(null)}>
        <AlertDialogContent className="border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white light:text-slate-900">
              Activate {labelOf(confirmActivate)} for all checkouts?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400 light:text-slate-600">
              All tenant subscription checkouts will use {labelOf(confirmActivate)}. Tenants cannot choose a gateway.
              {activeId && confirmActivate && activeId !== confirmActivate
                ? ` This replaces ${labelOf(activeId)} as the active gateway.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === `activate:${confirmActivate}`}
              onClick={() => confirmActivate && activate(confirmActivate)}
              className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-400 hover:to-teal-400">
              {busy === `activate:${confirmActivate}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Activate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* deactivate confirmation — back to bank-transfer-only checkouts */}
      <AlertDialog open={confirmDeactivate} onOpenChange={setConfirmDeactivate}>
        <AlertDialogContent className="border-white/10 light:border-slate-200 bg-slate-950 light:bg-slate-50">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white light:text-slate-900">Deactivate {labelOf(activeId)}?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400 light:text-slate-600">
              Tenants cannot pay online until another gateway is activated — bank-transfer instructions are shown instead.
              Existing invoices, payments and receipts are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 text-white light:text-slate-900">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "deactivate"}
              onClick={deactivate}
              className="bg-red-600 text-white hover:bg-red-700">
              {busy === "deactivate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Deactivate gateway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------- storage ----------------

const STORAGE_FIELDS: Record<string, { key: string; label: string; secret?: boolean; placeholder?: string }[]> = {
  r2: [
    { key: "accountId", label: "Cloudflare account ID", placeholder: "e.g. 9a1b2c3d…" },
    { key: "accessKeyId", label: "Access key ID (R2 token)" },
    { key: "secretAccessKey", label: "Secret access key", secret: true },
    { key: "bucket", label: "Bucket name" },
    { key: "publicBaseUrl", label: "Public base URL (optional — custom domain / public bucket)", placeholder: "https://cdn.example.com" },
  ],
  cloudinary: [
    { key: "cloudName", label: "Cloud name" },
    { key: "apiKey", label: "API key" },
    { key: "apiSecret", label: "API secret", secret: true },
    { key: "folder", label: "Folder (optional, default finixhr)" },
  ],
}

export function StorageTab() {
  const q = useOwnerApi<{
    providers: MaskedProvider[]
    active: string | null
    encryptionKeyConfigured: boolean
    stats: { objects: number; storedBytes: number; failed: number; last7d: { uploads: number; failures: number }; byKind: { kind: string; count: number; bytes: number }[] } | null
  }>("owner.storage.get", {})
  const [drafts, setDrafts] = useState<Record<string, Record<string, string | boolean>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!q.data?.providers) return
    const next: Record<string, Record<string, string | boolean>> = {}
    for (const p of q.data.providers) {
      const d: Record<string, string | boolean> = { enabled: p.enabled }
      for (const f of STORAGE_FIELDS[p.id] || []) {
        d[f.key] = f.secret ? "" : typeof p.credentials[f.key] === "string" ? String(p.credentials[f.key]) : ""
      }
      next[p.id] = d
    }
    setDrafts(next)
  }, [q.data])

  if (q.loading) return <LoadingStub />
  if (q.error) return <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-300">{q.error}</p>
  const providers = q.data?.providers || []
  const active = q.data?.active
  const stats = q.data?.stats

  const save = async (id: string, activate: boolean) => {
    const d = drafts[id]
    if (!d) return
    setBusy(id); setErr(null)
    try {
      const credentials: Record<string, unknown> = {}
      for (const f of STORAGE_FIELDS[id] || []) {
        const v = d[f.key]
        if (v === "" || v === undefined) continue
        credentials[f.key] = v
      }
      await ownerRpc("owner.storage.save", { provider: id, enabled: !!d.enabled, ...(activate ? { active: true } : {}), credentials })
      void q.reload()
    } catch (e: any) { setErr(`${id}: ${e?.message || "save failed"}`) } finally { setBusy(null) }
  }

  const deactivate = async () => {
    setBusy("active"); setErr(null)
    try {
      await ownerRpc("owner.storage.save", { provider: active as string, active: false })
      void q.reload()
    } catch (e: any) { setErr(e?.message || "deactivate failed") } finally { setBusy(null) }
  }

  const runTest = async () => {
    setBusy("test"); setTestMsg(null); setErr(null)
    try {
      const res = await ownerRpc<{ ok: boolean; provider: string; ms: number; publicUrl: string | null; signedUrlReachable: boolean }>("owner.storage.test", {})
      setTestMsg(`Probe PASSED on ${res.provider} in ${res.ms} ms — object stored, signed URL minted, object deleted. ${res.publicUrl ? `Public delivery: ${res.publicUrl}` : "(private bucket — signed URLs only)"}`)
    } catch (e: any) { setErr(`Storage test failed: ${e?.message || "unknown error"}`) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      {/* stats strip */}
      {stats && (
        <Glass className="p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><HardDrive className="h-3.5 w-3.5" /><b className="text-white light:text-slate-900">{stats.objects.toLocaleString()}</b> objects</span>
            <span><Database className="mr-1 inline h-3.5 w-3.5" /><b className="text-white light:text-slate-900">{(stats.storedBytes / 1024 / 1024).toFixed(1)} MB</b> stored</span>
            <span><Zap className="mr-1 inline h-3.5 w-3.5" /><b className="text-white light:text-slate-900">{stats.last7d.uploads}</b> uploads / 7d</span>
            {stats.failed > 0 && <span className="text-rose-300"><b>{stats.failed}</b> failed rows</span>}
            {stats.byKind.map((k) => <span key={k.kind} className="rounded-md bg-white/5 light:bg-slate-100 px-2 py-0.5">{k.kind}: <b>{k.count}</b></span>)}
          </div>
        </Glass>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {providers.map((p) => {
          const d = drafts[p.id] || {}
          const isActive = active === p.id
          return (
            <Glass key={p.id} className={cn("p-5", isActive && "border-emerald-400/40 bg-emerald-500/5")}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cloud className="h-4 w-4 text-slate-400" />
                  <p className="text-sm font-bold text-white light:text-slate-900">{p.label}</p>
                  {isActive && <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">ACTIVE</span>}
                </div>
                <div className="flex gap-2">
                  {!isActive && p.configured && (
                    <Button size="sm" disabled={busy === p.id} onClick={() => save(p.id, true)}
                      className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white">
                      {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Activate"}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => save(p.id, false)}
                    className="border-white/15 light:border-slate-300">
                    {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Save className="h-3.5 w-3.5" /> Save</>}
                  </Button>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <label className="flex items-center justify-between rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
                  <span className="pr-3 text-xs">Credentials enabled</span>
                  <Switch checked={!!d.enabled} onCheckedChange={(v) => setDrafts({ ...drafts, [p.id]: { ...d, enabled: v } })} />
                </label>
                {(STORAGE_FIELDS[p.id] || []).map((f) => {
                  const has = !!p.credentials[`has${f.key.charAt(0).toUpperCase()}${f.key.slice(1)}`]
                  return (
                    <div key={f.key}>
                      <Label className="text-xs text-slate-400">{f.label}{f.secret && has ? " (saved — leave blank to keep)" : ""}</Label>
                      <Input
                        type={f.secret ? "password" : "text"}
                        value={String(d[f.key] ?? "")}
                        placeholder={f.secret && has ? "•••••••• (unchanged)" : f.placeholder || ""}
                        onChange={(e) => setDrafts({ ...drafts, [p.id]: { ...d, [f.key]: e.target.value } })}
                        className={inputCls}
                      />
                    </div>
                  )
                })}
                <p className="text-[11px] leading-relaxed text-slate-500">
                  {p.id === "r2"
                    ? "S3-compatible API (SigV4 signed with node:crypto — no AWS SDK). Private by default; set a public base URL only for a custom domain you control. Signed GETs are time-boxed presigned URLs."
                    : "Signed upload + signed delivery URLs (s--…--). Images optimize on delivery; non-images store as raw. "}
                </p>
              </div>
            </Glass>
          )
        })}
      </div>

      <Glass className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-white light:text-slate-900">Live connection test</p>
            <p className="text-[11px] text-slate-500">Stores a tiny probe object on the ACTIVE provider, mints a signed URL, deletes the probe — measures the full round-trip.</p>
          </div>
          <div className="flex gap-2">
            {active && (
              <Button size="sm" variant="outline" disabled={busy === "active"} onClick={deactivate} className="border-rose-400/30 text-rose-300">
                Deactivate storage
              </Button>
            )}
            <Button size="sm" disabled={!active || busy === "test"} onClick={runTest} className="bg-white/10 light:bg-slate-900 text-white light:text-white">
              {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Zap className="h-3.5 w-3.5" /> Run test</>}
            </Button>
          </div>
        </div>
        {testMsg && <p className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300">{testMsg}</p>}
        {err && <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">{err}</p>}
        {!active && <p className="mt-3 text-[11px] text-slate-500">No active provider — uploads keep the historical in-database behavior. Activating is reversible at any time.</p>}
      </Glass>
    </div>
  )
}

function LoadingStub() {
  return (
    <div className="flex items-center justify-center rounded-2xl border border-white/10 light:border-slate-200 p-10">
      <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
    </div>
  )
}
