// ============ WP-I — payment provider registry ============
// Keyed by the provider id used on SaasPayment.provider, in SaaSSetting
// group "payments" keys, and in the /api/payments/return|ipn?provider= param.
// Wave 10 (2026-10-24): PayStation + EPS joined the WP-I trio — all five
// Bangladeshi gateways the master prompt requires are now registered.
import type { PaymentProvider } from "./types"
import { sslcommerzProvider } from "./sslcommerz"
import { bkashProvider } from "./bkash"
import { nagadProvider } from "./nagad"
import { paystationProvider } from "./paystation"
import { epsProvider } from "./eps"

const REGISTRY: Record<string, PaymentProvider> = {
  [sslcommerzProvider.id]: sslcommerzProvider,
  [bkashProvider.id]: bkashProvider,
  [nagadProvider.id]: nagadProvider,
  [paystationProvider.id]: paystationProvider,
  [epsProvider.id]: epsProvider,
}

export const PAYMENT_PROVIDER_IDS = Object.keys(REGISTRY)

export function getPaymentProvider(id: string): PaymentProvider | null {
  return REGISTRY[String(id || "").toLowerCase()] || null
}

export function requirePaymentProvider(id: string): PaymentProvider {
  const p = getPaymentProvider(id)
  if (!p) {
    throw Object.assign(new Error(`Unknown payment provider "${id}". Supported: ${PAYMENT_PROVIDER_IDS.join(", ")}.`), { code: 400 })
  }
  return p
}
