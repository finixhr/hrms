#!/usr/bin/env bash
# ============ Live API verification — AIT engine + procurement + inventory ============
set -u
BASE="http://localhost:3000/api/hrm"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1 — $2"; }

# login helper
login() {
  curl -s -X POST "$BASE" -H 'Content-Type: application/json' \
    -d "{\"action\":\"auth.login\",\"payload\":{\"email\":\"$1\",\"password\":\"Pass@123\"}}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('token',''))"
}
call() { # call <token> <action> <json>
  curl -s -X POST "$BASE" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $1" -d "{\"action\":\"$2\",\"payload\":$3}"
}
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d, indent=0)[:400])"; }

echo "— login"
ADMIN=$(login admin@finixhr.com)
[ -n "$ADMIN" ] && ok "admin login" || fail "admin login" "no token"
EMP=$(login employee@finixhr.com)
[ -n "$EMP" ] && ok "employee login" || fail "employee login" "no token"

echo "— AIT configuration (3A–3F)"
R=$(call "$ADMIN" "ait.config.get" '{}')
echo "$R" | grep -q '"FY 2025-26"' && ok "FY 2025-26 config exists" || fail "ait.config.get" "$(echo $R | J)"
echo "$R" | grep -q '"freedom_fighter"' && ok "freedom-fighter category present" || fail "categories" "missing"
echo "$R" | grep -q '500000' && ok "exemption cap ৳5,00,000 present" || fail "cap" "missing"

echo "— AIT calculation engine (spec §4 steps 1–7)"
# monthly gross 100000, basic 50000 → annual 100000*12 + 2*50000 = 1,300,000
# exemption = min(1300000/3, 500000) = 433,333 → taxable = 866,667 → above 400k = 466,667
# slabs: 300k@10% = 30000 + 166,667@15% = 25000 → 55000 annual tax
# avg rate = 55000/1300000 = 4.2308% → monthly TDS = 100000 × 4.2308% = 4231
R=$(call "$ADMIN" "ait.calc.preview" '{"monthlyBasicSalary":50000,"monthlyGrossSalary":100000,"currentMonthGross":100000}')
echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('data', {}).get('result', {})
assert r.get('annualGross') == 1300000, f\"annualGross {r.get('annualGross')}\"
assert round(r.get('exemption', 0)) == 433333, f\"exemption {r.get('exemption')}\"
assert r.get('threshold') == 400000, f\"threshold {r.get('threshold')}\"
assert round(r.get('slabTax', 0)) == 55000, f\"slabTax {r.get('slabTax')}\"
assert round(r.get('annualTax', 0)) == 55000, f\"annualTax {r.get('annualTax')}\"
assert abs(r.get('averageRatePercent', 0) - 4.2308) < 0.001, f\"avg {r.get('averageRatePercent')}\"
assert r.get('monthlyTds') == 4231, f\"monthlyTds {r.get('monthlyTds')}\"
assert len(r.get('slabLines', [])) == 2, f\"slabLines {r.get('slabLines')}\"
print('ENGINE-OK')
" && ok "7-step engine math (exemption 433333, tax 55000, TDS 4231)" || fail "engine math" "$(echo $R | J)"

# female category threshold
R=$(call "$ADMIN" "ait.calc.preview" '{"monthlyBasicSalary":50000,"monthlyGrossSalary":100000,"currentMonthGross":100000,"taxpayerCategory":"female"}')
echo "$R" | grep -q '"threshold":425000' && ok "female threshold 425000 applied" || fail "female threshold" "$(echo $R | J)"

# senior auto-suggestion with warning
R=$(call "$ADMIN" "ait.calc.preview" '{"monthlyBasicSalary":50000,"monthlyGrossSalary":100000,"currentMonthGross":100000,"dob":"1955-01-01"}')
echo "$R" | grep -q '"SENIOR_AUTO"' && ok "senior auto-suggest warning fires (SENIOR_AUTO)" || fail "senior warning" "missing"

# minimum tax warning: income just above threshold → tiny tax below the minimum
# annual = 12×46667 + 2×25000 = 610,004 → exempt 203,334 → taxable 406,670 → above 400k = 6,670 → tax 667 < 5000
R=$(call "$ADMIN" "ait.calc.preview" '{"monthlyBasicSalary":25000,"monthlyGrossSalary":46667,"currentMonthGross":46667}')
echo "$R" | grep -q '"MIN_TAX"' && ok "minimum tax warning fires (MIN_TAX, not inflated)" || fail "min tax" "$(echo $R | J)"

# basic > gross blocked
R=$(call "$ADMIN" "ait.calc.preview" '{"monthlyBasicSalary":90000,"monthlyGrossSalary":60000,"currentMonthGross":60000}')
echo "$R" | grep -q 'cannot exceed' && ok "basic>gross blocked" || fail "validation" "$(echo $R | J)"

# investment rebate
R=$(call "$ADMIN" "ait.calc.preview" '{"monthlyBasicSalary":50000,"monthlyGrossSalary":100000,"currentMonthGross":100000,"declaredInvestment":300000}')
echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('data', {}).get('result', {})
# eligible = min(300000, 866667*0.25=216667, 1cr) = 216667 → rebate 15% = 32500
assert round(r.get('rebateAmount', 0)) == 32500, f\"rebate {r.get('rebateAmount')}\"
assert round(r.get('annualTax', 0)) == 22500, f\"annualTax {r.get('annualTax')}\"
print('REBATE-OK')
" && ok "Sec 78 rebate computed (eligible capped at 25% of taxable)" || fail "rebate" "$(echo $R | J)"

echo "— batch + reconciliation"
R=$(call "$ADMIN" "ait.batch.calculate" '{}')
echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin).get('data', {})
assert d.get('summary', {}).get('employees', 0) >= 10, f\"batch {d.get('summary')}\"
print('BATCH-OK')
" && ok "batch TDS for all employees" || fail "batch" "$(echo $R | J)"

R=$(call "$ADMIN" "ait.reconciliation" '{}')
echo "$R" | grep -q '"monthsElapsed"' && ok "reconciliation view" || fail "reconciliation" "$(echo $R | J)"

R=$(call "$ADMIN" "ait.logs.list" '{}')
echo "$R" | grep -q '"BATCH"' && ok "audit journal records batch" || fail "audit log" "$(echo $R | J)"

echo "— inventory"
R=$(call "$ADMIN" "inventory.stock.overview" '{}')
echo "$R" | grep -q '"Ergonomic Office Chair"' && ok "stock overview lists seeded items" || fail "overview" "$(echo $R | J)"
echo "$R" | grep -q '"lowStock"' && ok "summary block present" || fail "summary" "missing"

echo "— requisition lifecycle (ESS → create → submit)"
EMPID=$(call "$ADMIN" "employees.list" '{}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['id'])")
R=$(call "$EMP" "requisitions.mine" '{}')
echo "$R" | grep -q 'data' && ok "requisitions.mine (own list)" || fail "mine" "$(echo $R | J)"

ITEMID=$(call "$ADMIN" "inventory.items.list" '{}' | python3 -c "import sys,json; rows=json.load(sys.stdin)['data']; print([r for r in rows if r['name']=='Wireless Mouse'][0]['id'])")
R=$(call "$EMP" "requisitions.create" "{\"priority\":\"URGENT\",\"submit\":true,\"items\":[{\"itemId\":\"$ITEMID\",\"itemCategory\":\"IT\",\"itemName\":\"Wireless Mouse\",\"quantity\":2,\"unit\":\"Pcs\"}]}")
echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin).get('data', {})
assert d.get('status') == 'PENDING_APPROVAL', f\"status {d.get('status')}\"
assert d.get('reqNo','').startswith('GR-'), f\"reqNo {d.get('reqNo')}\"
print('REQ-OK')
" && ok "requisition created + submitted (GR number)" || fail "create" "$(echo $R | J)"

echo "— requisition approve → issue (stock available path)"
REQID=$(call "$EMP" "requisitions.mine" '{}' | python3 -c "import sys,json; rows=json.load(sys.stdin)['data']; print([r for r in rows if r['status']=='PENDING_APPROVAL'][0]['id'])")
# approve all workflow steps (dept manager → hr manager → hr admin)
for TOK in dept hr admin; do
  case $TOK in
    dept) T=$(login dept@finixhr.com);;
    hr)   T=$(login hr@finixhr.com);;
    admin) T=$ADMIN;;
  esac
  AR=$(call "$T" "requisitions.action" "{\"id\":\"$REQID\",\"decision\":\"APPROVE\"}")
  ST=$(echo "$AR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status',''))" 2>/dev/null)
  [ -n "$ST" ] && ok "step approved ($ST)" || fail "approve step" "$(echo $AR | J)"
done
R=$(call "$ADMIN" "requisitions.get" "{\"id\":\"$REQID\"}")
echo "$R" | grep -q '"ISSUED"' && ok "final approval auto-issued goods from stock" || fail "issue" "$(echo $R | J)"

echo "— employee receipt confirmation"
R=$(call "$EMP" "requisitions.receive" "{\"id\":\"$REQID\",\"decision\":\"CONFIRM\"}")
echo "$R" | grep -q '"COMPLETED"' && ok "receipt confirmed → COMPLETED" || fail "receive" "$(echo $R | J)"

echo "— stock ledger integrity (issue transaction recorded)"
R=$(call "$ADMIN" "inventory.transactions.list" '{"type":"ISSUE"}')
echo "$R" | grep -q 'GOODS_REQUISITION' && ok "ISSUE transaction linked to requisition" || fail "ledger" "$(echo $R | J)"

echo "— forgot-password (login screen reset flow)"
R=$(curl -s -X POST "$BASE" -H 'Content-Type: application/json' -d '{"action":"auth.forgotPassword","payload":{"email":"employee@finixhr.com"}}')
echo "$R" | grep -q '"ok":true' && ok "forgotPassword returns ok (no enumeration)" || fail "forgotPassword" "$(echo $R | J)"
R=$(curl -s -X POST "$BASE" -H 'Content-Type: application/json' -d '{"action":"auth.resetPassword","payload":{"email":"employee@finixhr.com","code":"WRONG123","newPassword":"Xx123456!"}}')
echo "$R" | grep -q 'Invalid reset code' && ok "resetPassword rejects a wrong code" || fail "reset wrong code" "$(echo $R | J)"
R=$(curl -s -X POST "$BASE" -H 'Content-Type: application/json' -d '{"action":"auth.forgotPassword","payload":{"email":"nosuchuser@finixhr.com"}}')
echo "$R" | grep -q '"ok":true' && ok "unknown email gets identical ok response" || fail "enumeration guard" "$(echo $R | J)"

echo "— procurement requisition numbering + itemOptions"
R=$(call "$EMP" "requisitions.itemOptions" '{}')
echo "$R" | grep -q 'Wireless Mouse' && ok "itemOptions lists catalogue items" || fail "itemOptions" "$(echo $R | J)"

echo
echo "==================================="
echo "PASS: $PASS   FAIL: $FAIL"
[ $FAIL -eq 0 ] && echo "ALL LIVE-API CHECKS PASSED" || echo "SOME CHECKS FAILED"
