/// <reference types="bun-types" />
// ============ bun-test preload (runs BEFORE any test file is loaded) ============
// Registered in bunfig.toml [test].preload. Guarantees DATABASE_URL points at
// the ISOLATED unit-test PostgreSQL database BEFORE any module graph that
// touches @/lib/db can construct the PrismaClient singleton (utils.ts imports
// db transitively, so plain import-order bootstrapping is not enough).
//
// Test-database selection — candidates are tried IN ORDER and the first one
// that `prisma db push --force-reset` accepts wins (db push also CREATES the
// database when it does not exist yet, so a fresh machine needs no manual
// setup):
//   1. TEST_DATABASE_URL environment variable (shell export, or the value
//      Bun auto-loaded from .env.test — `bun test` runs with NODE_ENV=test)
//   2. TEST_DATABASE_URL in .env
//   3. DERIVED from the DATABASE_URL inside the .env FILE — the developer's
//      real working credentials, with the database name swapped to "hrm_test"
//      (NOT process.env.DATABASE_URL: when Bun auto-loads .env.test it
//      OVERRIDES .env, replacing DATABASE_URL with the template's example
//      credentials — so the file must be read directly)
//   4. Derived from process.env.DATABASE_URL (when it is a PostgreSQL URL
//      and differs from #3 — e.g. a working URL exported in the shell)
//   5. Legacy localhost default postgres:postgres@127.0.0.1:5432/hrm_test
//
// Safety (tests NEVER touch real data):
//   - a URL whose database name contains "production" is refused outright;
//   - a URL that points at the SAME server+database as a development
//     DATABASE_URL (.env file or process env) is refused (--force-reset
//     would wipe the dev database);
//   - the unit-test database is disposable by design (it contains no data).
import { execSync } from "child_process"
import * as path from "path"
import * as fs from "fs"

const ROOT = path.resolve(import.meta.dir, "..")
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma")
const LEGACY_DEFAULT = "postgresql://postgres:postgres@127.0.0.1:5432/hrm_test"

function readEnvFile(name: string): Record<string, string> {
  const out: Record<string, string> = {}
  const p = path.join(ROOT, name)
  if (!fs.existsSync(p)) return out
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/)
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2]
  }
  return out
}

/** Mask the password so URLs can be printed safely. */
function maskUrl(url: string): string {
  return url.replace(/(:\/\/[^:\/@]+:)[^@]+@/, "$1***@")
}

/** Stable "host:port/database" identity of a connection URL (for equality checks). */
function dbTarget(url: string): string {
  try {
    const u = new URL(url)
    const db = decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase()
    const host = (u.hostname || "localhost").toLowerCase()
    const port = u.port || "5432"
    const schema = (u.searchParams.get("schema") || "public").toLowerCase()
    return `${host}:${port}/${db}:${schema}`
  } catch {
    return url.toLowerCase()
  }
}

/** Same server + credentials, but pointed at the isolated test database. */
function swapDatabase(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = "/" + dbName
  return u.toString()
}

function lastErrorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error/i.test(lines[i])) return lines[i]
  }
  return lines[lines.length - 1] ?? "unknown error"
}

const envFile = readEnvFile(".env")

// ---- Build the ordered, de-duplicated candidate list -----------------------
type Candidate = { url: string; label: string }
const candidates: Candidate[] = []
const seen = new Set<string>()
function addCandidate(raw: string | undefined, label: string): void {
  if (!raw || !/^postgres(ql)?(\/\+[^:]*)?:\/\//i.test(raw)) return
  if (seen.has(raw)) return
  seen.add(raw)
  candidates.push({ url: raw, label })
}
addCandidate(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL environment variable (or auto-loaded .env.test)")
addCandidate(envFile.TEST_DATABASE_URL, "TEST_DATABASE_URL in .env")
// The .env FILE is the only place the developer's real credentials are
// guaranteed to survive Bun's .env.test auto-override during `bun test`.
addCandidate(
  envFile.DATABASE_URL ? swapDatabase(envFile.DATABASE_URL, "hrm_test") : undefined,
  "derived from DATABASE_URL in .env (your working credentials, isolated hrm_test database)",
)
addCandidate(
  process.env.DATABASE_URL ? swapDatabase(process.env.DATABASE_URL, "hrm_test") : undefined,
  "derived from the DATABASE_URL environment variable",
)
// When hrm_user lacks CREATEDB permission, use an isolated schema in the existing database
function schemaIsolatedCandidate(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    u.searchParams.set("schema", "hrm_unit_test")
    return u.toString()
  } catch {
    return undefined
  }
}
addCandidate(
  schemaIsolatedCandidate(envFile.DATABASE_URL),
  "derived from DATABASE_URL in .env (isolated hrm_unit_test schema)",
)
addCandidate(
  schemaIsolatedCandidate(process.env.DATABASE_URL),
  "derived from DATABASE_URL env (isolated hrm_unit_test schema)",
)
addCandidate(LEGACY_DEFAULT, "legacy localhost default")

// ---- Development databases that must NEVER be force-reset ------------------
const devTargets = new Set<string>()
for (const u of [envFile.DATABASE_URL, process.env.DATABASE_URL]) {
  if (u && /^postgres(ql)?(\/\+[^:]*)?:\/\//i.test(u)) devTargets.add(dbTarget(u))
}

// ---- Try each candidate: the first successful `db push` wins ---------------
type Attempt = { label: string; url: string; result: string }
const attempts: Attempt[] = []
let TEST_URL: string | null = null

for (const c of candidates) {
  if (/production/i.test(c.url)) {
    attempts.push({ ...c, result: "REFUSED — database name contains \"production\" (tests never touch production)" })
    continue
  }
  if (devTargets.has(dbTarget(c.url))) {
    attempts.push({ ...c, result: "REFUSED — same server+database as a development DATABASE_URL; --force-reset would wipe it" })
    continue
  }
  try {
    execSync(`bunx prisma db push --force-reset --skip-generate --schema "${SCHEMA}"`, {
      stdio: "pipe",
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: c.url },
      timeout: 120_000,
    })
    TEST_URL = c.url
    break
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number }
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.toString()
    let result = lastErrorLine(out)
    if (/P1000|authentication failed/i.test(out)) result = `credentials rejected by the server (P1000): ${result}`
    else if (/P1001|can't reach|ENOTFOUND|ECONNREFUSED/i.test(out)) result = `server unreachable (P1001): ${result}`
    attempts.push({ ...c, result })
  }
}

if (!TEST_URL) {
  console.error(
    `
[preload] Could not prepare an isolated unit-test database. Attempted:

${attempts.map((a) => `  - ${maskUrl(a.url)}\n      (${a.label})\n      -> ${a.result}`).join("\n")}

How to fix — pick ONE:
  1. Best: nothing to do IF your development DATABASE_URL in .env already works —
     the tests reuse ITS credentials against a separate "hrm_test" database and
     create that database automatically. If that candidate is missing above,
     check that .env has a valid DATABASE_URL.
  2. Or set an explicit test database:
       TEST_DATABASE_URL="postgresql://<user>:<password>@127.0.0.1:5432/hrm_test"
     (in .env, or as an environment variable; NEVER point it at production or
     at your development database — it is force-reset on every test run).
  3. If your PostgreSQL is not running (or listens on another host/port),
     start it or adjust the URLs above accordingly. The "hrm_test" database
     itself is created automatically when it does not exist.
`.trimStart(),
  )
  process.exit(1)
}

process.env.DATABASE_URL = TEST_URL
;(process.env as Record<string, string | undefined>).NODE_ENV ||= "test"
// Never let remediation guards (destructive-script safety) block unit tests.
process.env.HRM_E2E_CONFIRM = "I-AM-ON-TEST"

console.log(`[preload] unit-test database ready: ${maskUrl(TEST_URL)}`)
