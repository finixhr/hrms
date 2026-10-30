// ============ Platform audit log — the owner plane's forensic record ============
// Separate from the tenant AuditLog on purpose: platform events have no
// vendorId of their own (the affected tenant is a TARGET, not the actor's
// tenant). Best-effort like the tenant audit() — but callers that need
// strict guarantees use the return value to decide.
import { db } from "@/lib/db"
import { auditJson } from "@/hrm-server/audit"

export type SaasAuditActor = { id?: string | null; name?: string | null; ip?: string | null } | null

export async function saasAudit(
  actor: SaasAuditActor,
  action: string,
  entity: string,
  entityId: string | null | undefined,
  summary: string,
  opts: { vendorId?: string | null; metadata?: unknown } = {}
): Promise<void> {
  try {
    await db.saasAuditLog.create({
      data: {
        actorId: actor?.id || null,
        actorName: actor?.name || "System",
        action,
        entity,
        entityId: entityId || null,
        vendorId: opts.vendorId || null,
        summary,
        metadata: auditJson(opts.metadata) ?? "{}",
        ip: actor?.ip || null,
      },
    })
  } catch (e) {
    // never let audit failure break the operation — but surface it loudly
    console.error("[saas-audit] write failed:", e)
  }
}
