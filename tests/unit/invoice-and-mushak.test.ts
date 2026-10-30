import "./_testdb"
import { describe, expect, it } from "bun:test"
import { DEFAULT_SAAS_SETTINGS, SETTINGS_WHITELIST, calculateVatBreakdown, saveSaasSettingsGroup } from "@/hrm-server/saas/settings"
import { createTermInvoice } from "@/hrm-server/saas/payments/billing-ops"
import { renderInvoicePdf } from "@/hrm-server/saas/payments/invoice-pdf"
import { db } from "@/lib/db"
import { mkVendor, mkUser, mkSession, uniq } from "./_fixtures"
import { postHrm } from "./_hrm-endpoint"
import { PDFDocument } from "pdf-lib"

describe("Invoice Template, VAT & Mushak-6.3 Configuration", () => {
  it("SaaS settings billing group includes default VAT % and tax/banking details", () => {
    expect(DEFAULT_SAAS_SETTINGS.billing.vatRatePercent).toBe(5.0)
    expect(DEFAULT_SAAS_SETTINGS.billing.companyLegalName).toBe("Finix HR Ltd.")
    expect(DEFAULT_SAAS_SETTINGS.billing.companyBin).toBe("009377515-0111")
    expect(DEFAULT_SAAS_SETTINGS.billing.signatoryName).toBe("MD JAKARIA")
    expect(DEFAULT_SAAS_SETTINGS.billing.bkashMerchantNumber).toBe("01943223366")
    expect(DEFAULT_SAAS_SETTINGS.billing.primaryBankName).toBe("The City Bank Ltd.")
    expect(DEFAULT_SAAS_SETTINGS.billing.secondaryBankName).toBe("BRAC Bank PLC")

    // Whitelist check
    expect(SETTINGS_WHITELIST.billing.vatRatePercent).toBe("number")
    expect(SETTINGS_WHITELIST.billing.companyLegalName).toBe("string")
    expect(SETTINGS_WHITELIST.billing.companyBin).toBe("string")
    expect(SETTINGS_WHITELIST.billing.bkashMerchantNumber).toBe("string")
  })

  it("calculates Bangladesh service VAT inclusive arithmetic correctly", () => {
    const total = 1000
    const vatRate = 5.0
    const net = Math.round((total / (1 + vatRate / 100)) * 100) / 100
    const vat = Math.round((total - net) * 100) / 100

    expect(net).toBe(952.38)
    expect(vat).toBe(47.62)
    expect(net + vat).toBe(1000.0)

    const calc5 = calculateVatBreakdown(1000, 5)
    expect(calc5.netAmount).toBe(952.38)
    expect(calc5.vatAmount).toBe(47.62)
    expect(calc5.vatRatePercent).toBe(5)

    const calc15 = calculateVatBreakdown(1000, 15)
    expect(calc15.netAmount).toBe(869.57)
    expect(calc15.vatAmount).toBe(130.43)
    expect(calc15.vatRatePercent).toBe(15)

    const calc0 = calculateVatBreakdown(1000, 0)
    expect(calc0.netAmount).toBe(1000)
    expect(calc0.vatAmount).toBe(0)
  })

  it("historical invoice retains snapshotted VAT rate and amounts when owner updates platform VAT %", async () => {
    const ven = await mkVendor("VAT Snapshot Test Vendor")
    const u = await mkUser(ven.id, { role: "HR_ADMIN", name: "VAT Admin" })
    const token = await mkSession(u.id, "FULL")

    // 1. Ensure platform VAT starts at 5%
    await saveSaasSettingsGroup("billing", { vatRatePercent: 5.0 })

    // 2. Create invoice under 5% VAT rate
    const inv1Res = await createTermInvoice({
      vendorId: ven.id,
      subscriptionId: null,
      amount: 1000,
      currency: "BDT",
      periodStart: new Date("2025-01-01T00:00:00Z"),
      periodEnd: new Date("2025-02-01T00:00:00Z"),
      actor: { id: u.id, name: "Test Actor" },
    })

    // Verify stored snapshot in DB
    const inv1Db = await db.saasInvoice.findUnique({ where: { id: inv1Res.id } })
    expect(Number(inv1Db?.vatRatePercent)).toBe(5)
    expect(Number(inv1Db?.netAmount)).toBe(952.38)
    expect(Number(inv1Db?.vatAmount)).toBe(47.62)

    // 3. Platform Owner updates VAT rate from 5% to 15% (e.g. new fiscal year policy)
    await saveSaasSettingsGroup("billing", { vatRatePercent: 15.0 })

    // 4. Query the historical invoice through billing.invoice.get
    const getRes1 = await postHrm("billing.invoice.get", { id: inv1Res.id }, { bearer: token })
    expect(getRes1.body.ok).toBe(true)
    const oldInv = getRes1.body.data.invoice
    // Crucial check: Historical invoice VAT rate and amounts must NOT mutate!
    expect(oldInv.vatRatePercent).toBe(5)
    expect(oldInv.netAmount).toBe(952.38)
    expect(oldInv.vatAmount).toBe(47.62)

    // 5. Query billing.invoices list
    const listRes = await postHrm("billing.invoices", {}, { bearer: token })
    expect(listRes.body.ok).toBe(true)
    const row1 = listRes.body.data.rows.find((r: any) => r.id === inv1Res.id)
    expect(row1?.vatRatePercent).toBe(5)
    expect(row1?.netAmount).toBe(952.38)
    expect(row1?.vatAmount).toBe(47.62)

    // 6. Create a new invoice under the new 15% rate
    const inv2Res = await createTermInvoice({
      vendorId: ven.id,
      subscriptionId: null,
      amount: 1000,
      currency: "BDT",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-02-01T00:00:00Z"),
      actor: { id: u.id, name: "Test Actor" },
    })
    const getRes2 = await postHrm("billing.invoice.get", { id: inv2Res.id }, { bearer: token })
    expect(getRes2.body.ok).toBe(true)
    const newInv = getRes2.body.data.invoice
    // New invoice uses the current 15% rate
    expect(newInv.vatRatePercent).toBe(15)
    expect(newInv.netAmount).toBe(869.57)
    expect(newInv.vatAmount).toBe(130.43)

    // 7. Re-verify that old invoice still retains 5%
    const getRes1Again = await postHrm("billing.invoice.get", { id: inv1Res.id }, { bearer: token })
    expect(getRes1Again.body.data.invoice.vatRatePercent).toBe(5)
    expect(getRes1Again.body.data.invoice.netAmount).toBe(952.38)
    expect(getRes1Again.body.data.invoice.vatAmount).toBe(47.62)

    // Clean up settings back to default 5%
    await saveSaasSettingsGroup("billing", { vatRatePercent: 5.0 })
  })


  it("renders a 1-page invoice PDF with valid PDF document structure", async () => {
    const pdfBytes = await renderInvoicePdf({
      platformName: "Finix HR",
      invoiceNumber: "INV-2026-000002",
      issuedAt: new Date("2026-10-26T00:00:00Z"),
      dueAt: new Date("2026-11-02T00:00:00Z"),
      status: "PENDING",
      companyLegalName: "Finix HR Ltd.",
      companyBin: "009377515-0111",
      companyAddress: "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
      companyPhone: "+8809643666888",
      companyEmail: "service@finixhr.com",
      companyWebsite: "finixhr.com",
      customerName: "TradeCap Stock Brokerage Limited",
      customerAddress: "Noorani Tower (Level-13), Mohakhali C/A, Dhaka, Bangladesh",
      customerPhone: "+8801777694051",
      customerEmail: "tradecap196@gmail.com",
      planName: "Cloud Mastery - Bangladesh",
      billingCycle: "MONTHLY",
      periodStart: new Date("2026-10-26T00:00:00Z"),
      periodEnd: new Date("2026-11-26T00:00:00Z"),
      amount: 1000.0,
      currency: "BDT",
      vatRatePercent: 5.0,
      transactions: [],
      primaryBank: {
        bankName: "The City Bank Ltd.",
        accountNo: "1233394761001",
        payeeName: "Finix HR Ltd.",
        branch: "Shyamoli",
        routing: "225264300",
      },
      secondaryBank: {
        bankName: "BRAC Bank PLC",
        accountNo: "2081769340001",
        payeeName: "Finix HR Ltd.",
        branch: "Satmasjid Road Branch",
        routing: "060276074",
      },
      mfs: {
        providerName: "bKash / Bangla QR",
        merchantNumber: "01943223366",
        instructions: "Scan QR with bKash app or enter Merchant number.",
      },
      bkash: {
        merchantNumber: "01943223366",
      },
    })

    expect(pdfBytes).toBeDefined()
    expect(pdfBytes.length).toBeGreaterThan(1000)

    // PDF magic bytes check (%PDF-)
    const header = Buffer.from(pdfBytes.slice(0, 5)).toString("utf-8")
    expect(header).toBe("%PDF-")

    // Parse with PDFDocument to verify page count is strictly 1
    const doc = await PDFDocument.load(pdfBytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it("renders a 1-page invoice PDF for PAID invoices showing transactions", async () => {
    const pdfBytes = await renderInvoicePdf({
      platformName: "Finix HR",
      invoiceNumber: "INV-2026-000002",
      issuedAt: new Date("2026-10-26T00:00:00Z"),
      dueAt: new Date("2026-11-02T00:00:00Z"),
      status: "PAID",
      companyLegalName: "Finix HR Ltd.",
      companyBin: "009377515-0111",
      companyAddress: "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
      companyPhone: "+8809643666888",
      companyEmail: "service@finixhr.com",
      companyWebsite: "finixhr.com",
      customerName: "TradeCap Stock Brokerage Limited",
      planName: "Cloud Mastery - Bangladesh",
      billingCycle: "MONTHLY",
      periodStart: new Date("2026-10-26T00:00:00Z"),
      periodEnd: new Date("2026-11-26T00:00:00Z"),
      amount: 1000.0,
      currency: "BDT",
      vatRatePercent: 5.0,
      transactions: [
        {
          date: new Date("2026-10-26T11:01:22Z"),
          gateway: "SSLCommerz",
          transactionId: "261026110122wzg9r47sqkN6R3k",
          amount: 1000.0,
        },
      ],
      primaryBank: {
        bankName: "The City Bank Ltd.",
        accountNo: "1233394761001",
        payeeName: "Finix HR Ltd.",
        branch: "Shyamoli",
        routing: "225264300",
      },
      secondaryBank: {
        bankName: "BRAC Bank PLC",
        accountNo: "2081769340001",
        payeeName: "Finix HR Ltd.",
        branch: "Satmasjid Road Branch",
        routing: "060276074",
      },
      mfs: {
        providerName: "Nagad",
        merchantNumber: "01700000000",
      },
      bkash: {
        merchantNumber: "01943223366",
      },
    })

    const doc = await PDFDocument.load(pdfBytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it("saves General platform branding and renders customized Money Receipt and Invoice PDFs", async () => {
    const { renderReceiptPdf } = await import("@/hrm-server/saas/payments/receipt-pdf")
    const QRCode = (await import("qrcode")).default

    // Create a 1x1 test image data URL to simulate uploaded logo/seal/signature
    const dummyPngBuffer = await QRCode.toBuffer("finix-brand-test", { width: 40 })
    const dummyPngDataUrl = `data:image/png;base64,${dummyPngBuffer.toString("base64")}`

    // 1. Save general settings through saveSaasSettingsGroup
    const saved = await saveSaasSettingsGroup("general", {
      platformName: "Finix HR Enterprise",
      tagline: "Corporate Workforce Cloud",
      address: "Finix Tower, Level 8, Gulshan-2, Dhaka",
      supportEmail: "billing@finixhr.com",
      supportPhone: "+8809612345678",
      websiteUrl: "https://enterprise.finixhr.com",
      signatoryName: "MD JAKARIA HOSSAIN",
      signatoryDesignation: "Director of Corporate Finance",
      logoUrl: dummyPngDataUrl,
      sealUrl: dummyPngDataUrl,
      signatureUrl: dummyPngDataUrl,
    })

    expect(saved.general.platformName).toBe("Finix HR Enterprise")
    expect(saved.general.signatoryName).toBe("MD JAKARIA HOSSAIN")
    expect(saved.general.logoUrl).toBe(dummyPngDataUrl)

    // 2. Render Money Receipt PDF with custom assets
    const receiptBytes = await renderReceiptPdf({
      platformName: saved.general.platformName,
      tagline: saved.general.tagline,
      websiteUrl: saved.general.websiteUrl,
      supportEmail: saved.general.supportEmail,
      companyAddress: saved.general.address,
      contactPhone: saved.general.supportPhone,
      logoUrl: saved.general.logoUrl,
      sealUrl: saved.general.sealUrl,
      signatureUrl: saved.general.signatureUrl,
      signatoryName: saved.general.signatoryName,
      signatoryDesignation: saved.general.signatoryDesignation,
      receiptNumber: "MR-2026-000001",
      invoiceNumber: "INV-2026-000001",
      paidAt: new Date("2026-10-26T12:00:00Z"),
      tenantName: "ABC Trading & Co.",
      tenantCode: "TEN-2026001",
      planName: "Enterprise",
      maxEmployees: 500,
      billingCycle: "MONTHLY",
      periodStart: new Date("2026-10-26T00:00:00Z"),
      periodEnd: new Date("2026-11-26T00:00:00Z"),
      method: "Bank Transfer",
      transactionId: "TXN-20261026-9999",
      paidBy: "Finance Director",
      amount: 25000.0,
      currency: "BDT",
      vatRatePercent: 5.0,
      netAmount: 23809.52,
      vatAmount: 1190.48,
    })

    const receiptDoc = await PDFDocument.load(receiptBytes)
    expect(receiptDoc.getPageCount()).toBe(1)
    expect(receiptBytes.length).toBeGreaterThan(5000)

    // 3. Render Invoice PDF with unified header/footer
    const invoiceBytes = await renderInvoicePdf({
      platformName: saved.general.platformName,
      tagline: saved.general.tagline,
      websiteUrl: saved.general.websiteUrl,
      supportEmail: saved.general.supportEmail,
      logoUrl: saved.general.logoUrl,
      invoiceNumber: "INV-2026-000001",
      issuedAt: new Date("2026-10-26T00:00:00Z"),
      dueAt: new Date("2026-11-02T00:00:00Z"),
      status: "PAID",
      companyLegalName: "Finix HR Ltd.",
      companyBin: "009377515-0111",
      companyAddress: saved.general.address,
      companyPhone: saved.general.supportPhone,
      companyEmail: saved.general.supportEmail,
      companyWebsite: saved.general.websiteUrl,
      customerName: "ABC Trading & Co.",
      planName: "Enterprise",
      billingCycle: "MONTHLY",
      periodStart: new Date("2026-10-26T00:00:00Z"),
      periodEnd: new Date("2026-11-26T00:00:00Z"),
      amount: 25000.0,
      currency: "BDT",
      vatRatePercent: 5.0,
      primaryBank: {
        bankName: "The City Bank Ltd.",
        accountNo: "1233394761001",
        payeeName: "Finix HR Ltd.",
        branch: "Shyamoli",
        routing: "225264300",
      },
      secondaryBank: {
        bankName: "BRAC Bank PLC",
        accountNo: "2081769340001",
        payeeName: "Finix HR Ltd.",
        branch: "Satmasjid Road Branch",
        routing: "060276074",
      },
      bkash: {
        merchantNumber: "01943223366",
      },
    })

    const invoiceDoc = await PDFDocument.load(invoiceBytes)
    expect(invoiceDoc.getPageCount()).toBe(1)
    expect(invoiceBytes.length).toBeGreaterThan(5000)

    // Clean up settings
    await saveSaasSettingsGroup("general", {
      platformName: "Finix HR",
      tagline: "Standalone HRM & Workforce Platform",
      address: "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
      supportEmail: "support@finixhr.com",
      supportPhone: "+8809643666888",
      websiteUrl: "https://hrm.finixmart.com.bd",
      signatoryName: "MD JAKARIA",
      signatoryDesignation: "Executive, Admin & Operations, Finix HR Ltd.",
      logoUrl: "",
      sealUrl: "",
      signatureUrl: "",
    })
  })

  it("renders a compliant A4 Mushak-6.3 PDF with Bangladesh Govt logo, blue background, and uploaded signature", async () => {
    const { renderMushakPdf } = await import("@/hrm-server/saas/payments/mushak-pdf")
    const QRCode = (await import("qrcode")).default
    const dummySig = `data:image/png;base64,${(await QRCode.toBuffer("sig-test", { width: 60 })).toString("base64")}`
    const dummySeal = `data:image/png;base64,${(await QRCode.toBuffer("seal-test", { width: 60 })).toString("base64")}`

    const mushakPdfBytes = await renderMushakPdf({
      companyLegalName: "FINIX HR LTD.",
      companyBin: "009377515-0111",
      companyAddress: "House 11, Road 6, Sector 16/A, Uttara, Dhaka - 1230",
      customerName: "TradeCap Stock Brokerage Limited",
      customerBin: "—",
      customerAddress: "Noorani Tower (Level-13), Mohakhali C/A, Dhaka, Bangladesh",
      invoiceNumber: "INV-2026-000004",
      issuedAt: new Date("2026-10-26T18:52:00Z"),
      planName: "Starter Plan",
      billingCycle: "MONTHLY",
      periodStart: new Date("2026-10-26T00:00:00Z"),
      periodEnd: new Date("2026-11-26T00:00:00Z"),
      amount: 2500.0,
      currency: "BDT",
      vatRatePercent: 10.0,
      netAmount: 2272.73,
      vatAmount: 227.27,
      signatoryName: "MD RAYHAN SARDER",
      signatoryDesignation: "Executive, Admin & Operations, Finix HR Ltd.",
      signatureUrl: dummySig,
      sealUrl: dummySeal,
    })

    expect(mushakPdfBytes).toBeDefined()
    expect(mushakPdfBytes.length).toBeGreaterThan(10000)

    const doc = await PDFDocument.load(mushakPdfBytes)
    expect(doc.getPageCount()).toBe(1)
    const page = doc.getPage(0)
    expect(Math.round(page.getWidth())).toBe(595)
    expect(Math.round(page.getHeight())).toBe(842)

    // Test billing.mushak.pdf RPC endpoint
    const ven = await mkVendor("Mushak Endpoint Test Vendor")
    const u = await mkUser(ven.id, { role: "HR_ADMIN", name: "Mushak Admin" })
    const token = await mkSession(u.id, "FULL")
    const invRes = await createTermInvoice({
      vendorId: ven.id,
      subscriptionId: null,
      amount: 2500,
      currency: "BDT",
      periodStart: new Date("2026-10-26T00:00:00Z"),
      periodEnd: new Date("2026-11-26T00:00:00Z"),
      actor: { id: u.id, name: "Test Actor" },
    })

    const mushakRpcRes = await postHrm("billing.mushak.pdf", { invoiceId: invRes.id }, { bearer: token })
    expect(mushakRpcRes.body.ok).toBe(true)
    expect(mushakRpcRes.body.data.filename).toMatch(/^Mushak-6\.3-.*\.pdf$/)
    expect(mushakRpcRes.body.data.base64).toBeDefined()
    const rpcPdfBytes = Buffer.from(mushakRpcRes.body.data.base64, "base64")
    const rpcDoc = await PDFDocument.load(rpcPdfBytes)
    expect(rpcDoc.getPageCount()).toBe(1)
  })
})
