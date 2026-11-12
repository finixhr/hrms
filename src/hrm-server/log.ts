// ============ FIN-032 (Phase 3) — the structured logging standard ============
// The audit found 106 console.log calls across the backend production paths
// (src/hrm-server, src/app/api) with no standard and no lint ban: log noise,
// a sensitive-field printing risk (contents never audited line by line) and
// container log cost. This module is the ONE logging chokepoint:
//
//   · every backend log line goes through loggerFor("<module>") —
//     scripts/check-no-console-log.mjs fails CI on any console.log in the
//     backend plane, so a new unstructured print cannot land again;
//   · PRODUCTION (NODE_ENV=production, or LOG_FORMAT=json) emits ONE JSON
//     object per line — { ts, level, mod, msg, k… } — ready for a log shipper
//     (Loki/CloudWatch) without regex parsing;
//   · development/CLI (seeds, scripts) keeps the human-pretty single-line
//     form via process.stdout, so seed output stays readable;
//   · structured fields are passed as extras, never string-interpolated into
//     msg, so a shipper can filter on { mod: "lifecycle", event: "drain" }.
//
// Security posture (same as the audit demanded): the logger never inspects or
// redacts values — callers pass display strings, exactly as they did before;
// centralizing the emission is what makes a future redaction pass one edit.
type Level = "debug" | "info" | "warn" | "error"

const JSON_MODE = process.env.LOG_FORMAT === "json" || process.env.NODE_ENV === "production"
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? LEVELS.info

/** Normalize a second call argument into structured fields. The migrated
 *  console.error("msg", e) call sites pass the caught error positionally;
 *  rather than rewriting 124 catch sites, the logger accepts it and emits it
 *  as a field: an Error → { err: <message> }, an object → itself, a
 *  primitive → { extra: <value> }. Callers that want full fidelity write
 *  log.error(msg, { err: e, runId }) as usual. */
function normalizeFields(f: unknown): Record<string, unknown> | undefined {
  if (f == null) return undefined
  if (typeof f === "object" && !(f instanceof Error)) return f as Record<string, unknown>
  if (f instanceof Error) return { err: f.message }
  return { extra: String(f) }
}

function emit(level: Level, mod: string, msg: string, fields?: unknown) {
  if (LEVELS[level] < MIN) return
  const ts = new Date().toISOString()
  const f = normalizeFields(fields)
  if (JSON_MODE) {
    const line: Record<string, unknown> = { ts, level, mod, msg }
    if (f) for (const [k, v] of Object.entries(f)) if (v !== undefined) line[k] = v
    process.stdout.write(JSON.stringify(line) + "\n")
  } else {
    const extras = f && Object.keys(f).length ? " " + JSON.stringify(f) : ""
    const out = `${ts} ${level.toUpperCase().padEnd(5)} [${mod}] ${msg}${extras}\n`
    if (level === "error") process.stderr.write(out)
    else process.stdout.write(out)
  }
}

/** Module-scoped logger — the standard import at the top of every backend
 *  module that used to console.log:
 *
 *    import { loggerFor } from "@/hrm-server/log"
 *    const log = loggerFor("lifecycle")
 *    log.info("drain complete")
 *    log.warn("bg job recovered stale rows", { count: res.count })
 */
export function loggerFor(mod: string) {
  return {
    debug: (msg: string, fields?: unknown) => emit("debug", mod, msg, fields),
    info: (msg: string, fields?: unknown) => emit("info", mod, msg, fields),
    warn: (msg: string, fields?: unknown) => emit("warn", mod, msg, fields),
    error: (msg: string, fields?: unknown) => emit("error", mod, msg, fields),
  }
}

/** Test/CLI helper — the seeds print progress blocks; keep them pretty and
 *  explicitly scoped (level info, module "seed") instead of bare prints. */
export const seedLog = loggerFor("seed")
