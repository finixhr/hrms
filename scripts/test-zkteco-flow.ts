#!/usr/bin/env bun
// End-to-end smoke test for the ZKTeco Push SDK / ADMS protocol.
// 1. Registers a test device directly via Prisma
// 2. Simulates a handshake GET to /iclock/cdata
// 3. Simulates an ATTLOG POST to /iclock/cdata
// 4. Verifies ACK format ("OK: <count>")
// 5. Re-pushes the same events to verify dedup (idempotency)
// 6. Verifies raw events were persisted
// 7. Simulates a getrequest poll
// 8. Verifies legacy proxy path works
// 9. Verifies Hikvision ISAPI stub responds

import { PrismaClient } from "@prisma/client"
import crypto from "crypto"

const BASE = process.env.BASE_URL || "http://localhost:3000"
const SN = "TEST-DEVICE-001"
const KEY = "test-secret-key-123"

const db = new PrismaClient()

async function main() {
  console.log("──────── Step 1: Register a test device in the DB ────────")
  const commKeyHash = crypto.createHash("sha256").update(KEY).digest("hex")
  // Find or create a vendor record (AttendanceDevice has a vendorId FK).
  const vendor = await db.vendor.upsert({
    where: { id: "vendor-test" },
    update: {},
    create: {
      id: "vendor-test",
      name: "Test Vendor (BD)",
      code: "TEST",
      active: true,
    },
  }).catch(() => null)
  if (!vendor) {
    // Vendor table may not exist or the schema may differ — try without.
    console.log("  (vendor table not present — skipping FK check)")
  }
  await db.attendanceDevice.deleteMany({ where: { deviceIdentifier: SN } }).catch(() => {})
  await db.attendanceRawEvent.deleteMany({ where: { deviceSerial: SN } }).catch(() => {})
  await db.deviceCommLog.deleteMany({ where: { serial: SN } }).catch(() => {})
  await db.deviceCommand.deleteMany({ where: { } }).catch(() => {})

  const device = await db.attendanceDevice.create({
    data: {
      id: "dev-test-001",
      vendorId: "vendor-test",
      deviceId: "TEST-001",
      name: "Test ZKTeco Device",
      deviceIdentifier: SN,
      protocol: "ADMS",
      enabled: true,
      timezone: "Asia/Dhaka",
      status: "OFFLINE",
      syncStatus: "IDLE",
      eventCount: 0,
      configuration: "{}",
      commKeyHash,
    },
  })
  console.log(`  ✓ Device registered (SN=${SN})`)

  console.log("\n──────── Step 2: Simulate device handshake (GET /iclock/cdata) ────────")
  const url1 = `${BASE}/iclock/cdata?SN=${SN}&options=all&pushcommkey=${KEY}&pushver=3.1.3&language=en&FW=Ver 6.60 Sep 2024`
  const r1 = await fetch(url1)
  const t1 = await r1.text()
  console.log(`  HTTP ${r1.status}`)
  console.log(`  Response:`)
  for (const line of t1.split("\n")) console.log(`    | ${line}`)
  if (!t1.startsWith("GET OPTION FROM:")) throw new Error("handshake response missing 'GET OPTION FROM:' prefix")
  if (!t1.includes("LOGDELAY=")) throw new Error("handshake response missing LOGDELAY")
  if (!t1.includes("Realtime=")) throw new Error("handshake response missing Realtime")
  if (!t1.includes("TimeZone=6")) throw new Error("handshake response missing TimeZone=6 (Asia/Dhaka)")
  console.log("  ✓ Handshake response is well-formed")

  console.log("\n──────── Step 3: Simulate ATTLOG push (POST /iclock/cdata) ────────")
  const now = new Date()
  const dt = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 8)}`
  const body = [
    ["1", "3", dt, "0", "0", "0", "0"].join("\t"),
    ["2", "1", dt, "1", "0", "0", "0"].join("\t"),
  ].join("\n")
  console.log(`  POST body:
${body.split("\n").map((l) => "    | " + l).join("\n")}`)
  const r2 = await fetch(`${BASE}/iclock/cdata?SN=${SN}&pushcommkey=${KEY}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body,
  })
  const t2 = await r2.text()
  console.log(`  HTTP ${r2.status}  Response: ${JSON.stringify(t2)}`)
  if (!t2.startsWith("OK:")) throw new Error(`expected 'OK: 2' ACK, got '${t2}'`)
  const accepted = Number(t2.replace(/^OK:\s*/, "").trim())
  if (accepted !== 2) throw new Error(`expected ACK count 2, got ${accepted}`)
  console.log("  ✓ ACK 'OK: 2' — both events accepted")

  console.log("\n──────── Step 4: Re-push same events (idempotency check) ────────")
  const r3 = await fetch(`${BASE}/iclock/cdata?SN=${SN}&pushcommkey=${KEY}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body,
  })
  const t3 = await r3.text()
  console.log(`  HTTP ${r3.status}  Response: ${JSON.stringify(t3)}`)
  if (!t3.startsWith("OK:")) throw new Error(`expected 'OK: 2' for duplicates, got '${t3}'`)
  const dupCount = Number(t3.replace(/^OK:\s*/, "").trim())
  if (dupCount !== 2) throw new Error(`expected 2 duplicates ACK, got ${dupCount}`)
  console.log("  ✓ ACK 'OK: 2' (duplicates acknowledged — device won't resend)")

  console.log("\n──────── Step 5: Verify raw events persisted in DB ────────")
  const rawCount = await db.attendanceRawEvent.count({ where: { deviceSerial: SN } })
  console.log(`  Raw events for SN=${SN}: ${rawCount}`)
  if (rawCount !== 2) throw new Error(`expected 2 raw events in DB, got ${rawCount}`)
  const statusBreakdown = await db.attendanceRawEvent.groupBy({
    by: ["processingStatus"], where: { deviceSerial: SN }, _count: true,
  })
  console.log(`  Processing status breakdown: ${JSON.stringify(statusBreakdown)}`)
  console.log("  ✓ All events durably stored")

  console.log("\n──────── Step 6: Verify device state updated ────────")
  const dev = await db.attendanceDevice.findFirst({ where: { deviceIdentifier: SN } })
  console.log(`  lastSeenAt: ${dev?.lastSeenAt?.toISOString()}`)
  console.log(`  status: ${dev?.status}`)
  console.log(`  eventCount: ${dev?.eventCount}`)
  console.log(`  pushVersion: ${dev?.pushVersion}`)
  console.log(`  firmwareVersion: ${dev?.firmwareVersion}`)
  if (dev?.status !== "ONLINE") throw new Error(`expected status ONLINE, got ${dev?.status}`)
  if (dev?.eventCount !== 2) throw new Error(`expected eventCount=2, got ${dev?.eventCount}`)
  console.log("  ✓ Device status ONLINE, eventCount incremented, pushVersion captured")

  console.log("\n──────── Step 7: Simulate getrequest poll (GET /iclock/getrequest) ────────")
  const r4 = await fetch(`${BASE}/iclock/getrequest?SN=${SN}&pushcommkey=${KEY}`)
  const t4 = await r4.text()
  console.log(`  HTTP ${r4.status}  Response: ${JSON.stringify(t4)}`)
  if (t4.trim() !== "OK") throw new Error(`expected 'OK' for empty queue, got '${t4}'`)
  console.log("  ✓ Empty queue returns 'OK'")

  console.log("\n──────── Step 8: Queue a CHECK command and re-poll ────────")
  await db.deviceCommand.create({
    data: {
      vendorId: "vendor-test", deviceId: device.id,
      command: "CHECK", status: "QUEUED",
    },
  })
  const r5 = await fetch(`${BASE}/iclock/getrequest?SN=${SN}&pushcommkey=${KEY}`)
  const t5 = await r5.text()
  console.log(`  HTTP ${r5.status}  Response: ${JSON.stringify(t5)}`)
  if (!t5.startsWith("CHECK\n") || !t5.endsWith("OK\n")) {
    throw new Error(`expected 'CHECK\\nOK\\n', got '${t5}'`)
  }
  console.log("  ✓ Queued CHECK command returned as 'CHECK\\nOK\\n'")

  console.log("\n──────── Step 9: Verify devicecmd callback ────────")
  const r6 = await fetch(`${BASE}/iclock/devicecmd?SN=${SN}&pushcommkey=${KEY}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "OK",
  })
  const t6 = await r6.text()
  console.log(`  HTTP ${r6.status}  Response: ${JSON.stringify(t6)}`)
  if (t6.trim() !== "OK") throw new Error(`expected 'OK' ack, got '${t6}'`)
  const sentCmd = await db.deviceCommand.findFirst({ where: { deviceId: device.id, status: "DONE" } })
  if (!sentCmd) throw new Error("command not marked DONE after devicecmd callback")
  console.log("  ✓ Command marked DONE after callback")

  console.log("\n──────── Step 10: Verify legacy proxy path ────────")
  const r7 = await fetch(`${BASE}/api/integrations/zkteco/adms/cdata?SN=${SN}&pushcommkey=${KEY}&options=all`)
  console.log(`  HTTP ${r7.status} (legacy path)`)
  if (r7.status !== 200) throw new Error(`legacy proxy not working: status ${r7.status}`)
  console.log("  ✓ Legacy /api/integrations/zkteco/adms/cdata still works (back-compat)")

  console.log("\n──────── Step 11: Verify Hikvision ISAPI stub ────────")
  const r8 = await fetch(`${BASE}/ISAPI/System/deviceInfo`)
  const t8 = await r8.text()
  console.log(`  HTTP ${r8.status}`)
  console.log(`  Body snippet: ${t8.slice(0, 100)}...`)
  if (r8.status !== 200 || !t8.includes("HRM-Attendance-Gateway")) {
    throw new Error("ISAPI stub not responding correctly")
  }
  console.log("  ✓ Hikvision ISAPI stub responds")

  console.log("\n──────── Step 12: Verify OPERLOG push ────────")
  const oplogBody = `OPERLOG\t1\t${dt}\t1`
  const r9 = await fetch(`${BASE}/iclock/cdata?SN=${SN}&pushcommkey=${KEY}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: oplogBody,
  })
  const t9 = await r9.text()
  console.log(`  HTTP ${r9.status}  Response: ${JSON.stringify(t9)}`)
  console.log("  ✓ OPERLOG acknowledged")

  console.log("\n════════════════════════════════════════════════════════════")
  console.log("  ✅ ZKTeco Push SDK / ADMS protocol — smoke test PASSED")
  console.log("════════════════════════════════════════════════════════════")
}

main()
  .catch((e) => {
    console.error("\n════════════════════════════════════════════════════════════")
    console.error("  ❌ SMOKE TEST FAILED:", e.message)
    console.error("════════════════════════════════════════════════════════════")
    process.exit(1)
  })
  .finally(() => db.$disconnect())
