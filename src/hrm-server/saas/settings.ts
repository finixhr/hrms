// ============ Platform settings (SaaSSetting) with typed defaults ============
// Global knobs for the SaaS business layer. Mirrors the tenant HrSetting
// accessor pattern (group/key/value JSON + a typed getter) but with no
// vendorId — these apply platform-wide.
import { db } from "@/lib/db"

export type SaasSettings = {
  general: {
    platformName: string
    supportEmail: string
    supportPhone: string
    websiteUrl: string
    tagline: string
    address: string
    logoUrl: string
    appLogoUrl: string
    faviconUrl: string
    sealUrl: string
    signatureUrl: string
    signatoryName: string
    signatoryDesignation: string
  }
  registration: {
    enabled: boolean
    requireApproval: boolean
    defaultPlanId: string | null
    allowedBillingCycles: string[]
    messageOnSubmit: string
  }
  subscription: {
    gracePeriodDays: number
    renewalReminderDays: number[]
    trialDays: number
    // R15 (2026-10-12) — expiry automation: reminders AFTER expiry (rejoin /
    // renewal nudges), SMS channel toggle, and the rejoin-offer line in
    // post-expiry emails. Every notice attempt is logged (SaasExpiryNotice)
    // with dedupe + retry.
    postExpiryNoticeDays: number[]
    expirySmsEnabled: boolean
    rejoinOfferEnabled: boolean
    // 2026-10-25 (master prompt Part H §13) — automated renewal billing:
    // invoice lead time + receipt/thank-you email toggles.
    invoiceLeadDays: number
    receiptEmailEnabled: boolean
    thankYouEmailEnabled: boolean
  }
  security: {
    ownerMfaRequired: boolean
    sessionDays: number
    lockoutThreshold: number
    lockoutMinutes: number
  }
  // ---- Wave 2 WP-H (2026-10-08) & Mushak-6.3 Tax Settings (2026-10-26) ----
  // Platform billing, tax/VAT rate, bank transfer and bKash instructions.
  // Owner-writable through the existing owner.settings.save action.
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
    mfsProviderName: string
    mfsMerchantNumber: string
    mfsQrUrl: string
    mfsInstructions: string
  }
  communication: {
    // The platform layer deliberately does NOT duplicate the tenant email/SMS
    // gateway stack. Owner-side notifications are recorded in the owner
    // console; when a platform gateway is configured, sends go out — otherwise
    // they are skipped transparently (same SKIPPED/SENT/FAILED contract).
    notifyOnRegistration: boolean
    notifyOnApproval: boolean
    // applicant-facing "application received" thank-you email (tracking no +
    // tracking link) sent right after a successful public.register
    notifyApplicantOnSubmit: boolean
    notifyOnExpiryDays: number[]
  }
  // ---- Phase 5 P0 (Scope 5) — alert routing (webhook) ----
  // Optional outbound webhook for platform incidents (backup failures,
  // restore-drill failures). Sends ride the SAME SSRF-guarded signed-POST
  // path as tenant webhooks (security.ts resolveOutboundUrl + HMAC +
  // redirect: manual). Empty URL = disabled (email alerts stay as-is).
  alerts: {
    webhookUrl: string
    webhookSecret: string
    webhookOnBackupFailure: boolean
    // ---- Phase 5 P1 — quota threshold alerts ----
    // Master switch + utilization percentage at which the daily platform
    // pass fires QUOTA_THRESHOLD alerts (owner email digest + the webhook
    // above when configured). Clamped to 50..100 at the read site.
    quotaAlertsEnabled: boolean
    quotaThresholdPercent: number
  }
}

export const DEFAULT_SAAS_SETTINGS: SaasSettings = {
  general: {
    platformName: "Finix HR",
    supportEmail: "support@finixhr.com",
    supportPhone: "+8809643666888",
    websiteUrl: "https://hrm.finixmart.com.bd",
    tagline: "Standalone HRM & Workforce Platform",
    address: "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
    logoUrl: "",
    appLogoUrl: "",
    faviconUrl: "",
    sealUrl: "",
    signatureUrl: "",
    signatoryName: "MD JAKARIA",
    signatoryDesignation: "Executive, Admin & Operations, Finix HR Ltd.",
  },
  registration: {
    enabled: true,
    requireApproval: true,
    defaultPlanId: null,
    allowedBillingCycles: ["MONTHLY", "YEARLY"],
    messageOnSubmit:
      "Registration submitted successfully. Keep your Application ID — you can track its status anytime on the Registration Status page.",
  },
  subscription: {
    gracePeriodDays: 7,
    renewalReminderDays: [7, 30, 60],
    trialDays: 14,
    postExpiryNoticeDays: [1, 7],
    expirySmsEnabled: false,
    rejoinOfferEnabled: true,
    // 2026-10-25 (master prompt Part H §13) — automated renewal billing:
    // invoiceLeadDays = days before endDate the renewal invoice is generated
    // (idempotent per term); receiptEmailEnabled/thankYouEmailEnabled gate the
    // post-payment money-receipt email.
    invoiceLeadDays: 14,
    receiptEmailEnabled: true,
    thankYouEmailEnabled: true,
  },
  security: {
    // SEC-5 (Phase 1) — owner MFA now DEFAULTS ON. Owner-console accounts are
    // the most powerful identities on the platform (billing, every tenant's
    // data); an unenrolled owner signing in with a password alone is no longer
    // an acceptable default. The login flow already supports the forced
    // first-login enrollment wizard (mfaEnrollmentRequired → enrollToken), so
    // an owner without a second factor is walked through enrollment before any
    // session is issued. Deployments that explicitly saved ownerMfaRequired in
    // the console keep their stored choice.
    ownerMfaRequired: true,
    sessionDays: 7,
    lockoutThreshold: 5,
    lockoutMinutes: 15,
  },
  billing: {
    vatRatePercent: 5.0,
    companyLegalName: "Finix HR Ltd.",
    companyBin: "009377515-0111",
    companyAddress: "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
    companyPhone: "+8809643666888",
    companyEmail: "service@finixhr.com",
    companyWebsite: "finixhr.com",
    signatoryName: "MD JAKARIA",
    signatoryDesignation: "Executive, Admin & Operations, Finix HR Ltd.",
    primaryBankName: "The City Bank Ltd.",
    primaryAccountNo: "1233394761001",
    primaryAccountName: "Finix HR Ltd.",
    primaryBranch: "Shyamoli",
    primaryRouting: "225264300",
    secondaryBankName: "BRAC Bank PLC",
    secondaryAccountNo: "2081769340001",
    secondaryAccountName: "Finix HR Ltd.",
    secondaryBranch: "Satmasjid Road Branch",
    secondaryRouting: "060276074",
    bkashMerchantNumber: "01943223366",
    bankTransferInstructions: "",
    mfsProviderName: "bKash / Bangla QR",
    mfsMerchantNumber: "01943223366",
    mfsQrUrl: "",
    mfsInstructions: "Scan QR Code with any bank or MFS app supporting Bangla QR / bKash / Nagad.",
  },
  communication: {
    notifyOnRegistration: true,
    notifyOnApproval: true,
    notifyApplicantOnSubmit: true,
    notifyOnExpiryDays: [7, 30],
  },
  alerts: {
    webhookUrl: "",
    webhookSecret: "",
    webhookOnBackupFailure: true,
    quotaAlertsEnabled: true,
    quotaThresholdPercent: 90,
  },
}

const cache = new Map<string, { value: SaasSettings; at: number }>()
const TTL_MS = 10_000

export function invalidateSaasSettings() {
  cache.clear()
}

export async function getSaasSettings(): Promise<SaasSettings> {
  const hit = cache.get("root")
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const rows = await db.saasSetting.findMany()
  const merged: any = JSON.parse(JSON.stringify(DEFAULT_SAAS_SETTINGS))
  for (const row of rows) {
    if (!merged[row.group]) merged[row.group] = {}
    let v: unknown
    const expectedType = SETTINGS_WHITELIST[row.group]?.[row.key]
    if (expectedType === "string") {
      v = String(row.value ?? "")
    } else {
      try { v = JSON.parse(row.value) } catch { v = row.value }
    }
    merged[row.group][row.key] = v
  }
  // merge with defaults so newly-added keys exist even on old rows
  for (const [group, def] of Object.entries(DEFAULT_SAAS_SETTINGS)) {
    merged[group] = { ...(def as any), ...(merged[group] || {}) }
    // Ensure string fields stay strings (prevents numeric strings like account numbers from turning into numbers)
    for (const [k, val] of Object.entries(def as any)) {
      if (typeof val === "string" && merged[group][k] !== undefined) {
        merged[group][k] = String(merged[group][k] ?? "")
      }
    }
  }
  const value = merged as SaasSettings
  cache.set("root", { value, at: Date.now() })
  return value
}

/** Whitelisted group/key pairs the owner console may write (settings.save
 *  mirrors the tenant h2-settings-whitelist discipline). */
export const SETTINGS_WHITELIST: Record<string, Record<string, "string" | "number" | "boolean" | "string[]" | "number[]">> = {
  general: {
    platformName: "string", supportEmail: "string", supportPhone: "string",
    websiteUrl: "string", tagline: "string", address: "string",
    logoUrl: "string", appLogoUrl: "string", faviconUrl: "string",
    sealUrl: "string", signatureUrl: "string",
    signatoryName: "string", signatoryDesignation: "string",
  },
  registration: {
    enabled: "boolean", requireApproval: "boolean", defaultPlanId: "string",
    allowedBillingCycles: "string[]", messageOnSubmit: "string",
  },
  subscription: {
    gracePeriodDays: "number", renewalReminderDays: "number[]", trialDays: "number",
    postExpiryNoticeDays: "number[]", expirySmsEnabled: "boolean", rejoinOfferEnabled: "boolean",
    invoiceLeadDays: "number", receiptEmailEnabled: "boolean", thankYouEmailEnabled: "boolean",
  },
  security: {
    ownerMfaRequired: "boolean", sessionDays: "number",
    lockoutThreshold: "number", lockoutMinutes: "number",
  },
  billing: {
    vatRatePercent: "number",
    companyLegalName: "string",
    companyBin: "string",
    companyAddress: "string",
    companyPhone: "string",
    companyEmail: "string",
    companyWebsite: "string",
    signatoryName: "string",
    signatoryDesignation: "string",
    primaryBankName: "string",
    primaryAccountNo: "string",
    primaryAccountName: "string",
    primaryBranch: "string",
    primaryRouting: "string",
    secondaryBankName: "string",
    secondaryAccountNo: "string",
    secondaryAccountName: "string",
    secondaryBranch: "string",
    secondaryRouting: "string",
    bkashMerchantNumber: "string",
    bankTransferInstructions: "string",
    mfsProviderName: "string",
    mfsMerchantNumber: "string",
    mfsQrUrl: "string",
    mfsInstructions: "string",
  },
  communication: {
    notifyOnRegistration: "boolean", notifyOnApproval: "boolean",
    notifyApplicantOnSubmit: "boolean", notifyOnExpiryDays: "number[]",
  },
  alerts: {
    webhookUrl: "string", webhookSecret: "string",
    webhookOnBackupFailure: "boolean",
    quotaAlertsEnabled: "boolean", quotaThresholdPercent: "number",
  },
}

export async function saveSaasSettingsGroup(group: string, values: Record<string, unknown>) {
  const allowed = SETTINGS_WHITELIST[group]
  if (!allowed) throw new Error(`Unknown settings group: ${group}`)
  for (const [key, raw] of Object.entries(values || {})) {
    const type = allowed[key]
    if (!type) continue // silently drop unknown keys (whitelist behavior)
    let stored: string
    switch (type) {
      case "number": {
        const n = Number(raw)
        if (!Number.isFinite(n)) continue
        stored = String(n)
        break
      }
      case "boolean":
        stored = String(raw === true || raw === "true")
        break
      case "string[]": {
        if (!Array.isArray(raw)) continue
        stored = JSON.stringify(raw.map(String).filter(Boolean))
        break
      }
      case "number[]": {
        if (!Array.isArray(raw)) continue
        const nums = raw.map(Number).filter(Number.isFinite)
        stored = JSON.stringify(nums)
        break
      }
      default: {
        if (typeof raw !== "string") continue
        const isMedia = key.endsWith("Url") || key.includes("signature") || key.includes("seal") || key.includes("logo") || key.includes("favicon") || key.includes("Qr")
        stored = isMedia ? raw.slice(0, 2_000_000) : raw.slice(0, 2000)
      }
    }
    await db.saasSetting.upsert({
      where: { group_key: { group, key } },
      create: { group, key, value: stored },
      update: { value: stored },
    })
  }
  invalidateSaasSettings()
  return getSaasSettings()
}

/** Calculate standard inclusive Bangladesh VAT breakdown (Net + VAT = Total).
 *  Net = ROUND(Total / (1 + vatRate / 100), 2)
 *  VAT = ROUND(Total - Net, 2)
 */
export function calculateVatBreakdown(amount: number, vatRatePercent: number) {
  const total = Number(amount) || 0
  const rate = Math.max(0, Number(vatRatePercent) || 0)
  if (rate <= 0 || total <= 0) {
    return {
      vatRatePercent: rate,
      netAmount: total,
      vatAmount: 0,
    }
  }
  const net = Math.round((total / (1 + rate / 100)) * 100) / 100
  const vat = Math.round((total - net) * 100) / 100
  return {
    vatRatePercent: rate,
    netAmount: net,
    vatAmount: vat,
  }
}

