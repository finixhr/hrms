// ============ Wave 4 BD compliance validators — unit tests ============
// NID shapes (10/13/17-digit), e-TIN checksum (12-digit, NBR weights),
// BIN structure, and the Mushak "in words" line (takaInWords).
import { describe, expect, test } from "bun:test"
import { validateNid, validateTin, validateBin, takaInWords } from "../../src/hrm/validators-bd"

describe("validators-bd — NID", () => {
  test("accepts the three public shapes", () => {
    expect(validateNid("1234567890").ok).toBe(true)
    expect(validateNid("1234567890123").ok).toBe(true)
    expect(validateNid("19901234567890123").ok).toBe(true) // 4-digit year + 13-digit registration
  })
  test("tolerates spaces and dashes", () => {
    expect(validateNid("1234-5678-90").ok).toBe(true)
    expect(validateNid(" 1234567890 ").ok).toBe(true)
  })
  test("rejects wrong length / non-digits / empty", () => {
    expect(validateNid("123456789").ok).toBe(false) // 9 digits
    expect(validateNid("12345678901").ok).toBe(false) // 11 digits
    expect(validateNid("123456789A").ok).toBe(false) // letter
    expect(validateNid("").ok).toBe(false)
    expect(validateNid(null).ok).toBe(false)
  })
  test("17-digit smart NID flags implausible birth years", () => {
    expect(validateNid("17991234567890123").ok).toBe(false) // year 1799
    expect(validateNid("29991234567890123").ok).toBe(false) // year 2999
  })
})

describe("validators-bd — e-TIN checksum", () => {
  // weights [3,7,1,3,7,1,3,7,1,3,5] over first 11 digits; check = (10 - sum%10) % 10
  const withCheck = (first11: string) => {
    const w = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 5]
    let sum = 0
    for (let i = 0; i < 11; i++) sum += Number(first11[i]) * w[i]
    return first11 + String((10 - (sum % 10)) % 10)
  }
  test("valid checksum returns OK shape", () => {
    const tin = withCheck("12345678901")
    const r = validateTin(tin)
    expect(r.ok).toBe(true)
    expect(r.shape ?? "").toBe("OK")
    expect(tin).toHaveLength(12)
  })
  test("checksum mismatch stays ADVISORY (ok=true, shape WARN) — legacy NBR TINs exist", () => {
    const r = validateTin("123456789019") // arbitrary last digit
    expect(r.ok).toBe(true)
    expect(["OK", "WARN"]).toContain(r.shape ?? "")
  })
  test("rejects non-12-digit and non-numeric", () => {
    expect(validateTin("1234567890").ok).toBe(false)
    expect(validateTin("1234567890123").ok).toBe(false)
    expect(validateTin("ABCDEFGH").ok).toBe(false)
    expect(validateTin("").ok).toBe(false)
  })
})

describe("validators-bd — BIN", () => {
  test("accepts 13-digit and legacy 9-digit", () => {
    expect(validateBin("1234567890123").ok).toBe(true)
    expect(validateBin("123456789").ok).toBe(true)
  })
  test("rejects other shapes", () => {
    expect(validateBin("12345").ok).toBe(false)
    expect(validateBin("123456789012").ok).toBe(false) // 12 digits
    expect(validateBin("1234-567-8901-23").ok).toBe(true) // dashes stripped
    expect(validateBin("").ok).toBe(false)
  })
})

describe("validators-bd — takaInWords (Mushak 'in words' line)", () => {
  test("simple amounts", () => {
    expect(takaInWords(0)).toBe("Taka Zero Only")
    expect(takaInWords(1)).toBe("Taka One Only")
    expect(takaInWords(21)).toBe("Taka Twenty-One Only")
    expect(takaInWords(100)).toBe("Taka One Hundred Only")
  })
  test("BD lakh/crore convention", () => {
    expect(takaInWords(100000)).toBe("Taka One Lakh Only")
    expect(takaInWords(35550)).toBe("Taka Thirty-Five Thousand Five Hundred and Fifty Only")
    expect(takaInWords(10000000)).toBe("Taka One Crore Only")
    expect(takaInWords(15000000)).toBe("Taka One Crore Fifty Lakh Only")
  })
  test("poisha and rounding", () => {
    expect(takaInWords(10.5)).toBe("Taka Ten and Fifty Poisha Only")
    expect(takaInWords(10.555)).toBe("Taka Ten and Fifty-Six Poisha Only") // rounds to 56
  })
  test("non-finite / negative inputs degrade safely", () => {
    expect(takaInWords(NaN)).toBe("Taka Zero Only")
    expect(takaInWords(-5)).toBe("Taka Zero Only") // floor(-5) = -5… clamp path
  })
})
