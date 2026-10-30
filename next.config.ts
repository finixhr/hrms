import type { NextConfig } from "next";
import os from "os";

// CHUNK-ERROR FIX (2026-10-12) — resolve the port the dev server ACTUALLY
// listens on. `next dev -p 4055` does NOT set process.env.PORT, so the old
// `process.env.PORT || "3000"` advertised :3000 origins while the server ran
// on :4055 — EVERY allowlisted origin had the wrong port, the Turbopack HMR
// websocket was rejected from every host (localhost included), and the browser
// tab silently kept a STALE CHUNK MANIFEST. After any recompile (file edit,
// dev-server restart, or a cloud-sync client touching files) the old chunk
// URLs 404 → random "Failed to load chunk … (next/dynamic entry, async
// loader)" crashes until a manual refresh. Precedence: -p/--port CLI flag →
// PORT env → the repo's dev-script port → 3000.
function devPort(): string {
  const argv = typeof process !== "undefined" ? process.argv : []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-p" || a === "--port") {
      const v = argv[i + 1]
      if (v && /^\d+$/.test(v)) return v
    } else if (a.startsWith("--port=")) {
      const v = a.slice("--port=".length)
      if (/^\d+$/.test(v)) return v
    }
  }
  const env = process.env.PORT
  if (env && /^\d+$/.test(env)) return env
  return "4055" // package.json dev script
}

// Dev-server origin allowlist. Next 16 blocks the /_next/hmr websocket (and
// therefore stalls hydration on the "Loading…" screen) when the page is
// opened from an origin it does not consider trusted — e.g. an IP literal
// (http://127.0.0.1:3000) or a reverse-proxy/preview domain in front of the
// dev server. Allow the common local hosts plus sandbox/preview domains so
// `next dev` hydrates correctly behind any of them. Dev-only knob: it has
// zero effect on production builds (`next start`).
//
// LAN-ACCESS FIX: when colleagues open the dev server from ANOTHER PC via
// http://<this-machine's-LAN-IP>:3000, that origin is not trusted by default
// and the app freezes on "Loading Finix HR…". The server's
// LAN IP is by definition one of ITS OWN network interfaces, so we auto-allow
// every local IPv4 address (with and without the dev port). Extra hostnames
// (e.g. a LAN hostname or another proxy domain) can be added via the
// HRM_ALLOWED_DEV_ORIGINS env var — comma-separated, e.g.
//   HRM_ALLOWED_DEV_ORIGINS="hrm.local:3000,192.168.0.50"
function devOrigins(): string[] {
  const port = devPort()
  // Cover both the live port and the historic default so switching the dev
  // script port never silently un-trusts every origin again.
  const ports = [...new Set([port, "3000"])]
  const origins = new Set<string>(["*.space-z.ai"])
  for (const p of ports) {
    origins.add(`localhost:${p}`)
    origins.add(`127.0.0.1:${p}`)
  }
  // bare hostnames too — belt and braces for origin-matching semantics
  origins.add("localhost")
  origins.add("127.0.0.1")
  try {
    for (const nics of Object.values(os.networkInterfaces())) {
      for (const nic of nics || []) {
        // IPv4 interface addresses (e.g. 192.168.x.x) — the exact host:port
        // other machines on the LAN use to reach this dev server. `family` is
        // the string "IPv4" on current Node/Bun and the number 4 on older
        // runtimes — accept both.
        const fam = nic.family as string | number;
        if (fam === "IPv4" || fam === 4) {
          origins.add(nic.address);
          for (const p of ports) origins.add(`${nic.address}:${p}`);
        }
      }
    }
  } catch {
    /* interface enumeration failed — the static entries still apply */
  }
  for (const extra of (process.env.HRM_ALLOWED_DEV_ORIGINS || "").split(",")) {
    const v = extra.trim();
    if (v) origins.add(v);
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: devOrigins(),
  // M-18 — quality gates RESTORED: the production build now FAILS on type
  // errors (previously silently ignored). The codebase is clean — the gate
  // costs nothing and defends the pipeline.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  // M-3/E.4 — web-layer hardening: baseline security headers on every response.
  // M-10 — the CSP moved to src/middleware.ts: it is now NONCE-BASED (no more
  // 'unsafe-inline' in script-src — C-07's escaping closed the XSS sinks, so
  // the header layer no longer needs the escape hatch). ws:/wss: are dropped
  // from connect-src: the shipped app uses no WebSockets. The remaining
  // baseline headers stay here; middleware adds the per-request CSP.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Selfie Attendance G1 — `camera=()` switched the camera OFF for the
          // whole app, so the new in-app capture preview (getUserMedia) could
          // never start on any browser that honours Permissions-Policy; it also
          // made `<input type="file" capture>` unreliable. `camera=(self)`
          // allows the origin's OWN frames only (no third-party iframes) and
          // keeps `microphone=()` off — the app never records audio.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // ARCH-F1 (this audit) — HSTS at the Next.js layer so non-Caddy
          // deployments (LAN, alternate reverse proxy, container bare port)
          // are HSTS-protected. Mirrors deploy/Caddyfile:20,50.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
        ],
      },
      {
        // the device plane is plain protocol traffic — no headers needed there
        source: "/iclock/:path*",
        headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
      },
    ];
  },
};

export default nextConfig;
