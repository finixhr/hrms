// ============ Hikvision ISAPI deviceInfo probe ============
// Hikvision terminals call GET /ISAPI/System/deviceInfo on first connect to
// verify the server is alive. We return a minimal XML device-info envelope
// identifying ourselves as the HRM attendance gateway.
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo>
  <deviceName>HRM-Attendance-Gateway</deviceName>
  <deviceID>hrm-attendance-gw</deviceID>
  <model>ZKTeco-HRM-Adapter</model>
  <serialNumber>HRM-ADMS-001</serialNumber>
  <firmwareVersion>3.1.3</firmwareVersion>
  <firmwareReleasedDate>2024-09-15</firmwareReleasedDate>
</DeviceInfo>`,
    { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } },
  )
}
