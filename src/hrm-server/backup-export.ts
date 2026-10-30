// ============ DB-01 rebuild — DMMF-driven tenant backup export ============
// The previous BACKUP_EXPORT (jobs.ts) carried a hand-maintained table list
// that queried child models (familyMember, bankAccount, loanInstallment …)
// with where:{vendorId}; none of them HAS a vendorId column, so every one of
// those queries threw, and the catch classifier (`typeof db[t] !== "function"`
// — true for EVERY Prisma delegate, which are objects, not functions)
// misclassified the genuine errors as "model missing", silently skipping the
// child tables while the job still finished DONE. ~20 vendor-scoped models
// (assets, visits, recruitment, accounting, tracking, policies, notifications,
// …) were additionally absent from the list entirely.
//
// The rebuild (audit Phase R1 / DB-01):
//   1. the export inventory is generated from the Prisma DMMF — schema
//      additions surface in the export automatically (vendor-scoped models
//      need NO map entry at all);
//   2. vendor-scoped models export via where:{vendorId}; child models (no
//      vendorId of their own — bare string FKs into a vendor-scoped parent)
//      export through their parent's exported ID set, so no unscoped
//      cross-tenant query is ever issued;
//   3. the delegate check is a real presence check (property on the client
//      WITH a findMany function), never a typeof trap;
//   4. any model that resolves to NO strategy and is NOT on the explicit
//      exclusion list fails the job LOUDLY — a silent skip is structurally
//      impossible now. The unit-test suite additionally walks the DMMF and
//      fails CI when a new model is left unclassified.
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"

/** Models never exported in a tenant data export, with the human-readable
 *  reason (surfaced verbatim in the job result so an operator can audit the
 *  exclusion surface itself). This map is the ONLY legitimate way to omit a
 *  model — anything else fails the export. */
export const BACKUP_EXCLUDED_MODELS: Record<string, string> = {
  Vendor: "the tenant row itself — exported separately with the result envelope",
  User: "account records — exported separately as safe fields ONLY (C-2)",
  Session: "live auth tokens never leave the database",
  UserMfaSecret: "encrypted TOTP seeds never leave the database",
  ApiRefreshToken: "API refresh material never leaves the database",
  ApiKey: "hashed API keys never leave the database",
  PushSubscription: "per-browser web-push endpoints — ephemeral device state",
  BgJob: "queue-engine internals (this job's own machinery)",
  Throttle: "runtime rate-limit counters",
  CoordinationLock: "runtime single-writer advisory locks",
  LoginAuditLog: "security probe metadata — not tenant business data",
  AuditLog: "action trail retained in-database; carried by the pg_dump backup lane (BACKUP_PG_DUMP)",
  // ---- platform-plane records ABOUT the tenant (owner console books) ----
  // A tenant data export never carries the platform's own billing, metering
  // or marketing records; the owner plane retains and backs those up itself.
  SaasSubscription: "platform-plane subscription record",
  SaasSubscriptionEvent: "platform-plane subscription history",
  SaasTenantOverride: "platform-plane tenant override",
  SaasPlanChangeRequest: "platform-plane plan-change queue",
  SaasInvoice: "platform-plane billing",
  SaasPayment: "platform-plane billing",
  SaasExpiryNotice: "platform-plane dunning",
  SaasAuditLog: "platform-plane audit",
  UsageRollup: "platform-plane usage metering",
  UsageSnapshot: "platform-plane usage metering",
  SaasCampaignRecipient: "platform-plane campaign log",
  // ---- platform-global models (no tenant dimension at all) ----
  SaasPlan: "platform catalog",
  SaasRegistration: "platform signups",
  SaasOwnerUser: "platform identities",
  SaasOwnerRole: "platform roles",
  SaasOwnerMfaSecret: "platform secrets",
  SaasOwnerSession: "platform sessions",
  SaasSetting: "platform settings",
  SaasContactInquiry: "platform inbox",
  SaasCmsPage: "platform CMS",
  SaasCmsFeature: "platform CMS",
  SaasCmsClient: "platform CMS",
  SaasCmsTestimonial: "platform CMS",
  SaasCmsMedia: "platform CMS",
  SaasSiteSetting: "platform site settings",
  SaasBackupRun: "platform backup registry",
  SaasCampaign: "platform campaigns",
  SaasCommunicationTemplate: "platform templates",
  CampaignBounce: "platform campaign bounces",
  SaasSupportAccessSession: "platform support access session",
  SaasSupportMessage: "platform support messages",
  WebAuthnChallenge: "platform WebAuthn authentication challenges",
}

/** Child models without their own vendorId column. Prisma relations are not
 *  declared for these (bare indexed string FKs — see schema.prisma), so the
 *  scope is expressed as "rows whose <fk> is in the parent's exported ID set".
 *  The parent MUST itself be a vendor-scoped model (validated at classify
 *  time — a child of an excluded model fails loudly). */
export const BACKUP_CHILD_SCOPE: Record<string, { parent: string; fk: string }> = {
  FamilyMember: { parent: "Employee", fk: "employeeId" },
  Education: { parent: "Employee", fk: "employeeId" },
  Referee: { parent: "Employee", fk: "employeeId" },
  PreviousEmployment: { parent: "Employee", fk: "employeeId" },
  BankAccount: { parent: "Employee", fk: "employeeId" },
  TaxSlab: { parent: "TaxRuleSet", fk: "ruleSetId" },
  LoanInstallment: { parent: "Loan", fk: "loanId" },
  CommunicationRecipient: { parent: "CommunicationLog", fk: "logId" },
  ApprovalStep: { parent: "ApprovalWorkflow", fk: "workflowId" },
  ApprovalAction: { parent: "ApprovalRequest", fk: "requestId" },
  GoodsRequisitionItem: { parent: "GoodsRequisition", fk: "requisitionId" },
  GoodsRequisitionHistory: { parent: "GoodsRequisition", fk: "requisitionId" },
  PurchaseRequestItem: { parent: "PurchaseRequest", fk: "purchaseId" },
  PurchaseQuotationItem: { parent: "PurchaseQuotation", fk: "quotationId" },
  StockEntryItem: { parent: "StockEntry", fk: "entryId" },
}

/** Models whose tenant scope lives INSIDE the id key ("<vendorId>:suffix"),
 *  not in a vendorId column. Exported with a key-prefix filter — the tenant's
 *  code-sequence state rides the backup so a restore cannot collide with the
 *  per-vendor unique constraints (employee codes and friends). */
export const BACKUP_KEY_PREFIX_MODELS = new Set(["SequenceCounter"])

/** Prisma delegate property for a model name (FamilyMember → familyMember). */
const delegateName = (model: string) => model[0].toLowerCase() + model.slice(1)

/** Chunk size for parent-ID-set queries. A 100k-employee tenant must not
 *  build a single 100k-bind-parameter statement (Postgres caps a single
 *  extended-protocol statement at 65,535 parameters); 5,000 keeps every
 *  statement far below the ceiling with a handful of round-trips. */
const CHILD_SCOPE_CHUNK = 5000

/** The DMMF walk: classify EVERY model in the schema into exactly one of
 *  vendor-scoped / child-scoped / excluded. Throws loudly when a model
 *  resolves to nothing — this is the DB-01 guarantee that a schema addition
 *  can never silently shrink a backup again. */
export function classifyBackupModels(): {
  vendorScoped: string[]
  childScoped: string[]
  keyPrefixScoped: string[]
  excluded: { model: string; reason: string }[]
} {
  const vendorScoped: string[] = []
  const childScoped: string[] = []
  const keyPrefixScoped: string[] = []
  const excluded: { model: string; reason: string }[] = []
  const unresolved: string[] = []

  for (const m of Prisma.dmmf.datamodel.models) {
    const name = m.name
    if (name in BACKUP_EXCLUDED_MODELS) {
      excluded.push({ model: name, reason: BACKUP_EXCLUDED_MODELS[name] })
      continue
    }
    if (name in BACKUP_CHILD_SCOPE) {
      childScoped.push(name)
      continue
    }
    if (BACKUP_KEY_PREFIX_MODELS.has(name)) {
      keyPrefixScoped.push(name)
      continue
    }
    if (m.fields.some((f) => f.name === "vendorId" && f.kind === "scalar")) {
      vendorScoped.push(name)
      continue
    }
    unresolved.push(name)
  }

  // A child model whose parent is not vendor-scoped would have nothing to
  // scope against — classify-time failure, never a runtime surprise.
  const vendorSet = new Set(vendorScoped)
  for (const child of childScoped) {
    const scope = BACKUP_CHILD_SCOPE[child]
    if (!scope) continue
    if (!vendorSet.has(scope.parent)) {
      throw new Error(
        `BACKUP_EXPORT: child model ${child} scopes through ${scope.parent}, which is not a vendor-scoped exported model — fix BACKUP_CHILD_SCOPE`,
      )
    }
  }

  if (unresolved.length) {
    throw new Error(
      `BACKUP_EXPORT: schema model(s) not classified for tenant export: ${unresolved.join(", ")} — ` +
        `add them to BACKUP_CHILD_SCOPE (if they are bare-FK children of a vendor-scoped model), ` +
        `BACKUP_KEY_PREFIX_MODELS (if the tenant scope lives in the id key) or BACKUP_EXCLUDED_MODELS ` +
        `(with a reason). Silent omission is not an option (DB-01).`,
    )
  }
  return { vendorScoped, childScoped, keyPrefixScoped, excluded }
}

/** Builds the tenant data-export payload (the BACKUP_EXPORT job body).
 *  Never issues an unscoped query: vendor-scoped models filter on vendorId,
 *  child models filter on their parent's exported IDs. */
export async function buildTenantBackupExport(vendorId: string) {
  const { vendorScoped, childScoped, keyPrefixScoped, excluded } = classifyBackupModels()
  const data: Record<string, unknown[]> = {}
  const parentIds = new Map<string, string[]>()

  // Pass 1 — vendor-scoped models. IDs of parent models are retained for the
  // child pass (only for models that actually have children, to bound memory).
  const parentsOfChildren = new Set(Object.values(BACKUP_CHILD_SCOPE).map((s) => s.parent))
  for (const model of vendorScoped) {
    const key = delegateName(model)
    const delegate = (db as any)[key]
    if (!delegate || typeof delegate.findMany !== "function") {
      throw new Error(`BACKUP_EXPORT: prisma client has no ${key} delegate — generate the client (bun run db:generate)`)
    }
    const rows: unknown[] = await delegate.findMany({ where: { vendorId } })
    data[key] = rows
    if (parentsOfChildren.has(model)) {
      parentIds.set(model, rows.map((r: any) => r.id as string))
    }
  }

  // Pass 2 — child models through their parent's exported ID set (chunked).
  for (const model of childScoped) {
    const scope = BACKUP_CHILD_SCOPE[model]
    if (!scope) continue
    const { parent, fk } = scope
    const key = delegateName(model)
    const delegate = (db as any)[key]
    if (!delegate || typeof delegate.findMany !== "function") {
      throw new Error(`BACKUP_EXPORT: prisma client has no ${key} delegate — generate the client (bun run db:generate)`)
    }
    const ids = parentIds.get(parent) || []
    const rows: unknown[] = []
    for (let i = 0; i < ids.length; i += CHILD_SCOPE_CHUNK) {
      const chunk = ids.slice(i, i + CHILD_SCOPE_CHUNK)
      const part: unknown[] = await delegate.findMany({ where: { [fk]: { in: chunk } } })
      for (const r of part) rows.push(r)
    }
    data[key] = rows
  }

  // Pass 3 — key-prefix-scoped models (tenant scope inside the id key).
  for (const model of keyPrefixScoped) {
    const key = delegateName(model)
    const delegate = (db as any)[key]
    if (!delegate || typeof delegate.findMany !== "function") {
      throw new Error(`BACKUP_EXPORT: prisma client has no ${key} delegate — generate the client (bun run db:generate)`)
    }
    data[key] = await delegate.findMany({ where: { key: { startsWith: `${vendorId}:` } } })
  }

  return {
    data,
    excluded,
    /** vendor-scoped + child + key-prefix tables + the user safe-fields export below. */
    expectedTableCount: vendorScoped.length + childScoped.length + keyPrefixScoped.length + 1,
  }
}
