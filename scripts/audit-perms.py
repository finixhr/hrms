#!/usr/bin/env python3
"""M-02 — registry permission lint.

Every registered action must satisfy ONE of:
  1. perm: ["module", "action"] permission gate
  2. public: true                              (unauthenticated by design)
  3. // INTENTIONALLY_SELF_SCOPED (M-02): …    (authenticated, no module perm,
                                               handler enforces caller-identity
                                               scoping — reason must be stated)
  4. // INTENTIONALLY_PUBLIC: …                 (reason stated directly above)

Exit 1 with a report listing any action that satisfies none of the above.
Also reports dead actions: registered names never called from src/hrm/views/*
and mismatched frontend rpc('name') calls with no registration (audit #20).
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROUTES_DIR = ROOT / "src/hrm-server/routes"
VIEWS_DIR = ROOT / "src/hrm/views"

route_re = re.compile(r'route\(\s*[`"]([^`"]+)[`"]\s*,\s*\{')

# H-06 — legacy action names that must NEVER be re-registered (they returned
# raw device rows including the write-only comm-key hash).
LEGACY_BLOCKLIST = {
    "attendance.devices.list",
    "attendance.devices.create",
    "attendance.devices.save",
}
rpc_re = re.compile(r"""rpc(?:<[^>]*>)?\(\s*[`"']([a-zA-Z0-9_.]+)[`"']""")
useapi_re = re.compile(r"""useApi(?:<[^>]*>)?\(\s*[`"']([a-zA-Z0-9_.]+)[`"']""")
dynamic_rpc_re = re.compile(r'rpc\([^`"\']+\)')  # dynamic name — skipped

registered: dict[str, Path] = {}
gated: dict[str, str] = {}
violations: list[str] = []

for f in sorted(ROUTES_DIR.glob("*.ts")):
    src = f.read_text()
    for m in route_re.finditer(src):
        name = m.group(1)
        if '${' in name:
            continue  # SECTION factory: routes are registered with perm at call time
        if name in LEGACY_BLOCKLIST:
            violations.append(f"{f.name}: {name} — H-06 legacy action re-registered (leaks comm-key hash)")
            continue
        registered[name] = f
        block = src[m.end():m.end()+500]
        has_perm = re.search(r'\bperm\s*:\s*(\[\s*["\']|[A-Z][A-Z0-9_]+\b)', block)
        has_public = re.search(r'\bpublic\s*:\s*true', block)
        before = src[max(0, m.start()-400):m.start()]
        recent = "\n".join(before.split("\n")[-5:])
        has_self_scope = "INTENTIONALLY_SELF_SCOPED" in recent
        has_intentional = "INTENTIONALLY_PUBLIC" in recent
        if has_perm:
            gated[name] = "perm"
        elif has_public and has_intentional:
            gated[name] = "public+reason"
        elif has_public:
            violations.append(f"{f.name}: {name} — public:true without an INTENTIONALLY_PUBLIC reason")
        elif has_self_scope:
            gated[name] = "self-scoped+reason"
        else:
            violations.append(f"{f.name}: {name} — no perm gate, no public flag, no INTENTIONALLY_* marker")


# ---- factory-registered actions (CRUD/SECTION helpers register gated routes
# dynamically — treat their prefixes as registered) ----
crud_re = re.compile(r'CRUD\(\s*"[a-z]+"\s*,\s*"[a-z]+"\s*,\s*"[A-Za-z]+"\s*,\s*"([a-z]+)"')
section_re = re.compile(r'SECTION\(\s*"([a-z]+)"')
for f in [ROUTES_DIR / "organization.ts", ROUTES_DIR / "employees.ts"]:
    if not f.exists():
        continue
    src = f.read_text()
    for m in crud_re.finditer(src):
        for suffix in ["list", "nextCode", "create", "update", "delete"]:
            registered.setdefault(f"{m.group(1)}.{suffix}", f)
    for m in section_re.finditer(src):
        for suffix in ["list", "create", "update", "delete"]:
            registered.setdefault(f"employees.{m.group(1)}.{suffix}", f)

# ---- frontend call audit (audit item #20): dead / mismatched action names ----
called: set[str] = set()
for f in VIEWS_DIR.glob("*.tsx"):
    src = f.read_text()
    called.update(rpc_re.findall(src))
    called.update(useapi_re.findall(src))

# some actions are called server-side (seeds/scripts/tests/other routes) or from
# non-view code (app-shell, shared dialogs) — scan those too
EXTRA_SCAN = [ROOT / "src/hrm", ROOT / "src/app", ROOT / "scripts", ROOT / "tests"]
for d in EXTRA_SCAN:
    if not d.exists():
        continue
    for f in d.rglob("*.ts*"):
        try:
            src = f.read_text()
        except Exception:
            continue
        called.update(rpc_re.findall(src))
        called.update(useapi_re.findall(src))

uncalled = sorted(set(registered) - called)
unregistered_calls = sorted(n for n in called if n not in registered and not n.startswith("test."))

if violations:
    print("PERMISSION LINT VIOLATIONS (M-02):")
    for v in violations:
        print("  " + v)
if unregistered_calls:
    print("FRONTEND CALLS WITH NO REGISTERED ACTION (audit #20):")
    for n in unregistered_calls:
        print("  " + n)
if uncalled:
    print(f"INFO: {len(uncalled)} registered action(s) not referenced in code (kept: server-side/seed flows):")
    for n in uncalled[:40]:
        print("  " + n)

if violations or unregistered_calls:
    print(f"\nFAIL: {len(violations)} permission violation(s), {len(unregistered_calls)} mismatched call(s)")
    sys.exit(1)
print(f"\nOK: {len(registered)} actions registered — all gated or annotated; frontend calls all resolve")
