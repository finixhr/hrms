// ============ SMS / Email system-template routes (2026-10 restructure) ============
// Serves the fixed catalog of event-triggered SMS/Email templates merged with
// the tenant's edits, and saves/resets a single template's wording.
// DESIGN RULES (product decision):
//   - the template LIST is system-defined — there is deliberately NO create
//     or delete route; tenants edit the wording of existing templates only
//   - birthday/anniversary wishes stay stored in the `wishes` settings group
//     (they predate this tab) and are surfaced here read/write-compatible
import { route } from "./registry"
import { Deny } from "../rbac"
import { audit } from "../audit"
import { getSettings, saveSettingsGroup } from "../settings"
import { z } from "zod"
import {
  SYSTEM_MESSAGE_TEMPLATES, SYSTEM_TEMPLATE_BY_KEY, effectiveMessageTemplate,
} from "../message-templates"

route("messageTemplates.list", {
  perm: ["settings", "view"],
  handler: async (ctx) => {
    const settings = await getSettings(ctx.vendorId)
    const overrides = (settings as any).messageTemplates || {}
    return {
      templates: SYSTEM_MESSAGE_TEMPLATES.map((t) => {
        // wishes templates live in the wishes group — surface their EFFECTIVE
        // value so the tab edits the same data the daily job consumes
        if (t.key === "birthday_wish") {
          const edited = (settings as any).wishes?.birthdayTemplate
          return {
            key: t.key, label: t.label, description: t.description, variables: t.variables,
            emailSubject: t.emailSubject, emailBody: t.emailBody, smsBody: t.smsBody,
            effectiveEmailBody: edited || t.emailBody,
            effectiveSmsBody: edited || t.smsBody,
            customized: !!edited && edited !== t.emailBody,
          }
        }
        if (t.key === "anniversary_wish") {
          const edited = (settings as any).wishes?.anniversaryTemplate
          return {
            key: t.key, label: t.label, description: t.description, variables: t.variables,
            emailSubject: t.emailSubject, emailBody: t.emailBody, smsBody: t.smsBody,
            effectiveEmailBody: edited || t.emailBody,
            effectiveSmsBody: edited || t.smsBody,
            customized: !!edited && edited !== t.emailBody,
          }
        }
        const eff = effectiveMessageTemplate(overrides, t.key)
        return {
          key: t.key, label: t.label, description: t.description, variables: t.variables,
          emailSubject: t.emailSubject, emailBody: t.emailBody, smsBody: t.smsBody,
          effectiveEmailSubject: eff.emailSubject,
          effectiveEmailBody: eff.emailBody,
          effectiveSmsBody: eff.smsBody,
          customized: eff.emailSubject !== t.emailSubject || eff.emailBody !== t.emailBody || eff.smsBody !== t.smsBody,
        }
      }),
    }
  },
})

const FIELD_MAX = 4000
function sanitizeValue(v: unknown): string {
  return String(v ?? "").slice(0, FIELD_MAX)
}

route("messageTemplates.save", {
  perm: ["settings", "edit"],
  schema: z.object({
    key: z.string().trim().min(1).max(60),
    emailSubject: z.string().max(4000).optional(),
    emailBody: z.string().max(4000).optional(),
    smsBody: z.string().max(1000).optional(),
  }),
  handler: async (ctx, p) => {
    const key = String(p.key || "")
    const def = SYSTEM_TEMPLATE_BY_KEY[key]
    if (!def) throw new Deny("Unknown template — the template list is system-defined and cannot be extended", 400)

    const emailSubject = sanitizeValue(p.emailSubject)
    const emailBody = sanitizeValue(p.emailBody)
    const smsBody = sanitizeValue(p.smsBody)
    // all-empty = reset to the system default
    const reset = !emailSubject.trim() && !emailBody.trim() && !smsBody.trim()

    // wishes templates keep their storage location (settings.wishes) so the
    // daily wish job and the Wishes & Notifications tab stay in sync
    if (key === "birthday_wish" || key === "anniversary_wish") {
      const value = reset ? def.emailBody : emailBody || def.emailBody
      await saveSettingsGroup(ctx.vendorId, "wishes", key === "birthday_wish" ? { birthdayTemplate: value } : { anniversaryTemplate: value })
      await audit(ctx, "messageTemplates.save", "HrSetting", key,
        `${reset ? "Reset" : "Edited"} ${def.label} template (wishes)`)
      return { key, reset: reset || value === def.emailBody }
    }

    if (reset) {
      // remove the tenant override entirely — the system default applies again
      await saveSettingsGroup(ctx.vendorId, "messageTemplates", { [key]: {} })
      await audit(ctx, "messageTemplates.save", "HrSetting", key, `Reset ${def.label} template to the system default`)
      return { key, reset: true }
    }

    const value = {
      ...(emailSubject.trim() ? { emailSubject } : {}),
      ...(emailBody.trim() ? { emailBody } : {}),
      ...(smsBody.trim() ? { smsBody } : {}),
    }
    await saveSettingsGroup(ctx.vendorId, "messageTemplates", { [key]: value })
    await audit(ctx, "messageTemplates.save", "HrSetting", key, `Edited ${def.label} template`)
    return { key, reset: false }
  },
})
