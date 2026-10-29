// ============ Hero block (server, CSS-only motion — reuses the site's hero language) ============
import Link from "next/link"
import { ArrowRight, CheckCircle2, Search, ShieldCheck } from "lucide-react"
import { Grad } from "@/saas/web/sections"
import { SiteIdentity } from "@/saas/web/content-types"

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

export function HeroBlock({ data, identity }: { data: Record<string, unknown>; identity: SiteIdentity }) {
  const bullets = arr<string>(data.bullets)
  const stats = arr<{ value: string; label: string }>(data.stats)
  return (
    <section className="relative overflow-hidden bg-slate-950 light:bg-white">
      {/* backdrop: grid + aurora glows */}
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
            {str(data.badge) && (
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 light:border-slate-200 light:bg-slate-50 light:text-slate-600">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                {str(data.badge)}
              </div>
            )}
            <h1 className="mt-6 text-4xl font-bold leading-[1.08] tracking-tight text-white text-balance light:text-slate-900 sm:text-5xl xl:text-6xl">
              <Grad>{str(data.title, "One Platform to Run Your Entire Workforce")}</Grad>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-400 light:text-slate-600">
              {str(data.sub, identity.description)}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href={str(data.primaryHref, "/register")}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-7 text-[15px] font-semibold text-white shadow-xl shadow-indigo-950/60 transition-all hover:from-blue-500 hover:to-violet-500"
              >
                {str(data.primaryLabel, "Start Your HR Journey")} <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href={str(data.secondaryHref, "/features")}
                className="inline-flex h-12 items-center justify-center rounded-xl border border-white/15 bg-white/[0.03] px-7 text-[15px] font-semibold text-white backdrop-blur transition-colors hover:bg-white/[0.07] light:border-slate-300 light:bg-white light:text-slate-800 light:shadow-sm light:hover:bg-slate-100"
              >
                {str(data.secondaryLabel, "Explore Features")}
              </Link>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center justify-center rounded-xl px-5 text-[15px] font-semibold text-slate-300 transition-colors hover:text-white light:text-slate-600 light:hover:text-slate-900"
              >
                View Pricing
              </Link>
            </div>
            {bullets.length > 0 && (
              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-slate-400 light:text-slate-600">
                {bullets.map((t, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 light:text-emerald-600" /> {t}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- product visualization (client lazy component, stylized app window) ---- */}
          <div className="hero-fade-up-delayed relative mx-auto w-full max-w-[560px]">
            <div aria-hidden className="absolute -inset-6 rounded-[32px] bg-gradient-to-br from-blue-600/25 via-indigo-600/15 to-transparent blur-2xl light:opacity-70" />
            <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-slate-900 shadow-2xl shadow-black/50">
              <div className="flex items-center gap-2 border-b border-white/10 bg-slate-950/80 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
                <span className="ml-3 flex h-6 flex-1 items-center gap-2 rounded-md bg-white/5 px-2 text-[10px] text-slate-500">
                  <Search className="h-3 w-3" /> {identity.siteName.toLowerCase().replace(/\s+/g, "")}.app — All in One Dashboard
                </span>
              </div>
              <HeroDashboardMock stats={stats} />
            </div>
            {/* floating chips */}
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

        {/* ---- capability stats strip ---- */}
        {stats.length > 0 && (
          <div className="mt-16 grid grid-cols-2 gap-6 border-t border-white/10 pt-8 sm:grid-cols-4 light:border-slate-200">
            {stats.map((s, i) => (
              <div key={i} className="text-center lg:text-left">
                <p className="bg-gradient-to-r from-blue-400 to-violet-400 bg-clip-text text-2xl font-bold tabular-nums text-transparent light:from-blue-600 light:to-violet-600">{s.value}</p>
                <p className="mt-1 text-xs text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/** Compact static dashboard mock (server-rendered CSS only — the heavy
 *  interactive simulation lives on feature pages). */
function HeroDashboardMock({ stats }: { stats: { value: string; label: string }[] }) {
  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-3 gap-2">
        {(stats.length >= 3 ? stats.slice(0, 3) : [
          { value: "1,248", label: "Employees" },
          { value: "96%", label: "Present" },
          { value: "86", label: "Live tracked" },
        ]).map((s, i) => (
          <div key={i} className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{s.label}</p>
            <p className="mt-1.5 text-sm font-bold text-white">{s.value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Today · Attendance</p>
        <div className="mt-2 space-y-1.5">
          {[
            ["BR-0001 · Gulshan", "942 / 1,010 present"],
            ["BR-0003 · Uttara", "288 / 305 present"],
            ["BR-0007 · Chattogram", "18 flagged for review"],
          ].map(([site, val]) => (
            <div key={site} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="text-[10px] font-medium text-slate-300">{site}</span>
              <span className="ml-auto text-[10px] text-slate-400">{val}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Headcount</p>
          <div className="mt-2 flex h-16 items-end gap-1.5">
            {[35, 45, 40, 55, 62, 58, 72, 80, 76, 90, 86, 100].map((h, i) => (
              <span key={i} className="mock-bar w-full rounded-sm bg-gradient-to-t from-blue-600/70 to-indigo-400/80" style={{ height: `${h}%`, animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Activity</p>
          <div className="mt-2 space-y-1.5">
            {["Leave approved · N. Akter", "Payroll run ready", "Device A8C2… sync ok"].map((t) => (
              <div key={t} className="flex items-center gap-1.5 rounded-md bg-white/[0.03] px-2 py-1.5">
                <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400" />
                <span className="text-[10px] leading-snug text-slate-300">{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
