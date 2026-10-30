/// <reference types="bun-types" />
// ============ Wave 11 (2026-10-26) — outbox + cursor + defaults regressions ====
// Pure-function surfaces of the two feature rounds:
//   Outbox — backoff ladder bounds/growth (§4: "bounded retries, exponential
//            backoff, dead-letter handling") + the OutboxEvent delegate exists
//            on the generated Prisma client (schema/migration alignment).
//   Cursor — §12 contract: the two new designs parse through the owner-save
//            zod schema, COMET is the default (schema default + platform
//            default config), and unknown styles are rejected.
// NOTE: deliberately NO "./_testdb" import — everything here is pure (the
// PrismaClient is constructed but never connects; zod schemas and config
// constants don't touch the DB), so this file runs even without a test
// database, keeping it inside the sandbox/CI "pure suite".
import { describe, test, expect } from "bun:test"
import { outboxBackoffMs } from "@/hrm-server/outbox"
import { cursorSchema } from "@/hrm-server/saas/cms-routes"
import { DEFAULT_CURSOR_CONFIG } from "@/hrm-server/saas/cms-defaults"
import { PrismaClient } from "@prisma/client"

describe("Wave 11 — outbox backoff ladder", () => {
  test("backoff stays within ±25% jitter of the exponential value, capped at 15 min", () => {
    const base = 30_000
    for (let attempts = 1; attempts <= 8; attempts++) {
      const exp = Math.min(base * 2 ** (attempts - 1), 15 * 60_000)
      const lo = exp * 0.74
      const hi = exp * 1.26
      for (let sample = 0; sample < 200; sample++) {
        const v = outboxBackoffMs(attempts)
        expect(v).toBeGreaterThanOrEqual(lo)
        expect(v).toBeLessThanOrEqual(hi)
      }
    }
  })

  test("the ladder is capped at 15 minutes even after many attempts", () => {
    for (let sample = 0; sample < 50; sample++) {
      expect(outboxBackoffMs(9)).toBeLessThanOrEqual(15 * 60_000 * 1.26)
    }
  })

  test("later attempts schedule strictly longer waits (sampled)", () => {
    // Statistical, but with 200 samples the max of attempt 4 vs the min of
    // attempt 1 is 2^3 = 8× apart in expectation — a deterministic assertion
    // for any sane RNG.
    let minA4 = Number.POSITIVE_INFINITY
    let maxA1 = 0
    for (let sample = 0; sample < 200; sample++) {
      minA4 = Math.min(minA4, outboxBackoffMs(4))
      maxA1 = Math.max(maxA1, outboxBackoffMs(1))
    }
    expect(minA4).toBeGreaterThan(maxA1)
  })
})

describe("Wave 11 — OutboxEvent is a first-class Prisma model", () => {
  test("the generated client exposes the outboxEvent delegate (schema ↔ client aligned)", () => {
    // Constructing a PrismaClient performs NO connection — the delegate table
    // is built at client construction, so this asserts schema↔client alignment
    // without a live database.
    const client = new PrismaClient({ log: [] })
    expect(typeof client.outboxEvent).toBe("object")
    expect(typeof (client.outboxEvent as { create?: unknown }).create).toBe("function")
    expect(typeof (client.outboxEvent as { updateMany?: unknown }).updateMany).toBe("function")
  })
})

describe("Wave 11 — cursor style catalog (§12)", () => {
  test("the two new designs are accepted by the owner-save schema", () => {
    const auroraTrail = cursorSchema.parse({ style: "aurora-trail" })
    expect(auroraTrail.style).toBe("aurora-trail")
    const magneticSpark = cursorSchema.parse({ style: "magnetic-spark" })
    expect(magneticSpark.style).toBe("magnetic-spark")
  })

  test("COMET is the default after a bare save (schema level)", () => {
    const bare = cursorSchema.parse({})
    expect(bare.style).toBe("comet")
    expect(bare.enabled).toBe(true)
  })

  test("COMET is the platform default config (fresh installs)", () => {
    expect(DEFAULT_CURSOR_CONFIG.style).toBe("comet")
    expect(DEFAULT_CURSOR_CONFIG.enabled).toBe(true)
  })

  test("unknown styles are rejected (no silent fallthrough)", () => {
    const r = cursorSchema.safeParse({ style: "neon" })
    expect(r.success).toBe(false)
  })

  test("all five styles round-trip a full config", () => {
    const ALL = ["aurora", "comet", "classic", "aurora-trail", "magnetic-spark"] as const
    for (const style of ALL) {
      const parsed = cursorSchema.parse({
        style,
        primaryColor: "#38bdf8",
        accentColor: "#22d3ee",
        pullStrength: 7,
        trailIntensity: 80,
        glow: 60,
        magnetic: true,
        tilt: false,
        ripple: true,
        viewLabels: true,
        viewLabel: "OPEN",
      })
      expect(parsed.style).toBe(style)
      expect(parsed.viewLabel).toBe("OPEN")
    }
  })
})
