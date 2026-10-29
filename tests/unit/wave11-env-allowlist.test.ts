/// <reference types="bun-types" />
// ============ Wave 11 (2026-10-26) — env allowlist regression guard ============
// The exact bug that blocked the operator on 2026-10-25/26: the WebAuthn round
// documented HRM_WEBAUTHN_RPID / HRM_WEBAUTHN_ORIGINS in .env.example but never
// added them to instrumentation.ts's KNOWN_ENV_KEYS — every deployment that
// copied .env.example to .env failed validateEnvKeys() at boot. This test
// cross-checks the two lists mechanically so that class of drift can never
// ship again: every UNCOMMENTED HRM_/ZKTECO_/ADMS_ key documented in
// .env.example MUST be allowlisted, and the two WebAuthn keys MUST both exist.
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { _KNOWN_ENV_KEYS_FOR_TESTS } from "@/instrumentation"

const envExamplePath = resolve(import.meta.dir, "..", "..", ".env.example")

function documentedEnvKeys(): Set<string> {
  const raw = readFileSync(envExamplePath, "utf8")
  const keys = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(HRM_[A-Z0-9_]+|ZKTECO_[A-Z0-9_]+|ADMS_[A-Z0-9_]+)\s*=/.exec(line)
    if (m) keys.add(m[1])
  }
  return keys
}

describe("Wave 11 — instrumentation env allowlist", () => {
  test("the WebAuthn keys that broke boot on 2026-10-25 are allowlisted", () => {
    expect(_KNOWN_ENV_KEYS_FOR_TESTS.has("HRM_WEBAUTHN_RPID")).toBe(true)
    expect(_KNOWN_ENV_KEYS_FOR_TESTS.has("HRM_WEBAUTHN_ORIGINS")).toBe(true)
  })

  test("every HRM_/ZKTECO_/ADMS_ key documented in .env.example is allowlisted", () => {
    const documented = documentedEnvKeys()
    expect(documented.size).toBeGreaterThan(20) // parse sanity — a broken read fails loudly
    const missing = [...documented].filter((k) => !_KNOWN_ENV_KEYS_FOR_TESTS.has(k))
    expect(missing).toEqual([])
  })
})
