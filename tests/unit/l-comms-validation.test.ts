/// <reference types="bun-types" />
// ============ Comms + validation Low findings: L-26, L-27 ============
// L-26 — announcement in-app fan-out was silently capped at 200 while the
//        response reported targets.length (the cut was invisible). Now: cap
//        2000 via a pure planner + the response reports delivered/truncated.
// L-27 — photoUrl accepted arbitrary text; an editor could point employee
//        photos at http:// or javascript: URLs (viewer-IP leak / XSS vector).
//        Now: image data-URL or https:// only.
// Route-layer: drives announcements.create + employees.save through the REAL
// dispatcher.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkEmployee, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { planAnnouncementFanout, ANNOUNCEMENT_FANOUT_CAP } from "@/hrm-server/routes/communication"

let vendor: { id: string }
let adminToken: string

beforeAll(async () => {
  vendor = await mkVendor("L26 Comms Vendor")
  const admin = await mkUser(vendor.id, { role: "VENDOR_OWNER", name: "L26 Admin" })
  adminToken = await mkSession(admin.id, "FULL")
})

describe("L-26 — announcement fan-out is honest about the cap", () => {
  test("planner unit: 2050 targets → 2000 delivered + 50 truncated (old code hid the cut)", () => {
    const targets = Array.from({ length: ANNOUNCEMENT_FANOUT_CAP + 50 }, (_, i) => `emp-${i}`)
    const { delivered, truncated } = planAnnouncementFanout(targets)
    expect(delivered).toHaveLength(ANNOUNCEMENT_FANOUT_CAP)
    expect(truncated).toBe(50)
  })

  test("planner unit: a small audience is never truncated", () => {
    const { delivered, truncated } = planAnnouncementFanout(["a", "b", "c"])
    expect(delivered).toEqual(["a", "b", "c"])
    expect(truncated).toBe(0)
  })

  test("route: notified equals the delivered audience, truncated reported", async () => {
    // small audience — 3 employees in this vendor
    for (let i = 0; i < 3; i++) await mkEmployee(vendor.id, { fullName: `L26 Emp ${i}` })
    const r = await postHrm("announcements.create", {
      title: "L-26 regression", body: "fan-out honesty", audienceType: "ALL",
    }, { bearer: adminToken })
    expect(r.status).toBe(200)
    expect(Number(r.body?.data?.notified)).toBe(3)
    expect(Number(r.body?.data?.truncated)).toBe(0)
    const rows = await db.notification.count({ where: { vendorId: vendor.id, title: "HR Announcement: L-26 regression" } })
    expect(rows).toBe(3) // notified === rows actually written
  })
})

describe("L-27 — photoUrl must be an image data-URL or an https:// URL", () => {
  let employeeId: string
  beforeAll(async () => {
    const emp = await mkEmployee(vendor.id, { fullName: "L27 Photo Emp" })
    employeeId = emp.id
  })

  async function saveWithPhoto(photoUrl: string) {
    return postHrm("employees.update", { id: employeeId, fullName: "L27 Photo Emp", photoUrl }, { bearer: adminToken })
  }

  async function updatePhotoRoute(photoUrl: string) {
    return postHrm("employees.updatePhoto", { id: employeeId, photoUrl }, { bearer: adminToken })
  }

  test("http:// URL → 400 (insecure origin, viewer-IP leak)", async () => {
    const r = await saveWithPhoto("http://evil.example.com/pixel.png")
    expect(r.status).toBe(400)
    expect(String(r.body?.error || "")).toContain("photoUrl")
  })

  test("javascript: URL → 400 (XSS vector)", async () => {
    const r = await saveWithPhoto("javascript:alert(1)")
    expect(r.status).toBe(400)
    expect(String(r.body?.error || "")).toContain("photoUrl")
  })

  test("arbitrary text → 400", async () => {
    const r = await saveWithPhoto("just some text")
    expect(r.status).toBe(400)
  })

  test("valid image data-URL passes validation", async () => {
    const r = await saveWithPhoto("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")
    expect(r.status).toBe(200)
  })

  test("the dedicated updatePhoto route enforces the same rule (no bypass)", async () => {
    const bad = await updatePhotoRoute("http://evil.example.com/pixel.png")
    expect(bad.status).toBe(400)
    expect(String(bad.body?.error || "")).toContain("photoUrl")
    const good = await updatePhotoRoute("data:image/jpeg;base64,/9j/4AAQSkZJRg==")
    expect(good.status).toBe(200)
  })
})
