// ============ PII field-protection primitives (Wave R3-3, FLD-101/FLD-102) ============
// Shared by BOTH the server routes (employees.ts projection) and the client
// views (edit dialogs must not round-trip masked values back into saves).
// Mirrors the C-05 bank-masking convention already used server-side
// ("•••• 1234") so the product has ONE masking vocabulary.
//
// Design notes:
//  - maskDocNumber is LOSSY by design: the full number can only be re-read
//    from the audited download/view routes or by a caller holding the
//    dedicated reveal permission (employeeDocs.reveal).
//  - isMaskedDocNumber is the write-path guard: employees.update treats a
//    masked identity value as "unchanged" instead of overwriting the stored
//    number with bullets (a profile edit by a non-reveal viewer must never
//    corrupt identity data).

/** Mask a sensitive identifier to its last 4 characters ("•••• 1234").
 *  Values of 4 characters or fewer are fully masked (never reveal a short
 *  number in full). null/undefined pass through untouched. */
export function maskDocNumber(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = String(v)
  if (s === "") return null
  if (s.length <= 4) return "••••"
  return `•••• ${s.slice(-4)}`
}

/** True when the value carries the masking vocabulary — i.e. it came from a
 *  redacted read and must NEVER be persisted as real data. */
export function isMaskedDocNumber(v: unknown): boolean {
  return typeof v === "string" && v.includes("•")
}
