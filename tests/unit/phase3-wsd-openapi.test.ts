/// <reference types="bun-types" />
// ============ Phase 3 WS-D — OpenAPI 3.1 contract test (MOB-6) ================
// The spec (src/api-contract/openapi-v1.ts), the route files and the generated
// client (src/api-client/index.ts) must never drift apart:
//   1. every spec path+method maps to an existing route file exporting it;
//   2. every operationId has a method on the generated client;
//   3. every scope named in the spec's security requirements is a real scope
//      from the SCOPE_CATALOG the token endpoint validates against;
//   4. the serving route answers with the same document.
import "./_testdb"
import { describe, test, expect } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { OPENAPI_V1_SPEC } from "@/api-contract/openapi-v1"
import { SCOPE_CATALOG } from "@/app/api/v1/_tokens"
import { FinixApiClient } from "@/api-client"
import { GET as openapiRoute } from "@/app/api/v1/openapi/route"

const ROOT = path.resolve(import.meta.dir, "../..")
type Op = { operationId: string; security?: Record<string, string[]>[] }

function routeFileFor(specPath: string): string {
  // /api/v1/employees/{id} → src/app/api/v1/employees/[id]/route.ts
  const fsPath = specPath.replace(/\{([^}]+)\}/g, "[$1]")
  return path.join(ROOT, "src/app", fsPath, "route.ts")
}

describe("MOB-6 — the OpenAPI contract matches the implementation", () => {
  const spec = OPENAPI_V1_SPEC as {
    paths: Record<string, Record<string, Op>>
    openapi: string
  }

  test("declares OpenAPI 3.1", () => {
    expect(spec.openapi).toBe("3.1.0")
  })

  test("every spec path+method exists as a route file exporting it", () => {
    for (const [specPath, ops] of Object.entries(spec.paths)) {
      const file = routeFileFor(specPath)
      expect(fs.existsSync(file)).toBe(true)
      const src = fs.readFileSync(file, "utf8")
      for (const method of Object.keys(ops)) {
        expect(src).toMatch(new RegExp(`export async function ${method.toUpperCase()}\\b`))
      }
    }
  })

  test("every operationId is a method on the generated client", () => {
    const client: any = FinixApiClient.prototype
    // the token endpoint is generated as the two specialized grant methods
    const SPECIALIZED: Record<string, string[]> = { issueToken: ["passwordGrant", "refresh"] }
    for (const ops of Object.values(spec.paths)) {
      for (const op of Object.values(ops)) {
        if (!op.operationId) continue
        const names = SPECIALIZED[op.operationId] || [op.operationId]
        for (const n of names) expect(typeof client[n]).toBe("function")
      }
    }
  })

  test("every scope in the security requirements belongs to the SCOPE_CATALOG", () => {
    const catalog = new Set<string>(SCOPE_CATALOG)
    for (const ops of Object.values(spec.paths)) {
      for (const op of Object.values(ops)) {
        for (const req of op.security || []) {
          for (const scopes of Object.values(req)) {
            for (const s of scopes) expect(catalog.has(s)).toBe(true)
          }
        }
      }
    }
  })

  test("GET /api/v1/openapi serves the same document", async () => {
    const res = await openapiRoute()
    expect(res.status).toBe(200)
    const served = await res.json()
    expect(served.openapi).toBe("3.1.0")
    expect(Object.keys(served.paths).sort()).toEqual(Object.keys(spec.paths).sort())
  })

  test("the generated client follows cursors end-to-end (stubbed transport)", async () => {
    let call = 0
    const pages = [
      { ok: true, data: [{ id: "e1" }, { id: "e2" }], meta: { hasMore: true, nextCursor: "CUR1" } },
      { ok: true, data: [{ id: "e3" }], meta: { hasMore: false, nextCursor: null } },
    ]
    const fetchImpl = (async (url: string) => {
      const u = new URL(url)
      call++
      if (call === 1) expect(u.searchParams.get("updatedSince")).toBe("2026-10-22T00:00:00Z")
      if (call === 2) expect(u.searchParams.get("cursor")).toBe("CUR1")
      return new Response(JSON.stringify(pages[call - 1]), {
        status: 200,
        headers: { "content-type": "application/json", etag: `W/"p${call}"` },
      })
    }) as typeof fetch

    const api = new FinixApiClient({ baseUrl: "http://stub", fetchImpl })
    const all = await api.listAllEmployees({ updatedSince: "2026-10-22T00:00:00Z", pageSize: 2 })
    expect(all.map((e: any) => e.id)).toEqual(["e1", "e2", "e3"])
    expect(call).toBe(2)
  })
})
