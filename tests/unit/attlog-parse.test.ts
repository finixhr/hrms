/// <reference types="bun-types" />
// ============ ATTLOG line parsing — ZKTeco push-SDK field-order regression ============
// Real SenseFace 3A firmware pushes the standard push-SDK order:
//   PIN \t timestamp \t status \t verify \t workcode [\t reserved]
// The parser previously assumed PIN \t verify \t timestamp \t status \t workcode,
// which silently dropped 100% of real device punches (eventCount=0, ACK 200).
import { describe, test, expect } from "bun:test"
import { parseAttLogLine } from "@/hrm-server/zkteco/adapter"

describe("parseAttLogLine — push-SDK standard order (SenseFace 3A)", () => {
  test("parses PIN \\t timestamp \\t status \\t verify \\t workcode", () => {
    const ev = parseAttLogLine("1\t2026-09-22 10:42:40\t0\t15\t0")
    expect(ev).not.toBeNull()
    expect(ev!.deviceUserId).toBe("1")
    expect(ev!.eventTime).toBe("2026-09-22 10:42:40")
    expect(ev!.attendanceStatus).toBe(0)
    expect(ev!.eventType).toBe("IN")
    expect(ev!.verifyMode).toBe(15)
    expect(ev!.workCode).toBe("0")
  })

  test("status 255 → AUTO punch direction", () => {
    const ev = parseAttLogLine("123\t2024-06-15 09:00:00\t255\t15\t0")
    expect(ev!.eventType).toBe("AUTO")
    expect(ev!.attendanceStatus).toBeNull()
  })

  test("trailing reserved field (6 columns) is tolerated", () => {
    const ev = parseAttLogLine("7\t2026-09-22 08:03:11\t1\t15\t0\t0")
    expect(ev!.eventTime).toBe("2026-09-22 08:03:11")
    expect(ev!.eventType).toBe("OUT")
  })

  test("missing workcode (4 columns) parses", () => {
    const ev = parseAttLogLine("9\t2026-09-22 17:30:00\t1\t15")
    expect(ev!.deviceUserId).toBe("9")
    expect(ev!.eventTime).toBe("2026-09-22 17:30:00")
    expect(ev!.eventType).toBe("OUT")
    expect(ev!.workCode).toBeNull()
  })

  test("timestamp with T separator parses", () => {
    const ev = parseAttLogLine("3\t2026-09-22T09:15:00\t0\t15\t0")
    expect(ev!.eventTime).toBe("2026-09-22T09:15:00")
  })

  test("alphanumeric employee-code PIN parses (TCSBL-005 real-world punch)", () => {
    // Exact line pushed by the SenseFace 3A at 11:18 (11 columns — reserved
    // tail + record index). Previously rejected: PIN rule was numeric-only.
    const ev = parseAttLogLine("TCSBL-005\t2026-09-22 11:18:43\t0\t15\t0\t0\t0\t0\t0\t0\t4558")
    expect(ev).not.toBeNull()
    expect(ev!.deviceUserId).toBe("TCSBL-005")
    expect(ev!.eventTime).toBe("2026-09-22 11:18:43")
    expect(ev!.eventType).toBe("IN")
    expect(ev!.verifyMode).toBe(15)
  })

  test("alphanumeric PIN with underscore and dot parses", () => {
    expect(parseAttLogLine("EMP_01.a\t2026-09-22 09:00:00\t0\t15\t0")!.deviceUserId).toBe("EMP_01.a")
  })
})

describe("parseAttLogLine — legacy order stays supported", () => {
  test("parses PIN \\t verify \\t timestamp \\t status \\t workcode", () => {
    const ev = parseAttLogLine("1\t15\t2026-09-15 09:00:00\t0\t0")
    expect(ev).not.toBeNull()
    expect(ev!.deviceUserId).toBe("1")
    expect(ev!.eventTime).toBe("2026-09-15 09:00:00")
    expect(ev!.verifyMode).toBe(15)
    expect(ev!.attendanceStatus).toBe(0)
    expect(ev!.eventType).toBe("IN")
  })
})

describe("parseAttLogLine — malformed input", () => {
  test("no timestamp at any plausible position → null", () => {
    expect(parseAttLogLine("1\tnot-a-date\t0\t15\t0")).toBeNull()
  })

  test("PIN with whitespace/symbol garbage → null", () => {
    // PIN_RE allows [A-Za-z0-9._-] only — anything else is rejected
    expect(parseAttLogLine("AB CD\t2026-09-22 10:00:00\t0\t15\t0")).toBeNull()
    expect(parseAttLogLine("a/b\t2026-09-22 10:00:00\t0\t15\t0")).toBeNull()
  })

  test("empty line → null", () => {
    expect(parseAttLogLine("")).toBeNull()
  })

  test("fewer than 3 fields → null", () => {
    expect(parseAttLogLine("1\t2026-09-22 10:00:00")).toBeNull()
  })
})