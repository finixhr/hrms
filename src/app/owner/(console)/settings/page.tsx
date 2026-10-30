"use client"
// ============ /owner/settings — tab-based Platform Settings ============
// Tabs: General · Registration · Subscription · Security · Communication ·
// Gateway · My Account · Website Studio (the full public-site CMS).
// Every settings group keeps the per-group save model (settings.save →
// zod whitelist + audit); the Website Studio saves through owner.cms.*.
import { useEffect, useState } from "react"
import {
<<<<<<< HEAD
  AlertTriangle, CheckCircle2, Copy, Fingerprint, Globe, KeyRound, Loader2, Plus, Save, Send, ShieldCheck, ShieldOff, Trash2, Upload, X,
=======
  AlertTriangle, CheckCircle2, Copy, Fingerprint, Globe, Image as ImageIcon, KeyRound, Loader2, PenTool, Plus, Save, Send, ShieldCheck, ShieldOff, Stamp, Trash2, Upload, X,
>>>>>>> origin/main
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useOwnerApi, ownerRpc } from "@/saas/owner/client"
import { ErrorBanner, PageHeader, Loading } from "@/saas/owner/ui"
import { WebsiteStudio } from "@/saas/owner/website-studio"
import { PaymentsTab, StorageTab } from "@/saas/owner/integrations-panel"
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser"
import { cn } from "@/lib/utils"

type Settings = {
  general: {
    platformName: string
    supportEmail: string
    supportPhone: string
    websiteUrl: string
    tagline: string
    address?: string
    logoUrl?: string
    appLogoUrl?: string
    faviconUrl?: string
    sealUrl?: string
    signatureUrl?: string
    signatoryName?: string
    signatoryDesignation?: string
  }
  registration: { enabled: boolean; requireApproval: boolean; defaultPlanId: string | null; allowedBillingCycles: string[]; messageOnSubmit: string }
  subscription: {
    gracePeriodDays: number
    renewalReminderDays: number[]
    trialDays: number
    postExpiryNoticeDays: number[]
    expirySmsEnabled: boolean
    rejoinOfferEnabled: boolean
    // 2026-10-25 (master prompt Part H §13) — automated renewal billing:
    // invoice lead time + receipt/thank-you email toggles.
    invoiceLeadDays: number
    receiptEmailEnabled: boolean
    thankYouEmailEnabled: boolean
  }
  security: { ownerMfaRequired: boolean; sessionDays: number; lockoutThreshold: number; lockoutMinutes: number }
  billing: {
    vatRatePercent: number
    companyLegalName: string
    companyBin: string
    companyAddress: string
    companyPhone: string
    companyEmail: string
    companyWebsite: string
    signatoryName: string
    signatoryDesignation: string
    primaryBankName: string
    primaryAccountNo: string
    primaryAccountName: string
    primaryBranch: string
    primaryRouting: string
    secondaryBankName: string
    secondaryAccountNo: string
    secondaryAccountName: string
    secondaryBranch: string
    secondaryRouting: string
    bkashMerchantNumber: string
    bankTransferInstructions: string
    mfsProviderName?: string
    mfsMerchantNumber?: string
    mfsQrUrl?: string
    mfsInstructions?: string
  }
  communication: { notifyOnRegistration: boolean; notifyOnApproval: boolean; notifyApplicantOnSubmit: boolean; notifyOnExpiryDays: number[] }
  alerts: { webhookUrl: string; webhookSecret: string; webhookOnBackupFailure: boolean; quotaAlertsEnabled: boolean; quotaThresholdPercent: number }
}

type Gateway = {
  email: { enabled: boolean; host: string; port: number; secure: boolean; username: string; password: string; fromAddress: string; fromName: string; hasPassword: boolean }
  sms: { enabled: boolean; apiUrl: string; method: "GET" | "POST"; senderId: string; apiKey: string; hasApiKey: boolean; provider: string }
}

type Tab = "general" | "registration" | "subscription" | "billing" | "security" | "communication" | "alerts" | "gateway" | "payments" | "storage" | "account" | "website"

const TABS: { key: Tab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "registration", label: "Registration" },
  { key: "subscription", label: "Subscription" },
  { key: "billing", label: "Billing & Tax" },
  { key: "security", label: "Security" },
  { key: "communication", label: "Communication" },
  { key: "alerts", label: "Alerts" },
  { key: "gateway", label: "Gateway" },
  { key: "payments", label: "Payments" },
  { key: "storage", label: "Storage" },
  { key: "account", label: "My Account" },
  { key: "website", label: "Website Studio" },
]

const inputCls = "h-10 border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 light:border-slate-300 light:bg-white light:text-slate-900"

function resizeImage(file: File, max = 400): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement("canvas")
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext("2d")
        if (!ctx) { URL.revokeObjectURL(url); resolve(null); return }
        ctx.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL("image/png"))
      } catch {
        URL.revokeObjectURL(url)
        resolve(null)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

function validateAndProcessImage(
  file: File,
  opts: {
    label: string
    maxDimension?: number
    requireSquare?: boolean
    maxSizeBytes?: number
  }
): Promise<{ dataUrl?: string; error?: string }> {
  const { label, maxDimension = 512, requireSquare = false, maxSizeBytes = 2 * 1024 * 1024 } = opts
  if (file.size > maxSizeBytes) {
    const mb = (maxSizeBytes / (1024 * 1024)).toFixed(1)
    return Promise.resolve({ error: `${label} exceeds maximum allowed size of ${mb}MB.` })
  }
  return new Promise((resolve) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        if (requireSquare) {
          const ratio = img.width / img.height
          if (ratio < 0.75 || ratio > 1.33) {
            URL.revokeObjectURL(url)
            resolve({
              error: `${label} must have a square aspect ratio (1:1). Uploaded image is ${img.width}x${img.height}px.`
            })
            return
          }
        }
        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement("canvas")
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          URL.revokeObjectURL(url)
          resolve({ error: "Failed to process image canvas context." })
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        resolve({ dataUrl: canvas.toDataURL("image/png") })
      } catch (e: any) {
        URL.revokeObjectURL(url)
        resolve({ error: e?.message || "Failed to process image" })
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ error: `Invalid or unreadable image file for ${label}.` })
    }
    img.src = url
  })
}

export default function SettingsPage() {
  const { data, loading, error } = useOwnerApi<{ settings: Settings; plans: { id: string; name: string }[] }>("owner.settings.get", {})
  const [form, setForm] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>("general")
  const [busy, setBusy] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => { if (data?.settings) setForm(JSON.parse(JSON.stringify(data.settings))) }, [data])

  const saveGroup = async (group: keyof Settings) => {
    if (!form) return
    setBusy(group as string)
    try {
      const res = await ownerRpc<{ settings: Settings }>("owner.settings.save", { group, values: form[group] as any })
      setForm(JSON.parse(JSON.stringify(res.settings)))
      setSaved(group as string); setTimeout(() => setSaved(null), 4000)
    } catch (e: any) { alert(e?.message || "Save failed") } finally { setBusy(null) }
  }

  if (loading) return <Loading />
  if (error) return <ErrorBanner message={error} />
  if (!form && tab !== "website") return null

  return (
    <div className="space-y-5">
      <PageHeader title="Platform Settings" sub="Global knobs for the SaaS layer plus the complete Website Studio. Tenant-level settings are unaffected — this page never duplicates them." />
      {saved && <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 light:text-emerald-700 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-700">{saved} saved.</p>}

      {/* tab bar — horizontally scrollable on mobile */}
      <div className="-mx-1 overflow-x-auto scroll-thin px-1 pb-1" role="tablist" aria-label="Platform settings sections">
        <div className="flex min-w-max gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[12px] font-semibold transition-colors",
                tab === t.key
                  ? "bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-indigo-950/40"
                  : "border border-white/10 light:border-slate-200 text-slate-400 light:text-slate-600 hover:bg-white/5 light:hover:bg-slate-100 hover:text-white light:hover:text-slate-900"
              )}
            >
              {t.key === "website" && <Globe className="h-3.5 w-3.5" />}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- WEBSITE STUDIO (full CMS) ---- */}
      {tab === "website" && <WebsiteStudio />}

      {/* ---- Wave 10 integrations (payments gateways + cloud storage) ---- */}
      {tab === "payments" && <PaymentsTab />}
      {tab === "storage" && <StorageTab />}

      {/* ---- platform settings tabs ---- */}
      {form && tab !== "website" && (
        <div className="grid gap-4 xl:grid-cols-2">
          {tab === "general" && (
            <>
              <Card title="Platform Profile & Branding" busy={busy === "general"} onSave={() => saveGroup("general")}>
                <F label="Platform name">
                  <Input value={form.general.platformName || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, platformName: e.target.value } })} className={inputCls} />
                </F>
                <F label="Tagline / Subtitle">
                  <Input value={form.general.tagline || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, tagline: e.target.value } })} className={inputCls} placeholder="Standalone HRM & Workforce Platform" />
                </F>
                <F label="Platform Logo (Public Website, Owner Console Header, Invoices)">
                  <div className="flex items-center gap-3 rounded-lg border border-white/10 p-2.5 bg-white/5 dark:bg-slate-800/40">
                    {form.general.logoUrl ? (
                      <img src={form.general.logoUrl} alt="Platform Logo" className="h-10 max-w-32 object-contain rounded bg-white p-1 shadow-sm" />
                    ) : (
                      <div className="h-10 w-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-black text-xl shadow-sm">
                        F
                      </div>
                    )}
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="file"
                          id="logo-upload"
                          accept="image/png,image/jpeg,image/webp,image/svg+xml"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const res = await validateAndProcessImage(file, { label: "Platform Logo", maxDimension: 400, requireSquare: false, maxSizeBytes: 2 * 1024 * 1024 })
                            if (res.error) alert(res.error)
                            else if (res.dataUrl) setForm({ ...form, general: { ...form.general, logoUrl: res.dataUrl } })
                            e.target.value = ""
                          }}
                        />
                        <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs cursor-pointer">
                          <label htmlFor="logo-upload">
                            <Upload className="h-3.5 w-3.5" /> {form.general.logoUrl ? "Change Logo" : "Upload Logo"}
                          </label>
                        </Button>
                        {form.general.logoUrl && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 gap-1 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                            onClick={() => setForm({ ...form, general: { ...form.general, logoUrl: "" } })}
                          >
                            <X className="h-3.5 w-3.5" /> Remove
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Recommended: Transparent PNG or SVG (approx. 400x120px, max 2MB). Used for public website navbar, owner panel header, and invoices.
                      </p>
                    </div>
                  </div>
                </F>
                <F label="App Logo (Mobile App, PWA, Launcher)">
                  <div className="flex items-center gap-3 rounded-lg border border-white/10 p-2.5 bg-white/5 dark:bg-slate-800/40">
                    {form.general.appLogoUrl ? (
                      <img src={form.general.appLogoUrl} alt="App Logo" className="h-10 w-10 object-contain rounded-lg bg-white p-1 shadow-sm" />
                    ) : (
                      <div className="h-10 w-10 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-black text-sm shadow-sm">
                        App
                      </div>
                    )}
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="file"
                          id="app-logo-upload"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const res = await validateAndProcessImage(file, { label: "App Logo", maxDimension: 512, requireSquare: true, maxSizeBytes: 2 * 1024 * 1024 })
                            if (res.error) alert(res.error)
                            else if (res.dataUrl) setForm({ ...form, general: { ...form.general, appLogoUrl: res.dataUrl } })
                            e.target.value = ""
                          }}
                        />
                        <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs cursor-pointer">
                          <label htmlFor="app-logo-upload">
                            <Upload className="h-3.5 w-3.5" /> {form.general.appLogoUrl ? "Change App Logo" : "Upload App Logo"}
                          </label>
                        </Button>
                        {form.general.appLogoUrl && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 gap-1 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                            onClick={() => setForm({ ...form, general: { ...form.general, appLogoUrl: "" } })}
                          >
                            <X className="h-3.5 w-3.5" /> Remove
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Recommended: Square 1:1 aspect ratio (512x512px, max 2MB). Used for mobile app launcher &amp; app icon.
                      </p>
                    </div>
                  </div>
                </F>
                <F label="Website Favicon (Browser Tab Icon)">
                  <div className="flex items-center gap-3 rounded-lg border border-white/10 p-2.5 bg-white/5 dark:bg-slate-800/40">
                    {form.general.faviconUrl ? (
                      <img src={form.general.faviconUrl} alt="Website Favicon" className="h-8 w-8 object-contain rounded bg-white p-1 shadow-sm" />
                    ) : (
                      <div className="h-8 w-8 rounded bg-slate-700 flex items-center justify-center text-white font-bold text-xs shadow-sm">
                        ico
                      </div>
                    )}
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="file"
                          id="favicon-upload"
                          accept="image/png,image/x-icon,image/svg+xml,image/webp"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const res = await validateAndProcessImage(file, { label: "Website Favicon", maxDimension: 128, requireSquare: true, maxSizeBytes: 500 * 1024 })
                            if (res.error) alert(res.error)
                            else if (res.dataUrl) setForm({ ...form, general: { ...form.general, faviconUrl: res.dataUrl } })
                            e.target.value = ""
                          }}
                        />
                        <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs cursor-pointer">
                          <label htmlFor="favicon-upload">
                            <Upload className="h-3.5 w-3.5" /> {form.general.faviconUrl ? "Change Favicon" : "Upload Favicon"}
                          </label>
                        </Button>
                        {form.general.faviconUrl && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 gap-1 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                            onClick={() => setForm({ ...form, general: { ...form.general, faviconUrl: "" } })}
                          >
                            <X className="h-3.5 w-3.5" /> Remove
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Recommended: Square 1:1 aspect ratio (32x32px or 64x64px, max 500KB). Displayed in browser tabs.
                      </p>
                    </div>
                  </div>
                </F>
                <F label="Address (displayed on Invoices & Money Receipts)">
                  <Input value={form.general.address || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, address: e.target.value } })} className={inputCls} placeholder="House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230" />
                </F>
                <F label="Website URL">
                  <Input value={form.general.websiteUrl || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, websiteUrl: e.target.value } })} className={inputCls} placeholder="https://hrm.finixmart.com.bd" />
                </F>
                <F label="Support Email">
                  <Input value={form.general.supportEmail || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, supportEmail: e.target.value } })} className={inputCls} placeholder="support@finixhr.com" />
                </F>
                <F label="Contact Phone">
                  <Input value={form.general.supportPhone || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, supportPhone: e.target.value } })} className={inputCls} placeholder="+8809643666888" />
                </F>
              </Card>

              <Card title="Authorized Signatory & Official Seal" busy={busy === "general"} onSave={() => saveGroup("general")}>
                <F label="Signatory Name">
                  <Input value={form.general.signatoryName || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, signatoryName: e.target.value } })} className={inputCls} placeholder="MD JAKARIA" />
                </F>
                <F label="Signatory Designation">
                  <Input value={form.general.signatoryDesignation || ""} onChange={(e) => setForm({ ...form, general: { ...form.general, signatoryDesignation: e.target.value } })} className={inputCls} placeholder="Executive, Admin & Operations, Finix HR Ltd." />
                </F>
                <F label="Authorized Signature Image">
                  <div className="space-y-2 rounded-lg border border-white/10 p-3 bg-white/5 dark:bg-slate-800/40">
                    <div className="flex h-16 w-full items-center justify-center rounded border border-dashed border-slate-300 dark:border-slate-700 bg-white/80 p-2">
                      {form.general.signatureUrl ? (
                        <img src={form.general.signatureUrl} alt="Signature Preview" className="h-12 max-w-56 object-contain" />
                      ) : (
                        <span className="font-serif italic text-base text-slate-800 select-none">
                          {form.general.signatoryName || "MD Jakaria"}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] text-slate-400">PNG with transparent background recommended</p>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="file"
                          id="sig-upload"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const dataUrl = await resizeImage(file, 400)
                            if (dataUrl) setForm({ ...form, general: { ...form.general, signatureUrl: dataUrl } })
                            e.target.value = ""
                          }}
                        />
                        <Button asChild size="sm" variant="outline" className="h-7 text-xs cursor-pointer">
                          <label htmlFor="sig-upload">
                            <Upload className="h-3 w-3 mr-1" /> {form.general.signatureUrl ? "Change" : "Upload"}
                          </label>
                        </Button>
                        {form.general.signatureUrl && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-rose-500 hover:text-rose-600"
                            onClick={() => setForm({ ...form, general: { ...form.general, signatureUrl: "" } })}
                          >
                            <X className="h-3 w-3 mr-1" /> Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </F>
                <F label="Official Seal / Stamp Image">
                  <div className="space-y-2 rounded-lg border border-white/10 p-3 bg-white/5 dark:bg-slate-800/40">
                    <div className="flex h-24 w-full items-center justify-center rounded border border-dashed border-slate-300 dark:border-slate-700 bg-white/80 p-2">
                      {form.general.sealUrl ? (
                        <img src={form.general.sealUrl} alt="Seal Preview" className="h-20 w-20 object-contain rounded-full shadow-sm" />
                      ) : (
                        <div className="relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-blue-600 p-0.5 text-center select-none rotate-[-6deg]">
                          <div className="flex h-full w-full flex-col items-center justify-center rounded-full border-2 border-blue-600 bg-blue-50/50 text-blue-700">
                            <span className="text-[8px] font-black uppercase tracking-widest">{form.general.platformName || "Finix HR"}</span>
                            <span className="text-[10px] font-black tracking-wider text-blue-600 my-0.5">★ PAID ★</span>
                            <span className="text-[7px] font-bold uppercase tracking-tight text-blue-500">Official Seal</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] text-slate-400">Round seal PNG (transparent background recommended)</p>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="file"
                          id="seal-upload"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            const dataUrl = await resizeImage(file, 400)
                            if (dataUrl) setForm({ ...form, general: { ...form.general, sealUrl: dataUrl } })
                            e.target.value = ""
                          }}
                        />
                        <Button asChild size="sm" variant="outline" className="h-7 text-xs cursor-pointer">
                          <label htmlFor="seal-upload">
                            <Upload className="h-3 w-3 mr-1" /> {form.general.sealUrl ? "Change" : "Upload"}
                          </label>
                        </Button>
                        {form.general.sealUrl && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-rose-500 hover:text-rose-600"
                            onClick={() => setForm({ ...form, general: { ...form.general, sealUrl: "" } })}
                          >
                            <X className="h-3 w-3 mr-1" /> Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </F>
                <div className="rounded-lg border border-blue-400/20 bg-blue-500/10 p-3 text-xs text-blue-300 dark:text-blue-300 light:text-blue-700">
                  <p className="font-semibold flex items-center gap-1.5 mb-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Automatic PDF Document Branding
                  </p>
                  <p className="text-[11px] leading-relaxed opacity-90">
                    Uploaded branding, contacts, signatory, and official seal are automatically rendered on tenant Money Receipts, Invoices, and automated email receipts.
                  </p>
                </div>
              </Card>
            </>
          )}

          {tab === "registration" && (
            <Card title="Registration" busy={busy === "registration"} onSave={() => saveGroup("registration")}>
              <Toggle label="Registrations open" checked={form.registration.enabled} onChange={(v) => setForm({ ...form, registration: { ...form.registration, enabled: v } })} />
              <Toggle label="Require approval" checked={form.registration.requireApproval} onChange={(v) => setForm({ ...form, registration: { ...form.registration, requireApproval: v } })} />
              <F label="Default plan (when applicant picks none)">
                <Select value={form.registration.defaultPlanId || "none"} onValueChange={(v) => setForm({ ...form, registration: { ...form.registration, defaultPlanId: v === "none" ? null : v } })}>
                  <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No default</SelectItem>
                    {(data?.plans || []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </F>
              <F label="Allowed billing cycles">
                <div className="flex gap-2">
                  {(["MONTHLY", "YEARLY"] as const).map((c) => (
                    <button key={c} type="button"
                      onClick={() => {
                        const cur = form.registration.allowedBillingCycles.includes(c)
                          ? form.registration.allowedBillingCycles.filter((x) => x !== c)
                          : [...form.registration.allowedBillingCycles, c]
                        setForm({ ...form, registration: { ...form.registration, allowedBillingCycles: cur.length ? cur : [c] } })
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                        form.registration.allowedBillingCycles.includes(c)
                          ? "border-indigo-400/50 bg-indigo-600/20 text-white light:text-slate-900 light:border-indigo-400 light:bg-indigo-50 light:text-indigo-700" : "border-white/10 light:border-slate-200 text-slate-500 light:border-slate-300 light:text-slate-500"
                      }`}>
                      {c === "MONTHLY" ? "Monthly" : "Yearly"}
                    </button>
                  ))}
                </div>
              </F>
              <F label="Message shown after submission">
                <Input value={form.registration.messageOnSubmit} onChange={(e) => setForm({ ...form, registration: { ...form.registration, messageOnSubmit: e.target.value } })} className={inputCls} />
              </F>
            </Card>
          )}

          {tab === "subscription" && (
            <Card title="Subscription" busy={busy === "subscription"} onSave={() => saveGroup("subscription")}>
              <F label="Grace period (days)"><Input type="number" min={0} max={90} value={form.subscription.gracePeriodDays} onChange={(e) => setForm({ ...form, subscription: { ...form.subscription, gracePeriodDays: Number(e.target.value) || 0 } })} className={inputCls} /></F>
              <F label="Renewal reminders (days before expiry, comma-separated)">
                <Input value={form.subscription.renewalReminderDays.join(", ")}
                  onChange={(e) => setForm({ ...form, subscription: { ...form.subscription, renewalReminderDays: e.target.value.split(",").map((x) => Number(x.trim())).filter(Number.isFinite) } })}
                  className={inputCls} placeholder="7, 30, 60" />
              </F>
              <F label="Default trial days"><Input type="number" min={0} max={90} value={form.subscription.trialDays} onChange={(e) => setForm({ ...form, subscription: { ...form.subscription, trialDays: Number(e.target.value) || 0 } })} className={inputCls} /></F>
              {/* R15 — post-expiry notices + SMS toggle for expiry reminders */}
              <F label="Post-expiry notices (days AFTER expiry, comma-separated)">
                <Input value={(form.subscription.postExpiryNoticeDays || []).join(", ")}
                  onChange={(e) => setForm({ ...form, subscription: { ...form.subscription, postExpiryNoticeDays: e.target.value.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0) } })}
                  className={inputCls} placeholder="1, 7" />
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                  Rejoin/renewal nudges sent AFTER a subscription expires (the workspace stays read-only). Every attempt is
                  journaled with retry (max 3) and deduped per tenant + end date + channel.
                </p>
              </F>
              <Toggle label="Also SMS the tenant admin on expiry reminders (requires the SMS gateway in Platform Gateway)"
                checked={!!form.subscription.expirySmsEnabled}
                onChange={(v) => setForm({ ...form, subscription: { ...form.subscription, expirySmsEnabled: v } })} />

              {/* 2026-10-25 (master prompt Part H §13) — automated renewal billing & receipts */}
              <div className="space-y-3 border-t border-white/10 light:border-slate-200 pt-3">
                <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Billing &amp; notifications</p>
                <F label="Renewal invoice lead time (days before expiry)">
                  <Input type="number" min={0} max={90} value={form.subscription.invoiceLeadDays}
                    onChange={(e) => setForm({ ...form, subscription: { ...form.subscription, invoiceLeadDays: Number(e.target.value) || 0 } })}
                    className={`${inputCls} w-32`} />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                    Renewal invoices are generated automatically this many days before a subscription expires. Idempotent — one open invoice per term.
                  </p>
                </F>
                <Toggle label="Receipt email"
                  helper="Send the money receipt + thank-you email after each verified payment."
                  checked={!!form.subscription.receiptEmailEnabled}
                  onChange={(v) => setForm({ ...form, subscription: { ...form.subscription, receiptEmailEnabled: v } })} />
                <Toggle label="Thank-you email"
                  helper="The thank-you note rides along with the money receipt after each verified payment."
                  checked={!!form.subscription.thankYouEmailEnabled}
                  onChange={(v) => setForm({ ...form, subscription: { ...form.subscription, thankYouEmailEnabled: v } })} />
                <Toggle label="Rejoin offer in post-expiry emails"
                  helper="Adds the rejoin/renewal offer line to the post-expiry notice emails above."
                  checked={!!form.subscription.rejoinOfferEnabled}
                  onChange={(v) => setForm({ ...form, subscription: { ...form.subscription, rejoinOfferEnabled: v } })} />
              </div>
            </Card>
          )}

          {tab === "billing" && (
            <>
              {/* Top-Left: VAT & Mushak-6.3 Tax Settings */}
              <Card title="VAT & Mushak-6.3 Tax Settings" busy={busy === "billing"} onSave={() => saveGroup("billing")}>
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <F label="VAT Rate % (Inclusive convention for BD services)">
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        max={100}
                        value={form.billing.vatRatePercent ?? 5.0}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, vatRatePercent: Number(e.target.value) || 0 } })}
                        className={inputCls}
                      />
                      <p className="mt-1 text-[11px] text-slate-500">
                        BD Services convention: Net Base = Total / (1 + VAT/100). Default is 5.00%.
                      </p>
                    </F>
                    <F label="Company BIN (Business Identification Number)">
                      <Input
                        value={form.billing.companyBin || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, companyBin: e.target.value } })}
                        className={inputCls}
                        placeholder="009377515-0111"
                      />
                    </F>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <F label="Company Legal Name (Printed on Invoices & Mushak-6.3)">
                      <Input
                        value={form.billing.companyLegalName || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, companyLegalName: e.target.value } })}
                        className={inputCls}
                        placeholder="Finix HR Ltd."
                      />
                    </F>
                    <F label="Registered Address">
                      <Input
                        value={form.billing.companyAddress || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, companyAddress: e.target.value } })}
                        className={inputCls}
                        placeholder="House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230"
                      />
                    </F>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <F label="Company Phone">
                      <Input
                        value={form.billing.companyPhone || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, companyPhone: e.target.value } })}
                        className={inputCls}
                        placeholder="+8809643666888"
                      />
                    </F>
                    <F label="Company Email">
                      <Input
                        value={form.billing.companyEmail || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, companyEmail: e.target.value } })}
                        className={inputCls}
                        placeholder="service@finixhr.com"
                      />
                    </F>
                    <F label="Company Website">
                      <Input
                        value={form.billing.companyWebsite || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, companyWebsite: e.target.value } })}
                        className={inputCls}
                        placeholder="finixhr.com"
                      />
                    </F>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 border-t border-white/10 light:border-slate-200 pt-3">
                    <F label="Authorized Signatory Name">
                      <Input
                        value={form.billing.signatoryName || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, signatoryName: e.target.value } })}
                        className={inputCls}
                        placeholder="MD JAKARIA"
                      />
                    </F>
                    <F label="Authorized Signatory Designation">
                      <Input
                        value={form.billing.signatoryDesignation || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, signatoryDesignation: e.target.value } })}
                        className={inputCls}
                        placeholder="Executive, Admin & Operations, Finix HR Ltd."
                      />
                    </F>
                  </div>
                </div>
              </Card>

              {/* Top-Right: Bank Accounts */}
              <Card title="Bank Accounts" busy={busy === "billing"} onSave={() => saveGroup("billing")}>
                <div className="space-y-4">
                  <div className="rounded-lg border border-white/10 light:border-slate-200 p-3 space-y-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Primary Bank (City Bank)</p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <F label="Bank Name"><Input value={form.billing.primaryBankName || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, primaryBankName: e.target.value } })} className={inputCls} /></F>
                      <F label="A/C Number"><Input value={form.billing.primaryAccountNo || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, primaryAccountNo: e.target.value } })} className={inputCls} /></F>
                      <F label="Payee Name"><Input value={form.billing.primaryAccountName || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, primaryAccountName: e.target.value } })} className={inputCls} /></F>
                      <F label="Branch"><Input value={form.billing.primaryBranch || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, primaryBranch: e.target.value } })} className={inputCls} /></F>
                      <F label="Routing Number"><Input value={form.billing.primaryRouting || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, primaryRouting: e.target.value } })} className={inputCls} /></F>
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/10 light:border-slate-200 p-3 space-y-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Secondary Bank (BRAC Bank)</p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <F label="Bank Name"><Input value={form.billing.secondaryBankName || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, secondaryBankName: e.target.value } })} className={inputCls} /></F>
                      <F label="A/C Number"><Input value={form.billing.secondaryAccountNo || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, secondaryAccountNo: e.target.value } })} className={inputCls} /></F>
                      <F label="Payee Name"><Input value={form.billing.secondaryAccountName || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, secondaryAccountName: e.target.value } })} className={inputCls} /></F>
                      <F label="Branch"><Input value={form.billing.secondaryBranch || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, secondaryBranch: e.target.value } })} className={inputCls} /></F>
                      <F label="Routing Number"><Input value={form.billing.secondaryRouting || ""} onChange={(e) => setForm({ ...form, billing: { ...form.billing, secondaryRouting: e.target.value } })} className={inputCls} /></F>
                    </div>
                  </div>

                  <F label="General Bank Transfer Instructions (Displayed in tenant billing portal)">
                    <textarea
                      rows={2}
                      value={form.billing.bankTransferInstructions || ""}
                      onChange={(e) => setForm({ ...form, billing: { ...form.billing, bankTransferInstructions: e.target.value } })}
                      className="w-full rounded-md border border-white/10 light:border-slate-300 bg-white/5 light:bg-white p-2.5 text-sm"
                      placeholder="Optional notes or remittance instructions displayed to tenants..."
                    />
                  </F>
                </div>
              </Card>

              {/* Full Width Row: Mobile Financial Services */}
              <div className="xl:col-span-2">
                <Card title="Mobile Financial Services (MFS / Bangla QR / bKash / Nagad)" busy={busy === "billing"} onSave={() => saveGroup("billing")}>
                  <div className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <F label="Provider Name (e.g. bKash / Bangla QR, Nagad, Bangla QR)">
                        <Input
                          value={form.billing.mfsProviderName || ""}
                          onChange={(e) => setForm({ ...form, billing: { ...form.billing, mfsProviderName: e.target.value } })}
                          className={inputCls}
                          placeholder="bKash / Bangla QR"
                        />
                      </F>
                      <F label="Merchant / Wallet Number">
                        <Input
                          value={form.billing.mfsMerchantNumber || form.billing.bkashMerchantNumber || ""}
                          onChange={(e) => setForm({ ...form, billing: { ...form.billing, mfsMerchantNumber: e.target.value, bkashMerchantNumber: e.target.value } })}
                          className={inputCls}
                          placeholder="01943223366"
                        />
                      </F>
                    </div>

                    <F label="Payment QR Code (Bangla QR / bKash / Nagad QR Image)">
                      <div className="flex items-center gap-4 rounded-lg border border-white/10 p-3 bg-white/5 dark:bg-slate-800/40">
                        {form.billing.mfsQrUrl ? (
                          <img src={form.billing.mfsQrUrl} alt="Payment QR" className="h-24 w-24 object-contain rounded bg-white p-1.5 shadow-sm" />
                        ) : (
                          <div className="h-24 w-24 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white/10 flex flex-col items-center justify-center text-center p-2">
                            <span className="text-[11px] text-slate-400 font-medium">Auto-generated if empty</span>
                          </div>
                        )}
                        <div className="space-y-1.5 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="file"
                              id="mfs-qr-upload"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0]
                                if (!file) return
                                const res = await validateAndProcessImage(file, { label: "Payment QR", maxDimension: 400, requireSquare: true, maxSizeBytes: 1024 * 1024 })
                                if (res.error) alert(res.error)
                                else if (res.dataUrl) setForm({ ...form, billing: { ...form.billing, mfsQrUrl: res.dataUrl } })
                                e.target.value = ""
                              }}
                            />
                            <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs cursor-pointer">
                              <label htmlFor="mfs-qr-upload">
                                <Upload className="h-3.5 w-3.5" /> {form.billing.mfsQrUrl ? "Change QR Image" : "Upload QR Image"}
                              </label>
                            </Button>
                            {form.billing.mfsQrUrl && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 gap-1 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                                onClick={() => setForm({ ...form, billing: { ...form.billing, mfsQrUrl: "" } })}
                              >
                                <X className="h-3.5 w-3.5" /> Remove (Use Auto QR)
                              </Button>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400">
                            Recommended: Square 1:1 image (max 1MB). Displayed on 1-page Invoices and tenant payment dialogs.
                          </p>
                        </div>
                      </div>
                    </F>

                    <F label="Step-by-Step Payment Instructions (Printed on Invoices)">
                      <textarea
                        rows={2}
                        value={form.billing.mfsInstructions || ""}
                        onChange={(e) => setForm({ ...form, billing: { ...form.billing, mfsInstructions: e.target.value } })}
                        className="w-full rounded-md border border-white/10 light:border-slate-300 bg-white/5 light:bg-white p-2.5 text-sm"
                        placeholder="Scan QR code with bKash / Nagad / Bangla QR app. Enter Invoice Number as Reference & verify amount before payment."
                      />
                    </F>
                  </div>
                </Card>
              </div>
            </>
          )}

          {tab === "security" && (
            <Card title="Security" busy={busy === "security"} onSave={() => saveGroup("security")}>
              <Toggle label="Require MFA for owner users (enforced at sign-in — unenrolled owners are taken through enrollment)" checked={form.security.ownerMfaRequired} onChange={(v) => setForm({ ...form, security: { ...form.security, ownerMfaRequired: v } })} />
              <F label="Owner session length (days, 1–30)"><Input type="number" min={1} max={30} value={form.security.sessionDays} onChange={(e) => setForm({ ...form, security: { ...form.security, sessionDays: Number(e.target.value) || 7 } })} className={inputCls} /></F>
              <F label="Lockout threshold (failed attempts)"><Input type="number" min={1} value={form.security.lockoutThreshold} onChange={(e) => setForm({ ...form, security: { ...form.security, lockoutThreshold: Number(e.target.value) || 5 } })} className={inputCls} /></F>
              <F label="Lockout minutes"><Input type="number" min={1} value={form.security.lockoutMinutes} onChange={(e) => setForm({ ...form, security: { ...form.security, lockoutMinutes: Number(e.target.value) || 15 } })} className={inputCls} /></F>
            </Card>
          )}

          {tab === "communication" && (
            <Card title="Communication" busy={busy === "communication"} onSave={() => saveGroup("communication")}>
              <Toggle label="Notify owner team on new registration applications" checked={form.communication.notifyOnRegistration} onChange={(v) => setForm({ ...form, communication: { ...form.communication, notifyOnRegistration: v } })} />
              <Toggle label="Email applicants on approval / rejection" checked={form.communication.notifyOnApproval} onChange={(v) => setForm({ ...form, communication: { ...form.communication, notifyOnApproval: v } })} />
              <Toggle label="Send applicants a thank-you / application-received email (tracking no + tracking link) on submission" checked={form.communication.notifyApplicantOnSubmit} onChange={(v) => setForm({ ...form, communication: { ...form.communication, notifyApplicantOnSubmit: v } })} />
              <F label="Expiry reminders (days before subscription ends, comma-separated)">
                <Input value={form.communication.notifyOnExpiryDays.join(", ")}
                  onChange={(e) => setForm({ ...form, communication: { ...form.communication, notifyOnExpiryDays: e.target.value.split(",").map((x) => Number(x.trim())).filter(Number.isFinite) } })}
                  className={inputCls} placeholder="7, 30" />
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                  Sent once per tenant per end-date through the platform gateway (owners + tenant admin). Every attempt —
                  sent, skipped or failed — is visible in the notifications bell and the audit log.
                </p>
              </F>
            </Card>
          )}

          {tab === "alerts" && <AlertRoutingCard form={form} patch={(next) => setForm({ ...form, alerts: next })} onSave={() => saveGroup("alerts")} busy={busy === "alerts"} />}

          {tab === "account" && (
            <>
              <MyAccountMfaCard />
              <MyAccountPasskeysCard />
            </>
          )}
          {tab === "gateway" && <PlatformGatewayCard />}
        </div>
      )}
    </div>
  )
}

// ==================== Phase 5 P0 (Scope 5) — Alert Routing ====================
// Outbound webhook for platform incidents (backup / restore-drill failures).
// Sends ride the SSRF-guarded signed-POST path (DNS rebinding blocked,
// redirects refused, HMAC-SHA256 when a secret is set). The test button
// fires the EXACT same code path a real incident takes.
function AlertRoutingCard({ form, patch, onSave, busy }: { form: Settings; patch: (next: Settings["alerts"]) => void; onSave: () => void; busy: boolean }) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ status: string; detail?: string } | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  const sendTest = async () => {
    setTesting(true); setTestError(null); setTestResult(null)
    try {
      const d = await ownerRpc<{ status: string; detail?: string }>("owner.alerts.testWebhook", {})
      setTestResult({ status: d.status, detail: d.detail })
    } catch (e: any) {
      setTestError(e?.message || "Test send failed")
    } finally { setTesting(false) }
  }

  const tone = (status: string) =>
    status === "SENT" ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300 light:text-emerald-700"
    : status === "FAILED" ? "border-rose-400/40 bg-rose-500/10 text-rose-300 light:text-rose-600"
    : "border-slate-400/40 bg-slate-500/10 light:bg-slate-200 text-slate-400 light:text-slate-600"

  return (
    <Card title="Alert Routing (Webhook)" busy={busy} onSave={onSave}>
      <F label="Webhook URL (https:// — leave empty to disable)">
        <Input value={form.alerts.webhookUrl} onChange={(e) => patch({ ...form.alerts, webhookUrl: e.target.value })}
          className={inputCls} placeholder="https://hooks.example.com/finix-alerts" />
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          Platform incidents (backup failures, restore-drill failures) are POSTed here as JSON. Sends are signed with
          HMAC-SHA256 when a secret is set, resolved at send time (DNS rebinding to internal addresses is blocked) and
          never follow redirects.
        </p>
      </F>
      <F label="Signing secret (optional)">
        <Input value={form.alerts.webhookSecret} onChange={(e) => patch({ ...form.alerts, webhookSecret: e.target.value })}
          className={inputCls} placeholder="whsec_…" />
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          Sent as the <code className="rounded bg-white/10 px-1 py-0.5 text-[10px]">x-finx-signature</code> header —
          <span className="mx-1 font-mono text-[10px]">sha256=HMAC(secret, body)</span>. Verify it on your side.
        </p>
      </F>
      <Toggle label="Fire the webhook on backup / restore-drill failures" checked={form.alerts.webhookOnBackupFailure}
        onChange={(v) => patch({ ...form.alerts, webhookOnBackupFailure: v })} />
      {/* ---- Phase 5 P1 — quota threshold alerts ---- */}
      <F label="Quota threshold (% of plan cap at which the daily pass alerts)">
        <Input value={String(form.alerts.quotaThresholdPercent)} type="number" min={50} max={100} step={5}
          onChange={(e) => {
            const n = Number(e.target.value)
            patch({ ...form.alerts, quotaThresholdPercent: Number.isFinite(n) ? n : form.alerts.quotaThresholdPercent })
          }}
          className={`${inputCls} w-32`} />
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          The daily platform pass checks every subscribed tenant&apos;s utilization. At/above this percentage it fires one
          digest (owner email{form.alerts.webhookUrl.trim() ? " + the webhook above" : "; configure the webhook above to also POST it"}) —
          deduped per tenant per quota per calendar month. Clamped to 50–100.
        </p>
      </F>
      <Toggle label="Enable quota threshold alerts (the daily digest)" checked={form.alerts.quotaAlertsEnabled}
        onChange={(v) => patch({ ...form.alerts, quotaAlertsEnabled: v })} />
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button size="sm" onClick={sendTest} disabled={testing || !form.alerts.webhookUrl.trim()}
          className="h-9 bg-gradient-to-r from-blue-600 to-violet-600 text-white light:text-slate-900">
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send test alert
        </Button>
        {testError && <span className="text-xs text-rose-300 light:text-rose-600">{testError}</span>}
        {testResult && (
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-widest ${tone(testResult.status)}`}>
            {testResult.status}
            {testResult.detail ? <span className="font-normal normal-case tracking-normal opacity-80">{testResult.detail}</span> : null}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Email alerts to the owner team are unaffected — the webhook is an additional channel. Every attempt (sent,
        skipped, failed) appears in the notifications bell and the audit log.
      </p>
    </Card>
  )
}

// ============================ My Account — MFA ============================
function MyAccountMfaCard() {
  const { data, loading, error, reload: reloadMfa } = useOwnerApi<{ mfaEnrolled: boolean; platformRequires: boolean }>("owner.auth.mfa.status", {})
  const [pw, setPw] = useState("")
  const [code, setCode] = useState("")
  const [qr, setQr] = useState("")
  const [secret, setSecret] = useState("")
  const [stage, setStage] = useState<"idle" | "scan" | "codes">("idle")
  const [codes, setCodes] = useState<string[]>([])
  const [disablePw, setDisablePw] = useState("")
  const [disableCode, setDisableCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (loading) return <Card title="My Account — Security"><p className="text-xs text-slate-500">Loading…</p></Card>
  if (error) return <Card title="My Account — Security"><ErrorBanner message={error} /></Card>

  const enrolled = !!data?.mfaEnrolled

  const start = async () => {
    setErr(null); setBusy(true)
    try {
      const d = await ownerRpc<{ secret: string; qrDataUrl: string }>("owner.auth.mfa.selfEnroll.start", { password: pw })
      setQr(d.qrDataUrl); setSecret(d.secret); setStage("scan"); setCode("")
    } catch (e: any) { setErr(e?.message || "Could not start enrollment") } finally { setBusy(false) }
  }

  const confirm = async () => {
    setErr(null); setBusy(true)
    try {
      const d = await ownerRpc<{ recoveryCodes: string[] }>("owner.auth.mfa.selfEnroll.complete", { code })
      setCodes(d.recoveryCodes || []); setStage("codes")
    } catch (e: any) { setErr(e?.message || "Verification failed") } finally { setBusy(false) }
  }

  const disable = async () => {
    setErr(null); setBusy(true)
    try {
      await ownerRpc("owner.auth.mfa.disable", { password: disablePw, code: disableCode })
      setDisablePw(""); setDisableCode(""); reloadMfa()
    } catch (e: any) { setErr(e?.message || "Could not disable MFA") } finally { setBusy(false) }
  }

  return (
    <Card title="My Account — Two-Factor Authentication">
      {err && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-2.5 text-xs text-red-300 light:text-red-600 light:border-red-300 light:bg-red-50 light:text-red-700">{err}</p>}
      {stage === "codes" ? (
        <>
          <p className="flex gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200 light:text-amber-700 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Save these recovery codes now — each works exactly once if you lose your device. They will never be shown again.
          </p>
          <ul className="grid grid-cols-2 gap-1.5">
            {codes.map((c) => (
              <li key={c} className="select-all rounded border border-white/10 light:border-slate-200 bg-white/5 light:bg-slate-100 px-2 py-1.5 text-center font-mono text-[11px] text-slate-200 light:text-slate-800 light:border-slate-200 light:bg-slate-50 light:text-slate-800">{c}</li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="text-xs" onClick={() => navigator.clipboard?.writeText(codes.join("\n")).catch(() => {})}>
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy all codes
          </Button>
          <Button size="sm" className="bg-emerald-600 text-xs hover:bg-emerald-700" onClick={() => { setStage("idle"); setPw(""); reloadMfa() }}>
            Done
          </Button>
        </>
      ) : stage === "scan" ? (
        <>
          {qr && <div className="flex justify-center"><img src={qr} alt="TOTP QR code" width={180} height={180} className="rounded-lg border border-white/10 light:border-slate-200 bg-white p-1 light:border-slate-200" /></div>}
          {secret && <p className="break-all text-[11px] text-slate-500">Manual key: <span className="select-all font-mono text-slate-300 light:text-slate-700">{secret}</span></p>}
          <F label="6-digit code from your app">
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className={`${inputCls} text-center font-mono tracking-[0.3em]`} placeholder="••••••" />
          </F>
          <div className="flex gap-2">
            <Button size="sm" className="bg-emerald-600 text-xs hover:bg-emerald-700" disabled={busy || code.length < 6} onClick={confirm}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Enable MFA</>}
            </Button>
            <Button size="sm" variant="outline" className="text-xs" onClick={() => setStage("idle")}>Cancel</Button>
          </div>
        </>
      ) : enrolled ? (
        <>
          <p className="flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300 light:text-emerald-700 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-700">
            <ShieldCheck className="h-4 w-4 shrink-0" /> MFA is enabled for your account — sign-in requires your authenticator code.
          </p>
          <F label="Account password (to disable MFA)">
            <Input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} className={inputCls} autoComplete="current-password" />
          </F>
          <F label="Current 6-digit code">
            <Input value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className={`${inputCls} text-center font-mono tracking-[0.3em]`} placeholder="••••••" autoComplete="one-time-code" />
          </F>
          <Button size="sm" variant="outline" className="text-xs text-red-300 light:text-red-600 hover:bg-red-500/10 light:text-red-600 light:hover:bg-red-50" disabled={busy || !disablePw || disableCode.length < 6} onClick={disable}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><ShieldOff className="mr-1.5 h-3.5 w-3.5" /> Disable MFA</>}
          </Button>
        </>
      ) : (
        <>
          <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-400 light:text-slate-600 light:border-slate-200 light:bg-slate-50 light:text-slate-600">
            MFA is <span className="font-semibold">not enabled</span> for your account.{" "}
            {data?.platformRequires
              ? "Platform policy requires it — you will be asked to enroll at your next sign-in."
              : "Protect console access with a TOTP app (Google/Microsoft Authenticator, 1Password…)."}
          </p>
          <F label="Confirm your account password">
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className={inputCls} autoComplete="current-password" />
          </F>
          <Button size="sm" className="bg-emerald-600 text-xs hover:bg-emerald-700" disabled={busy || !pw} onClick={start}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><KeyRound className="mr-1.5 h-3.5 w-3.5" /> Start enrollment</>}
          </Button>
        </>
      )}
    </Card>
  )
}

// ============================ My Account — Passkeys ============================
// WebAuthn passkey manager (Face ID / Touch ID / Windows Hello): mirrors the
// tenant-side SecurityPasskeysDialog against owner.passkey.*. Enrollment and
// management ONLY — owner sign-in stays password + TOTP (no
// owner.passkey.login.* by design). Biometrics never leave the device: the
// authenticator only asserts a signed user-verified flag.
type OwnerPasskeyItem = {
  id: string
  deviceName: string
  backupEligible: boolean
  backupState: boolean
  lastUsedAt: string | null
  createdAt: string
}

function MyAccountPasskeysCard() {
  const { data, loading, error, reload: reloadPasskeys } = useOwnerApi<{ items: OwnerPasskeyItem[] }>("owner.passkey.list", {})
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<OwnerPasskeyItem | null>(null)
  const [removePw, setRemovePw] = useState("")
  // WebAuthn needs a secure context — hide the button (not the explanation)
  const supported = browserSupportsWebAuthn()

  if (loading) return <Card title="My Account — Passkeys"><p className="text-xs text-slate-500">Loading…</p></Card>
  if (error) return <Card title="My Account — Passkeys"><ErrorBanner message={error} /></Card>

  const items = data?.items || []

  const add = async () => {
    setErr(null); setBusy(true)
    try {
      const start = await ownerRpc<{ options: any }>("owner.passkey.register.start", {})
      // the OS/browser takes over: biometric or PIN prompt
      const attestation = await startRegistration({ optionsJSON: start.options })
      await ownerRpc("owner.passkey.register.finish", { name: label.trim() || undefined, attestation })
      setLabel(""); reloadPasskeys()
    } catch (e: any) { setErr(e?.message || "Passkey registration failed") } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!removeTarget) return
    setErr(null); setBusy(true)
    try {
      await ownerRpc("owner.passkey.remove", { id: removeTarget.id, password: removePw })
      setRemoveTarget(null); setRemovePw(""); reloadPasskeys()
    } catch (e: any) { setErr(e?.message || "Could not remove the passkey") } finally { setBusy(false) }
  }

  return (
    <Card title="My Account — Passkeys (Biometric)">
      {err && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-2.5 text-xs text-red-300 light:text-red-600 light:border-red-300 light:bg-red-50 light:text-red-700">{err}</p>}
      {!supported && (
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200 light:text-amber-700 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
          This browser (or the non-HTTPS connection) does not support passkeys — WebAuthn requires a modern browser over HTTPS.
        </p>
      )}
      {items.length === 0 ? (
        <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-400 light:text-slate-600">
          No passkeys registered. A passkey lets a supported device prove it is you with Face&nbsp;ID / Touch&nbsp;ID / Windows&nbsp;Hello —
          an additional enrolled factor for this console account (sign-in stays password + authenticator code for now).
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((k) => (
            <li key={k.id} className="flex items-center gap-3 rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
                <Fingerprint className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-slate-100 light:text-slate-800">{k.deviceName}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {k.backupEligible ? (k.backupState ? "Synced passkey" : "Synced-capable") : "Device-bound"}
                  {" · "}added {new Date(k.createdAt).toLocaleDateString()}
                  {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}
                </p>
              </div>
              <Button size="sm" variant="outline" className="text-xs" disabled={busy || !!removeTarget}
                onClick={() => { setRemoveTarget(k); setRemovePw(""); setErr(null) }}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removeTarget && (
        <div className="space-y-2 rounded-lg border border-red-400/30 bg-red-500/5 light:border-red-300 light:bg-red-50 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-red-300 light:text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Remove “{removeTarget.deviceName}”?
          </p>
          <F label="Account password (required)">
            <Input type="password" value={removePw} onChange={(e) => setRemovePw(e.target.value)} className={inputCls} autoComplete="current-password" />
          </F>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="text-xs" disabled={busy} onClick={() => { setRemoveTarget(null); setRemovePw(""); setErr(null) }}>Cancel</Button>
            <Button size="sm" className="bg-red-600 text-xs hover:bg-red-700" disabled={busy || !removePw} onClick={remove}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />} Remove passkey
            </Button>
          </div>
        </div>
      )}
      <F label="Device label (optional)">
        <Input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} className={inputCls} placeholder="e.g. MacBook — Touch ID" disabled={busy} />
      </F>
      <Button size="sm" className="bg-emerald-600 text-xs hover:bg-emerald-700" disabled={busy || !supported} onClick={add}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
        {busy ? "Waiting for your device…" : "Add passkey"}
      </Button>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Your biometrics never leave your device — the console only stores each passkey’s public key and a signature counter.
      </p>
    </Card>
  )
}

// ============================ Platform Gateway ============================
function PlatformGatewayCard() {
  const { data, loading, error } = useOwnerApi<{ gateway: Gateway }>("owner.gateway.get", {})
  const [g, setG] = useState<Gateway | null>(null)
  const [busy, setBusy] = useState(false)
  const [testTo, setTestTo] = useState("")
  const [testSmsTo, setTestSmsTo] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (data?.gateway) setG(JSON.parse(JSON.stringify(data.gateway))) }, [data])

  if (loading) return <Card title="Platform Gateway (Email / SMS)"><p className="text-xs text-slate-500">Loading…</p></Card>
  if (error) return <Card title="Platform Gateway (Email / SMS)"><ErrorBanner message={error} /></Card>
  if (!g) return null

  const save = async () => {
    setBusy(true); setErr(null); setMsg(null)
    try {
      const res = await ownerRpc<{ gateway: Gateway }>("owner.gateway.save", {
        emailEnabled: g.email.enabled, emailHost: g.email.host, emailPort: g.email.port, emailSecure: g.email.secure,
        emailUsername: g.email.username, emailPassword: g.email.password,
        emailFromAddress: g.email.fromAddress, emailFromName: g.email.fromName,
        smsEnabled: g.sms.enabled, smsApiUrl: g.sms.apiUrl, smsMethod: g.sms.method,
        smsSenderId: g.sms.senderId, smsApiKey: g.sms.apiKey,
        smsProvider: g.sms.provider || "none",
      })
      setG(res.gateway); setMsg("Gateway settings saved."); setTimeout(() => setMsg(null), 4000)
    } catch (e: any) { setErr(e?.message || "Save failed") } finally { setBusy(false) }
  }

  const testOtp = async () => {
    setBusy(true); setErr(null); setMsg(null)
    try {
      const res = await ownerRpc<{ sent: boolean; expiresAt: string }>("owner.sms.testOtp", { toPhone: testSmsTo })
      setMsg(`Test OTP delivered — expires ${new Date(res.expiresAt).toLocaleTimeString()}. Check the phone.`)
    } catch (e: any) { setErr(e?.message || "OTP test failed") } finally { setBusy(false) }
  }

  const test = async () => {
    setBusy(true); setErr(null); setMsg(null)
    try {
      const res = await ownerRpc<{ status: string; detail?: string }>("owner.gateway.test", { to: testTo })
      setMsg(`Test email: ${res.status}${res.detail ? ` — ${res.detail}` : ""}`)
    } catch (e: any) { setErr(e?.message || "Test failed") } finally { setBusy(false) }
  }

  return (
    <Card title="Platform Gateway (Email / SMS)" onSave={save} busy={busy}>
      {err && <p className="rounded-lg border border-red-400/30 bg-red-500/10 p-2.5 text-xs text-red-300 light:text-red-600 light:border-red-300 light:bg-red-50 light:text-red-700">{err}</p>}
      {msg && <p className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300 light:text-emerald-700 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-700">{msg}</p>}
      <Toggle label="Email gateway enabled (SMTP)" checked={g.email.enabled} onChange={(v) => setG({ ...g, email: { ...g.email, enabled: v } })} />
      <F label="SMTP host"><Input value={g.email.host} onChange={(e) => setG({ ...g, email: { ...g.email, host: e.target.value } })} className={inputCls} placeholder="smtp.gmail.com" /></F>
      <div className="grid grid-cols-2 gap-3">
        <F label="Port"><Input type="number" value={g.email.port} onChange={(e) => setG({ ...g, email: { ...g.email, port: Number(e.target.value) || 587 } })} className={inputCls} /></F>
        <F label="Use TLS/SSL (port 465)">
          <Select value={g.email.secure ? "yes" : "no"} onValueChange={(v) => setG({ ...g, email: { ...g.email, secure: v === "yes" } })}>
            <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="no">STARTTLS (587)</SelectItem><SelectItem value="yes">Implicit TLS (465)</SelectItem></SelectContent>
          </Select>
        </F>
      </div>
      <F label="SMTP username"><Input value={g.email.username} onChange={(e) => setG({ ...g, email: { ...g.email, username: e.target.value } })} className={inputCls} /></F>
      <F label={`SMTP password${g.email.hasPassword ? " (saved — leave blank to keep)" : ""}`}>
        <Input type="password" value={g.email.password} onChange={(e) => setG({ ...g, email: { ...g.email, password: e.target.value } })} className={inputCls} placeholder={g.email.hasPassword ? "•••••••• (unchanged)" : "app password"} />
      </F>
      <div className="grid grid-cols-2 gap-3">
        <F label="From address"><Input value={g.email.fromAddress} onChange={(e) => setG({ ...g, email: { ...g.email, fromAddress: e.target.value } })} className={inputCls} placeholder="no-reply@example.com" /></F>
        <F label="From name"><Input value={g.email.fromName} onChange={(e) => setG({ ...g, email: { ...g.email, fromName: e.target.value } })} className={inputCls} /></F>
      </div>

      <div className="border-t border-white/10 light:border-slate-200 pt-3 light:border-slate-200">
        <Toggle label="SMS gateway enabled" checked={g.sms.enabled} onChange={(v) => setG({ ...g, sms: { ...g.sms, enabled: v } })} />
        <F label="SMS provider (adapter)">
          <Select value={g.sms.provider || "none"} onValueChange={(v) => setG({ ...g, sms: { ...g.sms, provider: v } })}>
            <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None / legacy template</SelectItem>
              <SelectItem value="sslwireless">SSLWireless (iSMS Plus v3)</SelectItem>
              <SelectItem value="generichttp">Generic HTTP (URL template)</SelectItem>
            </SelectContent>
          </Select>
        </F>
        <F label={g.sms.provider === "sslwireless" ? "API token (api_token)" : "API URL (supports {phone} {message} {sender} {apiKey})"}>
          <Input value={g.sms.apiUrl} onChange={(e) => setG({ ...g, sms: { ...g.sms, apiUrl: e.target.value } })} className={inputCls} placeholder={g.sms.provider === "sslwireless" ? "https://smsplus.sslwireless.com (optional override)" : "https://provider.example/api/send"} />
        </F>
        <div className="grid grid-cols-2 gap-3">
          <F label="HTTP method">
            <Select value={g.sms.method} onValueChange={(v) => setG({ ...g, sms: { ...g.sms, method: v as "GET" | "POST" } })}>
              <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="POST">POST</SelectItem><SelectItem value="GET">GET</SelectItem></SelectContent>
            </Select>
          </F>
          <F label={g.sms.provider === "sslwireless" ? "Sender ID (sid)" : "Sender ID"}><Input value={g.sms.senderId} onChange={(e) => setG({ ...g, sms: { ...g.sms, senderId: e.target.value } })} className={inputCls} /></F>
        </div>
        <F label={`API key${g.sms.hasApiKey ? " (saved — leave blank to keep)" : ""}`}>
          <Input type="password" value={g.sms.apiKey} onChange={(e) => setG({ ...g, sms: { ...g.sms, apiKey: e.target.value } })} className={inputCls} placeholder={g.sms.hasApiKey ? "•••••••• (unchanged)" : "key"} />
        </F>
        <p className="text-[11px] leading-relaxed text-slate-500">
          SSLWireless uses the official iSMS Plus v3 push API (api_token + sid); the generic template keeps any legacy HTTP gateway working. Every send — platform and tenant — is journaled in the SMS delivery journal; OTP messages are never retried.
        </p>
      </div>

      <div className="border-t border-white/10 light:border-slate-200 pt-3 light:border-slate-200">
        <F label="Send a test email">
          <div className="flex gap-2">
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} className={inputCls} placeholder="you@example.com" type="email" />
            <Button size="sm" className="shrink-0 bg-white/10 light:bg-slate-200 text-xs text-white light:text-slate-900 hover:bg-white/20 light:hover:bg-slate-300 light:bg-slate-900 light:text-white light:hover:bg-slate-800" disabled={busy || !testTo} onClick={test}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Send className="mr-1.5 h-3.5 w-3.5" /> Test</>}
            </Button>
          </div>
        </F>
        <F label="Send a test OTP (SMS)">
          <div className="flex gap-2">
            <Input value={testSmsTo} onChange={(e) => setTestSmsTo(e.target.value)} className={inputCls} placeholder="+8801XXXXXXXXX" />
            <Button size="sm" className="shrink-0 bg-white/10 light:bg-slate-200 text-xs text-white light:text-slate-900 hover:bg-white/20 light:hover:bg-slate-300 light:bg-slate-900 light:text-white light:hover:bg-slate-800" disabled={busy || testSmsTo.length < 10} onClick={testOtp}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Send className="mr-1.5 h-3.5 w-3.5" /> Send OTP</>}
            </Button>
          </div>
        </F>
        <SmsJournalStrip />
        <p className="text-[11px] leading-relaxed text-slate-500">
          Unconfigured channels are skipped transparently — every attempt remains visible in the notifications bell.
          The SMS URL is validated (https, public hosts only) at save and send time.
        </p>
      </div>
    </Card>
  )
}

/** Wave 10 — SMS delivery-journal strip (last 24h sent/failed/skipped + the
 *  active providers), straight from the SaasSmsMessage journal. */
function SmsJournalStrip() {
  const { data } = useOwnerApi<{
    stats: { last24h: { sent: number; failed: number; skipped: number }; last7d: { sent: number; failed: number }; activeProviders: string[] } | null
  }>("owner.sms.journal", { take: 1 })
  if (!data?.stats) return null
  const s = data.stats
  return (
    <p className="rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-2.5 text-[11px] text-slate-400">
      SMS journal (24h): <b className="text-emerald-300">{s.last24h.sent} sent</b> · <b className="text-rose-300">{s.last24h.failed} failed</b> · {s.last24h.skipped} skipped
      {s.activeProviders.length > 0 && <> · active: {s.activeProviders.join(", ")}</>}
    </p>
  )
}

function Card({ title, children, onSave, busy }: { title: string; children: React.ReactNode; onSave?: () => void; busy?: boolean }) {
  return (
    <section className="rounded-2xl border border-white/10 light:border-slate-200 bg-white/[0.03] light:bg-slate-100/60 p-5 light:border-slate-200 light:bg-white light:shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-white light:text-slate-900">{title}</p>
        {onSave && (
          <Button size="sm" onClick={onSave} disabled={busy} className="bg-white/10 light:bg-slate-200 text-white light:text-slate-900 hover:bg-white/20 light:hover:bg-slate-300 light:bg-slate-900 light:text-white light:hover:bg-slate-800">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Save className="h-3.5 w-3.5" /> Save</>}
          </Button>
        )}
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  )
}
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-slate-400 light:text-slate-600">{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}
function Toggle({ label, checked, onChange, helper }: { label: string; checked: boolean; onChange: (v: boolean) => void; helper?: string }) {
  return (
    <div>
      <label className="flex items-center justify-between rounded-lg border border-white/10 light:border-slate-200 bg-white/[0.02] light:bg-slate-50 p-3 light:border-slate-200 light:bg-slate-50">
        <span className="pr-3 text-xs text-slate-300 light:text-slate-700">{label}</span>
        <Switch checked={checked} onCheckedChange={onChange} />
      </label>
      {helper && <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{helper}</p>}
    </div>
  )
}
