# Finix HR Desktop — Release Checklist (FIN-034, Phase 2)

The desktop shell hardening landed in code; the items below are the
**operator-side steps** that turn the wiring into a live, signed update
channel. They are release-blocking for the next signed desktop build.

> **Remediation log — 2026-11-09 (audit chapter 16, P1 wave):** the three
> desktop release blockers are addressed in code:
>
> - **DSK-1 [High] (updater ships inert)** — minisign keypair generated with
>   `bunx @tauri-apps/cli signer generate`; the real public key is now in
>   `desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`,
>   `bundle.createUpdaterArtifacts` is `true`, and the updater plugin is
>   registered unconditionally in `src-tauri/src/lib.rs` (startup check +
>   daily re-check + Workspace → "Check for Updates…"). Remaining operator
>   steps: §1 below (stand up the endpoint, secure the private key, build).
> - **DSK-2 [High] (clear-session link was a silent IPC no-op)** —
>   `app.withGlobalTauri` is now `true` in `tauri.conf.json` and the main
>   window is covered by `src-tauri/capabilities/default.json`
>   (`core:default`; the app's own commands `app_version` and
>   `clear_session` are allowed on local origins by the Tauri 2 ACL default
>   for app commands). `ui/app.js` now invokes the command through the
>   bridge and, if it is ever missing, falls back to a local wipe with an
>   explicit "cookies were NOT wiped" message. **Manual shared-computer
>   test still required** (§6 below).
> - **DSK-3 [Medium] (macOS navigation hardcoded to the Windows origin)** —
>   `src-tauri/src/lib.rs` now resolves the launcher origin per platform
>   (`tauri://localhost` on macOS, `http://tauri.localhost` elsewhere) via
>   `launcher_origin()`, used by both the menu's Server Connection Manager
>   navigation and the post-clear `window.location.replace`. Verify on a
>   macOS build (§6 below).
>
> `cargo build` was **not** run in the remediation sandbox (no Rust
> toolchain): `Cargo.lock` still lacks `tauri-plugin-updater`, so the first
> build on a real toolchain must refresh the lockfile (`cargo build` does
> this automatically unless `--locked`).

## 1. Provision the updater keypair and endpoint (once)

The update channel is wired end-to-end (`tauri-plugin-updater` in
`Cargo.toml`, unconditional registration + startup check + daily re-check +
"Check for Updates…" menu item in `src-tauri/src/lib.rs`, config in
`tauri.conf.json` → `plugins.updater`) and the keypair is generated — what
remains is hosting the endpoint and running the signed build.

- [x] Generate the minisign keypair (done 2026-11-09):
      `bunx @tauri-apps/cli signer generate -w <path> --password ""`
- [x] Paste the **public** key into `desktop/src-tauri/tauri.conf.json` →
      `plugins.updater.pubkey` (done; key id `29140B71CAA010D7`).
- [ ] **Move the private key into the release vault — it currently lives
      OUTSIDE the repository at
      `/home/z/my-project/download/desktop-updater-private-key.txt`
      (companion public key: `desktop-updater-private-key.txt.pub`;
      see `desktop-updater-README.txt` in the same directory for usage,
      a sandbox-encoded copy, and regeneration instructions).
      It must NEVER be committed or copied into the repo; if it leaks,
      regenerate the keypair and republish a signed update immediately.**
      If the key is lost, regenerate with the command above and update
      `plugins.updater.pubkey` (clients on the old key will have to be
      manually reinstalled once — after that the new channel holds).
- [ ] Stand up the endpoint behind the configured URL
      (`https://releases.finixhr.example/finix-hr-desktop/{{target}}/{{arch}}/{{current_version}}`)
      serving `latest.json` + the platform archives. NOTE:
      `releases.finixhr.example` is a deliberately **documented placeholder
      host** (`.example` is the reserved documentation TLD) — the operator
      must either stand it up behind that name or repoint
      `plugins.updater.endpoints` at the production host before the next
      signed release; do NOT ship a build pointing at a host nobody owns.
- [x] Enable updater artifacts in the build:
      `bundle.createUpdaterArtifacts: true` is set in `tauri.conf.json`;
      build with `bunx @tauri-apps/cli build` and publish BOTH the archive
      and its `.sig` file.
- [x] Pin the update policy: the app checks at startup and once a day
      (failures are logged, never fatal) and via Workspace →
      "Check for Updates…".

## 2. Windows signing — RFC-3161 timestamp (config done)

`bundle.windows.timestampUrl` is now `http://timestamp.digicert.com`, so
signatures remain valid after the code-signing certificate expires (the
shipped config had `timestampUrl: null`). Verify on the next build that
`signtool verify /pa /v` shows a RFC-3161 timestamp counter-signature.

## 3. macOS signing — ad-hoc now, real identity for release

`bundle.macOS.signingIdentity` is set to `"-"` (ad-hoc): local builds are
signed consistently and Gatekeeper behavior is deterministic. For the public
release:

- [ ] Set `signingIdentity` to the "Apple Development"/"Developer ID
      Application" certificate from the keychain.
- [ ] Enable notarization (`APPLE_*` env vars / `tauri.conf.json` hardened
      runtime options) so Gatekeeper does not train users to bypass warnings
      (which compounded the FIN-032 phishing risk).

## 4. Server verification expectations (FIN-032)

The shell refuses to navigate its address-bar-less window to any host that
does not serve `GET /api/health` → `{ ok: true, product: "finix-hr" }`
(the route now sends `Access-Control-Allow-Origin: *` for exactly this
read-only probe). Loopback (any port) and the official cloud hosts
(`finixhrm.com`, `oms.finixhr.com`) navigate once verified; every other host
requires the typed confirmation phrase **"I trust this server"** and is then
remembered in local storage. If you deploy additional official cloud hosts,
add them to `CLOUD_ALLOWLIST` in `desktop/ui/app.js`.

## 5. CSP

`app.security.csp` now mirrors the web app's policy for the shell page:
`script-src 'self'` (no `unsafe-inline`, no remote script loading — the old
policy allowed any injected script to load code from any host, including
downgrade `http:`), `connect-src 'self' https: http://localhost:* http://127.0.0.1:*`
(the health probe + loopback self-hosting), everything else `default-src
'self'`. Fully dynamic per-configured-server CSP (the audit's stretch goal)
would require rebuilding the webview at runtime; the static policy above
closes the code-loading hole without it and is what ships now.

## 6. Remaining manual verification (post-remediation, 2026-11-09)

These require a real build and hardware; the sandbox remediation could not
run them:

- [ ] **Shared-computer test (DSK-2, audit-required):** on a machine shared
      by two users, sign in to a server as user A, click the in-page
      "Clear session data" link in the settings modal, then reopen the app
      and connect as user B — user A's server cookies must NOT be replayed
      (the previous silent no-op left them alive). Repeat with the menu item
      (Workspace → "Clear Session Data && Sign Out") and confirm the app
      returns to the launcher in both cases.
- [ ] **macOS navigation test (DSK-3):** on a macOS build, verify that the
      Server Connection Manager menu item and the post-clear navigation both
      return to the launcher (origin `tauri://localhost`) instead of dying
      silently on `http://tauri.localhost`.
- [ ] **First real build:** run `cargo build` (or `cargo update`) inside
      `desktop/src-tauri/` so `Cargo.lock` picks up `tauri-plugin-updater`,
      then `bunx @tauri-apps/cli build` with
      `TAURI_SIGNING_PRIVATE_KEY=<private key file contents or path>` and
      `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` to produce signed updater
      artifacts.
- [ ] **Updater end-to-end:** publish v1.0.1 to the endpoint from §1, run
      the v1.0.0 client, and confirm the startup check (or Workspace →
      "Check for Updates…") offers and installs the signed update and
      restarts on the new version.
- [ ] **FIN-030 (Phase 3) — desktop multi-company title bar:** the Rust
      changes (FIN30_TITLE_BRIDGE + the `finix:page-title` listener in
      `run()`, `on_page_load` hook) need a `cargo build` pass — no Rust
      toolchain exists in the remediation sandbox, so this is a checklist
      item, not a verified gate. Verify on a real build: sign in, switch
      Company A → B, and confirm the NATIVE title bar shows
      "Finix HR — HRM Workspace · <Company>" (the page-side contract — the
      `finix:company-switched` event + the title segment — is pinned by
      tests/e2e-ui/desktop-company-switch.spec.ts, which runs in the default
      e2e lane and the FIN-035 nightly). Also confirm the remote-origin
      event grant (capabilities/finix-remote-title.json) is accepted by the
      ACL compiler: `bunx @tauri-apps/cli build` regenerates
      gen/schemas/* — a rejected capability fails the build.
