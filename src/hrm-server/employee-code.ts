// ============ Employee code allocation (2026-10 import round) ============
// ONE shared, settings-aware, atomic allocator for employee codes — used by
// employees.create, employees.createWithStructure AND employees.bulkImport.
//
// The bulk importer previously allocated from a DIFFERENT SequenceCounter key
// ("employee-code") than the interactive paths
// ("employee-code:{prefix}:{suffix}:{start}:{pad}") — two independent counters
// meant interactive creates and bulk imports interleaved number ranges, so
// serial numbers were neither chronological nor sequential. Both paths now
// share this helper and therefore ONE counter (still honoring the
// Settings → Employee id scheme: prefix / suffix / start number / padding),
// and both still advance past any legacy collision.
import { db } from "@/lib/db"
import { getSettings } from "./settings"
import { nextFormattedSeq } from "./utils"

export type EmployeeCodeScheme = {
  prefix: string
  suffix: string
  start: number
  pad: number
  /** ONE shared counter key derived from the full scheme. */
  seqKey: string
  format: (v: number) => string
}

/** Read the vendor's employee id scheme (Settings → Employee). */
export async function employeeCodeScheme(vendorId: string): Promise<EmployeeCodeScheme> {
  const es = (await getSettings(vendorId)).employeeSettings
  const prefix = String(es.idPrefix || "EMP").trim() || "EMP"
  const suffix = String(es.idSuffix || "").trim()
  const pad = Math.min(10, Math.max(1, Number(es.idPadLength) || 4))
  const start = Math.max(1, Math.round(Number(es.idStartNumber) || 1))
  const format = (v: number) => `${prefix}-${String(start + v - 1).padStart(pad, "0")}${suffix}`
  return { prefix, suffix, start, pad, seqKey: `employee-code:${prefix}:${suffix}:${start}:${pad}`, format }
}

/**
 * Allocate the NEXT sequential employee code for a vendor. Atomic via the
 * shared SequenceCounter (M-7); if the counter lags behind codes minted before
 * it existed (or manual codes), the loop advances past existing collisions.
 *
 * @param existingCodes optional pre-loaded set of the vendor's current codes
 *   (the bulk importer loads them once for the whole batch instead of paying
 *   one query per row).
 */
export async function nextEmployeeCode(vendorId: string, existingCodes?: Set<string>): Promise<string> {
  const scheme = await employeeCodeScheme(vendorId)
  const used = existingCodes ?? new Set(
    (await db.employee.findMany({ where: { vendorId }, select: { code: true } })).map((e: any) => e.code),
  )
  let code = await nextFormattedSeq(vendorId, scheme.seqKey, scheme.format)
  // bounded: every collision consumes at least one real code from `used`
  for (let guard = 0; code && used.has(code) && guard < used.size + 1000; guard++) {
    code = await nextFormattedSeq(vendorId, scheme.seqKey, scheme.format)
  }
  if (!code) throw Object.assign(new Error("Could not allocate an employee code — set one manually"), { code: 500 })
  // register the freshly minted code so a batch allocating many codes in a
  // row also skips ITS OWN earlier allocations without re-querying
  used.add(code)
  return code
}
