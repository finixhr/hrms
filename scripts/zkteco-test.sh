#!/bin/bash
# ============ ZKTeco ADMS integration — end-to-end test suite ============
# Covers: protocol (handshake/ATTLOG/getrequest/devicecmd), dedup/idempotency,
# unknown-user mapping, offline replay, overnight shifts, manual-correction
# precedence, device auth (unknown SN / disabled / comm key), rate limiting,
# RBAC scoping, reprocessing, health, simulator, audit trail, cleanup.
# Uses ONLY its own test device (SN TSTQASF3A00001) and far-past dates
# (88–90 days ago) so seeded demo data is never touched. User-created data
# (e.g. live device registrations) is preserved.
set -u
cd "$(dirname "$0")/.."

# H-01/H-02 — destructive-suite guard: the cleanup phase removes this suite's
# own test data. Refuse non-test databases unless explicitly confirmed.
if [[ "${DATABASE_URL:-}" != *"test"* && "${HRM_E2E_CONFIRM:-}" != "I-AM-ON-TEST" ]]; then
  echo "ERROR: Refusing to run against a non-test database. Set HRM_E2E_CONFIRM=I-AM-ON-TEST to override." && exit 1
fi

BASE="http://localhost:3000/api/hrm"
ADMS="http://localhost:3000/api/integrations/zkteco/adms"
JAR=/tmp/zk-admin.jar; JARE=/tmp/zk-emp.jar; JARB=/tmp/zk-branch2.jar
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
# C-4 — attach the Bearer token (cookie-only calls now require CSRF tokens)
req() { curl -s -b "$JAR" -H "Authorization: Bearer $(cat "$JAR.token" 2>/dev/null)" -H 'Content-Type: application/json' -d "{\"action\":\"$1\",\"payload\":$2}" "$BASE"; }
q()   { python3 -c "
import sqlite3,sys
db=sqlite3.connect('db/custom.db')
try: print(db.execute(sys.argv[1]).fetchone()[0])
except Exception as e: print('SQLERR')
" "$1"; }
push() { # pin datetime status [key]
  local url="$ADMS/cdata?SN=$TSN"
  local key="${4:-$PLAIN}"
  [ -n "$key" ] && url="$url&pushcommkey=$key"
  printf '%s\t3\t%s\t%s\t0\t0\t0\n' "$1" "$2" "$3" | curl -s -X POST "$url" --data-binary @-
}

TSN="TSTQASF3A00001"
TODAY=$(date +%F)
OLD=$(date -d "-90 days" +%F)     # offline replay date (before seed window)
OLD2=$(date -d "-89 days" +%F)    # manual-precedence date
OLD3=$(date -d "-88 days" +%F)    # overnight shift start
OLD4=$(date -d "-87 days" +%F)    # overnight shift end (next morning)

# Cleanup runs on exit too — aborted runs never leak test artifacts
zk_cleanup() {
  T_EID2="${EID2:-}" T_EID3="${EID3:-}" python3 << 'PYEOF'
import sqlite3, os
from datetime import date, timedelta
db = sqlite3.connect("db/custom.db")
c = db.cursor()
tsn = "TSTQASF3A00001"
old2 = (date.today() - timedelta(days=89)).isoformat()
old3 = (date.today() - timedelta(days=88)).isoformat()
eid2, eid3 = os.environ.get("T_EID2", ""), os.environ.get("T_EID3", "")
dev = c.execute("SELECT id FROM AttendanceDevice WHERE deviceIdentifier=?", (tsn,)).fetchone()
if dev:
    dev_id = dev[0]
    c.execute("DELETE FROM Attendance WHERE deviceInfo LIKE ?", (f"%{tsn}%",))
    if eid2:
        c.execute("DELETE FROM Attendance WHERE employeeId=? AND date=? AND source='MANUAL'", (eid2, old2))
    c.execute("DELETE FROM AttendanceRawEvent WHERE deviceSerial=?", (tsn,))
    c.execute("DELETE FROM AttendanceDeviceUser WHERE deviceId=?", (dev_id,))
    c.execute("DELETE FROM DeviceCommLog WHERE serial=?", (tsn,))
    c.execute("DELETE FROM DeviceCommLog WHERE serial='HACKER-0000'")
    c.execute("DELETE FROM DeviceCommand WHERE deviceId=?", (dev_id,))
    c.execute("DELETE FROM Notification WHERE title='Unknown Device User' AND message LIKE '%9777%'")
    c.execute("DELETE FROM AttendanceDevice WHERE id=?", (dev_id,))
c.execute("DELETE FROM Shift WHERE name='QA Night 22-06'")
if eid3:
    c.execute("DELETE FROM ShiftAssignment WHERE employeeId=? AND fromDate=?", (eid3, old3))
db.commit()
PYEOF
}
trap zk_cleanup EXIT

echo "================ ZKTECO ADMS E2E TESTS ================"

# ---------- logins ----------
LOGIN=$(curl -s -c "$JAR" -H 'Content-Type: application/json' -d '{"action":"auth.login","payload":{"email":"admin@finixhr.com","password":"Pass@123"}}' "$BASE")
echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])" > "$JAR.token"
echo "$LOGIN" | grep -q '"token"' && ok "admin login" || bad "admin login"
LOGIN=$(curl -s -c "$JARE" -H 'Content-Type: application/json' -d '{"action":"auth.login","payload":{"email":"employee@finixhr.com","password":"Pass@123"}}' "$BASE")
echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])" > "$JARE.token"
echo "$LOGIN" | grep -q '"token"' && ok "employee login" || bad "employee login"
LOGIN=$(curl -s -c "$JARB" -H 'Content-Type: application/json' -d '{"action":"auth.login","payload":{"email":"branch2@finixhr.com","password":"Pass@123"}}' "$BASE")
echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['token'])" > "$JARB.token"
echo "$LOGIN" | grep -q '"token"' && ok "branch2 (Uttara) login" || bad "branch2 login"

# ---------- pick 3 HO-branch employees WITHOUT attendance today ----------
read -r EID1 CODE1 EID2 CODE2 EID3 CODE3 EID4 CODE4 <<< "$(python3 -c "
import sqlite3
db=sqlite3.connect('db/custom.db')
vid=db.execute(\"SELECT id FROM Vendor WHERE code='FINIX'\").fetchone()[0]
bid=db.execute(\"SELECT id FROM Branch WHERE vendorId=? AND name LIKE '%Banani%'\",(vid,)).fetchone()[0]
rows=db.execute(\"SELECT e.id,e.code FROM Employee e WHERE e.branchId=? AND e.status IN ('ACTIVE','PROBATION') ORDER BY e.code DESC LIMIT 4\",(bid,)).fetchall()
print(' '.join(f'{r[0]} {r[1]}' for r in rows))
")"
if [ -z "$EID4" ]; then echo "FATAL: could not pick 4 HO employees"; exit 1; fi
ok "test employees picked: $CODE1 $CODE2 $CODE3 $CODE4"
PIN1=$((10#$(echo $CODE1 | cut -d- -f2)))
PIN2=$((10#$(echo $CODE2 | cut -d- -f2)))
PIN3=$((10#$(echo $CODE3 | cut -d- -f2)))

# ---------- 1. health ----------
H=$(curl -s "$ADMS/health")
echo "$H" | grep -q '"status":"healthy"' && ok "gateway health: healthy" || bad "health: $H"
echo "$H" | grep -q '"service":"zkteco-attendance-gateway"' && ok "health service name" || bad "health service name"

# ---------- 2. device registration (serial-only auth — Comm Key removed) ----------
HOBR=$(q "SELECT id FROM Branch WHERE name LIKE '%Banani%' AND vendorId=(SELECT id FROM Vendor WHERE code='FINIX')")
D=$(req devices.save "{\"name\":\"QA Test — SenseFace 3A\",\"deviceIdentifier\":\"$TSN\",\"serialNumber\":\"$TSN\",\"model\":\"SenseFace 3A\",\"manufacturer\":\"ZKTeco\",\"branchId\":\"$HOBR\",\"location\":\"QA bench\"}")
echo "$D" | grep -q "$TSN" && ok "device registered (pre-registration flow)" || bad "device save: $D"
DID=$(q "SELECT id FROM AttendanceDevice WHERE deviceIdentifier='$TSN'")
PLAIN=""
# Comm Key removed per user request — devices authenticate by registered serial only.
# A keyless device must be ACCEPTED at the handshake (regression guard for the removal).
KEYLESS_SN="KEYLESS-$(date +%s)"
req devices.save "{\"deviceIdentifier\":\"$KEYLESS_SN\",\"name\":\"rv keyless\"}" > /dev/null
KL_SN=$(python3 -c "
import sqlite3, secrets
db=sqlite3.connect('db/custom.db')
sn='K'+secrets.token_hex(6).upper()
db.execute('UPDATE AttendanceDevice SET deviceIdentifier=? WHERE deviceId=?', (sn,'$KEYLESS_SN'))
db.commit()
print(sn)")
KL=$(curl -s "$ADMS/cdata?SN=$KL_SN&PUSHVERSION=5.1.0")
echo "$KL" | grep -q "GET OPTION FROM" && ok "keyless device accepted (no Comm Key required)" || bad "keyless device rejected: $KL"
python3 -c "
import sqlite3
db=sqlite3.connect('db/custom.db')
db.execute('DELETE FROM AttendanceDevice WHERE deviceId=?',('$KEYLESS_SN',))
db.commit()" 2>/dev/null

# enroll test employees on the test device (mappings are PER-DEVICE — spec §8)
req devices.mapUser "{\"deviceId\":\"$DID\",\"deviceUserId\":\"$PIN1\",\"employeeId\":\"$EID1\"}" > /dev/null
req devices.mapUser "{\"deviceId\":\"$DID\",\"deviceUserId\":\"$PIN2\",\"employeeId\":\"$EID2\"}" > /dev/null
req devices.mapUser "{\"deviceId\":\"$DID\",\"deviceUserId\":\"$PIN3\",\"employeeId\":\"$EID3\"}" > /dev/null
MAPPED=$(q "SELECT COUNT(*) FROM AttendanceDeviceUser WHERE deviceId='$DID'")
[ "$MAPPED" = "3" ] && ok "3 test employees enrolled on test device (PINs $PIN1/$PIN2/$PIN3)" || bad "enrollment: $MAPPED"

# ---------- 3. handshake ----------
HS=$(curl -s "$ADMS/cdata?SN=$TSN&pushcommkey=$PLAIN&PUSHVERSION=5.1.0&options=&language=")
echo "$HS" | grep -q "GET OPTION FROM: $TSN" && ok "handshake response (ADMS options)" || bad "handshake: $HS"
SEEN=$(q "SELECT COUNT(*) FROM AttendanceDevice WHERE deviceIdentifier='$TSN' AND lastSeenAt IS NOT NULL")
[ "$SEEN" = "1" ] && ok "handshake updated lastSeenAt (device Online)" || bad "lastSeenAt not updated"

# ---------- 4. unknown SN rejected ----------
HS2=$(curl -s -w "|%{http_code}" "$ADMS/cdata?SN=HACKER-0000")
echo "$HS2" | grep -q "Unknown device HACKER-0000" && echo "$HS2" | grep -q "|404" && ok "unknown SN rejected 404 (no auto-registration)" || bad "unknown SN: $HS2"
REJ=$(q "SELECT COUNT(*) FROM DeviceCommLog WHERE serial='HACKER-0000' AND requestType='REJECTED'")
[ "$REJ" = "1" ] && ok "rejection logged in comm log" || bad "rejection not logged"

# ---------- 5. event ingestion ----------
R=$(push $PIN1 "$OLD 09:00:00" 0)
echo "$R" | grep -q "OK: 1" && ok "ATTLOG push ACK: OK: 1" || bad "push ack: $R"
RAW=$(q "SELECT COUNT(*) FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND eventTime LIKE '$OLD%'")
[ "$RAW" = "1" ] && ok "raw event durably stored" || bad "raw count: $RAW"
ST=$(q "SELECT processingStatus FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND eventTime LIKE '$OLD%'")
[ "$ST" = "PROCESSED" ] && ok "event processed (mapped via PIN)" || bad "status: $ST"
ATT=$(q "SELECT COUNT(*) FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE1' AND a.date='$OLD' AND a.source='BIOMETRIC'")
[ "$ATT" = "1" ] && ok "attendance row created for event date ($OLD)" || bad "attendance row: $ATT"

# ---------- 6. deduplication ----------
R=$(push $PIN1 "$OLD 09:00:00" 0)
echo "$R" | grep -q "OK: 1" && ok "duplicate push ACKed (known duplicate)" || bad "dup ack: $R"
RAW=$(q "SELECT COUNT(*) FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND eventTime LIKE '$OLD%'")
[ "$RAW" = "1" ] && ok "duplicate NOT re-inserted (idempotent)" || bad "dup inserted: $RAW"
DUP=$(q "SELECT COALESCE(MAX(duplicateCount),0) FROM DeviceCommLog WHERE serial='$TSN' AND requestType='ATTLOG'")
[ "$DUP" -ge 1 ] 2>/dev/null && ok "duplicate counted in comm log" || bad "dup count: $DUP"

# ---------- 7. distinct event same second (legitimate) ----------
push $PIN1 "$OLD 09:00:01" 1 > /dev/null
RAW=$(q "SELECT COUNT(*) FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND eventTime LIKE '$OLD%'")
[ "$RAW" = "2" ] && ok "distinct event (different second) stored separately" || bad "distinct: $RAW"

# ---------- 8. unknown employee ----------
push 9777 "$OLD 10:00:00" 0 > /dev/null
ST=$(q "SELECT processingStatus FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND deviceUserId='9777'")
[ "$ST" = "UNKNOWN_EMPLOYEE" ] && ok "unknown PIN retained as UNKNOWN_EMPLOYEE" || bad "unknown status: $ST"
FAKE=$(q "SELECT COUNT(*) FROM Employee WHERE code='EMP-9777'")
[ "$FAKE" = "0" ] && ok "no fake employee created" || bad "fake employee!"
U=$(req devices.unknownUsers '{}')
echo "$U" | grep -q '"deviceUserId":"9777"' && ok "unknown user listed in admin UI data" || bad "unknownUsers: $(echo $U | head -c 120)"

# ---------- 9. map unknown user + reprocess ----------
MAP=$(req devices.mapUser "{\"deviceId\":\"$DID\",\"deviceUserId\":\"9777\",\"employeeId\":\"$EID4\"}")
echo "$MAP" | grep -q '"reprocessed"' && ok "mapUser accepted" || bad "mapUser: $(echo $MAP | head -c 200)"
ST=$(q "SELECT processingStatus FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND deviceUserId='9777'")
[ "$ST" = "PROCESSED" ] && ok "historical unknown events reprocessed after mapping" || bad "reprocess status: $ST"
ATT=$(q "SELECT COUNT(*) FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE4' AND a.date='$OLD' AND a.source='BIOMETRIC'")
[ "$ATT" -ge 1 ] 2>/dev/null && ok "attendance created retroactively for mapped PIN" || bad "retro attendance: $ATT"

# ---------- 10. OUT punch completes the day ----------
push $PIN1 "$OLD 17:30:00" 1 > /dev/null
CO=$(q "SELECT COALESCE(checkOut,'-') FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE1' AND a.date='$OLD'")
[ "$CO" = "17:30" ] && ok "OUT punch set checkOut (last-out wins)" || bad "checkout: $CO"
WM=$(q "SELECT workingMinutes FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE1' AND a.date='$OLD'")
[ "$WM" -gt 400 ] 2>/dev/null && ok "working minutes computed ($WM)" || bad "workingMinutes: $WM"

# ---------- 11. reprocessing is idempotent ----------
RP=$(req devices.reprocess "{\"deviceId\":\"$DID\",\"dateFrom\":\"$OLD\",\"dateTo\":\"$OLD4\",\"includeProcessed\":true}")
echo "$RP" | grep -q '"daysRebuilt"' && ok "bulk reprocess executed" || bad "reprocess: $(echo $RP | head -c 150)"
ATT=$(q "SELECT COUNT(*) FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE1' AND a.date='$OLD'")
[ "$ATT" = "1" ] && ok "reprocess created NO duplicate attendance" || bad "dup after reprocess: $ATT"

# ---------- 12. manual correction precedence ----------
MM=$(req attendance.mark "{\"employeeId\":\"$EID2\",\"date\":\"$OLD2\",\"checkIn\":\"09:00\",\"checkOut\":\"17:00\"}")
echo "$MM" | grep -q '"id"' && ok "manual attendance marked for $OLD2" || bad "manual mark: $(echo $MM | head -c 120)"
push $PIN2 "$OLD2 09:07:00" 0 > /dev/null
SRC=$(q "SELECT source FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE2' AND a.date='$OLD2'")
[ "$SRC" = "MANUAL" ] && ok "device punch did NOT overwrite manual day (correction wins)" || bad "manual overwritten: $SRC"
ST=$(q "SELECT processingStatus FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND eventTime LIKE '$OLD2%'")
[ "$ST" = "SKIPPED_MANUAL" ] && ok "event flagged SKIPPED_MANUAL (visible + auditable)" || bad "skip status: $ST"

# ---------- 13. overnight shift ----------
SH=$(req shifts.create "{\"name\":\"QA Night 22-06\",\"startTime\":\"22:00\",\"endTime\":\"06:00\",\"weeklyOff\":\"FRIDAY\",\"active\":true}")
SHID=$(echo "$SH" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[ -n "$SHID" ] && ok "overnight shift created (22:00→06:00)" || bad "shift create: $(echo $SH | head -c 120)"
RA=$(req rosters.assign "{\"employeeId\":\"$EID3\",\"shiftId\":\"$SHID\",\"fromDate\":\"$OLD3\",\"toDate\":\"$OLD4\"}")
echo "$RA" | grep -q '"id"' && ok "night roster assigned" || bad "roster: $(echo $RA | head -c 120)"
push $PIN3 "$OLD3 22:00:00" 0 > /dev/null
push $PIN3 "$OLD4 05:45:00" 1 > /dev/null
NIGHT=$(q "SELECT COALESCE(checkIn,'-')||'→'||COALESCE(checkOut,'-') FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE3' AND a.date='$OLD3'")
[ "$NIGHT" = "22:00→05:45" ] && ok "overnight: IN $OLD3 22:00 + next-morning OUT attributed to same day" || bad "overnight row: $NIGHT"
WM3=$(q "SELECT workingMinutes FROM Attendance a JOIN Employee e ON e.id=a.employeeId WHERE e.code='$CODE3' AND a.date='$OLD3'")
[ "$WM3" -gt 400 ] 2>/dev/null && ok "overnight working minutes span midnight ($WM3)" || bad "overnight minutes: $WM3"

# ---------- 14. disabled device ----------
DID=$(q "SELECT id FROM AttendanceDevice WHERE deviceIdentifier='$TSN'")
req devices.setEnabled "{\"id\":\"$DID\",\"enabled\":false}" > /dev/null
DIS=$(printf '%s\t3\t%s 20:00:00\t0\t0\t0\t0\n' "$PIN1" "$OLD" | curl -s -w "|%{http_code}" -X POST "$ADMS/cdata?SN=$TSN" --data-binary @-)
echo "$DIS" | grep -q "|403" && ok "disabled device rejected 403" || bad "disabled: $DIS"
req devices.setEnabled "{\"id\":\"$DID\",\"enabled\":true}" > /dev/null
R=$(push $PIN1 "$OLD 20:01:00" 0 "${PLAIN:-}")
echo "$R" | grep -q "OK: 1" && ok "re-enabled device accepts pushes" || bad "re-enable: $R"

# ---------- 15. keyless operation (Comm Key removed) ----------
# The gateway authenticates by pre-registered serial only. A push carrying a
# stale/wrong pushcommkey param must still be ACCEPTED (the param is ignored).
R=$(push $PIN1 "$OLD 21:00:00" 0 "$PLAIN")
echo "$R" | grep -q "OK: 1" && ok "push accepted (no key / stale key ignored)" || bad "push: $R"
NOKEY=$(curl -s -w "|%{http_code}" -X POST "$ADMS/cdata?SN=$TSN" --data-binary $'1\t3\t'"$OLD"' 21:30:00\t0\t0\t0\t0\n')
echo "$NOKEY" | grep -q "|200" && ok "push without any key accepted 200" || bad "missing key rejected: $NOKEY"
BADK=$(curl -s -w "|%{http_code}" -X POST "$ADMS/cdata?SN=$TSN&pushcommkey=WRONG-KEY" --data-binary $'1\t3\t'"$OLD"' 21:45:00\t0\t0\t0\t0\n')
echo "$BADK" | grep -q "|200" && ok "push with wrong key param accepted (param ignored)" || bad "wrong key rejected: $BADK"

# ---------- 16. command channel ----------
GR=$(curl -s "$ADMS/getrequest?SN=$TSN&pushcommkey=$PLAIN")
echo "$GR" | grep -q "^OK" && ok "getrequest: OK (empty queue)" || bad "getrequest: $GR"
TC=$(req devices.test "{\"id\":\"$DID\"}")
echo "$TC" | grep -q '"command":"CHECK"' && ok "test connection queues CHECK" || bad "devices.test: $(echo $TC | head -c 150)"
GR=$(curl -s "$ADMS/getrequest?SN=$TSN&pushcommkey=$PLAIN")
echo "$GR" | grep -q "CHECK" && ok "device poll receives CHECK command" || bad "getrequest cmd: $GR"
DC=$(curl -s -X POST "$ADMS/devicecmd?SN=$TSN&pushcommkey=$PLAIN" --data-binary "CHECK result: OK 2026")
echo "$DC" | grep -q "^OK" && ok "devicecmd result accepted" || bad "devicecmd: $DC"
CMD=$(q "SELECT status FROM DeviceCommand WHERE deviceId='$DID' ORDER BY createdAt DESC LIMIT 1")
[ "$CMD" = "DONE" ] && ok "command marked DONE with result" || bad "command status: $CMD"

# ---------- 17. RBAC ----------
E403=$(curl -s -b "$JARE" -H "Authorization: Bearer $(cat "$JARE.token" 2>/dev/null)" -H 'Content-Type: application/json' -d '{"action":"devices.list","payload":{}}' "$BASE")
echo "$E403" | grep -q '"error"' && ok "EMPLOYEE denied devices.list (403)" || bad "employee rbac: $(echo $E403 | head -c 100)"
BL=$(curl -s -b "$JARB" -H "Authorization: Bearer $(cat "$JARB.token" 2>/dev/null)" -H 'Content-Type: application/json' -d '{"action":"devices.list","payload":{}}' "$BASE")
echo "$BL" | grep -q "$TSN" && bad "branch manager sees foreign-branch device" || ok "branch manager scoped: test device (HO) not visible to Uttara manager"
AL=$(req devices.list '{}')
echo "$AL" | grep -q "$TSN" && ok "admin sees all devices" || bad "admin device list"

# ---------- 18. events browser + detail ----------
EV=$(req devices.events "{\"deviceId\":\"$DID\",\"dateFrom\":\"$OLD\",\"dateTo\":\"$OLD4\"}")
echo "$EV" | grep -q '"total"' && echo "$EV" | grep -q '"employeeName"' && ok "events browser with filters + employee enrichment" || bad "events: $(echo $EV | head -c 120)"
EVID=$(echo "$EV" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['items'][0]['id'])" 2>/dev/null)
ED=$(req devices.eventDetail "{\"id\":\"$EVID\"}")
echo "$ED" | grep -q '"rawLine"' && echo "$ED" | grep -q '"normalized"' && ok "event detail (raw + normalized + attendance)" || bad "eventDetail"

# ---------- 19. recalculate + sync stats ----------
RC=$(req devices.recalculate "{\"employeeId\":\"$EID1\",\"dateFrom\":\"$OLD\",\"dateTo\":\"$OLD\"}")
echo "$RC" | grep -q '"days"' && ok "attendance recalculation from raw events" || bad "recalculate: $(echo $RC | head -c 120)"
SS=$(req devices.syncStats '{}')
echo "$SS" | grep -q '"queue"' && echo "$SS" | grep -q '"todayEvents"' && ok "sync monitor stats" || bad "syncStats: $(echo $SS | head -c 120)"

# ---------- 20. invalid payload ----------
IV=$(printf 'garbage,line\nXYZ\t3\tNOT-A-DATE\t0\n' | curl -s -X POST "$ADMS/cdata?SN=$TSN&pushcommkey=$PLAIN" --data-binary @-)
echo "$IV" | grep -q "OK: 0" && ok "malformed lines skipped (OK: 0), connection survives" || bad "invalid: $IV"

# ---------- 21. simulator (dev-only) ----------
SIM=$(curl -s -X POST http://localhost:3000/api/dev/zkteco/simulate-event -H 'Content-Type: application/json' -d "{\"sn\":\"$TSN\",\"pin\":\"9778\",\"key\":\"$PLAIN\",\"count\":2}")
echo "$SIM" | grep -qE '"(accepted|OK: )2' && ok "dev simulator: 2 events injected" || bad "simulator: $(echo $SIM | head -c 150)"
ST=$(q "SELECT processingStatus FROM AttendanceRawEvent WHERE deviceSerial='$TSN' AND deviceUserId='9778' LIMIT 1")
[ "$ST" = "UNKNOWN_EMPLOYEE" ] && ok "simulator unknown-pin scenario works" || bad "sim unknown: $ST"

# ---------- 22. audit trail ----------
A=$(req audit.list '{"limit":200}')
echo "$A" | grep -q 'devices.mapUser' && ok "audit: employee mapping logged" || bad "audit mapUser"
echo "$A" | grep -q 'devices.disable\|devices.setEnabled' && ok "audit: device disable/enable logged" || bad "audit disable"
echo "$A" | grep -q 'devices.create' && ok "audit: device registration logged" || bad "audit devices.create"

# ---------- 23. rate limiting (last — exhausts the per-minute budget) ----------
CODES=$(for i in $(seq 1 320); do curl -s -o /dev/null -w "%{http_code}\n" "$ADMS/cdata?SN=$TSN&pushcommkey=$PLAIN"; done | sort -u | tr '\n' ' ')
echo "$CODES" | grep -q 429 && ok "rate limiting engages (429 observed)" || bad "rate limit codes: $CODES"
# drain the window so the NEXT suite run (or its own cleanup) starts unthrottled
echo "  (draining the rate-limit window for 65s…)"
sleep 65

# ---------- 24. cleanup (test artifacts ONLY) ----------
export T_EID2="$EID2" T_EID3="$EID3"
python3 - << 'PYEOF'
import sqlite3, os
from datetime import date, timedelta
db = sqlite3.connect("db/custom.db")
c = db.cursor()
tsn = "TSTQASF3A00001"
old2 = (date.today() - timedelta(days=89)).isoformat()
old3 = (date.today() - timedelta(days=88)).isoformat()
eid2, eid3 = os.environ.get("T_EID2", ""), os.environ.get("T_EID3", "")
dev = c.execute("SELECT id FROM AttendanceDevice WHERE deviceIdentifier=?", (tsn,)).fetchone()
if dev:
    dev_id = dev[0]
    # attendance rows touched by the test device only (deviceInfo carries its SN)
    c.execute("DELETE FROM Attendance WHERE deviceInfo LIKE ?", (f"%{tsn}%",))
    # manually-marked test row (far-past date, test employee only)
    if eid2:
        c.execute("DELETE FROM Attendance WHERE employeeId=? AND date=? AND source='MANUAL'", (eid2, old2))
    c.execute("DELETE FROM AttendanceRawEvent WHERE deviceSerial=?", (tsn,))
    c.execute("DELETE FROM AttendanceDeviceUser WHERE deviceId=?", (dev_id,))
    c.execute("DELETE FROM DeviceCommLog WHERE serial=?", (tsn,))
    c.execute("DELETE FROM DeviceCommLog WHERE serial='HACKER-0000'")
    c.execute("DELETE FROM DeviceCommand WHERE deviceId=?", (dev_id,))
    c.execute("DELETE FROM Notification WHERE title='Unknown Device User' AND message LIKE '%9777%'")
    c.execute("DELETE FROM AttendanceDevice WHERE id=?", (dev_id,))
c.execute("DELETE FROM Shift WHERE name='QA Night 22-06'")
if eid3:
    c.execute("DELETE FROM ShiftAssignment WHERE employeeId=? AND fromDate=?", (eid3, old3))
db.commit()
left = c.execute("SELECT COUNT(*) FROM AttendanceRawEvent WHERE deviceSerial=?", (tsn,)).fetchone()[0]
dev_left = c.execute("SELECT COUNT(*) FROM AttendanceDevice WHERE deviceIdentifier=?", (tsn,)).fetchone()[0]
print(f"cleanup: raw={left} device={dev_left}")
PYEOF
CL=$(q "SELECT COUNT(*) FROM AttendanceDevice WHERE deviceIdentifier='$TSN'")
[ "$CL" = "0" ] && ok "test artifacts removed (user data untouched)" || bad "cleanup: device still present"

echo ""
echo "================ RESULTS: $PASS PASS / $FAIL FAIL ================"
[ "$FAIL" = "0" ]
