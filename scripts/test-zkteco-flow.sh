#!/bin/bash
# End-to-end smoke test for the ZKTeco Push SDK / ADMS protocol.
# Registers a test device, simulates a handshake, simulates an ATTLOG push,
# verifies the ACK is "OK: 1", and verifies the raw event is persisted.
#
# ⚠️ ARCHIVED (2026-09-30, SQLite→PostgreSQL migration): this shell variant
# manipulates the database through the `sqlite3` CLI and Python's sqlite3
# module, which cannot run against PostgreSQL. It is superseded by the
# engine-agnostic TypeScript suite — run:
#     bun run test:zkteco        (scripts/test-zkteco-flow.ts, uses Prisma)
# which covers every step of this script plus idempotency, devicecmd,
# the legacy proxy path, ISAPI and OPERLOG checks.
echo "ARCHIVED: this SQLite-era shell variant does not run against PostgreSQL."
echo "Use: bun run test:zkteco   (scripts/test-zkteco-flow.ts)"
exit 1
# --- historical body below is preserved for reference only ---
set -e
# L-11 — no hardcoded absolute paths: resolve the repo root from this script's
# location, and read the DB location from DATABASE_URL (falling back to the
# repo-relative prisma/db/custom.db).
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${TEST_DB:-${DATABASE_URL:-file:$REPO_ROOT/prisma/db/custom.db}}"
DB="${DB#file:}"
# H-01/H-02 — this suite INSERTs/REPLACEs rows directly in SQLite. Refuse
# non-test databases unless explicitly confirmed.
if [[ "${DATABASE_URL:-}" != *"test"* && "${HRM_E2E_CONFIRM:-}" != "I-AM-ON-TEST" && "${TEST_DB:-}" == "" ]]; then
  echo "ERROR: Refusing to run against a non-test database. Set HRM_E2E_CONFIRM=I-AM-ON-TEST to override." && exit 1
fi
BASE="${BASE_URL:-http://localhost:3000}"
SN="TEST-DEVICE-001"
KEY="test-secret-key-123"

echo "──────── Step 1: Register a test device in the DB ────────"
# Insert directly via sqlite3 since we don't have an auth session.
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$KEY').digest('hex'))")
sqlite3 "$DB" "INSERT OR REPLACE INTO AttendanceDevice (id, vendorId, deviceId, name, deviceIdentifier, protocol, enabled, timezone, status, syncStatus, eventCount, configuration, commKeyHash, createdAt, updatedAt) VALUES ('dev-test-001', 'vendor-test', 'TEST-001', 'Test ZKTeco Device', '$SN', 'ADMS', 1, 'Asia/Dhaka', 'OFFLINE', 'IDLE', 0, '{}', '$HASH', datetime('now'), datetime('now'));"
echo "  ✓ Device registered (SN=$SN, key hash=$HASH)"

echo
echo "──────── Step 2: Simulate the device handshake (GET /iclock/cdata) ────────"
RESP=$(curl -s -w "\n[HTTP %{http_code}]" "$BASE/iclock/cdata?SN=$SN&options=all&pushcommkey=$KEY&pushver=3.1.3&language=en&FW=Ver%206.60%20Sep%202024")
echo "$RESP"
echo "  ✓ Handshake returned (should be 200 with GET OPTION FROM: $SN ...)"

echo
echo "──────── Step 3: Simulate the device pushing an ATTLOG (POST /iclock/cdata) ────────"
NOW=$(date -u +"%Y-%m-%d %H:%M:%S")
BODY="1 3       $NOW    0       0       0       0
2       1       $NOW    1       0       0       0"
RESP=$(curl -s -w "\n[HTTP %{http_code}]" -X POST "$BASE/iclock/cdata?SN=$SN&pushcommkey=$KEY" --data-binary "$BODY")
echo "Request body:
$BODY"
echo "Response:
$RESP"
echo "  ✓ Push ACK should be 'OK: 2' (two new events)"

echo
echo "──────── Step 4: Simulate the device re-pushing (duplicate detection) ────────"
RESP=$(curl -s -X POST "$BASE/iclock/cdata?SN=$SN&pushcommkey=$KEY" --data-binary "$BODY")
echo "Duplicate response: $RESP"
echo "  ✓ Should still be 'OK: 2' (0 new + 2 duplicates — idempotent)"

echo
echo "──────── Step 5: Verify raw events persisted in DB ────────"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM AttendanceRawEvent WHERE deviceSerial='$SN';")
echo "  Raw events for SN=$SN: $COUNT"
STATUS=$(sqlite3 "$DB" "SELECT processingStatus, COUNT(*) FROM AttendanceRawEvent WHERE deviceSerial='$SN' GROUP BY processingStatus;")
echo "  Processing status breakdown:
$STATUS"

echo
echo "──────── Step 6: Verify the device's lastSeenAt was updated ────────"
SEEN=$(sqlite3 "$DB" "SELECT datetime(lastSeenAt), status, eventCount FROM AttendanceDevice WHERE deviceIdentifier='$SN';")
echo "  Device state: $SEEN"

echo
echo "──────── Step 7: Simulate a getrequest poll (GET /iclock/getrequest) ────────"
RESP=$(curl -s "$BASE/iclock/getrequest?SN=$SN&pushcommkey=$KEY")
echo "  Empty-queue response: '$RESP' (should be 'OK\n')"

echo
echo "──────── Step 8: Verify legacy /api/integrations/zkteco/adms/cdata proxy works ────────"
RESP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/integrations/zkteco/adms/cdata?SN=$SN&pushcommkey=$KEY&options=all")
echo "  Legacy endpoint HTTP status: $RESP (should be 200)"

echo
echo "──────── Step 9: Verify Hikvision ISAPI stub responds ────────"
RESP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/ISAPI/System/deviceInfo")
echo "  ISAPI deviceInfo HTTP status: $RESP (should be 200)"

echo
echo "════════════════════════════════════════════════════════════"
echo "  ✅ ZKTeco Push SDK / ADMS protocol — smoke test PASSED"
echo "════════════════════════════════════════════════════════════"
