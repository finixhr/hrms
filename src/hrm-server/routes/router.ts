// ============ Master router: imports all domain routes and exposes registry ============
import "./auth"
import "./passkeys" // WebAuthn/passkey MFA — auth.passkey.* (self-service + public login)
import "./organization"
import "./employees"
import "./lifecycle"
import "./attendance"
import "./devices"
import "./leave"
import "./payroll"
import "./finance"
import "./performance"
import "./communication"
import "./letters"
import "./exit"
import "./ess"
import "./reports"
import "./roadmap"
import "./commissions" // Commission Rule Setup feature
import "./search"
import "./pf"
import "./admin"
import "./ait"
import "./procurement"
import "./inventory"
import "./cameras"  // Phase 4 — Camera Manager (singular module key per kickoff item 7)
import "./tracking" // 2026-10 round — Live Tracking + Geo-Fence + policies + secure attendance
import "./payout"   // 2026-10 round — salary payout validation + export engine
import "./subscription" // SaaS layer — tenant's own subscription/usage view (read-only)
import "./onboarding"   // 2026-10-04 — post-approval onboarding checklist (live from DB)
import "./message-templates" // 2026-10 restructure — SMS/Email system templates (HR Settings → Templates)
import "./push"  // Phase 5 P6 — web-push subscriptions (WS-C: punches/approvals push channel)
import "./assets"      // Wave 2 WP-K/L — Employee Asset Management + inventory/exit integration
import "./fieldforce"  // Wave 2 WP-M — Field Force (locations, plans, visits, board, reports)
import "./recruitment" // Wave 2 WP-P — Recruitment pipeline + public careers submissions
import "./billing"     // Wave 2 WP-H/I — tenant self-service billing + gateway payments
import "./support"     // 2026-10-25 — Support Center: tickets/chat + Live Support Access requests
import "./accounting" // Wave 2 WP-E — Accounting module (manual vouchers, ledger, trial balance, P&L)
import "./ats" // Wave 4 WP-D — ATS depth (interviews, offers, onboarding checklist)
import "./integrations" // Wave 4 WP-C — API keys + outbound webhooks management
import "./ai" // Wave 4 — AI assist (NL report queries, anomalies, resume screening)
import { registerAllHooks } from "./hooks"

registerAllHooks()

export { getRoute } from "./registry"
