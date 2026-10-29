# Implementation Report — 2026-10-07 (Device Sync, Mapping, Punch Alerts, Permissions)

Verified against the live ZKTeco SenseFace 3A (SN VGU6251500072, push protocol 2.4.1)
connected to the running dev server. `tsc --noEmit` clean; eslint clean on every
touched file (the remaining react-hooks findings in app-shell.tsx /
attendance-devices.tsx are pre-existing). Originals of every changed file are in
`_backup-before-claude-2026-10-07/`.

---

## 1. ADMS protocol — root causes found on the live device

| Symptom | Root cause | Fix |
|---|---|---|
| Historical sync never pulled anything; every queued command stuck at **SENT** | `/iclock/getrequest` returned bare commands (`CHECK\nOK`). ZKTeco firmware only executes `C:<id>:<command>` lines, so CHECK / DATA QUERY / roster pushes were silently ignored | `buildCommandResponse` emits `C:<id>:<cmd>`; `/iclock/devicecmd` results (`ID=…&Return=…&CMD=…`) are matched back to their command → DONE / FAILED with the return code |
| Device could not be told to re-upload its stored log | Handshake answered only non-standard keys (`ATTLOGFILE`, `ATTLOG=1` …); no `ATTLOGStamp` watermark | Standard ADMS options (`ATTLOGStamp`, `OPERLOGStamp`, `ErrorDelay`, `Delay`, `TransFlag`, `Realtime`, `Encrypt` …). Upload stamps the device reports are stored; a historical sync hands out `ATTLOGStamp=0` **once per run** → the device re-uploads its whole log |
| `DATA QUERY` range sync ignored | range parameters were space-separated | TAB-separated per spec |
| Large uploads would fail / loop | 500-line cap threw → HTTP 500 → device re-sent the same batch forever; 256 KB body cap; thousands of days rebuilt inline before the ACK | 20,000-line / 4 MB cap with a clean 413; large batches are ACKed immediately and processed by the sweeper |
| Device user list never reached the server | `table=OPERLOG` roster lines (`USER PIN=…`) and the options line (`~DeviceName=…`) were parsed as broken punches (INVALID) | Classifier honours the `table` parameter; `USER PIN=` KEY=VALUE format parsed; roster stored per device |
| **`/iclock/cdata` 404** | The gateway's own *"Unknown device <SN> — register it in HRM first"* answer (text/plain 404) — any SN not matching a registered device exactly | SN lookup now tolerates case differences and a serial entered only in the *Serial Number* field (unique match only). A genuinely unregistered terminal still gets 404 by design (no auto-registration of internet devices) |
| Duplicate-key errors in the server log | sweeper and live-push path rebuilt the same employee-day concurrently (`attendance.create` race) | Atomic upsert on `(vendorId, employeeId, date)`; event projection tolerant of concurrent writers; raw inserts use `ON CONFLICT DO NOTHING` |
| Comm-log flooding | one row per OPERLOG/USER/out-of-window line (a single push wrote 1,055 rows) | Capped per request; totals on the summary row |

### Check-out not showing (reported during testing)
The SenseFace 3A stamps **every** punch with status `0` ("Check-In") — 4,931 of 4,939 records — because the terminal is not using punch-state keys. The processor trusted that code, so every punch was a check-in and check-out stayed empty.
Fix (`processor.rebuildDaily`): when a day has **no explicit check-out-type punch** (status 1/2/5), punch order decides — first punch = check-in, last punch = check-out (a re-scan within 2 minutes of the first punch is ignored). Devices that do send real states keep state-based behaviour. All 1,199 historical days were rebuilt; e.g. 7 Oct now shows 09:08 → 17:22, 08:55 → 18:35 … with working minutes.
Note: for overnight shifts on a state-less device, a morning punch is attributed to its own calendar date; configure punch-state keys on the terminal if night shifts are used.

**Live result:** 28 → **4,939** raw events from the device (4,784 older than 1 Oct), all processed; commands complete with `Return=0`.

## 2. Automatic employee ↔ device mapping

- A device User ID that matches an HRM **Employee ID** is mapped automatically — on the first punch and as soon as the device reports its user list.
  - exact Employee ID (case-insensitive): `TCSBL-005` ↔ `TCSBL-005`
  - numeric PIN ↔ numeric part of the Employee ID (`12` ↔ `EMP-0012`) — only when unambiguous
- Existing admin decisions are never overridden (an INACTIVE mapping stays inactive). An exact-ID match may be added as a second PIN for an employee already enrolled under an old numeric PIN (that was the live issue: `TCSBL-004/005/006` were blocked by PINs `4/5/6`).
- **Attendance → Unknown Device Users** now shows the Employee-ID match per PIN, device-roster users that have not punched yet, an **Auto-map by Employee ID** button (`devices.autoMap`), and pre-selects the suggested employee in the manual dialog (plus "also keep existing PIN").
- Every automatic mapping is audit-logged (`devices.autoMap`).

## 3. Real-time punch notifications

- App-wide toast (`src/hrm/shared/punch-alerts.tsx`, mounted in the shell) for **device**, **geo-fence** and **selfie** punches.
- Settings: **HR Settings → Communications → Wishes & Notifications → Real-time Punch Alerts** — master switch, per-source switches, check-outs on/off, *who receives* (permission: Attendance View / Verify / Edit, Devices View, Live Tracking View), poll interval.
- Server route `attendance.punchAlerts`: returns nothing unless enabled and the caller holds the chosen permission; branch/department managers only get their own scope; cursor is the recording time and punches older than 30 min never alert (a historical backfill does not spray toasts).
- Each user can mute alerts in their own browser (bell on Attendance → Daily, same preference as before — no duplicate toasts).

## 4. Roles & Permissions

- New permission module **Subscription & Usage** (`subscription.view`) in Roles & Permissions.
- Granted by default to HR Admin, HR Manager, Payroll Officer, Branch Manager, Department Manager, Vendor Owner — **not** to Employee (Self-Service).
- Enforced server-side (`subscription.overview`), in navigation, the Plan & Usage dashboard widget and the header subscription chips. The Vendor Owner always keeps it (billing owner).

## 5. Errors

- **MaxListenersExceededWarning** — process listeners (`SIGTERM`, `SIGINT`, `uncaughtException`, `unhandledRejection`, `SIGUSR2`) were guarded by module-level flags; any re-evaluation of the instrumentation/lifecycle modules in the long-lived dev process stacked another set (SIGUSR2 had no guard). Now a process-wide registry on `globalThis` replaces a listener instead of adding one; SIGUSR2 is skipped on Windows. The jobs scheduler had the same flaw (duplicate timers → duplicate ticks) and the sweeper kept running stale code after edits; both now replace their timer.
- **`window.ethereum.selectedAddress`** — not in the application: the string appears in no source file and in no compiled client bundle. It is thrown by a crypto-wallet browser extension (MetaMask / Coinbase / Trust …) injecting into every page. Disable the extension for `localhost` (or test in a profile without it). Not suppressed in code.

## Files
Changed: `src/app/iclock/cdata/route.ts`, `src/app/iclock/getrequest/route.ts`,
`src/hrm-server/zkteco/{adapter,gateway,processor,sweeper}.ts`,
`src/hrm-server/routes/{devices,tracking,subscription}.ts`,
`src/hrm-server/{auth,jobs,lifecycle,settings,types}.ts`, `src/instrumentation.ts`,
`src/hrm/{app-shell.tsx,nav.ts}`, `src/hrm/dashboard/registry.tsx`,
`src/hrm/views/{attendance,attendance-devices,settings}.tsx`.
Added: `src/hrm/shared/punch-alerts.tsx`.
No database migration (device state lives in the existing `AttendanceDevice.configuration` JSON).

## After pulling these changes
Restart `bun run dev` once so the background sweeper/scheduler run the new code from a clean process.
