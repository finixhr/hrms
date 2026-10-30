// ============ MOB-6 (Phase 3 WS-D) — OpenAPI 3.1 contract for /api/v1 ==========
// The machine-readable contract for the public REST API, served at
// GET /api/v1/openapi.json and consumed by scripts/gen-api-client.ts to
// generate the TypeScript client (src/api-client/index.ts). The contract test
// (tests/unit/phase3-wsd-openapi.test.ts) fails when the spec and the route
// files drift apart.
//
// Auth (components.securitySchemes):
//   ApiKeyBearer    — Bearer fk_… tenant integration key (scopes per key)
//   UserTokenBearer — Bearer eyJ… user access token (MOB-1; scopes in the JWT)
export type OpenApiSpec = Record<string, unknown>

export const OPENAPI_V1_SPEC: OpenApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Finix HR Public API",
    version: "1.1.0",
    summary: "Tenant-facing REST API for integrations and native mobile clients.",
    description:
      "Base path /api/v1. Two credential types: tenant API keys (Bearer fk_) and user access tokens " +
      "(Bearer eyJ, MOB-1 - minted and rotated via /api/v1/auth/token). List endpoints support page/pageSize " +
      "(legacy), cursor keyset pagination (?cursor=, stable across writes), delta sync (?updatedSince=ISO) and " +
      "ETag/If-None-Match. All responses are JSON: {ok: true, data, meta?} or {ok: false, error, code}. " +
      "Rate limits: 60 req/min per API key, 120 req/min per user token; 429 responses carry Retry-After.",
  },
  servers: [{ url: "/", description: "This deployment" }],
  security: [{ UserTokenBearer: [] }, { ApiKeyBearer: [] }],
  tags: [
    { name: "auth", description: "Token issuance and rotation (MOB-1)" },
    { name: "employees", description: "Employee directory (directory-level field policy)" },
    { name: "attendance", description: "Attendance records and punch ingestion" },
    { name: "leave", description: "Leave requests and balances" },
    { name: "push", description: "Web-push subscriptions (Phase 5 P6): punches/approvals push channel" },
  ],
  paths: {
    "/api/v1/auth/token": {
      post: {
        operationId: "issueToken",
        tags: ["auth"],
        summary: "Password grant (issue access+refresh) or refresh grant (rotate)",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    required: ["grant_type", "email", "password"],
                    properties: {
                      grant_type: { const: "password" },
                      email: { type: "string", format: "email", maxLength: 200 },
                      password: { type: "string", maxLength: 200 },
                      scopes: {
                        type: "array", maxItems: 10,
                        items: { type: "string", enum: ["employees:read", "attendance:read", "attendance:write", "leave:read", "leave:write", "push:write"] },
                      },
                    },
                  },
                  {
                    type: "object",
                    required: ["grant_type", "refresh_token"],
                    properties: {
                      grant_type: { const: "refresh_token" },
                      refresh_token: { type: "string", maxLength: 200 },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Token pair issued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                    data: { "$ref": "#/components/schemas/TokenPair" },
                  },
                },
              },
            },
          },
          "401": { "$ref": "#/components/responses/Error" },
          "403": { "$ref": "#/components/responses/Error" },
        },
      },
    },
    "/api/v1/employees": {
      get: {
        operationId: "listEmployees",
        tags: ["employees"],
        summary: "Employee directory (page mode or cursor mode, delta sync, ETag)",
        security: [{ UserTokenBearer: ["employees:read"] }, { ApiKeyBearer: ["employees:read"] }],
        parameters: [
          { "$ref": "#/components/parameters/page" },
          { "$ref": "#/components/parameters/pageSize" },
          { "$ref": "#/components/parameters/cursor" },
          { "$ref": "#/components/parameters/updatedSince" },
          { name: "status", in: "query", schema: { type: "string", enum: ["ACTIVE", "PROBATION", "SUSPENDED", "ON_LEAVE", "RESIGNED", "TERMINATED", "RETIRED", "INACTIVE"] } },
        ],
        responses: {
          "200": {
            description: "Employee page",
            headers: { ETag: { schema: { type: "string" }, description: "Weak ETag - send back via If-None-Match for 304s" } },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                    data: { type: "array", items: { "$ref": "#/components/schemas/Employee" } },
                    meta: { "$ref": "#/components/schemas/ListMeta" },
                  },
                },
              },
            },
          },
          "304": { description: "Not modified (ETag matched)" },
          "401": { "$ref": "#/components/responses/Error" },
          "403": { "$ref": "#/components/responses/Error" },
          "429": { "$ref": "#/components/responses/Error" },
        },
      },
    },
    "/api/v1/employees/{id}": {
      get: {
        operationId: "getEmployee",
        tags: ["employees"],
        summary: "Single employee + current salary structure summary",
        security: [{ UserTokenBearer: ["employees:read"] }, { ApiKeyBearer: ["employees:read"] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Employee detail",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { const: true }, data: { "$ref": "#/components/schemas/Employee" } },
                },
              },
            },
          },
          "404": { "$ref": "#/components/responses/Error" },
        },
      },
    },
    "/api/v1/attendance": {
      get: {
        operationId: "listAttendance",
        tags: ["attendance"],
        summary: "Attendance records for a from/to range (cursor mode walks past the 500-row page cap)",
        security: [{ UserTokenBearer: ["attendance:read"] }, { ApiKeyBearer: ["attendance:read"] }],
        parameters: [
          { "$ref": "#/components/parameters/page" },
          { "$ref": "#/components/parameters/pageSize" },
          { "$ref": "#/components/parameters/cursor" },
          { "$ref": "#/components/parameters/updatedSince" },
          { name: "from", in: "query", required: true, schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
          { name: "to", in: "query", required: true, schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
          { name: "employeeId", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Attendance page",
            headers: { ETag: { schema: { type: "string" } } },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                    data: { type: "array", items: { "$ref": "#/components/schemas/AttendanceRecord" } },
                    meta: {
                      type: "object",
                      properties: {
                        from: { type: "string" }, to: { type: "string" },
                        employeeId: { type: ["string", "null"] },
                        count: { type: "integer" },
                        truncated: { type: "boolean", description: "page mode only: true when the 500-row cap was hit - switch to cursor mode" },
                        hasMore: { type: "boolean" }, nextCursor: { type: ["string", "null"] },
                        cursor: { type: ["string", "null"] }, updatedSince: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "304": { description: "Not modified" },
          "400": { "$ref": "#/components/responses/Error" },
        },
      },
      post: {
        operationId: "pushAttendance",
        tags: ["attendance"],
        summary: "Push one attendance punch (IN/OUT) through the shared engine",
        security: [{ UserTokenBearer: ["attendance:write"] }, { ApiKeyBearer: ["attendance:write"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["employeeId", "timestamp", "direction"],
                properties: {
                  employeeId: { type: "string" },
                  timestamp: { type: "string", description: "ISO 8601 datetime" },
                  direction: { enum: ["IN", "OUT"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Upserted attendance day", content: { "application/json": { schema: { type: "object" } } } },
          "400": { "$ref": "#/components/responses/Error" },
          "404": { "$ref": "#/components/responses/Error" },
        },
      },
    },
    "/api/v1/leave-requests": {
      post: {
        operationId: "createLeaveRequest",
        tags: ["leave"],
        summary: "File a leave request into the LEAVE approval workflow (balance reserved)",
        security: [{ UserTokenBearer: ["leave:write"] }, { ApiKeyBearer: ["leave:write"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["employeeId", "typeCode", "startDate", "endDate"],
                properties: {
                  employeeId: { type: "string" },
                  typeCode: { type: "string", maxLength: 20 },
                  startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                  endDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                  reason: { type: "string", maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Filed request (pending approval)", content: { "application/json": { schema: { type: "object" } } } },
          "400": { "$ref": "#/components/responses/Error" },
          "409": { "$ref": "#/components/responses/Error" },
        },
      },
    },
    "/api/v1/leave-balances": {
      get: {
        operationId: "listLeaveBalances",
        tags: ["leave"],
        summary: "Leave balances for the current cycle (delta sync + ETag)",
        security: [{ UserTokenBearer: ["leave:read"] }, { ApiKeyBearer: ["leave:read"] }],
        parameters: [
          { "$ref": "#/components/parameters/page" },
          { "$ref": "#/components/parameters/pageSize" },
          { "$ref": "#/components/parameters/updatedSince" },
          { name: "employeeId", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Balance page",
            headers: { ETag: { schema: { type: "string" } } },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                    data: { type: "array", items: { "$ref": "#/components/schemas/LeaveBalance" } },
                    meta: {
                      type: "object",
                      properties: {
                        page: { type: "integer" }, pageSize: { type: "integer" },
                        total: { type: "integer" }, year: { type: "integer" },
                        updatedSince: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "304": { description: "Not modified" },
        },
      },
    },
    "/api/v1/push/subscriptions": {
      get: {
        operationId: "listPushSubscriptions",
        tags: ["push"],
        summary: "List the authenticated user's registered push devices (Phase 5 P6)",
        security: [{ UserTokenBearer: ["push:write"] }, { ApiKeyBearer: ["push:write"] }],
        responses: {
          "200": {
            description: "The caller's own subscriptions (never another user's)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          endpoint: { type: "string", format: "uri" },
                          platform: { type: "string", enum: ["web", "pwa", "other"] },
                          lastSuccessAt: { type: ["string", "null"] },
                          lastErrorAt: { type: ["string", "null"] },
                          createdAt: { type: "string" },
                        },
                      },
                    },
                    meta: { type: "object", properties: { count: { type: "integer" } } },
                  },
                },
              },
            },
          },
          "401": { "$ref": "#/components/responses/Error" },
          "403": { "$ref": "#/components/responses/Error" },
        },
      },
      post: {
        operationId: "registerPushSubscription",
        tags: ["push"],
        summary: "Register this browser/device's Web Push subscription (pushes: punches, approvals)",
        security: [{ UserTokenBearer: ["push:write"] }, { ApiKeyBearer: ["push:write"] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint", "keys"],
                properties: {
                  endpoint: { type: "string", format: "uri", maxLength: 2048 },
                  keys: {
                    type: "object",
                    required: ["p256dh", "auth"],
                    properties: {
                      p256dh: { type: "string", maxLength: 512, description: "base64url ECDH P-256 public key from the browser PushSubscription" },
                      auth: { type: "string", maxLength: 256, description: "base64url 16-byte auth secret from the browser PushSubscription" },
                    },
                  },
                  platform: { type: "string", enum: ["web", "pwa", "other"] },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Registered (idempotent — re-subscribing upserts on the endpoint)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { const: true },
                    data: { type: "object", properties: { id: { type: "string" }, endpoint: { type: "string" } } },
                    meta: { type: "object", properties: { registered: { const: true } } },
                  },
                },
              },
            },
          },
          "400": { "$ref": "#/components/responses/Error" },
          "401": { "$ref": "#/components/responses/Error" },
        },
      },
    },
    "/api/v1/push/subscriptions/{id}": {
      delete: {
        operationId: "deletePushSubscription",
        tags: ["push"],
        summary: "Remove one of the authenticated user's push subscriptions (by id or endpoint URL)",
        security: [{ UserTokenBearer: ["push:write"] }, { ApiKeyBearer: ["push:write"] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", maxLength: 2048 }, description: "Subscription id, or the URL-encoded endpoint" },
        ],
        responses: {
          "200": {
            description: "Removed",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { const: true }, data: { type: "object", properties: { removed: { const: true } } } } },
              },
            },
          },
          "404": { "$ref": "#/components/responses/Error" },
          "401": { "$ref": "#/components/responses/Error" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyBearer: {
        type: "http",
        scheme: "bearer",
        description: "Tenant API key: Authorization: Bearer fk_ (non-expiring integration key, scope-tagged)",
      },
      UserTokenBearer: {
        type: "http",
        scheme: "bearer",
        description: "User access token: Authorization: Bearer eyJ (15-min JWT, MOB-1; refresh via /api/v1/auth/token)",
      },
    },
    parameters: {
      page: { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
      pageSize: { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      cursor: { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque keyset cursor from meta.nextCursor - stable across writes" },
      updatedSince: { name: "updatedSince", in: "query", schema: { type: "string", format: "date-time" }, description: "Delta sync: only rows with updatedAt >= this instant" },
    },
    responses: {
      Error: {
        description: "Error envelope",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                ok: { const: false },
                error: { type: "string" },
                code: { type: "string", description: "UNAUTHORIZED | SCOPE_MISSING | VALIDATION | NOT_FOUND | RATE_LIMITED | SUBSCRIPTION_READONLY | API_NOT_INCLUDED | INVALID_GRANT | GRANT_REFUSED" },
              },
            },
          },
        },
      },
    },
    schemas: {
      TokenPair: {
        type: "object",
        properties: {
          access_token: { type: "string" },
          token_type: { const: "Bearer" },
          expires_in: { type: "integer", description: "Access-token TTL seconds (default 900)" },
          refresh_token: { type: "string", description: "Opaque; rotate for a new pair - reuse revokes the family" },
          scope: { type: "string", description: "Space-separated granted scopes" },
        },
      },
      Employee: {
        type: "object",
        description: "Directory-level projection - deep PII and binary payloads are never exposed",
        properties: {
          id: { type: "string" }, code: { type: ["string", "null"] }, fullName: { type: "string" },
          nameBn: { type: ["string", "null"] }, preferredName: { type: ["string", "null"] },
          gender: { type: ["string", "null"] }, bloodGroup: { type: ["string", "null"] },
          maritalStatus: { type: ["string", "null"] }, nationality: { type: ["string", "null"] },
          religion: { type: ["string", "null"] }, dob: { type: ["string", "null"] },
          mobile: { type: ["string", "null"] }, altMobile: { type: ["string", "null"] },
          officialEmail: { type: ["string", "null"] }, personalEmail: { type: ["string", "null"] },
          branchId: { type: ["string", "null"] }, branchName: { type: ["string", "null"] },
          departmentId: { type: ["string", "null"] }, departmentName: { type: ["string", "null"] },
          designationId: { type: ["string", "null"] }, designationName: { type: ["string", "null"] },
          reportingManagerId: { type: ["string", "null"] }, reportingManagerName: { type: ["string", "null"] },
          workLocation: { type: ["string", "null"] }, joiningDate: { type: ["string", "null"] },
          confirmationDate: { type: ["string", "null"] }, probationMonths: { type: ["integer", "null"] },
          employmentType: { type: ["string", "null"] }, status: { type: "string" },
          category: { type: ["string", "null"] }, grade: { type: ["string", "null"] },
          createdAt: { type: "string" }, updatedAt: { type: "string" },
        },
      },
      AttendanceRecord: {
        type: "object",
        properties: {
          id: { type: "string" }, employeeId: { type: "string" },
          employeeCode: { type: ["string", "null"] }, employeeName: { type: ["string", "null"] },
          date: { type: "string" }, shiftId: { type: ["string", "null"] },
          checkIn: { type: ["string", "null"] }, checkOut: { type: ["string", "null"] },
          workingMinutes: { type: ["integer", "null"] }, lateMinutes: { type: ["integer", "null"] },
          earlyLeaveMinutes: { type: ["integer", "null"] }, overtimeMinutes: { type: ["integer", "null"] },
          status: { type: "string" }, source: { type: "string" }, otApproved: { type: ["boolean", "null"] },
          createdAt: { type: "string" }, updatedAt: { type: "string" },
        },
      },
      LeaveBalance: {
        type: "object",
        properties: {
          employeeId: { type: "string" }, employeeCode: { type: ["string", "null"] }, employeeName: { type: ["string", "null"] },
          leaveTypeId: { type: "string" }, typeCode: { type: ["string", "null"] }, typeName: { type: ["string", "null"] },
          paid: { type: ["boolean", "null"] }, year: { type: "integer" },
          entitled: { type: "integer" }, used: { type: "integer" },
          pending: { type: "integer" }, carriedForward: { type: "integer" },
          remaining: { type: "integer" },
        },
      },
      ListMeta: {
        type: "object",
        properties: {
          page: { type: "integer" }, pageSize: { type: "integer" }, total: { type: "integer" },
          cursor: { type: ["string", "null"] }, hasMore: { type: "boolean" },
          nextCursor: { type: ["string", "null"] }, updatedSince: { type: "string" },
        },
      },
    },
  },
}
