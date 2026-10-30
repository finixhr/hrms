// ============ /legal/privacy — Privacy Policy ============
// Structured full text with clearly marked [PLACEHOLDER] items for counsel.
// Describes data factually: what the platform collects, why, the per-tenant
// isolation model, retention on lapse, cookies/localStorage keys actually
// used by the app (themes + sessions), and data-subject request routing.
import type { Metadata } from "next"
import { SectionHeading } from "@/saas/web/sections"
import { SITE } from "@/saas/web/site"

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How the Finix HR platform collects, uses and protects personal data — for applicants, workspace users and employees.",
  alternates: { canonical: "/legal/privacy" },
}

const LAST_UPDATED = "[DATE — set on publication]"

export default function PrivacyPage() {
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <SectionHeading align="left" eyebrow="Legal" title="Privacy Policy" />

        <div className="mt-6 rounded-xl border border-amber-400/25 bg-amber-500/10 p-4 text-[13px] leading-relaxed text-amber-200 light:border-amber-500/40 light:bg-amber-50 light:text-amber-800">
          <strong>Before production use:</strong> this is a complete working draft, not legal advice. Items in
          [BRACKETS] must be reviewed and finalized by the operator ({SITE.company}) with legal counsel for the
          operating jurisdiction. Last updated: {LAST_UPDATED}.
        </div>

        <div className="mt-10 space-y-10 text-[15px] leading-relaxed text-slate-300 light:text-slate-700">
          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">1. Who is responsible</h2>
            <p>
              <strong>[LEGAL ENTITY NAME], registration no. [REGISTRATION NUMBER]</strong>, address{" "}
              <strong>[REGISTERED ADDRESS]</strong>, is the operator and data processor for the {SITE.name} platform.
              <strong> [DATA PROTECTION OFFICER / PRIVACY CONTACT EMAIL]</strong> handles privacy questions.
            </p>
            <p>
              <strong>Controllers vs processor.</strong> Each customer organization (tenant) is the data controller
              for the employee and HR data it puts into its workspace. We process that data on the tenant&apos;s
              instructions, as described in this policy and the Terms of Service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">2. Data we collect</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li><strong>Registration applications</strong> (as an applicant you give us): organization name and details, administrator name, email, phone, requested scale (employee/branch/device counts), plan preference, and the administrator password (stored only as a salted hash).</li>
              <li><strong>Contact inquiries:</strong> name, email, phone, company and message.</li>
              <li><strong>Workspace data</strong> (uploaded by tenant administrators): employee master records (names, national IDs, photos, contact details, salary and bank information, attendance and leave records, documents), user accounts and permissions, and audit logs of administrative actions.</li>
              <li><strong>Technical data:</strong> IP addresses on form submissions and sign-ins, user-agent strings, and session identifiers — used for security (rate limiting, lockout, audit) and to keep you signed in.</li>
            </ul>
            <p>We do not sell personal data, and we do not run cross-site advertising trackers.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">3. Why we process it</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>To review and process your registration application and provision workspaces (contractual necessity).</li>
              <li>To provide the Service — HR, attendance, payroll and related functions — on the tenant&apos;s instructions.</li>
              <li>To secure the platform: abuse prevention, lockout, audit trails, incident investigation (legitimate interests).</li>
              <li>To communicate about subscriptions, renewals and support. Platform notification emails (application status, renewal reminders) are sent only with the communication toggles configured by the platform team.</li>
            </ul>
            <p>
              Sensitive categories (for example, data on health-related leave or biometric check-in media) are
              processed only when the controlling tenant supplies them and has a lawful basis; tenants are
              responsible for obtaining any consent their jurisdiction requires.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">4. Isolation and security</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>Every workspace is isolated per tenant; platform enforcement ensures one tenant can never query another&apos;s records.</li>
              <li>Passwords are stored as salted scrypt hashes; multi-factor authentication (TOTP) is available for tenant users and enforced for the platform team.</li>
              <li>Sensitive credentials (MFA secrets, integrations, camera credentials) are encrypted at rest with AES-256-GCM under a deployment key.</li>
              <li>Administrative actions are audit-logged; failed sign-ins trigger lockout.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">5. Sharing and sub-processors</h2>
            <p>
              We share data only with: (a) infrastructure providers hosting the deployment{" "}
              <strong>[HOSTING PROVIDER(S) AND LOCATIONS]</strong>; (b) the email/SMS gateway providers the operator
              or a tenant configures for notifications; (c) authorities where law requires. We never disclose
              tenant workspace data to other tenants.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">6. Retention</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>Registration applications and review history: kept for the life of the platform relationship plus <strong>[WINDOW]</strong>.</li>
              <li>Workspace data: kept while the subscription is active or recoverable (at least <strong>[WINDOW — e.g. 90 days]</strong> after expiry), and longer where payroll/tax law requires the tenant to keep records.</li>
              <li>Audit logs: platform logs are retained for security and compliance for <strong>[WINDOW — e.g. 5 years]</strong>.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">7. Your rights</h2>
            <p>
              If you are an <strong>applicant or website visitor</strong>, you may request access, correction or
              deletion of your application data at <strong>[PRIVACY CONTACT EMAIL]</strong>.
            </p>
            <p>
              If you are an <strong>employee of a customer organization</strong>, your data controller is your
              employer — direct access, correction, export and objection requests to them; the platform supports
              them in fulfilling these requests (export and audit tooling).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">8. Cookies and local storage</h2>
            <p>This site sets no advertising cookies. It uses:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li><code className="rounded bg-slate-800 px-1.5 py-0.5 text-[13px] text-slate-200 light:bg-slate-100 light:text-slate-800">hrm_session</code> — a strict httpOnly session cookie for signed-in workspace users (security-essential).</li>
              <li><code className="rounded bg-slate-800 px-1.5 py-0.5 text-[13px] text-slate-200 light:bg-slate-100 light:text-slate-800">saas_owner_session</code> — a separate httpOnly cookie for the platform owner console.</li>
              <li>Local storage keys <code className="rounded bg-slate-800 px-1.5 py-0.5 text-[13px] text-slate-200 light:bg-slate-100 light:text-slate-800">hrm_theme</code>, <code className="rounded bg-slate-800 px-1.5 py-0.5 text-[13px] text-slate-200 light:bg-slate-100 light:text-slate-800">owner_theme</code>, <code className="rounded bg-slate-800 px-1.5 py-0.5 text-[13px] text-slate-200 light:bg-slate-100 light:text-slate-800">site_theme</code> — remember your dark/light preference per surface. Never leaves your browser.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">9. International transfers</h2>
            <p>
              Where the deployment or its sub-processors move data outside your country, transfers are governed by
              <strong> [TRANSFER MECHANISM — e.g. standard contractual clauses]</strong> with{" "}
              <strong>[LIST OF COUNTRIES]</strong>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">10. Changes and contact</h2>
            <p>
              We will announce material changes to this policy in-app. For anything privacy-related, contact{" "}
              <strong>[PRIVACY CONTACT EMAIL]</strong> or write to <strong>[REGISTERED ADDRESS]</strong>.
            </p>
          </section>
        </div>
      </div>
    </section>
  )
}
