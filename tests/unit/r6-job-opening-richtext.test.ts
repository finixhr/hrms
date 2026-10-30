/// <reference types="bun-types" />
// ============ R6 regression: rich-text job openings + sanitization ============
// The New/Edit Job Opening dialogs now author description/requirements in a
// rich-text editor (formatting, lists, links). Defense in depth:
//   - the CLIENT sanitizes before sending (shared whitelist);
//   - routes/recruitment.ts repeats the SAME whitelist server-side — a
//     crafted client cannot persist XSS into the public careers page;
//   - rendering sites (careers board) re-sanitize before innerHTML.
import "./_testdb"
import { describe, test, expect, beforeAll } from "bun:test"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"

let vendor: { id: string }
let admin: { id: string; token: string }

beforeAll(async () => {
  vendor = await mkVendor("R6 Vendor")
  const u = await mkUser(vendor.id, { role: "HR_ADMIN", name: "R6 Admin" })
  admin = { id: u.id, token: await mkSession(u.id, "FULL") }
})

describe("R6 — job opening rich text with server-side sanitization", () => {
  test("safe formatting markup round-trips (lists, bold, links)", async () => {
    const description =
      "<h3>About the role</h3><p>Own the <strong>payroll</strong> pipeline for <em>450+ employees</em>.</p>" +
      "<ul><li>Monthly payroll runs</li><li>Statutory AIT/TDS</li></ul>" +
      '<p><a href="https://example.com/careers" target="_blank" rel="noopener noreferrer">Learn more</a></p>'
    const res = await postHrm("recruitment.openings.save", {
      title: "R6 Payroll Manager", description, requirements: "<ol><li>5+ years payroll</li><li>BD tax law</li></ol>",
    }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    const rec = await db.jobOpening.findFirst({ where: { vendorId: vendor.id, title: "R6 Payroll Manager" } })
    expect(rec?.description).toContain("<h3>")
    expect(rec?.description).toContain("<strong>payroll</strong>")
    expect(rec?.description).toContain("<ul>")
    expect(rec?.description).toContain('href="https://example.com/careers"')
    expect(rec?.requirements).toContain("<ol>")
  })

  test("XSS payloads are stripped server-side (script, handlers, javascript: URLs)", async () => {
    const payload =
      '<p>ok text</p><script>alert("xss")</script>' +
      '<img src=x onerror="alert(1)">' +
      '<div onclick="alert(2)" style="color:red">styled</div>' +
      '<a href="javascript:alert(3)">bad link</a>' +
      '<iframe src="https://evil.example"></iframe>'
    const res = await postHrm("recruitment.openings.save", {
      title: "R6 Evil Opening", description: payload, requirements: payload,
    }, { bearer: admin.token })
    expect(res.body.ok).toBe(true)
    const rec = await db.jobOpening.findFirst({ where: { vendorId: vendor.id, title: "R6 Evil Opening" } })
    const d = rec?.description || ""
    expect(d).not.toContain("<script")
    expect(d).not.toContain("onerror")
    expect(d).not.toContain("onclick")
    expect(d).not.toContain("javascript:")
    expect(d).not.toContain("<iframe")
    expect(d).not.toContain("<img")
    expect(d).toContain("ok text") // inner text survives; unsafe markup does not
    expect(d).toContain("styled") // div unwrapped, text kept
  })

  test("updates sanitize too, and null/blank clears the field", async () => {
    const created = await postHrm("recruitment.openings.save", { title: "R6 Clear Me", description: "<p>text</p>" }, { bearer: admin.token })
    const id = created.body.data.id
    const upd = await postHrm("recruitment.openings.save", { id, description: "<p>new <u>text</u></p><script>bad()</script>" }, { bearer: admin.token })
    expect(upd.body.ok).toBe(true)
    const rec = await db.jobOpening.findUnique({ where: { id } })
    expect(rec?.description).toContain("<u>text</u>")
    expect(rec?.description).not.toContain("script")
    const cleared = await postHrm("recruitment.openings.save", { id, description: "   " }, { bearer: admin.token })
    expect(cleared.body.ok).toBe(true)
    const rec2 = await db.jobOpening.findUnique({ where: { id } })
    expect(rec2?.description).toBeNull()
  })
})
