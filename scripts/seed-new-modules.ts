// ============ Seed — new modules demo data (idempotent) ============
// Adds to an EXISTING database (post schema push):
//   1. GOODS_REQUISITION + PURCHASE approval workflows (both real vendors)
//   2. Inventory demo: warehouses, suppliers, catalogue items
//   3. AIT FY 2025-26 bootstrap configuration (Finance Ordinance 2025)
// Run: bunx tsx scripts/seed-new-modules.ts   (or: bun run scripts/seed-new-modules.ts)
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

const log = (...a: unknown[]) => console.log("•", ...a)

async function main() {
  const vendors = await db.vendor.findMany({ where: { code: { in: ["FINIX", "RONGIN"] } } })
  const finix = vendors.find((v) => v.code === "FINIX")
  const rongin = vendors.find((v) => v.code === "RONGIN")
  if (!finix) throw new Error("FINIX vendor not found — run the base seed first")

  // ---------- 1. approval workflows for the goods/purchase/overtime/encashment flows ----------
  const wfDefs: { vendor: any; type: string; name: string; steps: { name: string; role: string }[] }[] = [
    {
      vendor: finix, type: "GOODS_REQUISITION", name: "Goods Requisition Approval",
      steps: [
        { name: "Department Head", role: "DEPT_MANAGER" },
        { name: "HR Review", role: "HR_MANAGER" },
        { name: "Final Approval", role: "HR_ADMIN" },
      ],
    },
    {
      vendor: finix, type: "PURCHASE", name: "Purchase Approval",
      steps: [
        { name: "HR Review", role: "HR_MANAGER" },
        { name: "Owner Approval", role: "VENDOR_OWNER" },
      ],
    },
    {
      vendor: finix, type: "OVERTIME", name: "Overtime Approval",
      steps: [
        { name: "Manager Review", role: "BRANCH_MANAGER" },
        { name: "HR Review", role: "HR_MANAGER" },
      ],
    },
    {
      vendor: finix, type: "ENCASHMENT", name: "Leave Encashment Approval",
      steps: [
        { name: "Manager Review", role: "BRANCH_MANAGER" },
        { name: "Finance Approval", role: "PAYROLL_OFFICER" },
      ],
    },
    ...(rongin ? [
      {
        vendor: rongin, type: "GOODS_REQUISITION", name: "Goods Requisition workflow",
        steps: [{ name: "Owner Approval", role: "VENDOR_OWNER" }],
      },
      {
        vendor: rongin, type: "PURCHASE", name: "Purchase workflow",
        steps: [{ name: "Owner Approval", role: "VENDOR_OWNER" }],
      },
      {
        vendor: rongin, type: "OVERTIME", name: "Overtime workflow",
        steps: [{ name: "Owner Approval", role: "VENDOR_OWNER" }],
      },
      {
        vendor: rongin, type: "ENCASHMENT", name: "Encashment workflow",
        steps: [{ name: "Owner Approval", role: "VENDOR_OWNER" }],
      },
    ] : []),
  ]
  for (const def of wfDefs) {
    const exists = await db.approvalWorkflow.findFirst({ where: { vendorId: def.vendor.id, processType: def.type } })
    if (exists) { log(`workflow ${def.type} already present for ${def.vendor.code}`); continue }
    const wf = await db.approvalWorkflow.create({
      data: { vendorId: def.vendor.id, name: def.name, processType: def.type, active: true },
    })
    for (const [i, s] of def.steps.entries()) {
      await db.approvalStep.create({
        data: { vendorId: wf.vendorId, workflowId: wf.id, sequence: i + 1, name: s.name, approverRole: s.role, required: true },
      })
    }
    log(`workflow ${def.type} created for ${def.vendor.code} (${def.steps.length} steps)`)
  }

  // ---------- 2. inventory demo ----------
  const whNames = ["Head Office Store", "Dhanmondi Store Room", "Uttara Store Room"]
  for (const [i, name] of whNames.entries()) {
    const exists = await db.warehouse.findFirst({ where: { vendorId: finix.id, name } })
    if (exists) continue
    const branch = await db.branch.findFirst({ where: { vendorId: finix.id }, orderBy: { name: "asc" }, skip: i })
    await db.warehouse.create({
      data: { vendorId: finix.id, name, branchId: branch?.id || null, address: branch?.address || null, active: true },
    })
    log(`warehouse "${name}" created`)
  }
  const warehouses = await db.warehouse.findMany({ where: { vendorId: finix.id } })
  const main = warehouses[0]

  const suppliers = [
    { name: "Smart Tech BD", contactPerson: "Rafiq Islam", mobile: "01711-223344", email: "sales@smarttechbd.com", address: "BDBL Bhaban, Kawran Bazar, Dhaka", tin: "123456789012" },
    { name: "Office Furnish Ltd.", contactPerson: "Shahana Begum", mobile: "01822-334455", email: "info@officefurnish.com", address: "Mirpur 10, Dhaka", tin: "234567890123" },
    { name: "Stationery World", contactPerson: "Kamal Uddin", mobile: "01933-445566", email: "order@stationeryworld.com.bd", address: "Nawabpur Road, Dhaka", tin: "345678901234" },
  ]
  for (const s of suppliers) {
    const exists = await db.supplier.findFirst({ where: { vendorId: finix.id, name: s.name } })
    if (exists) continue
    await db.supplier.create({ data: { vendorId: finix.id, ...s, active: true } })
    log(`supplier "${s.name}" created`)
  }

  const items = [
    { code: "ITM-0001", name: "Wireless Mouse", category: "IT", unit: "Pcs", reorderLevel: 10, lastCost: 850 },
    { code: "ITM-0002", name: "Mechanical Keyboard", category: "IT", unit: "Pcs", reorderLevel: 5, lastCost: 2400 },
    { code: "ITM-0003", name: "27\" LED Monitor", category: "IT", unit: "Pcs", reorderLevel: 4, lastCost: 18500 },
    { code: "ITM-0004", name: "Laptop Core i5", category: "IT", unit: "Pcs", reorderLevel: 2, lastCost: 78000 },
    { code: "FUR-0001", name: "Ergonomic Office Chair", category: "FURNITURE", unit: "Pcs", reorderLevel: 3, lastCost: 12500 },
    { code: "FUR-0002", name: "Executive Desk", category: "FURNITURE", unit: "Pcs", reorderLevel: 2, lastCost: 22000 },
    { code: "STA-0001", name: "A4 Paper Ream", category: "STATIONERY", unit: "Ream", reorderLevel: 20, lastCost: 480 },
    { code: "STA-0002", name: "Ballpoint Pen (Box-12)", category: "STATIONERY", unit: "Box", reorderLevel: 15, lastCost: 320 },
    { code: "ELE-0001", name: "LED Tube Light 20W", category: "ELECTRICAL", unit: "Pcs", reorderLevel: 10, lastCost: 390 },
  ]
  const itemIds: Record<string, string> = {}
  for (const it of items) {
    const exists = await db.item.findFirst({ where: { vendorId: finix.id, code: it.code } })
    if (exists) { itemIds[it.code] = exists.id; continue }
    const rec = await db.item.create({
      data: { vendorId: finix.id, ...it, active: true, notes: "Demo catalogue item" },
    })
    itemIds[it.code] = rec.id
    log(`item ${it.code} — ${it.name} created`)
  }

  // opening stock — POSTED stock entry through the same code path the app uses
  const hasEntry = await db.stockEntry.findFirst({ where: { vendorId: finix.id } })
  if (!hasEntry) {
    const openingQty: Record<string, number> = {
      "ITM-0001": 25, "ITM-0002": 10, "ITM-0003": 6, "ITM-0004": 2, "FUR-0001": 8,
      "FUR-0002": 3, "STA-0001": 45, "STA-0002": 30, "ELE-0001": 18,
    }
    const admin = await db.user.findFirst({ where: { vendorId: finix.id, role: "HR_ADMIN" } })
    const entry = await db.stockEntry.create({
      data: {
        vendorId: finix.id, code: `SE-${new Date().getFullYear()}-00001`,
        warehouseId: main.id, supplierId: null, invoiceNo: "OPENING",
        entryDate: new Date().toISOString().slice(0, 10),
        remarks: "Opening stock (seed)", status: "POSTED",
        postedAt: new Date(), byUserId: admin?.id || null, byUserName: admin?.name || "Seed",
        items: {
          create: Object.entries(openingQty).map(([code, qty]) => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
            const it = items.find((x) => x.code === code)!
            return { vendorId: finix.id, itemId: itemIds[code], itemName: it.name, quantity: qty, unitCost: it.lastCost, remarks: null }
          }),
        },
      },
    })
    for (const [code, qty] of Object.entries(openingQty)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- audited TODO(H-20 paydown): convert to an explicit null check
      const it = items.find((x) => x.code === code)!
      await db.stockLevel.create({
        data: { vendorId: finix.id, itemId: itemIds[code], warehouseId: main.id, quantity: qty, reserved: 0 },
      })
      await db.stockTransaction.create({
        data: {
          vendorId: finix.id, itemId: itemIds[code], warehouseId: main.id,
          kind: "ENTRY", quantity: qty, balanceAfter: qty, unitCost: it.lastCost,
          refType: "STOCK_ENTRY", refId: entry.id, note: "Opening stock (seed)",
          byUserId: admin?.id || null, byUserName: admin?.name || "Seed",
        },
      })
    }
    // keep the code sequence counter ahead of the manually-created entry
    await db.sequenceCounter.upsert({
      where: { key: `${finix.id}:stock-entry` },
      create: { key: `${finix.id}:stock-entry`, value: 1 },
      update: { value: { increment: 1 } },
    })
    log(`opening stock entry ${entry.code} posted (9 items, warehouse "${main.name}")`)
  } else {
    log("stock entries already exist — opening stock skipped")
  }

  // ---------- 3. AIT FY 2025-26 bootstrap ----------
  const hasAit = await db.aitFiscalYear.findFirst({ where: { vendorId: finix.id } })
  if (!hasAit) {
    const { defaultFy2026Config } = await import("../src/hrm-server/ait-engine")
    const def = defaultFy2026Config(finix.id)
    const fy = await db.aitFiscalYear.create({
      data: {
        vendorId: finix.id, label: def.label, incomeYear: def.incomeYear, assessmentYear: def.assessmentYear,
        tdsSectionRef: def.tdsSectionRef, exemptionFraction: def.exemptionFraction, exemptionCap: def.exemptionCap,
        minimumTax: def.minimumTax, rebateRatePercent: def.rebateRatePercent, rebateCapFraction: def.rebateCapFraction,
        rebateCapAmount: def.rebateCapAmount, festivalBonusCount: def.festivalBonusCount, active: true, notes: def.notes,
      },
    })
    await db.aitTaxpayerCategory.createMany({ data: def.categories.map((c: any) => ({ ...c, vendorId: finix.id, fiscalYearId: fy.id })) })
    await db.aitTaxSlab.createMany({ data: def.slabs.map((s: any) => ({ ...s, vendorId: finix.id, fiscalYearId: fy.id })) })
    log(`AIT ${def.label} configuration bootstrapped (5 categories, 5 slabs)`)
  } else {
    log("AIT configuration already present")
  }

  log("done.")
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
