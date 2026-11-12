#!/usr/bin/env node
// ============ FIN-036 (Phase 3) — performance trend gate =====================
// The audit: "k6 performance gate is a newly added stage; baselines are
// static files with no trend alerting." The unit-lane budget
// (tests/perf-baseline.json) and the k6 scenario thresholds are STATIC — a
// slow drift that stays under the absolute budget is invisible until it
// breaches. This module adds the trending layer on top of the nightly k6
// money-path lane (ci.sh stage 16):
//
//   · RECORD — every nightly run appends { ts, label, scenarios:{ p95_ms } }
//     to tests/perf-trend.json (capped, default 50 entries);
//   · CHECK — two verdicts per scenario:
//       A. absolute:   latest p95 ≤ the scenario budget (the k6 thresholds,
//                      mirrored here as budgets so the trend file is
//                      self-describing);
//       B. regression: with ≥ PERF_TREND_MIN_SAMPLES (default 3) entries,
//                      latest p95 must stay within PERF_TREND_REGRESSION_PCT
//                      (default 15%) of the median of the PREVIOUS entries —
//                      a slow drift now alerts long before the absolute
//                      breach, and an improving trend never fires.
//
// Usage:
//   node scripts/perf-trend.mjs record --label nightly-2026-11-11 \
//        --scenario payroll-preflight --file /tmp/k6-payroll-preflight.json \
//        --scenario leave-approval --file /tmp/k6-leave-approval.json
//   node scripts/perf-trend.mjs check            # exit 1 on any breach
//   node scripts/perf-trend.mjs show             # print the history table
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const TREND_FILE = join(ROOT, "tests", "perf-trend.json")

export function loadTrend(file = TREND_FILE) {
  return JSON.parse(readFileSync(file, "utf8"))
}

export function saveTrend(data, file = TREND_FILE) {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
}

/** Extract the p95 from a k6 --summary-export JSON (ms). */
export function p95OfSummary(summary) {
  const v = summary?.metrics?.http_req_duration?.["p(95)"]
  return typeof v === "number" ? v : null
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The pure verdict engine — unit-tested (tests/unit/fin36-perf-trend.test.ts).
 *  history: newest-LAST array of { ts, label, scenarios: { <name>: { p95_ms } } }.
 *  Returns { verdict: "pass"|"fail", rows: [...], summary }. */
export function evaluateTrend(history, opts = {}) {
  const budgets = opts.budgets || {}
  const minSamples = opts.minSamples ?? 3
  const regressionPct = opts.regressionPct ?? 15
  const rows = []
  const failures = []
  if (!history.length) {
    return { verdict: "pass", rows: [], summary: "no history yet — record a run first (nothing to alert on)" }
  }
  const latest = history[history.length - 1]
  const previous = history.slice(0, -1)
  for (const [scenario, budget] of Object.entries(budgets)) {
    const latestVal = latest.scenarios?.[scenario]?.p95_ms
    if (latestVal == null) {
      rows.push({ scenario, latest: null, budget: budget.p95_ms, median: null, verdict: "FAIL (missing in latest run)" })
      failures.push(`${scenario}: no p95 recorded in the latest run (${latest.label || latest.ts})`)
      continue
    }
    const priorVals = previous.map((h) => h.scenarios?.[scenario]?.p95_ms).filter((v) => v != null)
    const med = priorVals.length >= Math.max(2, minSamples - 1) ? median(priorVals) : null
    const absOk = latestVal <= budget.p95_ms
    let trendOk = true
    let trendNote = med == null ? `n/a (${priorVals.length} prior sample(s) < ${minSamples})` : `median ${med.toFixed(0)}ms`
    if (med != null && latestVal > med * (1 + regressionPct / 100)) {
      trendOk = false
      trendNote = `REGRESSED +${(((latestVal - med) / med) * 100).toFixed(1)}% vs median ${med.toFixed(0)}ms`
    }
    const ok = absOk && trendOk
    if (!ok) {
      if (!absOk) failures.push(`${scenario}: p95 ${latestVal.toFixed(0)}ms exceeds the ${budget.p95_ms}ms budget`)
      if (!trendOk) failures.push(`${scenario}: p95 ${latestVal.toFixed(0)}ms regressed >${regressionPct}% vs the rolling median (${trendNote})`)
    }
    rows.push({
      scenario,
      latest: latestVal,
      budget: budget.p95_ms,
      median: med,
      verdict: ok ? "ok" : absOk ? `FAIL (trend: ${trendNote})` : `FAIL (over budget)`,
    })
  }
  return {
    verdict: failures.length ? "fail" : "pass",
    rows,
    failures,
    summary: `${history.length} entr${history.length === 1 ? "y" : "ies"} · latest ${latest.label || latest.ts} · ${failures.length} breach(es)`,
  }
}

// ------------------------------- CLI (main module only — unit tests import
// the pure functions above; importing must never trigger the CLI) ---------
import { pathToFileURL } from "node:url"
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (IS_MAIN) {
const [cmd, ...args] = process.argv.slice(2)
if (cmd === "record") {
  const label = (args.match(/--label\s+(\S+)/) || [])[1] || `run-${new Date().toISOString()}`
  const data = loadTrend()
  const scenarios = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      const name = args[i + 1]
      const file = (args.slice(i).match(/--file\s+(\S+)/) || [])[1]
      if (!file) { console.error(`record: --scenario ${name} without --file`); process.exit(2) }
      const p95 = p95OfSummary(JSON.parse(readFileSync(file, "utf8")))
      if (p95 == null) { console.error(`record: no http_req_duration p(95) in ${file}`); process.exit(2) }
      scenarios[name] = { p95_ms: p95 }
    }
  }
  if (!Object.keys(scenarios).length) { console.error("record: no --scenario/--file pairs given"); process.exit(2) }
  data.history.push({ ts: new Date().toISOString(), label, scenarios })
  const cap = data.cap || 50
  while (data.history.length > cap) data.history.shift()
  saveTrend(data)
  console.log(`perf-trend: recorded ${Object.keys(scenarios).length} scenario(s) as "${label}" (${data.history.length}/${cap} entries)`)
  process.exit(0)
}
if (cmd === "check") {
  const data = loadTrend()
  const res = evaluateTrend(data.history, {
    budgets: data.budgets,
    minSamples: Number(process.env.PERF_TREND_MIN_SAMPLES || 3),
    regressionPct: Number(process.env.PERF_TREND_REGRESSION_PCT || 15),
  })
  console.log("── perf trend gate (FIN-036)")
  for (const r of res.rows) {
    const fmt = (v) => (v == null ? "—" : `${v.toFixed ? v.toFixed(0) : v}ms`)
    console.log(`   ${r.scenario}: latest ${fmt(r.latest)} / budget ${fmt(r.budget)} / rolling ${fmt(r.median)} → ${r.verdict}`)
  }
  if (res.verdict === "fail") {
    for (const f of res.failures) console.error(`   FAIL: ${f}`)
    process.exit(1)
  }
  console.log(`   OK: ${res.summary}`)
  process.exit(0)
}
if (cmd === "show") {
  const data = loadTrend()
  console.log(`perf-trend history (${data.history.length} entries, budgets: ${JSON.stringify(data.budgets)})`)
  for (const h of data.history) {
    console.log(`   ${h.ts} ${h.label}: ${JSON.stringify(h.scenarios)}`)
  }
  process.exit(0)
}
console.error("usage: perf-trend.mjs record --label L (--scenario S --file F)+ | check | show")
process.exit(2)
}
