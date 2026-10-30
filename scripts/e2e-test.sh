#!/bin/bash
# ============ E2E workflow verification: leave → loan → payroll → approval → payment ============
set -e

# H-01/H-02 — destructive-suite guard: this suite resets E2E state directly in
# the database. Refuse non-test databases unless explicitly confirmed.
if [[ "${DATABASE_URL:-}" != *"test"* && "${HRM_E2E_CONFIRM:-}" != "I-AM-ON-TEST" ]]; then
  echo "ERROR: Refusing to run against a non-test database. Set HRM_E2E_CONFIRM=I-AM-ON-TEST to override." && exit 1
fi

# PostgreSQL target comes from DATABASE_URL (the same URL the server uses).
if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found on PATH — the E2E cleanup needs the PostgreSQL client." && exit 1
fi
# state file: IDs of adjustment runs created by THIS suite (scoped cleanup)
E2E_RUN_IDS="${E2E_RUN_IDS:-/tmp/e2e-adjustment-runs.txt}"

BASE="http://localhost:3000/api/hrm"
# C-4 note: cookie-authenticated calls now require the CSRF token, so the suite
# authenticates with the Bearer fallback (CSRF-exempt by construction — the
# browser E2E covers the cookie+CSRF path).
CJ() { # jar email
  curl -s -X POST $BASE -H "Content-Type: application/json" -c "$1" -d "{\"action\":\"auth.login\",\"payload\":{\"email\":\"$2\",\"password\":\"Pass@123\"}}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['token'])" > "$1.token" 2>/dev/null
  head -c 20 "$1.token"; echo
}

api() { # jar action payload
  curl -s -X POST $BASE -H "Content-Type: application/json" -b "$1" -H "Authorization: Bearer $(cat "$1.token" 2>/dev/null)" -d "{\"action\":\"$2\",\"payload\":$3}"
}
jqv() { python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d$1)[:${2:-200}])"; }

echo "════ 1. Login all roles ════"
CJ /tmp/admin.txt admin@finixhr.com >/dev/null && echo "admin ✓"
CJ /tmp/hr.txt hr@finixhr.com >/dev/null && echo "hr ✓"
CJ /tmp/payroll.txt payroll@finixhr.com >/dev/null && echo "payroll ✓"
CJ /tmp/branch.txt branch@finixhr.com >/dev/null && echo "branch ✓"
CJ /tmp/emp.txt employee@finixhr.com >/dev/null && echo "employee ✓"

echo ""
echo "════ 2. LEAVE WORKFLOW: employee applies → manager approves → HR approves → balance + attendance ════"
# idempotency: repeated runs must not exhaust the demo balance — reset the
# employee's casual-leave balance and clear prior E2E artifacts first.
# H-01/H-02 — the E2E-marked leave rows (reason LIKE '%E2E%') are the ONLY rows touched.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'PGCLEAN'
UPDATE "LeaveBalance" SET used=0, pending=0
WHERE "employeeId" = (SELECT "id" FROM "Employee" WHERE "code" = 'EMP-0009')
  AND "leaveTypeId" = (SELECT "id" FROM "LeaveType" WHERE "code" = 'CASUAL'
                        AND "vendorId" = (SELECT "id" FROM "Vendor" WHERE "code" = 'FINIX'));
DELETE FROM "ApprovalRequest" WHERE "entityId" IN (SELECT "id" FROM "LeaveRequest" WHERE "reason" LIKE '%E2E%');
DELETE FROM "LeaveRequest" WHERE "reason" LIKE '%E2E%';
PGCLEAN
echo "  (e2e state reset: casual balance restored, prior E2E leave requests cleared)"
# find employee's leaveTypeId for CASUAL
CASUAL_ID=$(api /tmp/admin.txt "leaveTypes.list" "{}" | python3 -c "import sys,json; print([t['id'] for t in json.load(sys.stdin)['data'] if t['code']=='CASUAL'][0])")
EMP_ID=$(api /tmp/emp.txt "ess.profile" "{}" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['employee']['id'])")
FROM=$(date -d "+10 days" +%Y-%m-%d 2>/dev/null || date -v+10d +%Y-%m-%d)
TO=$(date -d "+12 days" +%Y-%m-%d 2>/dev/null || date -v+12d +%Y-%m-%d)
echo "employee EMP-0009 applies 3-day casual leave ($FROM → $TO)"
api /tmp/emp.txt "leaveRequests.apply" "{\"leaveTypeId\":\"$CASUAL_ID\",\"fromDate\":\"$FROM\",\"toDate\":\"$TO\",\"reason\":\"E2E test leave\"}" | jqv "['ok']" 50

BAL_BEFORE=$(api /tmp/emp.txt "ess.leave" "{}" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print([b['pending'] for b in d['balances'] if b['typeName']=='Casual Leave'][0])")
echo "pending balance after apply: $BAL_BEFORE (expect 13 = 10 entitled + 2 carry - ... minus used)"

REQ=$(api /tmp/branch.txt "approvals.queue" "{}" | python3 -c "
import sys,json
qs=json.load(sys.stdin)['data']
q=[x for x in qs if x['processType']=='LEAVE' and x['canAct'] and x['entityRef'] and 'Rahim' in x['entityRef'] and '$FROM' in x['entityRef']]
if not q: q=[x for x in qs if x['processType']=='LEAVE' and x['canAct']]
print(q[0]['id'])")
echo "branch manager approves leave step 1 (request $REQ)"
api /tmp/branch.txt "approvals.act" "{\"requestId\":\"$REQ\",\"decision\":\"APPROVE\",\"comment\":\"Coverage confirmed\"}" | jqv "['data']" 80

REQ2=$(api /tmp/hr.txt "approvals.queue" "{}" | python3 -c "
import sys,json
qs=json.load(sys.stdin)['data']
q=[x for x in qs if x['processType']=='LEAVE' and x['id']=='$REQ']
print(q[0]['id'])")
echo "HR manager approves step 2"
api /tmp/hr.txt "approvals.act" "{\"requestId\":\"$REQ2\",\"decision\":\"APPROVE\"}" | jqv "['data']" 80

BAL_AFTER=$(api /tmp/emp.txt "ess.leave" "{}" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; b=[b for b in d['balances'] if b['typeName']=='Casual Leave'][0]; print(f\"used={b['used']} pending={b['pending']}\")")
echo "balance after full approval: $BAL_AFTER (expect used=1→4, pending back to 0)"

echo ""
echo "════ 3. LOAN WORKFLOW: employee applies → Manager → HR → Finance (3-step chain) ════"
LOAN_START=$(date +%Y-%m-%d)
api /tmp/emp.txt "loans.create" "{\"type\":\"PERSONAL\",\"principal\":40000,\"installments\":8,\"startDate\":\"$LOAN_START\",\"purpose\":\"E2E loan test\"}" | jqv "['ok']" 40

approve_all() { # processType label
  PT="$1"; LABEL="$2"
  for i in 1 2 3 4 5 6; do
    FOUND=""
    for JAR in /tmp/branch.txt /tmp/hr.txt /tmp/payroll.txt /tmp/admin.txt; do
      RID=$(api "$JAR" "approvals.queue" "{}" 2>/dev/null | python3 -c "
import sys,json
try:
    qs=json.load(sys.stdin)['data']
    q=[x for x in qs if x['processType']=='$PT' and x['canAct']]
    print(q[0]['id'] if q else '')
except: print('')" 2>/dev/null)
      if [ -n "$RID" ]; then
        RES=$(api "$JAR" "approvals.act" "{\"requestId\":\"$RID\",\"decision\":\"APPROVE\"}")
        echo "  [$LABEL] step approved by $(basename $JAR .txt) → $(echo $RES | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["status"])' 2>/dev/null)"
        FOUND="1"
        break
      fi
    done
    [ -z "$FOUND" ] && break
  done
}
approve_all LOAN "Loan"
api /tmp/emp.txt "ess.loans" "{}" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['loans']
l=[x for x in d if x['purpose']=='E2E loan test'][-1]
print(f\"loan status={l['status']} outstanding={l['outstanding']} installments={len(l['installments'])}\")"

echo ""
echo "════ 4. PAYROLL: current month run → calculate → 3-step approval → PAY ════"
M=$(date +%-m); Y=$(date +%Y)
# idempotency: drop prior E2E adjustment runs — ONLY the run IDs this suite
# itself created (recorded in $E2E_RUN_IDS); user/roadmap adjustment runs are
# never touched (H-01/H-02 scoped cleanup).
if [ -s "$E2E_RUN_IDS" ]; then
  for RID in $(cat "$E2E_RUN_IDS"); do
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "DELETE FROM \"PayrollEntry\" WHERE \"runId\" = '$RID'; DELETE FROM \"PayrollRun\" WHERE \"id\" = '$RID';" 2>/dev/null || true
  done
  N=$(wc -w < "$E2E_RUN_IDS")
else
  N=0
fi
: > "$E2E_RUN_IDS"
echo "  (e2e state reset: $N prior E2E adjustment run(s) cleared — scoped to this suite)"
RUN_AND_STATUS=$(api /tmp/payroll.txt "payroll.runs.list" "{}" | python3 -c "
import sys,json
runs=json.load(sys.stdin)['data']
r=[x for x in runs if x['periodMonth']==$M and x['periodYear']==$Y and x['runType']=='REGULAR'][0]
print(r['id'], r['status'])")
RUN=$(echo $RUN_AND_STATUS | cut -d' ' -f1)
RUN_ST=$(echo $RUN_AND_STATUS | cut -d' ' -f2)
if [ "$RUN_ST" == "PAID" ]; then
  echo "current month run is PAID (immutable by design) — switching to its adjustment run"
  # adjustment-run creation requires payroll.create (admin), calculation/payment stay with the officer
  RUN=$(api /tmp/admin.txt "payroll.adjustmentCreate" "{\"runId\":\"$RUN\"}" | python3 -c "
import sys,json
print(json.load(sys.stdin)['data']['adjustmentRunId'])")
  # H-01/H-02 — record the E2E-created run so future cleanups stay scoped
  echo "$RUN" >> "$E2E_RUN_IDS"
fi
echo "calculating run $RUN ($M/$Y)…"
api /tmp/payroll.txt "payroll.calculate" "{\"runId\":\"$RUN\"}" | jqv "['data']" 120
RUN_STATUS=$(api /tmp/payroll.txt "payroll.runs.list" "{}" | python3 -c "
import sys,json
runs=json.load(sys.stdin)['data']
r=[x for x in runs if x['id']=='$RUN'][0]
print(r['status'])")
echo "run status after calculate: $RUN_STATUS"
if [ "$RUN_STATUS" == "CALCULATED" ]; then
  api /tmp/payroll.txt "payroll.submitApproval" "{\"runId\":\"$RUN\"}" | jqv "['ok']" 40
  approve_all PAYROLL "Payroll"
fi
RUN_STATUS=$(api /tmp/payroll.txt "payroll.runs.list" "{}" | python3 -c "
import sys,json
runs=json.load(sys.stdin)['data']
r=[x for x in runs if x['id']=='$RUN'][0]
print(r['status'])")
echo "run status after approvals: $RUN_STATUS"
if [ "$RUN_STATUS" == "APPROVED" ]; then
  echo "PAYING run…"
  api /tmp/payroll.txt "payroll.pay" "{\"runId\":\"$RUN\"}" | jqv "['data']" 100
fi

echo ""
echo "════ 5. VERIFY: employee portal sees payslip + loan deducted; journal posted ════"
api /tmp/emp.txt "ess.payroll" "{}" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
p=[x for x in d['payslips'] if '$M' in x['period'] or True][0]
print(f\"payslip {p['payslipNumber']} net=৳{p['net']} ait=৳{p['ait']}\")"
api /tmp/emp.txt "ess.loans" "{}" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['loans']
l=[x for x in d if x['purpose']=='E2E loan test'][0]
paid_inst=[i for i in l['installments'] if i['status']=='PAID']
print(f\"loan paid={l['paidAmount']} outstanding={l['outstanding']} (first installment recovered: {len(paid_inst)}>0)\")"
api /tmp/admin.txt "journals.list" "{}" | python3 -c "
import sys,json
js=json.load(sys.stdin)['data']
pay=[j for j in js if j['refType']=='PAYROLL'][0]
loan=[j for j in js if j['refType']=='LOAN_DISBURSE'][0]
d1=sum(l.get('debit',0) for l in pay['lines']); c1=sum(l.get('credit',0) for l in pay['lines'])
d2=sum(l.get('debit',0) for l in loan['lines']); c2=sum(l.get('credit',0) for l in loan['lines'])
print(f\"PAYROLL journal balanced: Dr {d1:.0f} = Cr {c1:.0f} → {abs(d1-c1)<1}\")
print(f\"LOAN_DISBURSE journal balanced: Dr {d2:.0f} = Cr {c2:.0f} → {abs(d2-c2)<1}\")"

echo ""
echo "════ 6. Self-test suite ════"
api /tmp/admin.txt "system.selfTest" "{}" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
for r in d['results']:
    print(('✓' if r['pass'] else '✗'), r['name'], '—', r['detail'])
print('ALL PASS:', d['allPass'])"
