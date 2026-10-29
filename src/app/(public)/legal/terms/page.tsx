// ============ /legal/terms — Terms of Service ============
// Structured full text with clearly marked [PLACEHOLDER] items the operator's
// counsel must finalize (entity, jurisdiction, SLA numbers). Everything else
// describes the service factually — pricing model, provisioning, lockout on
// lapse (data never deleted), manual billing, termination.
import type { Metadata } from "next"
import { SectionHeading } from "@/saas/web/sections"
import { SITE } from "@/saas/web/site"

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms of service for the Finix HR platform — subscription terms, acceptable use, billing and termination.",
  alternates: { canonical: "/legal/terms" },
}

const LAST_UPDATED = "[DATE — set on publication]"

export default function TermsPage() {
  return (
    <section className="bg-slate-950 light:bg-white">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <SectionHeading align="left" eyebrow="Legal" title="Terms of Service" />

        <div className="mt-6 rounded-xl border border-amber-400/25 bg-amber-500/10 p-4 text-[13px] leading-relaxed text-amber-200 light:border-amber-500/40 light:bg-amber-50 light:text-amber-800">
          <strong>Before production use:</strong> this document is a complete working draft. Items in
          [BRACKETS] must be finalized by the operator ({SITE.company}) with legal counsel — company
          registration details, governing jurisdiction, and any service-level commitments. Last updated: {LAST_UPDATED}.
        </div>

        <div className="mt-10 space-y-10 text-[15px] leading-relaxed text-slate-300 light:text-slate-700">
          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">1. About this agreement</h2>
            <p>
              These Terms of Service (&quot;Terms&quot;) govern your access to and use of the {SITE.name} human
              resources platform (the &quot;Service&quot;) operated by <strong>[LEGAL ENTITY NAME], registration
              no. [REGISTRATION NUMBER]</strong>, with offices at <strong>[REGISTERED ADDRESS]</strong> (&quot;we&quot;,
              &quot;us&quot;, &quot;the operator&quot;). By registering an organization, approving an application, or
              using the Service, you agree to these Terms on behalf of your organization.
            </p>
            <p>
              If you accept these Terms on behalf of an organization, you represent that you have the authority to
              bind that organization to them. If you do not agree, do not use the Service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">2. How the Service works</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>Organizations apply through the public registration form; a platform administrator reviews each application.</li>
              <li>On approval, a workspace is provisioned with the plan selected at review. Plan prices are snapshotted on the subscription at creation.</li>
              <li>Subscriptions run monthly or yearly. Plan limits (employees, users, branches, devices, storage, live-tracking seats) and module entitlements are enforced server-side.</li>
              <li>Billing is processed manually (bank transfer, cash, or mobile financial services) and recorded by the platform team. This website processes no online card payments.</li>
              <li>Trial subscriptions convert to a paid plan on approval by the platform team.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">3. Accounts and responsibilities</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>You are responsible for the accuracy of the information provided at registration and for keeping your administrator credentials confidential.</li>
              <li>Administrators manage their organization&apos;s users, roles and permissions inside the workspace. Access is action-logged for audit purposes.</li>
              <li>We strongly recommend enabling multi-factor authentication for all administrative accounts; the platform may make this mandatory for the platform console team.</li>
              <li>You must have the lawful basis needed to process your employees&apos; personal data through the Service (see our Privacy Policy).</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">4. Acceptable use</h2>
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>store or process personal data you have no right to process, including data collected without consent or a lawful basis;</li>
              <li>upload malicious code, probe or breach the Service&apos;s security, or attempt to access another organization&apos;s data;</li>
              <li>use the Service in violation of applicable labor, tax, or data-protection law, including the laws of <strong>[GOVERNING JURISDICTION]</strong>;</li>
              <li>resell or sublicense access to the Service without a written agreement with us;</li>
              <li>circumvent plan limits or entitlement controls.</li>
            </ul>
            <p>
              We may suspend a workspace for confirmed violations or non-payment. Suspension makes the workspace
              read-only; data is never deleted for lapsed payment (see §6).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">5. Fees, billing and renewals</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>Fees are those published on the pricing page (or agreed in writing for custom plans) and are quoted in <strong>[CURRENCY — e.g. BDT]</strong> excluding applicable taxes, which you additionally owe where law requires.</li>
              <li>Invoices are issued by the platform team with the subscription period and due date; late payment may move the subscription to past-due and eventually to a read-only state.</li>
              <li>Yearly plans are billed in advance; monthly plans renew automatically at the end of each cycle unless cancelled.</li>
              <li>Plan changes take effect with the next invoice unless otherwise agreed; upgrades may be prorated.</li>
              <li>Refunds, if any, are at the operator&apos;s sole discretion and any statutory refund rights under <strong>[GOVERNING LAW]</strong> remain unaffected.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">6. Lapse, suspension and data retention</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>If a subscription lapses or is suspended, the workspace becomes <strong>read-only</strong>: data stays intact and exportable while the subscription is in a recoverable state.</li>
              <li>We retain workspace data for at least <strong>[RETENTION WINDOW — e.g. 90 days]</strong> after expiry so you can export or renew. Thereafter the operator may delete the workspace after attempting to notify the registered administrator email.</li>
              <li>Nothing in this section limits retention required by law (for example, payroll and tax record-keeping obligations).</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">7. Service availability and support</h2>
            <p>
              We aim for high availability but do not guarantee uninterrupted service. Scheduled maintenance is
              announced in-app where practical. Support levels follow your plan (Standard, Priority, or Dedicated).
              Any explicit uptime commitment or service credits are defined in <strong>[SLA DOCUMENT / OR &quot;NONE OFFERED&quot;]</strong>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">8. Intellectual property</h2>
            <p>
              The Service, its software and its documentation are the operator&apos;s property and are protected by
              intellectual-property law. You retain all rights to your own data. You grant us the limited right to
              host and process that data solely to provide the Service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">9. Confidentiality</h2>
            <p>
              Each party will protect the other&apos;s confidential information with at least the care it uses for its
              own. Employee personal data you process through the Service is your confidential information; our
              handling of it is described in the Privacy Policy.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">10. Liability</h2>
            <p>
              To the maximum extent permitted by law, the operator is not liable for indirect, incidental or
              consequential damages, lost profits, or losses arising from your use or inability to use the Service.
              The operator&apos;s total aggregate liability is limited to <strong>[CAP — e.g. the fees paid in the
              12 months preceding the claim]</strong>. Nothing excludes liability that cannot be excluded under
              the applicable law of <strong>[GOVERNING JURISDICTION]</strong>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">11. Termination</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>You may cancel at any time from inside your workspace or by written notice; cancellation takes effect at the end of the current paid period.</li>
              <li>We may terminate for material breach after <strong>[NOTICE PERIOD]</strong> written notice and a chance to remedy.</li>
              <li>On termination you may export your data while the workspace remains in a recoverable state (see §6).</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">12. Changes to the Terms</h2>
            <p>
              We may update these Terms for new features or legal changes. Material changes are announced in-app at
              least <strong>[14/30]</strong> days before taking effect. Continued use after the effective date means
              acceptance of the updated Terms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white light:text-slate-900">13. Governing law and contact</h2>
            <p>
              These Terms are governed by the laws of <strong>[GOVERNING JURISDICTION]</strong>, with exclusive
              jurisdiction in its courts, unless mandatory consumer or labor protections provide otherwise. Questions:
              <strong> [LEGAL CONTACT EMAIL]</strong>.
            </p>
          </section>
        </div>
      </div>
    </section>
  )
}
