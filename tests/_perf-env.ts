/// <reference types="bun-types" />
// ============ Phase 4 WS-E — opt-in Prisma query instrumentation ============
// Loaded (dynamically, by tests/unit/phase4-perf-budget.test.ts) when
// HRM_QUERY_COUNT=1: wraps every model-delegate operation on the SHARED db
// singleton (the object every route module captured) with a counter —
// zero overhead unless this module is imported, and the import happens only
// in the perf-budget stage.
//
// Counted: every call through the singleton's model delegates (findMany,
// create, updateMany, groupBy, …). NOT counted: queries issued through a
// $transaction client (a separate delegate object created per transaction) —
// the profiled read actions do not transact, and the caps document this.
const INSTRUMENTED = Symbol.for("finix.hrm.perfInstrumented")
const QUERY_COUNT = Symbol.for("finix.hrm.queryCount")

export function queryCount(): number {
  return Number((globalThis as any)[QUERY_COUNT] || 0)
}

export function resetQueryCount(): void {
  ;(globalThis as any)[QUERY_COUNT] = 0
}

export async function instrumentQueries(): Promise<void> {
  if ((globalThis as any)[INSTRUMENTED]) return
  ;(globalThis as any)[INSTRUMENTED] = true
  const { db } = await import("@/lib/db")
  const OPS = new Set([
    "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
    "create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert",
    "delete", "deleteMany", "count", "aggregate", "groupBy",
  ])
  for (const key of Object.keys(db)) {
    if (key.startsWith("$")) continue // engine/internal — model delegates only
    const delegate = (db as any)[key]
    if (!delegate || typeof delegate !== "object") continue
    for (const op of Object.keys(delegate)) {
      if (!OPS.has(op)) continue
      const fn = delegate[op]
      if (typeof fn !== "function") continue
      delegate[op] = function (this: any, ...args: any[]) {
        ;(globalThis as any)[QUERY_COUNT] = Number((globalThis as any)[QUERY_COUNT] || 0) + 1
        return fn.apply(this, args)
      }
    }
  }
}
