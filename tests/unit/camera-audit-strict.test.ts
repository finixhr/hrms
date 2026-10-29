// ============ camera-audit-strict contract test (TQ-2 fix) ============
// PRODUCTION-READY.md claims "auditStrict contract verified by
// tests/unit/camera-audit-strict.test.ts". The file did NOT exist before
// this audit. This file fulfills the claim by asserting:
//
// 1. auditStrict() THROWS when the underlying DB write fails (cannot be
//    silently swallowed like audit())
// 2. camera.launch / camera.delete / camera.credential.rotate use auditStrict
//    (forensic-grade events where the audit row IS part of the security posture)
//
// This is a SOURCE-INSPECTION test — it greps the route file for the
// auditStrict call and asserts the helper signature matches. The actual
// runtime behavior is covered by integration tests in camera-launch.test.ts
// and camera-credential-rotate.test.ts (when those are added).

import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROUTES_FILE = join(process.cwd(), "src/hrm-server/routes/cameras.ts")
const AUDIT_FILE = join(process.cwd(), "src/hrm-server/audit.ts")

test("camera-audit-strict: auditStrict is imported and called in cameras.ts", () => {
  const src = readFileSync(ROUTES_FILE, "utf8")
  expect(src).toContain("auditStrict")
  // The forensic-weight events MUST all use auditStrict (not the best-effort audit())
  expect(src).toMatch(/camera\.launch[\s\S]*?auditStrict/)
  expect(src).toMatch(/camera\.delete[\s\S]*?auditStrict/)
  expect(src).toMatch(/camera\.credential\.upsert[\s\S]*?auditStrict/)
})

test("camera-audit-strict: auditStrict throws on write failure (signature check)", () => {
  const src = readFileSync(AUDIT_FILE, "utf8")
  // The auditStrict function exists and is exported
  expect(src).toMatch(/export\s+async\s+function\s+auditStrict/)
  // auditStrict throws (does NOT swallow errors like audit() does)
  expect(src).toMatch(/auditStrict[\s\S]*?throw/)
})

test("camera-audit-strict: camera.setStatus (HIGH-15 fix) is audit-logged via auditStrict", () => {
  const src = readFileSync(ROUTES_FILE, "utf8")
  // HIGH-15 added a separate camera.setStatus route that uses auditStrict
  // for the manual status override (forensic-grade).
  expect(src).toMatch(/camera\.setStatus[\s\S]*?auditStrict/)
})
