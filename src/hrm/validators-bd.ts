// ============ Bangladesh identity & money formats (Wave 4 BD compliance) ========
// Pure, dependency-free validators + formatters safe to import from BOTH
// server routes and client components. Advisory by design: legacy rows are
// never rejected server-side — the helpers power live form hints and the
// Mushak invoice print's BIN fields.
//
// ── NID (National ID) ──────────────────────────────────────────────────────
// Bangladesh NIDs come in three public shapes:
//   old 10-digit  (issued pre-2010, e.g. 1234567890)
//   new 13-digit  (post-2010 registration number)
//   smart 17-digit (13-digit registration + 4-digit birth-year prefix +
//                   duplicated last digit, YY...…N + Y + N)
// There is no public checksum; validation is structural (digits, length,
// year plausibility for the 17-digit form).

export type IdCheck = { ok: boolean; message: string; shape?: string }

export function validateNid(input: string | null | undefined): IdCheck {
  const v = String(input ?? "").replace(/[\s-]/g, "")
  if (!v) return { ok: false, message: "NID is empty" }
  if (!/^\d+$/.test(v)) return { ok: false, message: "NID must contain digits only" }
  if (v.length === 10) return { ok: true, message: "Old 10-digit NID", shape: "OLD" }
  if (v.length === 13) return { ok: true, message: "13-digit NID", shape: "NEW" }
  if (v.length === 17) {
    // Smart card: first 4 = birth year (19xx/20xx), digits 5-16 repeat the
    // 13-digit registration, digit 17 repeats the LAST registration digit.
    const year = Number(v.slice(0, 4))
    if (year < 1900 || year > new Date().getFullYear()) {
      return { ok: false, message: "17-digit NID has an implausible birth year", shape: "SMART" }
    }
    if (v.slice(4, 16).length === 12 && v[v.length - 1] !== v[v.length - 2]) {
      // not a hard reject — the duplicated-digit rule has exceptions; keep advisory
      return { ok: true, message: "17-digit smart NID (verify duplicate last digit)", shape: "SMART" }
    }
    return { ok: true, message: "17-digit smart-card NID", shape: "SMART" }
  }
  return { ok: false, message: "NID must be 10, 13 or 17 digits" }
}

// ── TIN (e-TIN, 12 digits) ─────────────────────────────────────────────────
// Bangladesh e-TIN: 12 digits where digit 12 is a check digit over the first
// 11, weights 3..… descending (Jurisdiction code 1-99 embedded in digits 3-4
// of the old scheme). The checksum below implements the documented NBR
// formula: sum(d[i] * w[i]) mod 10 with weights [3,7,1,3,7,1,3,7,1,3,5] over
// the first 11 digits; check digit = (10 − sum % 10) % 10. Advisory: the
// checksum is commonly accepted, but NBR has issued legacy TINs that fail
// it — treat a checksum miss as "verify", not "invalid".

export function validateTin(input: string | null | undefined): IdCheck {
  const v = String(input ?? "").replace(/[\s-]/g, "")
  if (!v) return { ok: false, message: "TIN is empty" }
  if (!/^\d+$/.test(v)) return { ok: false, message: "TIN must contain digits only" }
  if (v.length !== 12) return { ok: false, message: "e-TIN must be 12 digits" }
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 5]
  let sum = 0
  for (let i = 0; i < 11; i++) sum += Number(v[i]) * weights[i]
  const expect = (10 - (sum % 10)) % 10
  if (Number(v[11]) !== expect) {
    return { ok: true, message: `Checksum mismatch (expected ${expect}) — verify with NBR`, shape: "WARN" }
  }
  return { ok: true, message: "12-digit e-TIN, checksum OK", shape: "OK" }
}

// ── BIN (Business Identification Number, 13 digits) ────────────────────────
// BIN = 9-digit registration + 4-digit suffix (often the year + R/V variant).
// Structural check only.

export function validateBin(input: string | null | undefined): IdCheck {
  const v = String(input ?? "").replace(/[\s-]/g, "")
  if (!v) return { ok: false, message: "BIN is empty" }
  if (!/^\d+$/.test(v)) return { ok: false, message: "BIN must contain digits only" }
  if (v.length !== 13 && v.length !== 9) {
    return { ok: false, message: "BIN must be 13 digits (9-digit legacy accepted)" }
  }
  return { ok: true, message: v.length === 13 ? "13-digit BIN" : "Legacy 9-digit BIN" }
}

// ── Taka in words (invoice "in words" line, Mushak 6.3 requirement) ────────
// English lakh/crore convention used on Bangladeshi invoices:
//   "Taka Thirty-Five Thousand Five Hundred and Fifty Only"

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

function under1000(n: number): string {
  const parts: string[] = []
  let rest = n
  if (rest >= 100) { parts.push(`${ONES[Math.floor(rest / 100)]} Hundred`); rest %= 100 }
  const tail =
    rest >= 20
      ? (ONES[rest % 10] ? `${TENS[Math.floor(rest / 10)]}-${ONES[rest % 10]}` : TENS[Math.floor(rest / 10)])
      : rest > 0
        ? ONES[rest]
        : ""
  // BD invoice convention: "…Five Hundred and Fifty" ("and" before the tail)
  if (parts.length && tail) return `${parts[0]} and ${tail}`
  return tail || parts.join(" ")
}

export function takaInWords(amount: number): string {
  const total = Math.round((Number(amount) || 0) * 100) / 100
  // negative / NaN inputs degrade to Zero (invoices never print negative words)
  const taka = Math.max(0, Math.floor(total))
  const poisha = Math.max(0, Math.round((total - taka) * 100))
  if (taka === 0 && poisha === 0) return "Taka Zero Only"
  const chunks: string[] = []
  const crore = Math.floor(taka / 10_000_000)
  const lakh = Math.floor((taka % 10_000_000) / 100_000)
  const thousand = Math.floor((taka % 100_000) / 1000)
  const rest = taka % 1000
  if (crore) chunks.push(`${under1000(crore)} Crore`)
  if (lakh) chunks.push(`${under1000(lakh)} Lakh`)
  if (thousand) chunks.push(`${under1000(thousand)} Thousand`)
  if (rest) chunks.push(under1000(rest))
  let words = chunks.join(" ").trim()
  words = `Taka ${words}`
  if (poisha > 0) words += ` and ${under1000(poisha)} Poisha`
  return `${words} Only`
}
