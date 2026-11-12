/// <reference types="bun-types" />
// ============ R14 regression: storage usage math + MB/GB formatting ============
// Audit (2026-10-12): subscription.usage computed STORAGE pct as
// used(bytes) / limit(GB) — e.g. 2 MB used against a 5 GB cap reported 40,000%
// and a permanent "over limit" callout. Fixed: both sides normalized to bytes;
// callouts and the UsagePanel render MB below 1 GB and GB above.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import { fmtStorageBytes, fmtStorageGb } from "@/hrm/shared/usage-panel"

describe("R14 — storage MB/GB formatting", () => {
  test("bytes below 1 GB render as MB", () => {
    expect(fmtStorageBytes(0)).toBe("0 MB")
    expect(fmtStorageBytes(512 * 1024)).toBe("0.5 MB") // 512 KB
    expect(fmtStorageBytes(2 * 1024 * 1024)).toBe("2.0 MB")
    expect(fmtStorageBytes(412.6 * 1024 * 1024)).toBe("412.6 MB")
  })
  test("bytes at/above 1 GB render as GB with 2 decimals", () => {
    expect(fmtStorageBytes(1024 ** 3)).toBe("1.00 GB")
    expect(fmtStorageBytes(2.5 * 1024 ** 3)).toBe("2.50 GB")
  })
  test("fractional-GB plan quotas render as MB; whole GB stays GB", () => {
    expect(fmtStorageGb(null)).toBe("unlimited")
    expect(fmtStorageGb(5)).toBe("5 GB")
    expect(fmtStorageGb(0.5)).toBe("512 MB")
    expect(fmtStorageGb(25.5)).toBe("25.50 GB")
  })
})
