// ============ /careers — public job board for published openings ============
// Lists every JobOpening the tenants of the platform have explicitly published
// (status OPEN + isPublic + deadline not passed). The filter is enforced in
// the SERVER query — closed, non-public and past-deadline openings are never
// sent to the browser (client-side filtering alone would leak them).
//
// Visibility: the page is wired to the CMS page manager — the owner console's
// "careers" system page record (status/visible) is the hide toggle. Blocks on
// that record are intentionally NOT rendered here: the listing is dynamic
// tenant-published data, not static CMS content.
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowRight, Briefcase, Building2, CalendarClock } from "lucide-react"
import { db } from "@/lib/db"
import { getCmsPage, getSiteSettings } from "@/hrm-server/saas/cms"
import { Grad, SectionHeading } from "@/saas/web/sections"
import { CareersBoard, type PublicOpening } from "./careers-board"

export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const page = await getCmsPage("careers").catch(() => null)
  return {
    title: page?.seoTitle || "Careers",
    description:
      page?.seoDesc ||
      "Open positions at organizations running on Finix HR — apply online with your CV; every application reaches the hiring team directly.",
    alternates: { canonical: "/careers" },
    robots: { index: true, follow: true },
  }
}

/** Hard row cap — the page is a live listing, not an archive. */
const MAX_OPENINGS = 100

async function loadOpenings(): Promise<PublicOpening[]> {
  try {
    // deadline strings are normalized to YYYY-MM-DD on save (see
    // routes/recruitment.ts), so a lexical gte is chronologically correct.
    const today = new Date().toISOString().slice(0, 10)
    const rows = await db.jobOpening.findMany({
      where: {
        status: "OPEN",
        isPublic: true,
        OR: [{ deadline: null }, { deadline: { gte: today } }],
      },
      orderBy: [{ createdAt: "desc" }],
      take: MAX_OPENINGS,
      select: {
        id: true, title: true, description: true, requirements: true,
        employmentType: true, openings: true, salaryRange: true, deadline: true,
        departmentId: true, branchId: true, vendorId: true,
      },
    })
    if (rows.length === 0) return []
    // label joins — the ids come from published openings only, so the joins
    // surface exactly what each tenant chose to make public
    const vendorIds = [...new Set(rows.map((r) => r.vendorId))]
    const branchIds = [...new Set(rows.map((r) => r.branchId).filter((x): x is string => !!x))]
    const deptIds = [...new Set(rows.map((r) => r.departmentId).filter((x): x is string => !!x))]
    const [vendors, branches, departments] = await Promise.all([
      db.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true } }),
      branchIds.length ? db.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [],
      deptIds.length ? db.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : [],
    ])
    const vendorById = new Map(vendors.map((v) => [v.id, v.name]))
    const branchById = new Map(branches.map((b) => [b.id, b.name]))
    const deptById = new Map(departments.map((d) => [d.id, d.name]))
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      companyName: vendorById.get(r.vendorId) || "Confidential organization",
      branchName: r.branchId ? branchById.get(r.branchId) || null : null,
      departmentName: r.departmentId ? deptById.get(r.departmentId) || null : null,
      employmentType: r.employmentType,
      openings: r.openings,
      salaryRange: r.salaryRange,
      deadline: r.deadline,
      description: r.description,
      requirements: r.requirements,
    }))
  } catch {
    return [] // DB hiccup → the empty board renders, never a crash
  }
}

export default async function CareersPage() {
  // hide toggle: the owner console's careers page record (unpublish / hide → 404)
  const careersPage = await getCmsPage("careers").catch(() => null)
  if (!careersPage) notFound()

  const [{ identity }, openings] = await Promise.all([getSiteSettings(), loadOpenings()])
  const companies = new Set(openings.map((o) => o.companyName)).size

  return (
    <>
      {/* ---- hero ---- */}
      <section className="relative overflow-hidden bg-slate-950 light:bg-white">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-[-180px] h-[380px] w-[720px] -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[120px] light:opacity-50" />
        </div>
        <div className="relative mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 sm:py-20">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300 light:text-indigo-600">Careers</p>
          <h1 className="mt-4 text-4xl font-bold tracking-tight text-white text-balance light:text-slate-900 sm:text-5xl">
            Open roles at organizations on <Grad>{identity.siteName}</Grad>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-400 light:text-slate-600">
            Every position below was published directly by the organization&apos;s own HR team — apply online with your CV
            and your application lands straight in their recruitment pipeline.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-slate-400 light:text-slate-600">
            <span className="inline-flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-indigo-300 light:text-indigo-600" aria-hidden />
              <strong className="text-white light:text-slate-900 tabular-nums">{openings.length}</strong> open position{openings.length === 1 ? "" : "s"}
            </span>
            <span className="inline-flex items-center gap-2">
              <Building2 className="h-4 w-4 text-indigo-300 light:text-indigo-600" aria-hidden />
              <strong className="text-white light:text-slate-900 tabular-nums">{companies}</strong> hiring organization{companies === 1 ? "" : "s"}
            </span>
            <span className="inline-flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-indigo-300 light:text-indigo-600" aria-hidden />
              Updated live
            </span>
          </div>
        </div>
      </section>

      {/* ---- openings board ---- */}
      <section className="bg-slate-950 light:bg-white">
        <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6">
          <CareersBoard openings={openings} />
        </div>
      </section>

      {/* ---- employer band ---- */}
      <section className="border-t border-white/10 bg-slate-950 light:border-slate-200 light:bg-slate-50">
        <div className="mx-auto max-w-4xl px-4 py-14 text-center sm:px-6">
          <SectionHeading
            eyebrow="Hiring?"
            title={<>Publish your openings <Grad>here</Grad></>}
            sub={`${identity.siteName} tenants post jobs from the Recruitment module in seconds — openings go live on this page, applications arrive in the pipeline with CVs attached.`}
          />
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/register" className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-indigo-950/60 hover:from-blue-500 hover:to-violet-500">
              Register your organization <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/features/recruitment-pipeline" className="inline-flex h-11 items-center rounded-xl border border-white/15 px-6 text-sm font-semibold text-white hover:bg-white/5 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100">
              See how recruitment works
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
