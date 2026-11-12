/// <reference types="bun-types" />
// ============ C-07 regression: stored XSS in print documents ============
// The three print builders (procurement stock-issue, AIT TDS certificate,
// ESS my-tax certificate) must escape every interpolation, and
// openPrintWindow must refuse script/event-handler/javascript: markup.
import { describe, test, expect } from "bun:test"
import { esc, openPrintWindow } from "@/hrm/shared/ui-kit"
import { buildStockIssueReportHtml } from "@/hrm/views/procurement"
import { buildTdsCertificateHtml } from "@/hrm/views/ait"
import { buildMyTaxCertHtml } from "@/hrm/views/ess"

const XSS = `<img src=x onerror=alert(1)>`
const ATTR_BREAK = `"><script>alert(1)</script>`
const APOSTROPHE = `O'Brien রহিম's`

function assertEscaped(html: string) {
  // no live tag can be constructed from the payload
  expect(html).not.toMatch(/<img[^>]*onerror/)
  expect(html).not.toMatch(/<script[\s>]/i)
  // the raw payload itself must not appear verbatim
  expect(html).not.toContain(XSS)
  expect(html).not.toContain('"><script')
}

describe("esc() (C-07 shared escaper)", () => {
  test("destroys img-onerror payload", () => {
    expect(esc(XSS)).toBe("&lt;img src=x onerror=alert(1)&gt;")
  })
  test("escapes quotes for attribute contexts", () => {
    const out = esc(ATTR_BREAK)
    expect(out).not.toContain('"')
    expect(out).not.toContain("<")
  })
  test("apostrophe becomes a safe entity and round-trips as text", () => {
    const out = esc(APOSTROPHE)
    expect(out).toBe(`O&#39;Brien রহিম&#39;s`)
    // entity renders back to the original character in a browser
    expect(out.replace(/&#39;/g, "'")).toBe(APOSTROPHE)
    expect(out).toContain("রহিম")
  })
  test("nullish values render empty", () => {
    expect(esc(null)).toBe("")
    expect(esc(undefined)).toBe("")
  })
})

describe("procurement stock-issue print builder (C-07)", () => {
  test("employee/item/requisition names are escaped", () => {
    const html = buildStockIssueReportHtml([
      { date: "2026-01-02T10:00:00Z", requisitionNo: XSS, employeeName: XSS, itemName: ATTR_BREAK, quantity: 3, unit: "pcs", issuedBy: XSS },
    ])
    assertEscaped(html)
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })
  test("apostrophes in Bangla names survive as entities", () => {
    const html = buildStockIssueReportHtml([
      { date: "2026-01-02T10:00:00Z", requisitionNo: "RQ-1", employeeName: APOSTROPHE, itemName: "Safety boot", quantity: 3, unit: "pcs", issuedBy: "HR" },
    ])
    expect(html).toContain("O&#39;Brien রহিম&#39;s")
  })
})

describe("AIT TDS certificate print builder (C-07)", () => {
  const payloadCert = {
    company: { name: XSS, address: ATTR_BREAK, phone: XSS, binVatReg: XSS, tin: XSS, signatoryName: XSS, signatoryDesignation: ATTR_BREAK },
    employee: { name: XSS, code: "EMP-0001", designation: ATTR_BREAK, tin: XSS, mobile: XSS },
    fiscalYear: { label: XSS, assessmentYear: "2026-27", tdsSectionRef: ATTR_BREAK },
    result: { lines: [{ label: XSS, ref: XSS, value: 123 }], slabLines: [{ slabLabel: XSS, rate: 10, amount: 5000, tax: 500 }] },
    tdsThisMonth: 500,
    tdsYtd: 6000,
  }
  test("every stored field is escaped", () => {
    const html = buildTdsCertificateHtml(payloadCert, 8, 2026)
    assertEscaped(html)
  })
  test("apostrophe / Bangla correctness", () => {
    const html = buildTdsCertificateHtml({
      ...payloadCert,
      employee: { name: APOSTROPHE, code: "EMP-2", designation: "বিক্রয় কর্মকর্তা", tin: "123", mobile: "017" },
      company: { name: "ফিনিক্স মার্ট", signatoryName: APOSTROPHE },
    }, 8, 2026)
    expect(html).toContain("O&#39;Brien রহিম&#39;s")
    expect(html).toContain("বিক্রয় কর্মকর্তা")
  })
})

describe("ESS my-tax certificate print builder (C-07)", () => {
  const payloadCert = {
    company: { name: XSS, address: ATTR_BREAK, phone: XSS, tin: XSS, signatoryName: XSS, signatoryDesignation: ATTR_BREAK },
    employee: { name: XSS, code: "EMP-0001", designation: ATTR_BREAK, tin: XSS, mobile: XSS },
    fiscalYear: { label: XSS, assessmentYear: "2026-27", tdsSectionRef: ATTR_BREAK },
    result: { lines: [{ label: XSS, ref: XSS, value: 123 }], slabLines: [{ slabLabel: XSS, rate: 10, amount: 5000, tax: 500 }] },
    disclaimer: { bn: XSS, en: ATTR_BREAK },
    tdsThisMonth: 500,
    tdsYtd: 6000,
    monthsCovered: 6,
  }
  test("every stored field is escaped (incl. admin-editable disclaimer)", () => {
    const html = buildMyTaxCertHtml(payloadCert)
    assertEscaped(html)
    expect(html).not.toContain(XSS)
  })
  test("apostrophe / Bangla correctness", () => {
    const html = buildMyTaxCertHtml({ ...payloadCert, employee: { ...payloadCert.employee, name: APOSTROPHE } })
    expect(html).toContain("O&#39;Brien রহিম&#39;s")
  })
})

describe("openPrintWindow guard (C-07)", () => {
  // jsdom-free: window is undefined in bun test, so the guard runs first and
  // returns null BEFORE touching window.open — exactly what we assert.
  test("rejects markup containing an inline event handler", () => {
    expect(openPrintWindow(`<div onclick="alert(1)">x</div>`)).toBeNull()
    expect(openPrintWindow(`<img src=x onerror=alert(1)>`)).toBeNull()
  })
  test("rejects javascript: URLs", () => {
    expect(openPrintWindow(`<a href="javascript:alert(1)">x</a>`)).toBeNull()
  })
  test("rejects script tags", () => {
    expect(openPrintWindow(`<script>alert(1)</script>`)).toBeNull()
  })
})
