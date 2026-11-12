/// <reference types="bun-types" />
// ============ W1 SQL helper (the disposable PostgreSQL ships no psql) ============
// Executes ONE SQL statement (or a script as separate statements) against the
// DATABASE_URL the caller exports, prints rows as JSON. Usage:
//   bun scripts/w1-sql.ts "SELECT ..."
import { PrismaClient } from "@prisma/client"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("w1-sql: DATABASE_URL must be exported (source scripts/w1-env.sh)")
  process.exit(1)
}
const sql = process.argv[2]
if (!sql) {
  console.error("w1-sql: one SQL statement required as the first argument")
  process.exit(1)
}
const p = new PrismaClient({ datasources: { db: { url } } })
try {
  const rows = await p.$queryRawUnsafe(sql)
  console.log(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2))
} finally {
  await p.$disconnect()
}
