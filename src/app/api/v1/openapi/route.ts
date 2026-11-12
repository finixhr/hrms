// ============ GET /api/v1/openapi.json — serve the OpenAPI 3.1 contract =======
// MOB-6 (Phase 3 WS-D). Public and unauthenticated by design: the contract
// documents the auth requirements; it carries no deployment secrets.
import { NextResponse } from "next/server"
import { OPENAPI_V1_SPEC } from "@/api-contract/openapi-v1"

export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(OPENAPI_V1_SPEC, {
    headers: { "Cache-Control": "public, max-age=300" },
  })
}
