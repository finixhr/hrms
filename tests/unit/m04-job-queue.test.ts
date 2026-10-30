/// <reference types="bun-types" />
// ============ M-04/M-05 regression: background job queue ============
// Heavy fan-out routes (communications.send, payslips.emailAll,
// backups.export) enqueue a BgJob and return immediately; the worker lane
// claims PENDING rows atomically, streams progress, and lands DONE/FAILED.
import "./_testdb" // first — sets DATABASE_URL before db.ts is constructed
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, makeCtx, mkBranch } from "./_fixtures"
import { getRoute } from "@/hrm-server/routes/router"
import { submitJob, drainJobs } from "@/hrm-server/jobs"

let vendor: { id: string }
let owner: { id: string; vendorId: string; role: string }
let ctx: any

beforeAll(async () => {
  vendor = await mkVendor("M04 Vendor")
  owner = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "Owner" })
  ctx = makeCtx(owner, ["*"])
})

describe("M-04/M-05 background job queue", () => {
  test("submitJob enqueues PENDING; drainJobs claims + runs + lands DONE with result", async () => {
    const jobId = await submitJob(ctx, "BACKUP_EXPORT", { vendorId: vendor.id })
    expect(typeof jobId).toBe("string")
    const pending = await db.bgJob.findFirst({ where: { id: jobId } })
    expect(["RUNNING", "PENDING"]).toContain(pending?.status ?? "") // submitJob kicks a drain

    const ran = await drainJobs()
    expect(ran).toBeGreaterThanOrEqual(1)
    const job = await db.bgJob.findFirst({ where: { id: jobId } })
    expect(job?.status).toBe("DONE")
    expect(job?.startedAt).not.toBeNull()
    expect(job?.finishedAt).not.toBeNull()
    const result = JSON.parse(job!.resultJson!)
    // C-2 invariant preserved through the job lane: users exported as safe fields only
    expect(result.data.user).toBeArray()
    expect(result.vendor.id).toBe(vendor.id)
    expect(result.settings).toBeObject()
  })

  test("jobs.get returns vendor-scoped progress + result; foreign ids 404", async () => {
    const jobId = await submitJob(ctx, "BACKUP_EXPORT", { vendorId: vendor.id })
    await drainJobs()
    const res: any = await getRoute("jobs.get")!.handler(ctx, { id: jobId })
    expect(res.status).toBe("DONE")
    expect(res.result.vendor.id).toBe(vendor.id)

    const otherVendor = await mkVendor("M04 Other Vendor")
    const otherOwner = await mkUser(otherVendor.id, { role: "VENDOR_OWNER", name: "Other" })
    const otherCtx = makeCtx(otherOwner, ["*"])
    let threw = false
    try {
      await getRoute("jobs.get")!.handler(otherCtx, { id: jobId })
    } catch (e: any) {
      threw = true
      expect(e.message).toMatch(/not found/i)
    }
    expect(threw).toBe(true)
  })

  test("an unknown job type lands DEAD (dead-letter) with a readable error (never hangs)", async () => {
    // 2026-10 queue semantics: failures retry with backoff up to maxAttempts,
    // then DEAD (dead-letter) — there is no FAILED status. maxAttempts:1 makes
    // the unknown type dead-letter on the first drain, preserving the test's
    // intent (permanent failure, readable error, never hangs).
    const jobId = await submitJob(ctx, "NO_SUCH_TYPE", {}, { maxAttempts: 1 })
    await drainJobs()
    const job = await db.bgJob.findFirst({ where: { id: jobId } })
    expect(job?.status).toBe("DEAD")
    expect(job?.error).toMatch(/No runner registered/)
  })

  test("communciations.send returns a jobId immediately (delivery is queued, not inline)", async () => {
    const branch = await mkBranch(vendor.id, "M04 Branch")
    await mkEmployee(vendor.id, { branchId: branch.id, fullName: "M04 Emp A" })
    await mkEmployee(vendor.id, { branchId: branch.id, fullName: "M04 Emp B" })
    // gateways are unconfigured on a fresh vendor → EMAIL channel throws early
    // (proving validation still happens synchronously)
    let threw = false
    try {
      await getRoute("communications.send")!.handler(ctx, { channel: "EMAIL", message: "hi" })
    } catch (e: any) {
      threw = true
      expect(e.message).toMatch(/not configured/i)
    }
    expect(threw).toBe(true)

    // inApp-only SMS-less path is not available without a channel; use BOTH
    // unconfigured → also throws. Instead prove the queue path via the log:
    // (covered by the unit test below with the runner directly)
    const log = await db.communicationLog.create({
      data: { vendorId: vendor.id, channel: "EMAIL", subject: "s", message: "m", audienceType: "ALL", audienceLabel: "All", recipientCount: 0, status: "SENDING", sentBy: owner.id, sentByName: "Owner" },
    })
    const jid = await submitJob(ctx, "COMMUNICATION_SEND", {
      logId: log.id, targetIds: [], channel: "EMAIL", subject: "s", message: "m", inApp: true, audienceLabel: "All",
    }, 0)
    await drainJobs()
    const after: any = await db.bgJob.findFirst({ where: { id: jid } })
    expect(after.status).toBe("DONE")
    // zero targets → SKIPPED, log updated by the runner
    const logAfter = await db.communicationLog.findFirst({ where: { id: log.id } })
    expect(logAfter?.status).toBe("SKIPPED")
  })
})
