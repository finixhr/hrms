// ============ HikvisionProvider — CCTV cloud-launch (REFERENCE IMPLEMENTATION) ============
//
// *** DO NOT CONFUSE WITH src/app/ISAPI/* (the Hikvision ATTENDANCE TERMINAL integration) ***
//
// The two Hikvision integrations in this codebase serve different product
// classes and share NO code:
//
//   ┌──────────────────────────────┬─────────────────────────────────────────────────────┐
//   │ src/app/ISAPI/*              │ src/hrm-server/cameras/providers/hikvision.ts (THIS) │
//   ├──────────────────────────────┼─────────────────────────────────────────────────────┤
//   │ Product class                │ Product class                                        │
//   │ Hikvision DS-K1T series      │ Hikvision DS-2CD / DS-2DE / DS-7xxx NVRs / DVRs      │
//   │ ATTENDANCE / ACCESS-CONTROL  │ CCTV CAMERAS and RECORDERS                           │
//   │ TERMINALS (biometric         │                                                       │
//   │ clock-in devices)            │                                                       │
//   ├──────────────────────────────┼─────────────────────────────────────────────────────┤
//   │ Direction                     │ Direction                                            │
//   │ INBOUND: device POSTs XML    │ OUTBOUND: HRM returns a launch URL to the UI;         │
//   │ event-notification payloads  │ NO HTTP call from the HRM to any Hikvision cloud     │
//   │ to the HRM server            │                                                       │
//   ├──────────────────────────────┼─────────────────────────────────────────────────────┤
//   │ Protocol                      │ Protocol                                             │
//   │ ISAPI = Hikvision's on-prem   │ None — provider returns a static URL; the user       │
//   │ HTTP/XML spec (xmlns:         │ opens Hik-Connect in their browser/app              │
//   │ http://www.hikvision.com/     │                                                       │
//   │ ver20/XMLSchema)              │                                                       │
//   ├──────────────────────────────┼─────────────────────────────────────────────────────┤
//   │ Auth model                    │ Auth model                                           │
//   │ Device authenticates itself    │ No HRM→Hikvision auth — the user enters their       │
//   │ to the HRM via a per-device   │ camera's verificationCode in the Hik-Connect app     │
//   │ commKey (write-only,           │ manually. The HRM never sees Hik-Connect creds.    │
//   │ scrypt-hashed — see            │                                                       │
//   │ AttendanceDevice.commKeyHash) │                                                       │
//   ├──────────────────────────────┼─────────────────────────────────────────────────────┤
//   │ Reusable surface              │ Reusable surface                                     │
//   │ XML tag extractors, verify-   │ None — this file is self-contained.                 │
//   │ mode mapping, attendance-     │                                                       │
//   │ event normalization           │                                                       │
//   └──────────────────────────────┴─────────────────────────────────────────────────────┘
//
// Launch model (per Camera Manager §8):
//   - Per-camera: camera.verificationCode is the Hik-Connect verification code
//     printed on the device's sticker. The user enters this in the Hik-Connect
//     mobile app to add the camera to their account. The HRM does NOT call
//     Hik-Connect's API — it just hands off the URL + verificationCode to
//     the UI (Phase 6 displays the verificationCode separately).
//   - getLaunchTarget returns DEEP_LINK to the Hik-Connect web portal.
//   - fallbackWebUrl is the same URL (see TODO below).
//
// Status model (per Camera Manager §5):
//   - Hik-Connect has no public Open Platform API for status polling.
//   - getDeviceStatus returns the camera's stored last-known status (no
//     network call). The Camera.status field is updated only by manual
//     admin action (or a future Phase 7+ polling feature, if added).
//
// Credentials:
//   - None. validateCredentials is never called for HIKVISION (the route
//     layer refuses camera.credential.upsert for per-camera brands).
//     The implementation here is a defensive no-op returning true on null
//     input (the only valid input for Hikvision).
//
// TODO: confirm hikconnect:// deep-link scheme with Hikvision developer docs.
// The hikconnect:// scheme is widely referenced in user communities for the
// Hik-Connect mobile app (mobile app deep link), but I have no citable
// Hikvision developer doc confirming it. Per Camera Manager §12 (response
// envelope): "When a deep-link scheme is not documented in a citable source,
// do NOT invent one — return the fallback web URL as the primary launch
// target." This TODO is the explicit marker that the scheme is unconfirmed;
// once confirmed, swap the primary URL to hikconnect:// and keep the web
// URL as fallbackWebUrl.

import type {
  CameraProvider, CameraRecord, DecryptedCreds, DeviceStatus, LaunchResult,
} from "./camera-provider"

// Hik-Connect user portal URL.
// Source: user-suggested in Phase 5b kickoff ("if in doubt, use
// https://www.hik-connect.com"). The `i.hik-connect.com` subdomain is
// widely referenced in Hikvision user communities as the post-login
// portal; `www.hik-connect.com` is the marketing/entry page that
// redirects to the login flow.
//
// I cannot independently verify either URL without internet access in
// this environment. Conservative choice: use `www.hik-connect.com` (the
// entry domain) — even if `i.hik-connect.com` is the post-login portal,
// `www.` will redirect the user to the right place. If a deployer
// confirms `i.hik-connect.com` is the direct portal, swap the constant.
const HIK_CONNECT_WEB_URL = "https://www.hik-connect.com"

export const hikvisionProvider: CameraProvider = {
  brand: "HIKVISION",

  async validateCredentials(creds: DecryptedCreds): Promise<boolean> {
    // Hikvision has no tenant creds — this method is not called for HIKVISION
    // (the route layer refuses camera.credential.upsert for per-camera brands).
    // Returns true defensively: null creds = trivially valid (no creds to
    // validate). Any non-null input is unexpected and returns false.
    return creds === null
  },

  async getDeviceStatus(camera: CameraRecord, _creds: DecryptedCreds): Promise<DeviceStatus> {
    // Hik-Connect has no public Open Platform API for status polling.
    // Return the camera's stored last-known status (Camera Manager §5:
    // "last known" status applies for brands without an Open Platform).
    return {
      status: camera.status as DeviceStatus["status"],
      lastSeenAt: camera.lastSeenAt,
      // No `error` from the provider — errors come from brand-API call
      // failures, which we don't make. Camera.lastError is for the route
      // layer to record provider call failures (none for Hikvision).
      error: null,
    }
  },

  async getLaunchTarget(_camera: CameraRecord, _creds: DecryptedCreds): Promise<LaunchResult> {
    // Hikvision doesn't need the verificationCode IN the launch URL — the
    // user enters it manually in the Hik-Connect app. The UI (Phase 6)
    // displays the verificationCode alongside the launch button.
    //
    // The serialNumber is also not in the URL — Hik-Connect resolves the
    // camera by the verificationCode the user enters, not by the HRM
    // passing it in a deep link.
    //
    // TODO: confirm hikconnect:// deep-link scheme (see file header).
    // Until confirmed, return the web URL as the primary launch target.
    return {
      launchTarget: {
        kind: "DEEP_LINK",
        url: HIK_CONNECT_WEB_URL,
      },
      fallbackWebUrl: HIK_CONNECT_WEB_URL,
    }
  },
}
