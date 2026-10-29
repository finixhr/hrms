// ============ WP-I — payment gateway credentials (encrypted at rest) ============
// SaaSSetting group "payments" rows, AES-256-GCM encrypted with the SAME
// field-level crypto the Camera Manager and MFA secrets use (crypto-field.ts):
// the deployment env key HRM_MFA_KEY derives a SEPARATE data-encryption key
// for the context "saas-payments::v1", so a breach of the camera or MFA key
// material does not expose gateway credentials and vice versa.
//
// Storage layout (group "payments", mirrors the platform gateway in notify.ts):
//   credentials:<providerId> → encryptField(JSON.stringify(creds), CONTEXT)
//   enabled:<providerId>     → JSON boolean
//
// Owner console write path: this module self-registers owner.payments.get /
// owner.payments.save via ownerAction() — the same side-effect pattern as
// cms-routes.ts and health.ts. It is pulled into the /api/owner dispatcher's
// module graph by src/hrm-server/saas/lifecycle-sweep.ts (the one import line
// WP-J is allowed to add to src/app/api/owner/route.ts).
//
// MASKING DISCIPLINE: reads for the owner UI return booleans and non-secret
// config (mode, endpoint override) only — never a decrypted secret. Secret
// fields round-trip like the email/SMS gateway: an EMPTY string on save keeps
// the existing value.
import { z } from "zod"
import { db } from "@/lib/db"
import { encryptField, decryptField, fieldKeyConfigured } from "../../crypto-field"
import { ownerAction } from "../owner-routes"
import { saasAudit } from "../audit"

const GROUP = "payments"
/** The SINGLE active gateway key (master prompt Part E §8.1): group
 *  "payments", key "active" → providerId. Exactly one gateway may be active
 *  for tenant subscription payments at a time; the tenant portal NEVER
 *  chooses a gateway — billing.pay.start resolves this key server-side. */
const ACTIVE_KEY = "active"

/** Distinct crypto context — see crypto-field.ts (HKDF info parameter). */
export const PAYMENTS_CRYPTO_CONTEXT = "saas-payments::v1"

export type PaymentMode = "sandbox" | "live"

export type SslcommerzCreds = {
  storeId: string
  storePassword: string // secret
  mode: PaymentMode
  baseUrlOverride?: string
}
export type BkashCreds = {
  appKey: string
  appSecret: string // secret
  username: string
  password: string // secret
  mode: PaymentMode
  baseUrlOverride?: string
}
export type NagadCreds = {
  merchantId: string
  accountNumber: string
  privateKeyPem: string // secret — merchant RSA signing key
  publicKeyPem: string // secret — Nagad platform RSA encryption key
  mode: PaymentMode
  baseUrlOverride?: string
}
// ---- Wave 10 (2026-10-24) — PayStation + EPS (master prompt §3) ----
export type PaystationCreds = {
  merchantId: string
  password: string // secret
  mode: PaymentMode
  /** 1 = the CUSTOMER pays the gateway charge, 0 (default) = merchant pays. */
  payWithCharge?: number
  baseUrlOverride?: string
}
export type EpsCreds = {
  username: string
  password: string // secret
  hashKey: string // secret — HMAC-SHA512 x-hash signing key
  merchantId: string
  storeId: string
  /** EPS transaction type id (WEB checkout default "1" — override per the
   *  merchant portal's type table if the account differs). */
  transactionTypeId?: string
  mode: PaymentMode
  baseUrlOverride?: string
}

export type AnyProviderCreds = SslcommerzCreds | BkashCreds | NagadCreds | PaystationCreds | EpsCreds

/** Field names that must never leave this module unencrypted. */
const SECRET_FIELDS: Record<string, string[]> = {
  sslcommerz: ["storePassword"],
  bkash: ["appSecret", "password"],
  nagad: ["privateKeyPem", "publicKeyPem"],
  paystation: ["password"],
  eps: ["password", "hashKey"],
}

export const PROVIDER_LABELS: Record<string, string> = {
  sslcommerz: "SSLCommerz",
  bkash: "bKash",
  nagad: "Nagad",
  paystation: "PayStation",
  eps: "EPS",
}

// ---------------- read path (with a short-lived plaintext memo) ----------------

type CredsCacheEntry = { at: number; enabled: boolean; creds: AnyProviderCreds | null }
const credsCache = new Map<string, CredsCacheEntry>()
const CREDS_TTL_MS = 10_000

export function invalidatePaymentCredentials() {
  credsCache.clear()
}

export type ResolvedProviderConfig = {
  enabled: boolean
  configured: boolean // credentials present AND decryptable
  mode: PaymentMode
  creds: AnyProviderCreds | null
}

/** Decrypt + validate one provider's credentials. `configured` is false when
 *  no row exists or the ciphertext cannot be decrypted (e.g. HRM_MFA_KEY was
 *  rotated) — callers treat that as "gateway not available", never throw. */
export async function getProviderConfig(providerId: string): Promise<ResolvedProviderConfig> {
  const hit = credsCache.get(providerId)
  if (hit && Date.now() - hit.at < CREDS_TTL_MS) {
    return { enabled: hit.enabled, configured: !!hit.creds, mode: (hit.creds as any)?.mode || "sandbox", creds: hit.creds }
  }
  const [credRow, enabledRow] = await Promise.all([
    db.saasSetting.findUnique({ where: { group_key: { group: GROUP, key: `credentials:${providerId}` } } }),
    db.saasSetting.findUnique({ where: { group_key: { group: GROUP, key: `enabled:${providerId}` } } }),
  ])
  let enabled = !!credRow // default: present credentials are live
  if (enabledRow) {
    try {
      enabled = JSON.parse(enabledRow.value) === true
    } catch {
      enabled = enabledRow.value === "true"
    }
  }
  let creds: AnyProviderCreds | null = null
  if (credRow?.value && fieldKeyConfigured()) {
    try {
      const plain = decryptField(credRow.value, PAYMENTS_CRYPTO_CONTEXT)
      const parsed = JSON.parse(plain)
      if (parsed && typeof parsed === "object" && (parsed.mode === "sandbox" || parsed.mode === "live")) {
        creds = parsed as AnyProviderCreds
      }
    } catch (e) {
      console.error(`[payments] credential decrypt failed for ${providerId}:`, e instanceof Error ? e.message : e)
    }
  }
  credsCache.set(providerId, { at: Date.now(), enabled, creds })
  return { enabled, configured: !!creds, mode: (creds as any)?.mode || "sandbox", creds }
}

/** Availability surface for tenant-plane reads: booleans + labels only.
 *  `active` marks the ONE gateway the platform owner activated — the only
 *  gateway the tenant checkout will ever use (master prompt §8.1). */
export async function paymentGatewaysAvailable(): Promise<{ id: string; label: string; enabled: boolean; active: boolean }[]> {
  const activeId = await getActivePaymentProviderId()
  const ids = Object.keys(PROVIDER_LABELS)
  const out: { id: string; label: string; enabled: boolean; active: boolean }[] = []
  for (const id of ids) {
    const cfg = await getProviderConfig(id)
    out.push({ id, label: PROVIDER_LABELS[id], enabled: cfg.enabled && cfg.configured, active: id === activeId })
  }
  return out
}

/** Resolve the ONE active payment provider id (null when none is activated
 *  or the activated provider is no longer enabled/configured). */
export async function getActivePaymentProviderId(): Promise<string | null> {
  const row = await db.saasSetting.findUnique({ where: { group_key: { group: GROUP, key: ACTIVE_KEY } } })
  const id = row?.value ? row.value.replace(/"/g, "").trim() : null
  if (!id || !PROVIDER_LABELS[id]) return null
  const cfg = await getProviderConfig(id)
  if (!cfg.enabled || !cfg.configured) return null // never checkout through a disabled gateway
  return id
}

/** Set (or clear) the single active gateway. Server-side single-active rule
 *  is inherent — ONE row holds the value; activating X replaces Y. */
export async function setActivePaymentProvider(providerId: string | null): Promise<void> {
  if (providerId === null) {
    await db.saasSetting.deleteMany({ where: { group: GROUP, key: ACTIVE_KEY } })
    invalidatePaymentCredentials()
    return
  }
  await db.saasSetting.upsert({
    where: { group_key: { group: GROUP, key: ACTIVE_KEY } },
    create: { group: GROUP, key: ACTIVE_KEY, value: providerId },
    update: { value: providerId },
  })
  invalidatePaymentCredentials()
}

/** Masked projection for the owner UI — secret fields become has<Field>
 *  booleans, nothing decryptable ever leaves. */
function maskConfig(providerId: string, cfg: ResolvedProviderConfig) {
  const secrets = SECRET_FIELDS[providerId] || []
  const c: any = cfg.creds || {}
  const masked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(c)) {
    if (secrets.includes(k)) {
      masked[`has${k.charAt(0).toUpperCase()}${k.slice(1)}`] = !!v
    } else {
      masked[k] = v
    }
  }
  return {
    id: providerId,
    label: PROVIDER_LABELS[providerId] || providerId,
    enabled: cfg.enabled,
    configured: cfg.configured,
    mode: cfg.configured ? cfg.mode : null,
    credentials: masked, // non-secret config + has* booleans only
  }
}

// ---------------- write path (owner actions, self-registered) ----------------

const credsSchemas: Record<string, z.ZodType<any, any>> = {
  sslcommerz: z.object({
    storeId: z.string().trim().max(120).optional(),
    storePassword: z.string().max(200).optional(), // empty = keep existing
    mode: z.enum(["sandbox", "live"]).optional(),
    baseUrlOverride: z.string().trim().max(300).optional(),
  }),
  bkash: z.object({
    appKey: z.string().trim().max(120).optional(),
    appSecret: z.string().max(300).optional(), // empty = keep existing
    username: z.string().trim().max(120).optional(),
    password: z.string().max(200).optional(), // empty = keep existing
    mode: z.enum(["sandbox", "live"]).optional(),
    baseUrlOverride: z.string().trim().max(300).optional(),
  }),
  nagad: z.object({
    merchantId: z.string().trim().max(120).optional(),
    accountNumber: z.string().trim().max(30).optional(),
    privateKeyPem: z.string().max(4000).optional(), // empty = keep existing
    publicKeyPem: z.string().max(4000).optional(), // empty = keep existing
    mode: z.enum(["sandbox", "live"]).optional(),
    baseUrlOverride: z.string().trim().max(300).optional(),
  }),
  paystation: z.object({
    merchantId: z.string().trim().max(120).optional(),
    password: z.string().max(200).optional(), // empty = keep existing
    payWithCharge: z.number().int().min(0).max(1).optional(),
    mode: z.enum(["sandbox", "live"]).optional(),
    baseUrlOverride: z.string().trim().max(300).optional(),
  }),
  eps: z.object({
    username: z.string().trim().max(120).optional(),
    password: z.string().max(200).optional(), // empty = keep existing
    hashKey: z.string().max(300).optional(), // empty = keep existing
    merchantId: z.string().trim().max(120).optional(),
    storeId: z.string().trim().max(120).optional(),
    transactionTypeId: z.string().trim().max(40).optional(),
    mode: z.enum(["sandbox", "live"]).optional(),
    baseUrlOverride: z.string().trim().max(300).optional(),
  }),
}

ownerAction("owner.payments.get", {
  perm: "billing.view",
  handler: async () => {
    const activeId = await getActivePaymentProviderId()
    const providers = []
    for (const id of Object.keys(PROVIDER_LABELS)) {
      providers.push(maskConfig(id, await getProviderConfig(id)))
    }
    return { providers, activeProviderId: activeId, encryptionKeyConfigured: fieldKeyConfigured() }
  },
})

ownerAction("owner.payments.save", {
  perm: "billing.manage",
  schema: z.object({
    provider: z.enum(["sslcommerz", "bkash", "nagad", "paystation", "eps"]),
    enabled: z.boolean().optional(),
    // provider-specific shape validated in-handler against credsSchemas
    // (the per-provider schema is selected by `provider`, which the outer
    // zod object cannot key on statically)
    credentials: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: async (ctx, p) => {
    const schema = credsSchemas[p.provider]
    if (!schema) throw Object.assign(new Error(`Unknown payment provider: ${p.provider}`), { code: 400 })
    if (!fieldKeyConfigured()) {
      throw Object.assign(
        new Error("Server encryption key (HRM_MFA_KEY) is not configured — payment credentials cannot be stored. Configure the deployment key first."),
        { code: 500 },
      )
    }
    const cur = await getProviderConfig(p.provider)
    const before = maskConfig(p.provider, cur)

    // Merge: explicit fields win; EMPTY secret strings keep the existing value
    // (masked UI round-trips blanks — same contract as owner.gateway.save).
    const merged: Record<string, string> = { ...(cur.creds as any) }
    if (p.credentials) {
      const parsed = schema.safeParse(p.credentials)
      if (!parsed.success) {
        const issue = parsed.error.issues?.[0]
        throw Object.assign(new Error(`Invalid credentials: ${issue?.path?.join(".") || ""} ${issue?.message || ""}`), { code: 400 })
      }
      for (const [k, v] of Object.entries(parsed.data)) {
        if (v === undefined) continue
        const asStr = String(v ?? "")
        const isSecret = (SECRET_FIELDS[p.provider] || []).includes(k)
        if (isSecret && asStr === "") continue // keep existing secret
        if (asStr === "" && !isSecret) {
          delete merged[k]
          continue
        }
        merged[k] = asStr
      }
    }
    if (!merged.mode) merged.mode = "sandbox"

    const encrypted = encryptField(JSON.stringify(merged), PAYMENTS_CRYPTO_CONTEXT)
    await db.saasSetting.upsert({
      where: { group_key: { group: GROUP, key: `credentials:${p.provider}` } },
      create: { group: GROUP, key: `credentials:${p.provider}`, value: encrypted },
      update: { value: encrypted },
    })
    if (p.enabled !== undefined) {
      await db.saasSetting.upsert({
        where: { group_key: { group: GROUP, key: `enabled:${p.provider}` } },
        create: { group: GROUP, key: `enabled:${p.provider}`, value: JSON.stringify(p.enabled) },
        update: { value: JSON.stringify(p.enabled) },
      })
    }
    invalidatePaymentCredentials()
    // SAFE DISABLE (master prompt §8.1): switching a gateway off while it is
    // the active checkout gateway also deactivates it — the tenant portal
    // must never reach a disabled gateway.
    if (p.enabled === false) {
      const activeId = await getActivePaymentProviderId()
      if (activeId === p.provider) await setActivePaymentProvider(null)
    }
    const after = maskConfig(p.provider, await getProviderConfig(p.provider))
    await saasAudit(
      ctx,
      "PAYMENT_PROVIDER_SETTINGS_CHANGED",
      "SaaSSetting",
      null,
      `Payment gateway "${p.provider}" settings updated (enabled: ${after.enabled ? "yes" : "no"}, mode: ${after.mode || "n/a"})`,
      { metadata: { provider: p.provider, before, after } },
    )
    return { provider: after }
  },
})

// ---- SINGLE-ACTIVE-GATEWAY CONTROL (master prompt Part E §8.1) --------------
// Activating one gateway inherently deactivates the previous one (ONE
// SaaSSetting row holds the value). Activation requires the gateway to be
// enabled AND credentialed; the owner UI confirms before switching.
ownerAction("owner.payments.activate", {
  perm: "billing.manage",
  schema: z.object({
    provider: z.enum(["sslcommerz", "bkash", "nagad", "paystation", "eps", "none"]),
    confirm: z.boolean(),
  }),
  handler: async (ctx, p) => {
    if (!p.confirm) throw Object.assign(new Error("Activation requires an explicit confirmation."), { code: 400 })
    if (p.provider === "none") {
      const previous = await getActivePaymentProviderId()
      await setActivePaymentProvider(null)
      await saasAudit(ctx, "PAYMENT_GATEWAY_DEACTIVATED", "SaaSSetting", null,
        `Active payment gateway cleared${previous ? ` (was ${PROVIDER_LABELS[previous] || previous})` : ""} — tenant online checkout is disabled until a gateway is activated`,
        { metadata: { previous } })
      return { activeProviderId: null }
    }
    const cfg = await getProviderConfig(p.provider)
    if (!cfg.configured) {
      throw Object.assign(new Error(`${PROVIDER_LABELS[p.provider]} has no stored credentials — configure and save them before activating.`), { code: 400 })
    }
    if (!cfg.enabled) {
      throw Object.assign(new Error(`${PROVIDER_LABELS[p.provider]} is disabled — enable it before activating.`), { code: 400 })
    }
    const previous = await getActivePaymentProviderId()
    await setActivePaymentProvider(p.provider)
    await saasAudit(ctx, "PAYMENT_GATEWAY_ACTIVATED", "SaaSSetting", null,
      `Active payment gateway set to ${PROVIDER_LABELS[p.provider]} (${cfg.mode})${previous && previous !== p.provider ? ` — replaced ${PROVIDER_LABELS[previous] || previous}` : ""}. All tenant subscription checkouts now use this gateway.`,
      { metadata: { provider: p.provider, mode: cfg.mode, previous } })
    return { activeProviderId: p.provider }
  },
})
