# Finix HR — Local Build & Device Testing Guide (M5.1)

> **Purpose.** Everything you need to build, install, launch and manually test the
> **Web**, **Android** and **Windows Desktop** applications on your own computer and
> devices, before any further feature work (M6). This is the preparation companion to
> `docs/engineering/PRODUCTION_READINESS_CHECKLIST.md` §8 (the device verification
> matrix). Nothing in §8 is marked VERIFIED-ON-DEVICE until **you** execute §10 of this
> guide on real hardware.
>
> **Verification vocabulary** (same as the readiness checklist): a thing is either
> *verified here* (executed end-to-end in the M5.1 build environment on 2026-10-31),
> *previously verified* (executed on your Windows machine in an earlier session, see
> `docs/RELEASE-STATUS.md`), or **UNVERIFIED / BLOCKED**. Nothing is claimed from
> TypeScript passing alone.

---

## 0. What was actually verified while preparing this guide (2026-10-31)

| Surface | Verification | Evidence |
|---|---|---|
| Web app local stack | **VERIFIED end-to-end** | `bun install` (579 pkgs) → `prisma generate` → `migrate deploy` (48 migrations) → full seed (134,239 rows) → `bun run dev` → login page renders → `auth.login` → forced password rotation → re-login → authenticated `ess.dashboard` RPC returns live data |
| Unit/regression gates | **VERIFIED** | `scripts/ci.sh` all 14 stages PASS; 1,776/1,778→1,776/1,776 unit tests (158 files, 0 fail); root + mobile `tsc --noEmit` PASS; ESLint 0 errors; `next build` PASS |
| Android APK | **VERIFIED built** | `expo prebuild` + Gradle `assembleDebug` produced `finix-hr-dev-arm64-debug.apk` (151,081,956 bytes, 1,231 entries). `aapt2 dump badging`: `com.finixhr.app` v1.0.0, compileSdk 35; `apksigner verify` exit 0 (debug cert). One cosmetic ledger task (`createDebugApkListingFileRedirect`) could not complete — sandbox disk exhaustion; the APK itself was fully packaged before it. **Post-cycle (handover verification): that artefact file did NOT survive the build-environment recycle and was never committed (`mobile/android/` is gitignored CNG output) — no copy exists anywhere now. This row records the build verification, not current availability; rebuild locally via §4.3 Path A.** |
| Mobile config health | **VERIFIED** | `expo-doctor`: **18/18 checks pass** (after aligning `expo-image-manipulator` to `~13.0.6`) |
| Windows desktop build | **BLOCKED in the build sandbox** (no Rust toolchain / webkit2gtk) — **previously verified on your machine** (2026-10-29): NSIS setup 2.05 MiB, MSI 2.97 MiB, standalone EXE 8.65 MiB, launch verified, signed with thumbprint `250456C96E034A86C2581EC81B1D044347AB71C4` | `docs/RELEASE-STATUS.md` §1/§3 |
| Physical-device testing | **BLOCKED — not performed** | No Android/iOS device in the build environment. §8 of the readiness checklist remains ALL-BLOCKED until you run §10 below |
| Hosted URLs `oms.finixhr.com` / `staging-oms.finixhr.com` | **UNVERIFIED** — DNS did not resolve from the build environment | Do not point a local test build at them without checking on your network |
| Handover verification (7th session — pre-testing audit, 2026-10-31) | **DONE** | HEAD `4006c5e` = the M5.1 tip, clean tree, no dangling objects; GitHub `main` live-checked (`git ls-remote`) at `5b8071d` — the M5 line IS pushed, the M5.1 triplet (`040c6b0`…`4006c5e`) is local-only pending a plain fast-forward push from your machine; seed fix + dependency alignment re-verified in the diffs; NEW documented gap: SDK-52 **release** builds carry no `usesCleartextTraffic` (§4.4) |

One real blocker was found and fixed during preparation (see §11.1): `bun run seed`
crashed on every fresh database — the `EARNED`→`ANNUAL` leave-type alias had no
definition row. Fixed in `src/hrm-server/seed.ts`; full seed now completes.

---

## 1. Windows prerequisites

Install in this order. All are free; none require a paid account except optional EAS
(Google Play / App Store are explicitly **out of scope** for this milestone).

### 1.1 Core toolchain (web + repo)

| Tool | Version | Why / notes |
|---|---|---|
| Git for Windows | current | Includes **Git Bash** — the repo's helper scripts (`scripts/*.sh`) are bash. Run them from Git Bash |
| Node.js | **20 LTS** | Mobile app + desktop tooling (matches CI `actions/setup-node@v4 node-version: 20`) |
| **Bun** | **exactly 1.4.2** | Web server runtime + install. `bun.lock` is the Bun-1.4 text format; **Bun ≤ 1.3 cannot parse it** (`UnknownLockfileVersion`, reproduced with 1.3.14). Install: `powershell -c "irm bun.sh/install.ps1 | iex"` then `bun --version` must print `1.4.2` |
| PostgreSQL | **17.x** | Dev + test databases. Native installer **or** Docker (see §3) |

### 1.2 Android toolchain (physical-device testing)

| Tool | Version | Why / notes |
|---|---|---|
| Android Studio (or cmdline-tools only) | current | Provides SDK Manager + USB drivers. Minimum SDK packages: `platform-tools`, `platforms;android-35`, `build-tools;35.0.0` (NDK `26.1.10909125` auto-installs during the Gradle build) |
| JDK | **17 (full JDK, not a JRE)** | React Native 0.76 / AGP 8.6 / Gradle 8.10.2 toolchain. **A JRE-only Java 21 fails with "does not provide the required capabilities: [JAVA_COMPILER]"** — verified the hard way. Temurin 17 is a safe choice |
| EAS CLI (optional) | `npm i -g eas-cli` | Only for cloud builds (§4 path D). Local builds (paths A–C) need no EAS account |

Set once (PowerShell, adjust paths):

```powershell
[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Eclipse Adoptium\jdk-17.x.x-hotspot", "User")
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
# add to PATH: %JAVA_HOME%\bin ; %ANDROID_HOME%\platform-tools ; %ANDROID_HOME%\cmdline-tools\latest\bin
```

### 1.3 Windows desktop (Tauri) toolchain

| Tool | Version | Why / notes |
|---|---|---|
| Rust | stable via **rustup** (`https://rustup.rs`, choose MSVC host) | Previously verified with Rust 1.99.1 / MSVC 14.44 |
| Visual Studio 2022 Build Tools | "Desktop development with C++" workload + Windows 10/11 SDK | Links the Tauri binary |
| WebView2 Runtime | preinstalled on Win 11; Win 10: Evergreen installer from `https://developer.microsoft.com/microsoft-edge/webview2/` | Renders the desktop shell (previously verified runtime 156.0.4314.50) |

### 1.4 Hardware

- Windows PC (the build machine — everything above runs on it).
- One **physical Android phone, API 33+** (Android 13+), with USB debugging enabled
  (Settings → About → tap Build 7× → Developer options → USB debugging).
- USB cable, and **both devices on the same Wi-Fi LAN** for wireless testing.
- Optional (iOS, separate milestone): a Mac + Apple Developer account — see §11.

---

## 2. Web application — local setup and startup

The web app is a Next.js 16 server (RPC API at `POST /api/hrm`) with Prisma +
PostgreSQL. Exact sequence (Git Bash, from the repo root):

```bash
# 0. toolchain sanity
bun --version          # MUST be 1.4.2
node --version         # 20.x
psql --version         # PostgreSQL client on PATH (comes with the native install)

# 1. install dependencies (lockfile-exact)
bun install --frozen-lockfile

# 2. create .env (NEVER commit it — .gitignore already excludes it)
cp .env.example .env
```

Edit `.env` — the **minimum viable dev file** is exactly these three values:

```bash
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/hrm_dev"
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/hrm_test"
HRM_MFA_KEY="<64-char hex>"
```

Generate `HRM_MFA_KEY`:

```bash
openssl rand -hex 32                      # Git Bash ships openssl
```
```powershell
# PowerShell alternative (no openssl needed):
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Rules enforced at boot by `src/instrumentation.ts` (the server **refuses to start**):
- `HRM_MFA_KEY` must be 64-char hex and must not be a placeholder or any
  known-leaked value (the all-zero docker default is leaked-listed).
- Every `HRM_*` / `ZKTECO_*` / `ADMS_*` variable name must be in the known-keys
  allowlist — a typo'd or invented name is a hard boot failure, not a warning.

Everything else in `.env.example` is optional for local dev (device gateway tuning,
WebAuthn origins, backup key, SaaS owner overrides…). Leave the defaults.

```bash
# 3. generate the Prisma client
bunx prisma generate

# 4. create the dev database + apply all 48 migrations (non-destructive, versioned)
#    (psql creates hrm_dev if absent; migrate deploy never drops data)
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE hrm_dev;"   # skip if it exists
bunx prisma migrate deploy

# 5. seed the demo tenant + SaaS layer (vendors, 825 employees, users, attendance,
#    payroll, leave, loans, KPIs, plans, owner console) — takes ~40 s
bun run seed
bun run scripts/seed-new-modules.ts          # AIT config, procurement, inventory demo
bun run scripts/migrate-role-perms.ts         # role permission templates (idempotent)
bun run scripts/seed-approval-workflows.ts    # approval workflow fixtures

# 6. verify the seed
bun run seed:verify
```

One-command alternative for steps 1–6: `bash scripts/setup-and-seed.sh` (it does
exactly the sequence above, including auto-creating `hrm_dev` when `psql` is on PATH).

```bash
# 7. start the dev server — binds 0.0.0.0:4055 (LAN-reachable for phone testing)
bun run dev
```

Open **http://localhost:4055** — the login page renders. That is the whole web stack.

### 2.1 Test tenant and test accounts

The seed creates two tenants; **Bengal Textworks Ltd.** is the full-featured one
(Business plan, ACTIVE to 2027-04-14). All passwords are **`Pass@123`**:

| Account (email) | Role | Use it for |
|---|---|---|
| `owner@bengaltextworks.example` | VENDOR_OWNER | tenant admin surfaces |
| `admin@bengaltextworks.example` | HR_ADMIN | HR admin: employees, attendance review, settings |
| `hr@bengaltextworks.example` | HR_MANAGER | approvals, field-permission masking demo |
| `payroll@bengaltextworks.example` | PAYROLL_OFFICER | payroll runs/payslips |
| `branch@…` / `branch2@…` / `dept@…` | BRANCH/DEPT managers | scoped views |
| `employee@bengaltextworks.example` | EMPLOYEE (ESS) | **phone-testing account** — Rahim Miah |
| `employee2@bengaltextworks.example` | EMPLOYEE (ESS) | second phone / offline tests |
| `owner@rongintraders.com` / `employee@rongintraders.com` | second tenant | tenant-isolation spot checks |
| `owner@finixhr.local` / `SaasOwner@2026` | SaaS SUPER_ADMIN | **Owner Console** at `/owner/login` (plans, subscriptions) |

**First login forces a password rotation** (C-02: seeded credentials travel in a
public artifact). Login → "password expired" → set a new password (e.g.
`TestDevice#2026`) → re-login. This is expected behaviour, not a bug. MFA enrollment
is offered after login (T-14 wizard) — use it to exercise the MFA leg of §10.

### 2.2 Smoke-test the API over HTTP (no browser needed)

The RPC envelope is `{"action": "<route>", "payload": {...}}` — note the `payload`
key (sending parameters at the top level yields a clean 401 — verified):

```bash
# login (first login → rotation token)
curl -s -X POST http://localhost:4055/api/hrm \
  -H "Content-Type: application/json" \
  -d '{"action":"auth.login","payload":{"email":"employee@bengaltextworks.example","password":"Pass@123"}}'

# rotate the password with the returned pwToken
curl -s -X POST http://localhost:4055/api/hrm \
  -H "Content-Type: application/json" \
  -d '{"action":"auth.password.change","payload":{"pwToken":"<pwToken from login>","newPassword":"TestDevice#2026"}}'

# re-login → returns "token" (Bearer). Authenticated call:
curl -s -X POST http://localhost:4055/api/hrm \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token>" \
  -d '{"action":"ess.dashboard","payload":{}}'
# → {"ok":true,"data":{"attendance":{...},"casualRemaining":10,...}}
```

Web-browser calls additionally require the CSRF token (cookie sessions); native
clients (Android/desktop) use the Bearer header. Both paths are unit-tested server-side.

### 2.3 Integrations on a local stack

| Integration | Local behaviour | To enable |
|---|---|---|
| File/document storage | **DB-stored** (validated base64, ≤2 MB, magic-byte sniffed) — works with zero config | nothing |
| Email (SMTP) | off by default; no mail leaves the machine | Owner Console → Settings → Gateway (SMTP credentials are stored encrypted via `HRM_MFA_KEY` HKDF context) |
| SMS (SSLWireless) | off by default | same console path |
| Push (Expo) | registration contract enforced; delivery needs the EAS project + internet | projectId already wired in `mobile/app.json` (`5df89cc1-…`); receipts need a real device + EAS account |
| Cloud storage (R2/Cloudinary) | optional | Owner Console → Settings → Storage |
| ZKTeco ADMS devices | simulator enabled in dev (`ZKTECO_SIMULATOR_ENABLED="true"`) | production devices are out of scope locally |

---

## 3. PostgreSQL development setup

Two supported layouts. **Never** point `DATABASE_URL` at anything containing the
word `production`; the test preload refuses such URLs for tests, and the seed refuses
to run with the default password in production mode.

### 3.1 Native install (recommended for Windows)

1. Run the PostgreSQL 17 installer (EDB). Remember the `postgres` superuser password;
   keep port 5432.
2. Local dev convention used by every script in this repo:
   - user `postgres`, password `postgres` (dev only — change for anything shared)
   - databases `hrm_dev` (app) and `hrm_test` (disposable unit-test DB, auto-created
     by `tests/preload.ts`; it force-resets its own schema on every run — never keep
     anything in it)
3. Ensure `psql` is on PATH (installer option) so `scripts/setup-and-seed.sh` can
   auto-create `hrm_dev`.

### 3.2 Docker alternative

```bash
docker compose up -d db            # postgres:17-alpine, persistent volume finix-db
# the compose file does NOT expose 5432 to the host by default — uncomment the
# ports block (55432:5432) in docker-compose.yml and set
# DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/hrm_dev"
```

The full app stack also runs containerised (`docker compose up --build` → app on
:4000 with `migrate deploy` on boot) — see the header of `docker-compose.yml`.
For device testing use the native dev server (§2) so Metro/LAN addressing stays simple.

### 3.3 Database hygiene rules (already enforced by tooling)

- Migrations are **additive-only, versioned** (`prisma migrate deploy`); the repo has
  a schema-drift gate and a fresh-database migration smoke in `scripts/ci.sh`
  (stages 11–12) — a green CI means the chain reproduces `schema.prisma` exactly.
- `bun run seed` performs a **full reset of the tenant data** (it wipes its target
  database first). Only ever run it against `hrm_dev`/throwaway databases.
- Unit tests auto-create/reset `hrm_test`; never store anything there.

---

## 4. Android application — development build

The mobile app is **Expo SDK 52 / React Native 0.76.9** (managed workflow + prebuild,
no committed `android/` folder). Package `com.finixhr.app`, version 1.0.0,
`google-services.json` (FCM project `finix-hr-97374`) is wired and matches the
package name.

**Expo Go is NOT supported** (native modules: task-manager, background location,
push handlers) — you need a development build from one of the paths below.

### 4.1 The API base URL — read this before building

Resolution order in `mobile/src/lib/api.ts`:

1. `EXPO_PUBLIC_API_BASE_URL` — **inlined at JS bundle time** (Metro or EAS build env)
2. `app.json → extra.apiBaseUrl` — **`https://oms.finixhr.com` (the PRODUCTION URL!)**
3. last-resort default `http://localhost:4055`

Consequences (all verified against the code):

- **Always set `EXPO_PUBLIC_API_BASE_URL` explicitly** for any local/QA build —
  otherwise the baked fallback is the production URL.
- `localhost` **only works on an emulator** or with `adb reverse` USB forwarding — a
  physical phone on Wi-Fi cannot resolve it (the task's explicit warning).
- The debug/dev builds load JS from **Metro** at runtime, so for those you control the
  URL by setting the env var **when you start Metro** (`npx expo start`), not at
  install time. Release builds bake it permanently.

### 4.2 EAS build profiles (`mobile/eas.json`) — audit result

| Profile | APK? | Baked `EXPO_PUBLIC_API_BASE_URL` | Verdict for M5.1 |
|---|---|---|---|
| `development` | dev-client | `http://localhost:4055` | only with USB + `adb reverse tcp:4055 tcp:4055`; otherwise override at Metro start |
| `preview` | **APK**, internal | `https://staging-oms.finixhr.com` | **do not use as-is for local testing** — the host did not resolve from the build environment; edit the env to your LAN IP first |
| `production` | app-bundle | `https://oms.finixhr.com` | **NEVER for this milestone** (store artefact, production URL, `autoIncrement` versionCode) |

### 4.3 Path A (recommended first) — local debug build + Metro over LAN

Build once, then iterate JS instantly. Phone and PC on the same Wi-Fi:

```powershell
# 0. find your PC's LAN IP
ipconfig                      # → e.g. 192.168.1.100 (IPv4 of your Wi-Fi adapter)

# 1. one-time native build + install to the USB-attached phone
cd mobile
npm ci
npx expo run:android          # generates android/ (prebuild), builds, installs, launches
                              # (needs ANDROID_HOME + JDK 17; NDK auto-installs)

# 2. daily loop — serve JS with the API URL baked for the LAN:
cd mobile
$env:EXPO_PUBLIC_API_BASE_URL = "http://192.168.1.100:4055"   # YOUR IP
npx expo start                # Metro on :8081; press "a" or reopen the app on the phone
```

If you keep the phone on USB instead of Wi-Fi, `adb reverse tcp:8081 tcp:8081`
(forwards the phone's localhost:8081 to your Metro) **and** you may then use
`http://localhost:4055` for the API together with `adb reverse tcp:4055 tcp:4055`.

### 4.4 Path B — standalone release APK for LAN testing (no Metro, no USB)

The APK contains its JS — good for "install on my phone and walk around" testing:

```powershell
cd mobile
$env:EXPO_PUBLIC_API_BASE_URL = "http://192.168.1.100:4055"   # YOUR LAN IP — REQUIRED
npx expo run:android --variant release
# → mobile/android/app/build/outputs/apk/release/app-release.apk
```

The release APK is signed with your local **debug keystore** (Expo prebuild default —
`%USERPROFILE%\.android\debug.keystore`, auto-generated). That is fine for private
testing; it is not a store credential.

> **⚠ Cleartext trap in release builds (found during handover verification):** the
> actual Expo SDK 52 build templates were pulled and inspected
> (`expo-template-bare-minimum@52.0.79`): the **main** `AndroidManifest.xml` sets NO
> `android:usesCleartextTraffic` — only the **debug** variant manifest
> (`app/src/debug/AndroidManifest.xml`) sets it to `true`, and nothing in this repo's
> `mobile/app.json` adds it. Android 9+ (API 28+) therefore blocks every `http://`
> request a RELEASE build makes — the app reaches the login screen and every API call
> fails ("Cleartext HTTP traffic not permitted"). Fix, **test builds only**: add
> `"usesCleartextTraffic": true` under `"android"` in `mobile/app.json`, delete the
> generated `mobile/android/` if it exists, and rebuild; revert the flag before any
> store submission. Debug builds (Path A) are unaffected — the debug manifest already
> allows cleartext.

### 4.5 Path C — the pre-built M5.1 APK: NO LONGER AVAILABLE

`finix-hr-dev-arm64-debug.apk` (151 MB, arm64-v8a only, debug-signed, **no embedded
JS**) was built and verified in the M5.1 build environment (changelog Entry 34), but
**that environment was recycled and the artefact is gone** — it was never committed
(`mobile/android/` is gitignored CNG output) and no `.apk` blob exists anywhere in
git history (verified during the handover audit: the largest blob in the entire
history is 4.1 MB). Do not hunt for it: **build your own via Path A** — identical
behaviour (debug-signed, Metro required, LAN API URL set when Metro starts). If it is
the Metro-free release APK you want, read the §4.4 cleartext trap first.

### 4.6 Path D — EAS cloud build (optional, needs an EAS account)

```powershell
npm i -g eas-cli
eas login                                   # the account that owns project 5df89cc1-1316-49e8-ae1d-4ced3b9a69b5
# BEFORE building: edit mobile/eas.json → build.preview.env.EXPO_PUBLIC_API_BASE_URL
# to your LAN IP (or a reachable staging host) — the committed value does not resolve
eas build --platform android --profile preview     # internal APK, emailed/dashboard URL
```

Do **not** submit to Google Play (§8 safety rules; also targetSdk 34 vs the API 35/36
store requirement — see §11).

### 4.7 Permissions the app actually requests (from the built APK, `aapt2`)

`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`,
`CAMERA`, `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`,
`POST_NOTIFICATIONS`, `NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `VIBRATE`,
`c2dm.permission.RECEIVE` (FCM), plus legacy storage + `RECORD_AUDIO` (merged in from
`expo-camera`'s manifest; the app never requests audio at runtime — photo capture only).

---

## 5. Android APK installation

```powershell
# 0. enable Developer options + USB debugging on the phone (§1.4), plug in,
#    accept the "Allow USB debugging?" prompt on the phone
adb devices                                  # must list the device

# 1. install (use -r to update an existing install)
adb install -r mobile\android\app\build\outputs\apk\release\app-release.apk
# (Path A installs automatically via `npx expo run:android` — no manual adb needed.
#  The pre-built M5.1 APK no longer exists — see §4.5.)
# signature mismatch after switching build machines → adb uninstall com.finixhr.app first

# 2. launch
adb shell am start -n com.finixhr.app/.MainActivity

# 3. confirm install metadata
adb shell dumpsys package com.finixhr.app | findstr /i "versionName targetSdk"
```

Sideload alternative (no USB for install): copy the APK to the phone (browser
download / file copy), tap it, allow "install unknown apps" for that one file source.

---

## 6. API connectivity configuration

Three moving parts must line up before the phone can log in:

1. **The dev server must listen on your LAN IP.** `bun run dev` already binds
   `0.0.0.0:4055`. Allow it through Windows Defender Firewall once (admin PowerShell):

   ```powershell
   New-NetFirewallRule -DisplayName "Finix HR dev 4055" -Direction Inbound `
     -Protocol TCP -LocalPort 4055 -Action Allow -Profile Private
   ```

2. **The app must be built/loaded with the right base URL**
   (`EXPO_PUBLIC_API_BASE_URL=http://<LAN-IP>:4055` — §4).

3. **Origin/CSRF**: the phone's browser-style Origin (`http://<LAN-IP>:4055`) equals
   the request Host, so the same-host rule passes with **no extra config**; the native
   app sends no Origin at all and authenticates with the Bearer token. Both are
   already handled server-side (`isOriginAllowed` in `src/hrm-server/security.ts`).
   `HRM_ALLOWED_ORIGINS` is only needed for cross-host embedded previews.

Quick connectivity checks from the phone (any mobile browser):
`http://192.168.1.100:4055/login` must render the sign-in page. If it does, the RPC
API is reachable too. If not: firewall (most common), wrong IP (use the Wi-Fi
adapter's IPv4), or the PC and phone on different subnets/guest Wi-Fi isolation.

Sanity check from the PC itself (the exact verified request):

```bash
curl -s -X POST http://192.168.1.100:4055/api/hrm \
  -H "Content-Type: application/json" \
  -d '{"action":"auth.login","payload":{"email":"employee@bengaltextworks.example","password":"<post-rotation password>"}}'
```

---

## 7. Windows desktop application — development launch

The desktop app is **Tauri 2** wrapping a small local **hub UI**
(`desktop/ui/` — connection manager, diagnostics, presets). It does **not** embed the
Next.js server: on launch it probes the configured server URL and navigates the
window there directly (no iframe — this is the design that fixed the
X-Frame-Options/camera issues; commit `591a82e`). The server URL is user-configurable
at runtime and persisted in the webview's localStorage key `finix_desktop_server_url`
(default `http://localhost:4055`).

```powershell
# prerequisites once (§1.3): rustup + VS Build Tools C++ + WebView2 runtime
cd desktop
npm ci                        # installs @tauri-apps/cli (tauri-cli 2.12.4 verified)

# 1. start the web dev server first (terminal 1, repo root)
bun run dev                   # http://localhost:4055

# 2. launch the desktop shell (terminal 2)
npm run dev                   # = tauri dev — serves desktop/ui locally (devUrl is
                              #   intentionally null: the hub is static assets)
```

Expected: the "Finix HR" window opens on the connection hub; it shows *Connected* to
`localhost:4055` and navigates into the web app within a second. If the server is
down you get the offline hub with **Retry / Switch to Local / Settings** — the gear
icon (or menu **Workspace → Server Connection Manager**, `Ctrl+Shift+S`) opens the URL
editor with a live **Test** button. Other accelerators: `Ctrl+R` reload, `Ctrl+Q`
quit. The native menu also exposes `app_version`.

Configuration audit (`desktop/src-tauri/tauri.conf.json`): identifier
`com.finixhr.desktop`, version 1.0.0, `frontendDist: "../ui"` (local assets — the app
never hardcodes the hosted site; only the hub's *default* URL string points at
localhost), CSP restricts `object-src 'none'`, `base-uri 'self'`, allows remote
https/http workspaces for `connect-src`/`img-src` (needed to load the web app),
`script-src 'self' 'unsafe-inline'` (no `unsafe-eval`). The only native commands are
`app_version` and the opener plugin — no filesystem/shell surface for remote content.

---

## 8. Windows desktop application — installer build

```powershell
cd desktop
npm run build        # = tauri build → compiles release + bundles installers
```

Outputs (previously verified on your machine, 2026-10-29 — sizes from that build):

| Artefact | Path | Size |
|---|---|---|
| NSIS setup EXE | `desktop/src-tauri/target/release/bundle/nsis/Finix HR_1.0.0_x64-setup.exe` | 2.05 MiB |
| WiX MSI | `desktop/src-tauri/target/release/bundle/msi/Finix HR_1.0.0_x64_en-US.msi` | 2.97 MiB |
| Standalone EXE | `desktop/src-tauri/target/release/finix-hr.exe` | 8.65 MiB |

**Signing / certificates (recorded separately, per policy):** the config already
carries a Windows signing thumbprint — `certificateThumbprint:
250456C96E034A86C2581EC81B1D044347AB71C4` (SHA-256 digest, certificate lives in your
Windows cert store). Requirements to build signed installers:

- the certificate (with private key) imported into the Windows certificate store of
  the build user;
- `timestampUrl` is currently **null** in `tauri.conf.json` — signatures are not
  timestamped. Recommended before any real distribution: set a timestamp server
  (e.g. `http://timestamp.digicert.com`) so signatures outlive certificate expiry;
- unsigned builds also work (Tauri skips signing when the thumbprint is absent) —
  Windows will show SmartScreen warnings, which is fine for your own test machines.

Do **not** claim macOS builds from a Windows machine — the macOS artefacts are
produced by the authored GitHub Actions workflow on `macos-latest` runners
(`docs/MULTI-PLATFORM.md` §3), not locally.

---

## 9. Logging and troubleshooting

### 9.1 Web server

- Everything logs to the terminal running `bun run dev` (RPC errors, boot guards,
  sweeper activity). Boot failures print the exact env key that failed.
- Failed/successful logins are audited into the `LoginAuditLog` table — inspect with:

  ```bash
  psql -h 127.0.0.1 -U postgres -d hrm_dev -c \
    "SELECT success, \"failureReason\", email, ip, \"createdAt\" FROM \"LoginAuditLog\" ORDER BY \"createdAt\" DESC LIMIT 10;"
  ```

  (If a 401 shows `INVALID_CREDENTIALS` with an empty `email`, the request body was
  not in the `{action, payload}` envelope — see §2.2.)
- Migration state: `bunx prisma migrate status`. Schema drift / fresh-database smoke
  are CI stages 11–12 (`bash scripts/ci.sh`).

### 9.2 Android

```powershell
# live logs (filter to the app's JS + crashes)
adb logcat -s ReactNativeJS:* AndroidRuntime:E ExpoModulesCore:*

# clear first for a clean run
adb logcat -c ; adb shell am start -n com.finixhr.app/.MainActivity ; adb logcat -s ReactNativeJS:* AndroidRuntime:E

# crash triage: look for "FATAL EXCEPTION" → the stack names the module;
# white screen / "Unable to load script" → Metro not reachable (§4 paths);
# red box with a bundler error → the JS served by Metro failed to compile (see the Metro terminal)
```

- Metro's own terminal shows bundling errors and the QR/LAN URL — read it before the
  phone when the app won't start.
- The in-app dev menu (shake the phone, or `adb shell input keyevent 82`) exposes
  Reload / Settings / "Debug server host & port" (use it to point a standalone debug
  APK at your Metro over Wi-Fi without USB).
- Permission denials surface as actionable in-app messages (by design) — check
  Settings → Apps → Finix HR → Permissions when a scenario in §10 fails.

### 9.3 Windows desktop

- `npm run dev` / `npm run build` print the Rust build log — read the first `error:`
  line; almost always toolchain (rustup target, VS Build Tools workload, WebView2).
- `npx tauri info` (run in `desktop/`) validates prerequisites — it must show rustc,
  cargo, and (on Windows) WebView2 as ✔.
- The release webview has devtools disabled; use `npm run dev` while diagnosing, and
  the hub's built-in connection diagnostics for URL problems.
- Reset a bad saved server URL: menu **Workspace → Server Connection Manager**
  (`Ctrl+Shift+S`) → edit → Test → Save (no file to delete).

### 9.4 Known traps (each one hit and resolved during M5.1 preparation)

| Symptom | Cause | Fix |
|---|---|---|
| `UnknownLockfileVersion` during `bun install` | Bun ≤ 1.3 parsing the 1.4 lockfile | use **Bun 1.4.2** exactly |
| `Prisma … URL must start with the protocol postgresql://` (P1012) at seed/migrate | a `DATABASE_URL` from a foreign environment (e.g. an old SQLite `file:` path) overriding `.env` | `unset DATABASE_URL` (bash) / remove it from the shell profile, let `.env` supply it |
| `bun run seed` crash at `ltDefs.find(...)` | **fixed in M5.1** — EARNED leave-type alias had no definition row | commit in `src/hrm-server/seed.ts`; re-pull if you see it |
| Gradle: "Toolchain … does not provide [JAVA_COMPILER]" | JRE-only Java (e.g. Java 21) installed | install a **full JDK 17** and point `JAVA_HOME` at it |
| Gradle: SDK components missing | partial Android SDK | install §1.2's three packages; NDK auto-installs |
| `adb install` fails with signature mismatch | APK signed by a different debug keystore | `adb uninstall com.finixhr.app` then install |
| Phone can't reach `http://<LAN-IP>:4055` | Windows Firewall / wrong adapter IP / subnet isolation | §6 firewall command; verify with the phone's browser |
| Desktop window shows the offline hub | web dev server not running / URL typo | start `bun run dev`; use the hub's Test button |
| Release APK: app opens but **every API call fails**; logcat shows `Cleartext HTTP traffic not permitted` | SDK-52 **release** manifests carry no `usesCleartextTraffic` — only the debug variant does (§4.4) | add `"usesCleartextTraffic": true` under `expo.android` in `mobile/app.json`, delete the generated `mobile/android/`, rebuild — test builds only |

---

## 10. Manual device testing checklist

Execute on **physical hardware** (Android phone + Windows PC; the Windows-desktop
rows run on the PC itself). Basis: `docs/engineering/PRODUCTION_READINESS_CHECKLIST.md`
§8. **Nothing below is marked VERIFIED-ON-DEVICE yet** — every row starts as
TO-TEST and becomes PASS/FAIL only when you record evidence.

**Evidence fields — fill one line per scenario:**

```
Scenario ID:      A1
Device model:     e.g. Samsung Galaxy A54
OS version:       e.g. Android 14 (One UI 6)
App build:        e.g. release APK 1.0.0 built 2026-11-01 / debug+Metro
Server:           e.g. http://192.168.1.100:4055 (bun run dev, commit <SHA>)
Tester / date:    …
Expected:         (from the table)
Actual:           …
Result:           PASS | FAIL | BLOCKED
Evidence:         screenshot path / adb logcat excerpt / LoginAuditLog row
```

### 10.1 Pre-flight (once)

- [ ] PC: `bun run dev` serving on the LAN IP; phone browser opens the login page.
- [ ] Phone: Finix HR installed (§4/§5); app opens on the login screen.
- [ ] Test accounts ready: `employee@bengaltextworks.example` rotated password; a
      second ESS account for offline/duplicate tests; an HR_ADMIN account for the
      review-side checks; MFA enrollment available (T-14 wizard).
- [ ] HR admin setup (web, as `admin@…`): confirm the tenant's geofence/attendance
      policy so B1–B3 behave predictably (seeded defaults: geofence demo present).

### 10.2 Authentication (A1–A7)

| ID | Scenario | Expected result |
|---|---|---|
| A1 | Login + logout on device | Session works; logout clears token + cookie; next open lands on login |
| A2 | Session persistence across cold start | kill app → relaunch → `auth.me` restores session; no re-login |
| A3 | Token refresh | 401 → cookie/bearer fallback transparent; no visible bounce |
| A4 | MFA enrollment via wizard (QR → code → recovery codes) | QR renders and scans; code accepted once; recovery codes shown **exactly once**; wizard proceeds only on server acceptance |
| A5 | MFA verification on login | correct TOTP → session; wrong code → clear error + retry; throttle visible after repeated wrong codes |
| A6 | Recovery codes single-use | each code consumes once; exhausted set forces the re-enroll path |
| A7 | Expired/invalid token | 401 → token cleared → login screen; no infinite loop; offline queue pauses, nothing lost |

### 10.3 Attendance (B1–B6)

| ID | Scenario | Expected result |
|---|---|---|
| B1 | Normal geofence check-in/out | punch lands; honest status toast; method policy respected |
| B2 | Location permission grant → deny | grant → punch works; deny → actionable message, no crash |
| B3 | Inside/outside geofence | inside → accepted; outside → denied with distance info |
| B4 | Selfie attendance (camera permission → preview → capture → confirm → upload) | full flow completes; ≤640px upload; **explicit confirm required** |
| B5 | Camera permission denied | guidance to settings; no hang |
| B6 | Upload failure + retry | failed upload keeps entry pending; retry reuses the SAME idempotency key; no double punch |

### 10.4 Offline outbox (C1–C6)

| ID | Scenario | Expected result |
|---|---|---|
| C1 | Punch while offline (airplane mode) | entry queued locally with honest pending state; UI never claims success |
| C2 | Restore connectivity | NetInfo reconnect triggers debounced drain; entries sync automatically |
| C3 | Duplicate prevention | same `clientEventId` replays idempotently — one row, one event, one notification |
| C4 | Auth expiry DURING sync | queue pauses (`authPaused`), nothing lost; re-login drains it |
| C5 | Permanent failure | entry terminal with server message; dismiss requires acknowledgment |
| C6 | Delayed offline punch | lands in HR review queue as REVIEW_REQUIRED with device timestamp evidence |

Tip for C6: capture a punch offline, keep airplane mode on for a while, then
reconnect — the delayed-punch classification (server-side matrix) routes it to the
review queue; verify on the web as HR_ADMIN. Full design: `docs/engineering/OFFLINE_OUTBOX.md`.

### 10.5 Push notifications (D1–D5)

| ID | Scenario | Expected result |
|---|---|---|
| D1 | Device registration on login | `push.registerDevice` with real Expo token; fails closed without projectId |
| D2 | Token refresh (reinstall/update) | new token registered; old token gone |
| D3 | Notification receipt (foreground/background) | tenant push arrives and renders |
| D4 | Tap → deep navigation | routes to the right screen |
| D5 | Logout token cleanup | `push.unregisterDevice` on logout; no ghost devices |

D3–D4 need EAS push (real device + EAS project; `expo-notifications` + FCM via the
wired `google-services.json`). If you only build locally (paths A–C), record D1/D2/D5
(which need no push delivery) and mark D3/D4 BLOCKED-EAS unless you run path D.

### 10.6 Windows desktop rows

| ID | Scenario | Expected result |
|---|---|---|
| W1 | Cold launch with dev server up | hub shows Connected → web app loads in the window |
| W2 | Cold launch with server down | offline hub, no crash; Retry/Settings work |
| W3 | Server URL switch (`Ctrl+Shift+S`) | Test button validates; Save reconnects |
| W4 | Login + attendance + payslip inside the webview | same flows as the browser (camera permission included — B4 parity) |
| W5 | Session persistence | close/reopen keeps the web session (WebView2 profile storage) |

### 10.7 When you are done

Update `docs/engineering/PRODUCTION_READINESS_CHECKLIST.md` §8 rows from BLOCKED →
PASS/FAIL with your evidence, and TD-26 in `docs/engineering/TECHNICAL_DEBT_REGISTER.md`.
That act — not this document — is what flips device verification to real.

---

## 11. Known limitations and missing prerequisites

### 11.1 Fixed during this milestone

- **`bun run seed` crashed on every fresh database** (TypeError dereferencing the
  EARNED→ANNUAL leave-type alias, broken since the baseline commit — invisible to CI
  because the unit lane never runs the dev seed). Fixed in `src/hrm-server/seed.ts`;
  verified by a complete seed (134,239 rows) + `seed:verify`.
- **`expo-doctor` advisory**: `expo-image-manipulator` 13.0.3 → **~13.0.6** (the
  SDK-52-expected patch). Now 18/18 checks pass. (Also eliminates the one EAS build
  warning.)

### 11.2 Outstanding — environmental, not code

| Item | Status | What unblocks it |
|---|---|---|
| Physical-device verification (all of §10) | **BLOCKED** | you, a phone, ~2 hours |
| iOS build/test | **BLOCKED** | a macOS machine + Apple Developer account; no iOS artefact exists yet |
| EAS cloud builds (path D) | optional | `eas login` with the account owning project `5df89cc1-…`; adjust `eas.json` preview env first |
| The pre-built M5.1 debug APK (`finix-hr-dev-arm64-debug.apk`) | **ARTEFACT LOST** — the build environment was recycled; it was never in git (CNG output is gitignored) | rebuild locally via §4.3 Path A (~15 min on a first run) |
| `staging-oms.finixhr.com` / `oms.finixhr.com` reachability | **UNVERIFIED from the build environment** (DNS did not resolve there) | verify from your network before pointing any build at them |
| Google Play submission | **out of scope / ineligible** | targetSdk 34 vs the 2026 API 35/36 requirement — a future SDK upgrade task (see `docs/RELEASE-STATUS.md` §2.3), NOT this milestone |
| Desktop rebuild in the M5.1 environment | **BLOCKED there** (no Rust/webkit2gtk on Linux sandbox) | your Windows machine — previously verified (§8) |
| macOS desktop build | out of scope | GitHub Actions `desktop-release` workflow on macos runners |

### 11.3 Known quirks (documented, deliberately not "fixed")

- `seed:verify` reports "1 FIXTURE(S) MISSING (6/7)" for the EMP-0016 loan-arrears
  demo: the seeded **October payroll run legitimately recovers** one of the two
  overdue installments, so only 1 remains OVERDUE at month-end dates. The data is
  correct; the fixture check's `>= 2` threshold is date-dependent. Do not "fix" this
  by touching payroll logic.
- `docs/MULTI-PLATFORM.md` §3 still documents the **pre-`591a82e`** desktop config
  (`devUrl: http://localhost:4055`, `frontendDist: https://oms.finixhr.com`). The
  current design is the local hub (`frontendDist: "../ui"`, runtime-configurable
  URL). This guide supersedes that section; a docs refresh is a candidate for M6.
- `HRM_ALLOW_HTTP_LAN` appears in the env allowlist but nothing reads it — setting it
  is harmless but does nothing. Same-host LAN origins are already allowed by the
  origin rule; no action needed.
- The seed's `Pass@123` accounts force rotation on first login by design (C-02).

### 11.4 Hardware / credentials you still need

- An Android phone (API 33+), USB cable, and the Windows PC — for §10.
- (Later, optional) EAS account, Apple Developer account, code-signing certificate
  with timestamping for public desktop distribution, a deployed staging host if you
  want the `preview` profile to mean something.

---

*Prepared as deliverable M5.1 · 2026-10-31 · changes recorded in
`docs/engineering/IMPLEMENTATION_CHANGELOG.md`. Handover-verification addendum
(7th session, same day — Entry 36): cleartext release-build gap, APK artefact loss,
live push-state verification.*
