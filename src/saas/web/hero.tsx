// ============ Hero + product visualization (server component, CSS-only motion) ============
// The mockup is composed from the app's own design language (slate-900 chrome,
// emerald action color, rounded cards) — not a fake unrelated dashboard.
// Animations are pure CSS keyframes (respecting prefers-reduced-motion); no
// animation library is loaded for the marketing pages.
import Link from "next/link"
import { ArrowRight, Bell, MapPin, Search, ShieldCheck, TrendingUp, Users, Wallet } from "lucide-react"
import { SITE } from "./site"
import { Grad } from "./sections"

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-slate-950 light:bg-white">
      {/* backdrop: grid + aurora glows (softer under the light theme) */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(148,163,184,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.07) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, black 55%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, black 55%, transparent 100%)",
          }}
        />
        <div className="absolute left-1/2 top-[-220px] h-[540px] w-[900px] -translate-x-1/2 rounded-full bg-indigo-600/25 blur-[140px] light:opacity-50" />
        <div className="absolute right-[-160px] top-[120px] h-[380px] w-[380px] rounded-full bg-emerald-500/15 blur-[120px] light:opacity-60" />
        <div className="absolute left-[-160px] bottom-[-120px] h-[360px] w-[420px] rounded-full bg-violet-600/20 blur-[120px] light:opacity-50" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 pb-20 pt-20 sm:px-6 sm:pt-28">
        <div className="grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
          {/* ---- copy ---- */}
          <div className="hero-fade-up">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 light:border-slate-200 light:bg-slate-50 light:text-slate-600">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Multi-tenant workforce platform · {SITE.country}
            </div>
            <h1 className="mt-6 text-4xl font-bold leading-[1.08] tracking-tight text-white text-balance light:text-slate-900 sm:text-5xl xl:text-6xl">
              One Platform to Run Your <Grad>Entire Workforce</Grad>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-400 light:text-slate-600">
              HR, attendance with GPS &amp; selfie verification, live tracking, payroll &amp; AIT, leave,
              performance, inventory, communication, security and analytics — one workspace per organization,
              one sign-in for your whole team.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/register"
                data-cursor="magnetic"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-7 text-[15px] font-semibold text-white shadow-xl shadow-indigo-950/60 transition-all hover:from-blue-500 hover:to-violet-500"
              >
                Start Your HR Journey <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/features"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-white/15 bg-white/[0.03] px-7 text-[15px] font-semibold text-white backdrop-blur transition-colors hover:bg-white/[0.07] light:border-slate-300 light:bg-white light:text-slate-800 light:shadow-sm light:hover:bg-slate-100"
              >
                Explore Features
              </Link>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center justify-center rounded-xl px-5 text-[15px] font-semibold text-slate-300 transition-colors hover:text-white light:text-slate-600 light:hover:text-slate-900"
              >
                View Pricing
              </Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-slate-400 light:text-slate-600">
              {["Approval-based onboarding", "Server-side plan enforcement", "Audit trail on every action", "Bangladesh payroll & AIT"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 light:text-emerald-600" /> {t}
                </li>
              ))}
            </ul>
          </div>

          {/* ---- product visualization (intentionally dark in BOTH themes:
               it depicts the shipped application's dark console, like a
               screenshot — the surrounding page re-skins, the product image
               does not) ---- */}
          <div className="hero-fade-up-delayed relative mx-auto w-full max-w-[560px]">
            {/* glow plate */}
            <div aria-hidden className="absolute -inset-6 rounded-[32px] bg-gradient-to-br from-blue-600/25 via-indigo-600/15 to-transparent blur-2xl light:opacity-70" />
            {/* app frame */}
            <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-slate-900 shadow-2xl shadow-black/50">
              {/* window chrome */}
              <div className="flex items-center gap-2 border-b border-white/10 bg-slate-950/80 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
                <span className="ml-3 flex h-6 flex-1 items-center gap-2 rounded-md bg-white/5 px-2 text-[10px] text-slate-500">
                  <Search className="h-3 w-3" /> {SITE.name.toLowerCase().replace(" ", "")}.app — HR Dashboard
                </span>
              </div>
              <div className="flex">
                {/* mini sidebar */}
                <div className="hidden w-32 shrink-0 flex-col gap-1 border-r border-white/10 bg-slate-950/60 p-2 sm:flex">
                  {["Dashboard", "Employees", "Attendance", "Leave", "Payroll", "Tracking"].map((item, i) => (
                    <span
                      key={item}
                      className={
                        i === 0
                          ? "rounded-md bg-gradient-to-r from-emerald-500 to-teal-600 px-2 py-1.5 text-[10px] font-semibold text-white"
                          : "rounded-md px-2 py-1.5 text-[10px] font-medium text-slate-400"
                      }
                    >
                      {item}
                    </span>
                  ))}
                </div>
                {/* main area */}
                <div className="min-w-0 flex-1 space-y-3 p-3">
                  {/* KPI row */}
                  <div className="grid grid-cols-3 gap-2">
                    <MockKpi icon={Users} label="Employees" value="1,248" trend="+18 this month" />
                    <MockKpi icon={Wallet} label="Payroll" value="On track" trend="Run 2026-09 · DRAFT" muted />
                    <MockKpi icon={MapPin} label="Live tracking" value="86 active" trend="3 GPS-disabled" />
                  </div>
                  {/* attendance list */}
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Today · Attendance</p>
                    <div className="mt-2 space-y-1.5">
                      {[
        ["BR-0001 · Gulshan", "942 / 1,010 present", "emerald"],
        ["BR-0003 · Uttara", "288 / 305 present", "emerald"],
        ["BR-0007 · Chattogram", "18 flagged for review", "amber"],
      ].map(([site, val, tone]) => (
                        <div key={site} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5">
                          <span className={tone === "emerald" ? "h-1.5 w-1.5 rounded-full bg-emerald-400" : "h-1.5 w-1.5 rounded-full bg-amber-400"} />
                          <span className="text-[10px] font-medium text-slate-300">{site}</span>
                          <span className="ml-auto text-[10px] text-slate-400">{val}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* chart + notifications */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
                      <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        <TrendingUp className="h-3 w-3 text-indigo-300" /> Headcount
                      </p>
                      <div className="mt-2 flex h-16 items-end gap-1.5">
                        {[35, 45, 40, 55, 62, 58, 72, 80, 76, 90, 86, 100].map((h, i) => (
                          <span
                            key={i}
                            className="mock-bar w-full rounded-sm bg-gradient-to-t from-blue-600/70 to-indigo-400/80"
                            style={{ height: `${h}%`, animationDelay: `${i * 70}ms` }}
                          />
                        ))}
                      </div>
                      <p className="mt-1.5 text-[9px] text-slate-500">Demo visualization — your dashboard shows live data</p>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
                      <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        <Bell className="h-3 w-3 text-indigo-300" /> Notifications
                      </p>
                      <div className="mt-2 space-y-1.5">
                        <MockNote tone="emerald" text="Leave approved · N. Akter (Annual)" />
                        <MockNote tone="indigo" text="Payroll run ready for approval" />
                        <MockNote tone="amber" text="Device SN A8C2… offline 12 min" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* floating cards */}
            <div className="hero-float absolute -left-4 top-16 hidden rounded-xl border border-white/15 bg-slate-900/90 p-3 shadow-xl shadow-black/40 backdrop-blur-xl sm:block">
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Selfie proof</p>
              <p className="mt-1 text-xs font-semibold text-emerald-300">Verified · geo-fence ✓</p>
              <p className="text-[10px] text-slate-400">Payslip &amp; attendance integrity</p>
            </div>
            <div className="hero-float-slow absolute -right-3 bottom-10 hidden rounded-xl border border-white/15 bg-slate-900/90 p-3 shadow-xl shadow-black/40 backdrop-blur-xl sm:block">
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">ZKTeco ADMS</p>
              <p className="mt-1 text-xs font-semibold text-indigo-300">3 devices · all healthy</p>
              <p className="text-[10px] text-slate-400">push · no CSV round-trips</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function MockKpi({ icon: Icon, label, value, trend, muted }: { icon: any; label: string; value: string; trend: string; muted?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
      <p className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">
        <Icon className="h-3 w-3 text-indigo-300" /> {label}
      </p>
      <p className="mt-1.5 text-sm font-bold text-white">{value}</p>
      <p className={muted ? "text-[9px] text-slate-500" : "text-[9px] text-emerald-400"}>{trend}</p>
    </div>
  )
}

function MockNote({ tone, text }: { tone: "emerald" | "indigo" | "amber"; text: string }) {
  const dot =
    tone === "emerald" ? "bg-emerald-400" : tone === "indigo" ? "bg-indigo-400" : "bg-amber-400"
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-white/[0.03] px-2 py-1.5">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="text-[10px] leading-snug text-slate-300">{text}</span>
    </div>
  )
}
