// ============ ADMS gateway reachability test (no auth, no DB) ============
// GET /iclock/ping → 200 "PONG <iso-timestamp>"
//
// Purpose: when a physical ZKTeco device cannot connect, the fastest way to
// isolate the problem is to open this URL in a browser ON THE SAME NETWORK
// as the device:
//
//   http://<server-ip>:3000/iclock/ping
//
// If you see "PONG ..." → the gateway is reachable from the device's network.
//   → the issue is SN mismatch or device-side config (no key is involved).
// If the browser times out → the issue is firewall, IP binding, or routing.
//
// Audit Low fix: the response no longer discloses the server's interface
// addresses or hostname to anonymous callers — a plain liveness probe needs
// neither. Detailed network info is available to authenticated admins.
import { NextRequest } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_req: NextRequest) {
  const body = [
    "PONG",
    `timestamp=${new Date().toISOString()}`,
    `port=3000`,
    `protocol=ZKTeco Push SDK / ADMS`,
    `endpoints=/iclock/cdata, /iclock/getrequest, /iclock/devicecmd, /iclock/deviceparams, /iclock/cdatapic`,
    "",
  ].join("\n")
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}
