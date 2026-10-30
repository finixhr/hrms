// ============ DahuaProvider — CCTV cloud-launch (mirrors HikvisionProvider) ============
//
// Dahua's consumer/prosumer CCTV ecosystem parallels Hikvision's:
//   - Per-camera verification (no tenant cloud-account creds needed)
//   - The brand's mobile app (DMSS for Dahua, Hik-Connect for Hikvision)
//     handles device registration + live viewing — the HRM hands off the
//     launch URL + displays the verificationCode for the user to enter
//     in the DMSS app
//   - No public Open Platform API for status polling
//   - Status field stays at last-known (admin-set or default UNKNOWN)
//
// Like Hikvision, this provider makes NO outbound HTTP calls. It's a static
// URL dispenser that mirrors the Hikvision pattern (per the user's Phase 5
// instruction: "likely mirrors Hikvision — per-camera verificationCode, no
// tenant creds, last-known status").
//
// Launch model (per Camera Manager §8):
//   - Per-camera: camera.verificationCode is the DMSS verification code
//     (printed on the device's sticker or shown in the device's web UI).
//   - getLaunchTarget returns DEEP_LINK to the DMSS web portal.
//   - fallbackWebUrl is the same URL (see TODO below).
//
// Status model (per Camera Manager §5):
//   - DMSS has no public Open Platform API for status polling.
//   - getDeviceStatus returns the camera's stored last-known status (no
//     network call). The route layer still sets lastStatusCheckAt = now()
//     per Flag 1 (Phase 5) — "we tried" marker even when no API call was
//     made.
//
// Credentials:
//   - None. validateCredentials is not called for DAHUA (the route layer
//     refuses camera.credential.upsert for per-camera brands).
//
// L-35 (2026-10-02): no official dahua:// deep-link scheme documentation
// exists publicly (Dahua publishes app manuals only) — web URL stays primary.
// TODO: confirm dahua:// deep-link scheme with Dahua developer docs.
// The dahua:// scheme (or dmss://) is referenced in user communities for
// the DMSS mobile app, but I have no citable Dahua developer doc confirming
// it. Per Camera Manager §12 (response envelope): "When a deep-link scheme
// is not documented in a citable source, do NOT invent one — return the
// fallback web URL as the primary launch target." This TODO is the explicit
// marker that the scheme is unconfirmed; once confirmed, swap the primary
// URL to dahua:// (or dmss://) and keep the web URL as fallbackWebUrl.

import type {
  CameraProvider, CameraRecord, DecryptedCreds, DeviceStatus, LaunchResult,
} from "./camera-provider"

// DMSS (Dahua Mobile Security Surveillance) web portal URL.
// Source: user-suggested in Phase 5b kickoff — the user offered
// `https://www.dmss.com` OR `https://dmss.dahuasecurity.com` as the
// correct DMSS web portal entry. The previous value
// (`https://www.dahuisecurity.com`) was the corporate marketing site,
// not the user portal — Flag 1 in the Phase 5b kickoff.
//
// Choice: `dmss.dahuasecurity.com` (subdomain on the official Dahua
// domain). This is more authoritative than `dmss.com` (which may not
// even be owned by Dahua). I cannot independently verify either URL
// without internet access in this environment; if a deployer confirms
// a different DMSS portal URL (e.g. `web.dahuacloud.com`), swap the
// constant.
const DMSS_WEB_URL = "https://dmss.dahuasecurity.com"

export const dahuaProvider: CameraProvider = {
  brand: "DAHUA",

  async validateCredentials(creds: DecryptedCreds): Promise<boolean> {
    // Dahua has no tenant creds — this method is not called for DAHUA
    // (the route layer refuses camera.credential.upsert for per-camera brands).
    // Returns true defensively: null creds = trivially valid (no creds to
    // validate). Any non-null input is unexpected and returns false.
    return creds === null
  },

  async getDeviceStatus(camera: CameraRecord, _creds: DecryptedCreds): Promise<DeviceStatus> {
    // DMSS has no public Open Platform API for status polling.
    // Return the camera's stored last-known status (Camera Manager §5:
    // "last known" status applies for brands without an Open Platform).
    return {
      status: camera.status as DeviceStatus["status"],
      lastSeenAt: camera.lastSeenAt,
      // No `error` from the provider — errors come from brand-API call
      // failures, which we don't make. Camera.lastError is for the route
      // layer to record provider call failures (none for Dahua).
      error: null,
    }
  },

  async getLaunchTarget(_camera: CameraRecord, _creds: DecryptedCreds): Promise<LaunchResult> {
    // Dahua doesn't need the verificationCode IN the launch URL — the user
    // enters it manually in the DMSS app. The UI (Phase 6) displays the
    // verificationCode alongside the launch button.
    //
    // The serialNumber is also not in the URL — DMSS resolves the camera by
    // the verificationCode the user enters, not by the HRM passing it in a
    // deep link.
    //
    // L-35 — VERIFICATION ATTEMPT 2026-10-02: Dahua publishes DMSS app
    // manuals but NO official dmss:// / dahua:// deep-link scheme spec.
    // Web URL stays the primary launch target (the audit-blessed default).
    // See the pre-production checklist in providers/README.md.
    return {
      launchTarget: {
        kind: "DEEP_LINK",
        url: DMSS_WEB_URL,
      },
      fallbackWebUrl: DMSS_WEB_URL,
    }
  },
}
