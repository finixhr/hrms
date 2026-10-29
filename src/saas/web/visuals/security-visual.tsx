"use client"
// ============ Visual 10 · Security & Control ============
// RBAC matrix (roles × permissions with allow/deny), MFA card with masked
// recovery codes, session policy, security-posture ring, audit-log feed with
// mono IPs and the tenant-isolation diagram.
import { Check, Fingerprint, Globe, KeyRound, Lock, ScrollText, Server, ShieldCheck, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Chip, Panel, Ring, StatusDot, WindowChrome } from "./chrome"
import type { ChipTone } from "./chrome"

/* ---------- data ---------- */
const ROLES = ["Vendor owner", "HR Manager", "Branch Manager", "Employee"]
// allow = true, deny = false
const MATRIX: { permission: string; cells: boolean[] }[] = [
  { permission: "Run payroll", cells: [false, true, false, false] },
  { permission: "Approve leave requests", cells: [false, true, true, false] },
  { permission: "Edit employee records", cells: [false, true, false, false] },
  { permission: "Manage attendance devices", cells: [false, true, false, false] },
  { permission: "View audit trail", cells: [true, true, false, false] },
  { permission: "View own payslips (ESS)", cells: [false, false, false, true] },
]

const RECOVERY_CODES = ["A3F9 · K2••", "7M42 · 9W••", "QD18 · C5••", "Z881 · HN••", "3VL2 · PY••"]

const SESSION_POLICY: [string, string][] = [
  ["Session lifetime", "7 days (sliding)"],
  ["Lockout", "5 failed attempts / 15 min"],
  ["Password rotation", "every 90 days"],
  ["Concurrent sessions", "3 devices max"],
]

const RATE_LIMITS: [string, string][] = [
  ["/api/hrm · tenant", "120 req / min / session"],
  ["login · global", "5 attempts / 15 min"],
  ["/iclock push · devices", "600 events / min"],
  ["owner console", "60 req / min / user"],
]

const AUDIT: { time: string; action: string; actor: string; target: string; ip: string; tone: ChipTone }[] = [
  { time: "10:42", action: "leave.approve", actor: "hr.admin", target: "LVR-2102", ip: "103.12.44.8", tone: "slate" },
  { time: "09:58", action: "login.failed ×3", actor: "emp-1087", target: "auth", ip: "118.179.22.4", tone: "amber" },
  { time: "09:15", action: "device.sync", actor: "system", target: "A8C2-9F41", ip: "internal", tone: "slate" },
  { time: "08:41", action: "mfa.recovery_used", actor: "emp-1154", target: "mfa", ip: "45.114.86.2", tone: "rose" },
  { time: "08:02", action: "payroll.open", actor: "finance.mgr", target: "RUN-2026-09", ip: "103.12.44.19", tone: "slate" },
]

function AllowIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300 light:bg-emerald-500/10 light:text-emerald-600">
      <Check className="h-3 w-3" />
    </span>
  ) : (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/5 text-slate-600 light:bg-slate-100 light:text-slate-400">
      <X className="h-3 w-3" />
    </span>
  )
}

/* ---------- the visual ---------- */
export function SecurityVisual() {
  return (
    <WindowChrome
      title={<>finixhr.app — Security &amp; Control
        <span className="ml-2 inline-flex items-center gap-1 text-emerald-400 light:text-emerald-600">
          <StatusDot tone="emerald" pulse /> posture 96
        </span>
      </>}
      glow="bg-emerald-600/20"
    >
      <div className="grid gap-3 lg:grid-cols-[230px_1fr]">
        {/* left rail: posture + MFA + session policy */}
        <div className="min-w-0 space-y-3">
          <Panel title="Security posture" icon={ShieldCheck} className="text-center">
            <div className="flex justify-center">
              <Ring value={96} size={88} color="#10b981" label="96" sub="/ 100" />
            </div>
            <div className="mt-2 flex flex-wrap justify-center gap-1.5">
              <Chip tone="emerald">MFA on</Chip>
              <Chip tone="emerald">RBAC strict</Chip>
              <Chip tone="emerald">Audit full</Chip>
            </div>
          </Panel>

          <Panel title="MFA · TOTP" icon={KeyRound}>
            <p className="flex items-center justify-between text-[10px]">
              <span className="text-slate-400 light:text-slate-600">Enrollment</span>
              <Chip tone="emerald"><Fingerprint className="h-2.5 w-2.5" /> enrolled</Chip>
            </p>
            <p className="mt-1 text-[9px] text-slate-500">Since 2025-08-14 · last verified today 09:02</p>
            <p className="mt-2 text-[9px] font-bold uppercase tracking-widest text-slate-500">Recovery codes</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {RECOVERY_CODES.map((c) => (
                <span key={c} className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[8px] text-slate-400 light:border-slate-200 light:bg-slate-50 light:text-slate-600">
                  {c}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[8px] text-slate-500">Masked · 10 codes, one-time use, hash-stored</p>
          </Panel>

          <Panel title="Session policy" icon={Globe}>
            <dl className="space-y-1 text-[9px]">
              {SESSION_POLICY.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-medium text-slate-300 light:text-slate-700">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel title="Rate limits" icon={Server}>
            <dl className="space-y-1 text-[9px]">
              {RATE_LIMITS.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 rounded-md bg-white/[0.03] px-2 py-1 light:bg-slate-50">
                  <dt className="font-mono text-slate-500">{k}</dt>
                  <dd className="font-medium text-slate-300 light:text-slate-700">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1.5 text-[8px] text-slate-500">Per-tenant throttling — one noisy workspace cannot starve the others.</p>
          </Panel>
        </div>

        {/* right: RBAC matrix + audit + tenant isolation */}
        <div className="min-w-0 space-y-3">
          <Panel title="RBAC matrix · roles × permissions" icon={Lock} action={<Chip tone="slate">scoped</Chip>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[430px] text-left text-[10px]">
                <thead>
                  <tr className="text-[9px] uppercase tracking-wider text-slate-500">
                    <th className="pb-1.5 font-semibold">Permission</th>
                    {ROLES.map((r) => (
                      <th key={r} className="pb-1.5 text-center font-semibold">{r}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MATRIX.map((row) => (
                    <tr key={row.permission} className="border-t border-white/5 light:border-slate-100">
                      <td className="py-1.5 text-slate-300 light:text-slate-700">{row.permission}</td>
                      {row.cells.map((ok, i) => (
                        <td key={`${row.permission}-${ROLES[i]}`} className="py-1.5 text-center">
                          <span className="flex justify-center"><AllowIcon ok={ok} /></span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[8px] text-slate-500">
              Least privilege by default · the platform owner manages tenants, never tenant data.
            </p>
          </Panel>

          <Panel title="Audit log · live" icon={ScrollText} action={<Chip tone="emerald">PII scrubbed</Chip>}>
            <ul className="space-y-1">
              {AUDIT.map((a) => (
                <li key={`${a.time}-${a.action}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-white/[0.03] px-2 py-1.5 font-mono text-[9px] light:bg-slate-50">
                  <span className="text-slate-500">{a.time}</span>
                  <Chip tone={a.tone}>{a.action}</Chip>
                  <span className="text-slate-400 light:text-slate-600">{a.actor}</span>
                  <span className="text-slate-600">→</span>
                  <span className="text-indigo-300 light:text-indigo-600">{a.target}</span>
                  <span className="ml-auto text-slate-500">{a.ip}</span>
                </li>
              ))}
            </ul>
          </Panel>

          {/* tenant isolation diagram */}
          <Panel title="Tenant isolation" icon={Server}>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
              <div className={cn(
                "rounded-xl border border-indigo-400/30 bg-indigo-500/[0.08] p-2.5 text-center",
                "light:border-indigo-500/30 light:bg-indigo-500/5",
              )}>
                <p className="text-[11px] font-bold text-white light:text-slate-900">Tenant A</p>
                <p className="mt-0.5 font-mono text-[8px] text-slate-500">vendor_id = 3</p>
                <p className="mt-1 text-[8px] text-slate-500">employees · payroll · devices</p>
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-emerald-400/50 bg-emerald-400/10">
                  <Lock className="h-4 w-4 text-emerald-300 light:text-emerald-600" />
                </span>
                <span className="font-mono text-[7px] uppercase tracking-widest text-slate-500">scoped</span>
              </div>
              <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/[0.08] p-2.5 text-center light:border-cyan-500/30 light:bg-cyan-500/5">
                <p className="text-[11px] font-bold text-white light:text-slate-900">Tenant B</p>
                <p className="mt-0.5 font-mono text-[8px] text-slate-500">vendor_id = 7</p>
                <p className="mt-1 text-[8px] text-slate-500">employees · payroll · devices</p>
              </div>
            </div>
            <p className="mt-2 text-center text-[9px] text-slate-500">
              Every query is vendor-scoped — cross-tenant ids resolve to 404, never 403.
            </p>
          </Panel>
        </div>
      </div>
    </WindowChrome>
  )
}
