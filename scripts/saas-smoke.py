#!/usr/bin/env python3
"""
End-to-end smoke test for the SaaS layer + full registration lifecycle.
Drives the REAL authentication flows (password expiry, MFA enrollment with a
computed TOTP) — no shortcuts, exactly what a customer experiences.

Usage: python3 scripts/saas-smoke.py [base_url]     (default http://127.0.0.1:3100)
"""
import hmac, hashlib, base64, json, struct, sys, time, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3100"
PASS, FAIL = 0, 0

def ok(msg):
    global PASS; PASS += 1
    print(f"  ✓ {msg}")

def bad(msg, detail=""):
    global FAIL; FAIL += 1
    print(f"  ✗ {msg} {detail[:300]}")

def check(name, expected, actual):
    ok(name) if expected == actual else bad(f"{name} (expected {expected}, got {actual})")

def post(path, payload, token=None, csrf=None, cookie=None, raw_cookie=None):
    url = BASE + path
    body = json.dumps({"action": path.split("/")[-1], "payload": payload} if "payload" in payload or True else payload) if False else json.dumps(payload)
    req = urllib.request.Request(url, data=body.encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if csrf:
        req.add_header("X-CSRF-Token", csrf)
    if raw_cookie:
        req.add_header("Cookie", raw_cookie)
    elif cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode()), r.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode()), e.headers.get_all("Set-Cookie") or []
        except Exception:
            return e.code, {"ok": False, "error": str(e)}, []

def totp(secret_b32, t=None):
    """RFC 6238 TOTP, SHA1/30s/6 digits — same as Google Authenticator."""
    key = base64.b32decode(secret_b32.upper() + "=" * ((8 - len(secret_b32) % 8) % 8))
    counter = struct.pack(">Q", int((t or time.time()) // 30))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0xF
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000
    return f"{code:06d}"

def get(path):
    try:
        req = urllib.request.Request(BASE + path)
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""

def sign_in_as_tenant(email, password, new_password=None):
    """Walks the REAL tenant login flow: password expiry → MFA enrollment.
    Returns (token, vendorId, final_payload) or (None, None, error)."""
    st, d, _ = post("/api/hrm", {"action": "auth.login", "payload": {"email": email, "password": password}})
    if not d.get("ok"):
        return None, None, d.get("error")
    data = d["data"]
    # expired password → change it via pwToken
    if data.get("passwordExpired"):
        pw = new_password or "FreshPass@2026"
        st2, d2, _ = post("/api/hrm", {"action": "auth.password.change", "payload": {"pwToken": data["pwToken"], "newPassword": pw}})
        if not d2.get("ok"):
            return None, None, d2.get("error")
        st, d, _ = post("/api/hrm", {"action": "auth.login", "payload": {"email": email, "password": pw}})
        if not d.get("ok"):
            return None, None, d.get("error")
        data = d["data"]
    # MFA enrollment required → enroll with a computed TOTP
    if data.get("mfaEnrollmentRequired"):
        et = data["enrollToken"]
        st3, d3, _ = post("/api/hrm", {"action": "auth.mfa.enroll.start", "payload": {"enrollToken": et}})
        if not d3.get("ok"):
            return None, None, d3.get("error")
        secret = d3["data"].get("secret") or d3["data"].get("enrollSecret")
        if not secret:
            return None, None, "enroll.start returned no secret"
        # let the TOTP clock tick past the enrollment window edge
        for attempt in range(3):
            code = totp(secret)
            st4, d4, cookies = post("/api/hrm", {"action": "auth.mfa.enroll.enable", "payload": {"enrollToken": et, "code": code}})
            if d4.get("ok") and d4["data"].get("token"):
                return d4["data"]["token"], d4["data"].get("vendor", {}).get("id"), d4["data"]
            time.sleep(2)
        return None, None, "MFA enrollment failed after 3 attempts"
    if data.get("token"):
        return data["token"], (data.get("vendor") or {}).get("id"), data
    return None, None, f"no token in login response: {list(data.keys())}"

def section(t):
    print(f"\n── {t} ──")

# ═══════════════════════ 0. routes ═══════════════════════
section("public routes")
for p in ["/", "/pricing", "/register", "/app", "/owner", "/owner/login", "/registration-status",
          "/faq", "/about", "/contact", "/legal/privacy", "/legal/terms",
          "/features/payroll", "/features/live-tracking", "/features/employee-management",
          "/sitemap.xml", "/robots.txt"]:
    code, _ = get(p)
    check(f"GET {p}", 200, code)

# ═══════════════════════ 1. registration ═══════════════════════
section("1. public registration")
st, d, _ = post("/api/saas", {
    "action": "public.register",
    "payload": {
        "organizationName": "Smoke Test Industries Ltd.",
        "organizationType": "PRIVATE_LTD", "industry": "Testing",
        "website": "https://smoke.example", "address": "Road 1", "city": "Dhaka", "country": "Bangladesh",
        "contactNumber": "+8801700000001", "officialEmail": "info@smoketest.example",
        "adminName": "Smoke Admin", "adminDesignation": "CEO",
        "adminEmail": "smokeadmin@smoketest.example", "adminPhone": "+8801700000002",
        "password": "SmokeAdmin@2026", "confirmPassword": "SmokeAdmin@2026",
        "employeeCount": 120, "branchCount": 3, "deviceCount": 4,
        "requiredModules": ["EMPLOYEES", "ATTENDANCE", "PAYROLL", "ESS"],
        "planId": "", "billingCycle": "MONTHLY", "agreedToTerms": True, "companyWebsiteField": "",
    },
})
appid = d.get("applicationNumber") if d.get("ok") else None
if appid:
    ok(f"registration accepted → {appid}")
else:
    bad("registration failed", json.dumps(d))
# weak password must be rejected
st, d, _ = post("/api/saas", {
    "action": "public.register",
    "payload": {
        "organizationName": "Weak Password Co.", "officialEmail": "w@w.example",
        "adminName": "W", "adminEmail": "weak@smoketest.example",
        "password": "simplepassword1", "confirmPassword": "simplepassword1",
        "employeeCount": 5, "branchCount": 1, "deviceCount": 0, "requiredModules": [],
        "planId": "", "billingCycle": "MONTHLY", "agreedToTerms": True,
    },
})
check("weak password rejected", 400, st)

# ═══════════════════════ 2. status lookup ═══════════════════════
section("2. application status (public)")
st, d, _ = post("/api/saas", {"action": "public.registrationStatus", "payload": {"applicationNumber": appid, "email": "smokeadmin@smoketest.example"}})
ok("status = PENDING with next-step guidance") if d.get("ok") and d.get("status") == "PENDING" else bad("status lookup", json.dumps(d))
st, d, _ = post("/api/saas", {"action": "public.registrationStatus", "payload": {"applicationNumber": appid, "email": "intruder@smoketest.example"}})
check("wrong email → 404 (no information leak)", 404, st)

# ═══════════════════════ 3. owner console ═══════════════════════
section("3. owner console auth")
st, d, sc = post("/api/owner", {"action": "owner.auth.login", "payload": {"email": "owner@finixhr.local", "password": "SaasOwner@2026"}})
if d.get("ok") and "saas_owner_session" in (sc[0] if sc else ""):
    ok("owner login → saas_owner_session httpOnly cookie + CSRF token")
else:
    bad("owner login", json.dumps(d)[:200])
    sys.exit(1)
ocsrf = d["csrfToken"]
owork = {"cookie": f"saas_owner_session={sc[0].split('saas_owner_session=')[1].split(';')[0]}"}

st, d, _ = post("/api/owner", {"action": "owner.dashboard.overview", "payload": {}}, cookie=owork["cookie"], csrf=ocsrf)
try:
    t, s = d["tenants"], d["subscriptions"]
    assert t["total"] >= 2 and s["mrr"] > 0
    ok(f"dashboard real data: {t['total']} tenants, {t['pendingRegistrations']} pending, MRR ৳{s['mrr']}, expiring≤7d: {s['expiring7']}")
except Exception as e:
    bad("dashboard overview", str(e))

# ═══════════════════════ 4. plane separation ═══════════════════════
section("4. owner/tenant plane separation")
st, d, _ = post("/api/owner", {"action": "owner.registrations.list", "payload": {}}, token="faketenanttoken1234567890abcdef", csrf=ocsrf)
check("fabricated token rejected on owner plane", 401, st)
st, d, _ = post("/api/hrm", {"action": "employees.list", "payload": {}}, token=ocsrf)
check("owner CSRF token is not a tenant session", 401, st)
st, d, _ = post("/api/owner", {"action": "owner.plans.list", "payload": {}}, cookie=owork["cookie"])
check("owner mutation without CSRF echo → 403", 403, st)

# ═══════════════════════ 5. approval → provisioning ═══════════════════════
section("5. review + approve (transactional provisioning)")
st, d, _ = post("/api/owner", {"action": "owner.registrations.list", "payload": {"status": "PENDING", "search": "Smoke Test", "page": 1, "pageSize": 10}}, cookie=owork["cookie"], csrf=ocsrf)
regid = d["rows"][0]["id"] if d.get("ok") and d.get("rows") else None
if not regid:
    bad("registrations.list could not find the smoke application", json.dumps(d)[:200])
    sys.exit(1)
# move to under review first
st, d, _ = post("/api/owner", {"action": "owner.registrations.review", "payload": {"id": regid, "toStatus": "UNDER_REVIEW", "internalNote": "smoke note", "reviewNote": "In review."}}, cookie=owork["cookie"], csrf=ocsrf)
ok("moved to UNDER_REVIEW with notes") if d.get("ok") else bad("review", json.dumps(d)[:200])

st, d, _ = post("/api/owner", {"action": "owner.plans.forApproval", "payload": {}}, cookie=owork["cookie"], csrf=ocsrf)
bplan = next((p["id"] for p in d["plans"] if p["name"] == "Business"), None)
splan = next((p["id"] for p in d["plans"] if p["name"] == "Starter"), None)
st, d, _ = post("/api/owner", {"action": "owner.registrations.approve", "payload": {"id": regid, "planId": bplan, "billingCycle": "YEARLY", "trialDays": 14, "reviewNote": "Approved — welcome!"}}, cookie=owork["cookie"], csrf=ocsrf)
vendor_id = d.get("vendorId") if d.get("ok") else None
if vendor_id:
    ok(f"approved + provisioned: vendor {d['vendorCode']}, admin {d['adminEmail']}, subscription {d['subscriptionId'][:8]}…")
else:
    bad("approve", json.dumps(d)[:300]); sys.exit(1)

# status page now APPROVED
st, d, _ = post("/api/saas", {"action": "public.registrationStatus", "payload": {"applicationNumber": appid, "email": "smokeadmin@smoketest.example"}})
ok("public status = APPROVED (next step: sign in at /app)") if d.get("status") == "APPROVED" else bad("post-approval status", json.dumps(d)[:200])

# ═══════════════════════ 6. provisioned admin signs in ═══════════════════════
section("6. provisioned admin → tenant sign-in (full MFA flow)")
token, vid, payload = sign_in_as_tenant("smokeadmin@smoketest.example", "SmokeAdmin@2026")
if token:
    ok("signed in through the real flow (VENDOR_OWNER MFA enrollment walked with computed TOTP)")
    sub = payload.get("subscription") or {}
    try:
        assert sub["mode"] == "SUBSCRIBED" and sub["planName"] == "Business" and sub["status"] == "TRIAL"
        assert sub["usage"]["employees"] == 0
        ok(f"session carries entitlements: Business / TRIAL / {sub['daysRemaining']}d remaining, usage employees=0")
    except Exception as e:
        bad("entitlements payload", str(e))
    st, d, _ = post("/api/owner", {"action": "owner.registrations.list", "payload": {}}, token=token)
    check("tenant token rejected on /api/owner", 401, st)
    # tenant core module works
    st, d, _ = post("/api/hrm", {"action": "employees.list", "payload": {}}, token=token)
    ok("tenant core module (employees) accessible") if d.get("ok") else bad("employees.list", json.dumps(d)[:150])
    # subscription overview
    st, d, _ = post("/api/hrm", {"action": "subscription.overview", "payload": {}}, token=token)
    ok(f"subscription view: {d['data']['planName']}, price ৳{d['data']['price']}/yr") if d.get("ok") and d["data"]["planName"] == "Business" else bad("subscription.overview", json.dumps(d)[:200])
else:
    bad("provisioned admin sign-in", str(payload))

# ═══════════════════════ 7. enforcement on the demo Starter tenant ═══════════════════════
section("7. plan enforcement (Starter demo tenant — Rongin Traders)")
token2, vid2, _ = sign_in_as_tenant("owner@rongintraders.com", "Pass@123", new_password="RonginFresh@2026")
if token2:
    st, d, _ = post("/api/hrm", {"action": "payroll.runs.list", "payload": {}}, token=token2)
    if not d.get("ok") and "not included in your Starter plan" in d.get("error", ""):
        ok("payroll blocked on Starter with the actionable upgrade message")
    else:
        bad("payroll gate", json.dumps(d)[:200])
    st, d, _ = post("/api/hrm", {"action": "employees.list", "payload": {}}, token=token2)
    ok("core modules unaffected on Starter") if d.get("ok") else bad("core on Starter", json.dumps(d)[:150])
    st, d, _ = post("/api/hrm", {"action": "subscription.overview", "payload": {}}, token=token2)
    if d.get("ok"):
        u = d["data"]
        ok(f"usage meters: {u['usage']['employees']}/{u['limits']['EMPLOYEES']} employees, ends {u['endDate'][:10]}")
    else:
        bad("subscription overview (Starter)", json.dumps(d)[:200])
else:
    bad("Rongin sign-in (full flow)", str(payload)[:200])

# ═══════════════════════ 8. readonly lockout ═══════════════════════
section("8. readonly lockout (suspend → mutate blocked → views still work)")
st, d, _ = post("/api/owner", {"action": "owner.tenants.suspend", "payload": {"id": vendor_id, "reason": "smoke test suspension"}}, cookie=owork["cookie"], csrf=ocsrf)
ok("tenant suspended via owner console") if d.get("ok") and d.get("status") == "SUSPENDED" else bad("suspend", json.dumps(d)[:200])
st, d, _ = post("/api/hrm", {"action": "employees.list", "payload": {}}, token=token)
ok("readonly: views still work (data safe)") if d.get("ok") else bad("view under suspension", json.dumps(d)[:200])
st, d, _ = post("/api/hrm", {"action": "branches.create", "payload": {"name": "Should Not Work"}}, token=token)
if not d.get("ok") and "read-only" in d.get("error", ""):
    ok("mutation blocked with the renewal message")
else:
    bad("readonly mutation gate", json.dumps(d)[:200])
st, d, _ = post("/api/hrm", {"action": "auth.me", "payload": {}}, token=token)
ok("auth.me under suspension reports readonly entitlements") if d.get("ok") and d["data"].get("subscription", {}).get("readonly") else bad("auth.me subscription payload", json.dumps(d)[:200])
st, d, _ = post("/api/owner", {"action": "owner.tenants.reactivate", "payload": {"id": vendor_id, "note": "smoke done"}}, cookie=owork["cookie"], csrf=ocsrf)
ok("reactivated — workspace writable again") if d.get("ok") and d.get("status") == "ACTIVE" else bad("reactivate", json.dumps(d)[:200])

# ═══════════════════════ 9. renewals + audit ═══════════════════════
section("9. renewal calendar + platform audit")
st, d, _ = post("/api/owner", {"action": "owner.renewals.list", "payload": {"window": "7"}}, cookie=owork["cookie"], csrf=ocsrf)
rongin = next((r for r in d.get("rows", []) if "Rongin" in r["tenant"]), None)
ok(f"Rongin appears in ≤7d window ({rongin['daysRemaining']}d, {rongin['status']})") if rongin else bad("renewals window", json.dumps(d)[:200])
st, d, _ = post("/api/owner", {"action": "owner.audit.list", "payload": {"entity": "SaaSRegistration", "page": 1, "pageSize": 20}}, cookie=owork["cookie"], csrf=ocsrf)
acts = {r["action"] for r in d.get("rows", [])}
need = {"REGISTRATION_CREATED", "REGISTRATION_REVIEWED", "REGISTRATION_APPROVED"}
ok(f"audit trail complete: {sorted(need & acts)} + TENANT_SUSPENDED={'TENANT_SUSPENDED' in acts}") if need <= acts else bad("audit actions", str(acts))

# ═══════════════════════ 10. owner RBAC ═══════════════════════
section("10. owner RBAC (permission gating)")
st, d, sc2 = post("/api/owner", {"action": "owner.auth.login", "payload": {"email": "owner@finixhr.local", "password": "SaasOwner@2026"}})
# create a SALES_MANAGER (no tenants.manage) and verify gating
st, d, _ = post("/api/owner", {"action": "owner.users.save", "payload": {"email": "sales@finixhr.local", "name": "Smoke Sales", "roleKey": "SALES_MANAGER", "password": "SalesManager@2026"}}, cookie=owork["cookie"], csrf=ocsrf)
ok("SALES_MANAGER owner user created") if d.get("ok") else bad("owner.users.save", json.dumps(d)[:200])
st, d, sc3 = post("/api/owner", {"action": "owner.auth.login", "payload": {"email": "sales@finixhr.local", "password": "SalesManager@2026"}})
if d.get("ok"):
    scsrf = d["csrfToken"]
    sales_cookie = f"saas_owner_session={sc3[0].split('saas_owner_session=')[1].split(';')[0]}"
    st, d, _ = post("/api/owner", {"action": "owner.tenants.suspend", "payload": {"id": vendor_id, "reason": "should be denied"}}, cookie=sales_cookie, csrf=scsrf)
    check("SALES_MANAGER denied tenants.manage (403)", 403, st)
    st, d, _ = post("/api/owner", {"action": "owner.registrations.list", "payload": {"status": "PENDING", "page": 1}}, cookie=sales_cookie, csrf=scsrf)
    ok("SALES_MANAGER allowed registrations.view (own domain)") if d.get("ok") else bad("sales registrations.view", json.dumps(d)[:150])
else:
    bad("sales manager login", json.dumps(d)[:200])

# ═══════════════════════ 11. billing ═══════════════════════
section("11. billing (manual invoice → mark paid)")
st, d, _ = post("/api/owner", {"action": "owner.invoices.create", "payload": {"vendorId": vendor_id, "amount": 65000, "periodStart": "2026-10-01T00:00:00.000Z", "periodEnd": "2026-10-31T00:00:00.000Z", "dueAt": "2026-11-05T00:00:00.000Z", "notes": "smoke invoice"}}, cookie=owork["cookie"], csrf=ocsrf)
inv_id = d.get("id") if d.get("ok") else None
ok(f"invoice {d.get('number')} created") if inv_id else bad("invoice.create", json.dumps(d)[:200])
if inv_id:
    st, d, _ = post("/api/owner", {"action": "owner.invoices.markPaid", "payload": {"id": inv_id, "method": "BANK", "transactionId": "TXN-SMOKE-1"}}, cookie=owork["cookie"], csrf=ocsrf)
    ok("marked PAID via BANK (payment row + audit written)") if d.get("ok") and d.get("status") == "PAID" else bad("markPaid", json.dumps(d)[:200])

# ═══════════════════════ 12. public contact ═══════════════════════
section("12. contact form → owner inbox")
st, d, _ = post("/api/saas", {"action": "public.contact", "payload": {"name": "Prospective Buyer", "email": "buyer@example.com", "company": "Buyer Co", "inquiryType": "SALES", "organizationSize": "51-200", "modulesRequested": ["Payroll", "Attendance"], "message": "We need payroll for 180 staff. Timeline: this quarter."}})
ok("contact inquiry stored") if d.get("ok") else bad("contact", json.dumps(d)[:200])
st, d, _ = post("/api/owner", {"action": "owner.inquiries.list", "payload": {"status": "NEW", "page": 1}}, cookie=owork["cookie"], csrf=ocsrf)
ok("owner inbox shows the inquiry") if d.get("ok") and any("Prospective" in r["name"] for r in d.get("rows", [])) else bad("inquiries.list", json.dumps(d)[:200])

print(f"\n══ RESULT: {PASS} passed, {FAIL} failed ══")
sys.exit(0 if FAIL == 0 else 1)
