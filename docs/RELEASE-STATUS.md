# Finix HR — Multi-Platform Release Status & Build Validation Report

**Report Date:** 2026-10-29  
**Platform Scope:** Android, iOS, Windows, macOS, Web  
**Root TypeScript Status:** ✅ Clean (exit code 0, 0 errors)  
**Mobile TypeScript Status:** ✅ Clean (exit code 0, 0 errors)  
**Expo Doctor Status:** ✅ Clean (18/18 checks passed, 0 errors, 0 warnings)  

---

## 1. Multi-Platform Release Matrix

| Platform | Source Validation | Bundle Export | Executable / Native Build | Signed Artifact | Installation Test | Store / Distro Status |
|---|---|---|---|---|---|---|
| **Android (Preview APK)** | ✅ 18/18 Expo Doctor; TypeScript 0 errors | ✅ Hermes HBC Bytecode (`3.27 MB`, 1,165 modules) | ⚠️ Cloud Gated (Requires `EXPO_TOKEN` or `eas login`) | ⚠️ Debug Keystore (EAS default) | ⏳ Awaiting EAS APK download | Ready for EAS Preview dispatch |
| **Android (Prod AAB)** | ✅ Configured for `app-bundle`; Package: `com.finixhr.app` | ✅ Hermes HBC Bytecode (`3.27 MB`, 1,165 modules) | ⚠️ Cloud Gated (Requires `EXPO_TOKEN` or `eas login`) | ⚠️ Google Play Signing Key required | ⏳ Post-build | Awaiting Play Console service account key |
| **iOS (IPA / TestFlight)** | ✅ Bundle ID: `com.finixhr.app`; Info.plist verified | ✅ Hermes HBC Bytecode (`3.26 MB`, 1,166 modules) | ⚠️ Cloud Gated (Requires macOS runner or EAS iOS) | ⚠️ Apple Developer Team ID / Certs required | ⏳ Post-build | Awaiting Apple Developer credentials |
| **Windows Desktop (.exe / .msi)**| ✅ Rust 1.99.1, Cargo 1.99.1, MSVC 14.44, WebView2 | N/A (Online Hybrid) | ✅ **BUILT & VERIFIED**<br>• `Finix HR_1.0.0_x64-setup.exe` (`1.83 MiB`)<br>• `Finix HR_1.0.0_x64_en-US.msi` (`2.78 MiB`)<br>• `finix-hr.exe` (`8.45 MiB`) | ⚠️ Unsigned (SmartScreen prompt on install) | ✅ Launchable Windows binary | Ready for Authenticode signing & distribution |
| **macOS Desktop (.dmg / .app)** | ✅ Tauri v2 configured (`frontendDist: https://oms.finixhr.com`) | N/A (Online Hybrid) | ⚠️ Host Gated (Requires macOS runner; workflow in `.github/workflows/desktop-release.yml`) | ⚠️ Apple Developer ID Application cert required | ⏳ Post-build | Turnkey GitHub Actions CI workflow ready |
| **Web / Backend** | ✅ Clean TypeScript; Next.js 15 App Router | ✅ Production build exportable | ✅ Next.js Production Build | ⚠️ SSL Managed by Edge Reverse Proxy | ✅ Web sessions verified | Production deployment ready at `https://oms.finixhr.com` |

---

## 2. Windows Desktop (Tauri v2) Build Evidence

### 2.1 Environmental Toolchain Configuration
- **Host OS:** Windows 10.0.26300 x86_64
- **Rust Toolchain:** `rustc 1.99.1 (58cf8f9c3 2026-10-13)`, `cargo 1.99.1 (5f94df478 2026-08-27)`, `rustup 1.29.2`
- **C++ Compiler:** Microsoft Visual Studio Build Tools 2022 (MSVC `14.44.35207`, `cl.exe`, `link.exe`)
- **Windows SDK:** Windows Kits 10 (`10.0.26100.0`, `kernel32.lib`, `ucrt.lib`)
- **WebView Runtime:** Microsoft Edge WebView2 `156.0.4314.50`

### 2.2 Build Execution Commands
```powershell
# Set environment path to Rust toolchain and MSVC tools
$env:PATH = "C:\Users\TRADECAP\.cargo\bin;$env:PATH"
Set-Location "c:\Program Files (x86)\MSBuild\OMS\desktop"

# 1. Typecheck & dependency audit
npx tauri info

# 2. Release build and packaging
npm run build
```

### 2.3 Verified Output Artifacts
| Artifact Name | Exact Relative Path | File Size | Build Timestamp |
|---|---|---|---|
| **Windows NSIS Setup Executable** | `desktop/src-tauri/target/release/bundle/nsis/Finix HR_1.0.0_x64-setup.exe` | **1,923,157 bytes (1.83 MiB)** | 2026-10-29 11:57:34 |
| **Windows WiX MSI Installer** | `desktop/src-tauri/target/release/bundle/msi/Finix HR_1.0.0_x64_en-US.msi` | **2,912,256 bytes (2.78 MiB)** | 2026-10-29 11:57:25 |
| **Windows Standalone Executable** | `desktop/src-tauri/target/release/finix-hr.exe` | **8,867,840 bytes (8.45 MiB)** | 2026-10-29 11:55:59 |

---

## 3. Mobile (Expo) Validation & Artifacts

### 3.1 Commands Executed
```powershell
Set-Location "c:\Program Files (x86)\MSBuild\OMS\mobile"

# 1. Dependency validation
npx expo-doctor

# 2. TypeScript compilation
npm run typecheck

# 3. Hermes Production Bytecode compilation
npx expo export --platform android
npx expo export --platform ios

# 4. Native continuous generation (CNG)
npx expo prebuild --platform android --clean --no-install
```

### 3.2 Output Verification
- **Expo Doctor Check:** 18/18 checks passed (`0 errors`, `0 warnings`).
- **Android Hermes Bundle:** `mobile/dist/_expo/static/js/android/entry-c52c86360169a1b2ac46aab9a680d4c8.hbc` (`3.27 MB`, 1,165 modules).
- **iOS Hermes Bundle:** `mobile/dist/_expo/static/js/ios/entry-416675b36ddff708ca4236653de40629.hbc` (`3.26 MB`, 1,166 modules).
- **Native Android Project:** Generated in `mobile/android/` with Gradle 8.8 wrapper.

---

## 4. Security Perimeter & Threat-Model Audit

### 4.1 Bearer vs Ambient Cookie Authentication & CSRF
- **Priority Resolution:** In `src/app/api/hrm/route.ts`, if `Authorization: Bearer <token>` is presented, it takes explicit precedence over any ambient cookie.
- **CSRF Token Enforcement:** When requests authenticate using an ambient cookie (`cookieToken`), the CSRF token in `X-CSRF-Token` is strictly mandatory unless carrying a capability token or primary password credential.
- **CSRF Exemption Threat Model:** Custom `Authorization: Bearer` headers cannot be sent cross-site by an attacker without a CORS preflight, which `/api/hrm` does not grant. Furthermore, a foreign domain cannot read local app memory or `SecureStore`.

### 4.2 Origin & Null-Origin Request Threat Model
- Browsers sending `Origin: null` (from sandboxed iframes, `data:` URIs, or `file://` schemes) fail host parsing and are rejected with `Cross-origin request blocked (403)`.
- Non-browser native mobile clients (which emit no `Origin` header) must present a valid Bearer token; missing tokens result in `401 Unauthorized`.

### 4.3 WebView Scheme and Origin Shielding
- In `mobile/app/(modules)/[module].tsx`, `isTrustedUrl` strictly checks both scheme (`https:` or development `http:`) and exact host origin.
- External links, `javascript:` pseudoprotocols, and untrusted schemes are intercepted via `onShouldStartLoadWithRequest` and dispatched to `Linking.openURL`, shielding the user's Bearer token from exposure.

### 4.4 Tauri Remote-Origin Capabilities
- Remote frontend (`https://oms.finixhr.com`) is isolated inside the OS WebView with zero ambient permissions.
- Only safe explicit commands (`app_version`) and the opener plugin (`tauri-plugin-opener`) are exposed. File system, shell, and native subprocess execution remain completely disabled.

---

## 5. Outstanding Release Blockers & Prerequisites

| Blocker Category | Specific Requirement | Affected Platform | Resolution Path |
|---|---|---|---|
| **EAS Account Credentials** | Expo account login (`EXPO_TOKEN` or `npx eas login`) | Android (APK/AAB), iOS (IPA) | Set `EXPO_TOKEN` in GitHub Secrets or run `npx eas login` in terminal. |
| **Apple Developer Program** | Apple Team ID, Distribution Cert, Provisioning Profile | iOS (IPA / TestFlight), macOS (Notarization) | Connect Apple ID to EAS (`eas credentials`) and Apple Developer portal. |
| **Google Play Console** | Service Account JSON API Key (`../path/to/api-key.json`) | Android (Production AAB submit) | Generate Google Play API Service Account key in Google Cloud Console. |
| **Windows Authenticode** | Code signing certificate (EV or Standard) | Windows (`.exe`, `.msi`) | Sign with `signtool.exe` or Azure Trusted Signing to eliminate SmartScreen warning. |
| **macOS Build Host** | macOS / Xcode environment | macOS (`.dmg`, `.app`) | Run `.github/workflows/desktop-release.yml` on GitHub Actions `macos-latest`. |
| **Production Database** | Production PostgreSQL connection string in `.env` | Backend API (`/api/hrm`) | Run `bunx prisma migrate deploy` on production database cluster. |

---

## 6. Prioritized Remediation Roadmap

1. **P0 (Immediate)**: Acquire/set `EXPO_TOKEN` secret to trigger `npx eas build -p android --profile preview` to generate the physical `.apk`.
2. **P0 (Immediate)**: Connect Git remote to GitHub repository and trigger `.github/workflows/desktop-release.yml` for automated macOS `.dmg` and Windows CI artifacts.
3. **P1 (Pre-Launch)**: Obtain Windows Authenticode certificate and sign `Finix HR_1.0.0_x64-setup.exe` and `Finix HR_1.0.0_x64_en-US.msi`.
4. **P1 (Pre-Launch)**: Connect Apple Developer Program credentials to EAS to generate the iOS internal ad-hoc `.ipa` for TestFlight.
5. **P2 (Post-Launch Maintenance)**: Follow [`docs/SDK-UPGRADE-ROADMAP.md`](file:///c:/Program%20Files%20(x86)/MSBuild/OMS/docs/SDK-UPGRADE-ROADMAP.md) to migrate incrementally from SDK 52 through SDK 53, 54, 55, 56, 57, and 58.
