use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Listener, Manager};

/// DSK-3 — the launcher origin is platform-dependent: macOS serves the
/// bundled frontend from `tauri://localhost`, while Windows and Linux use
/// `http://tauri.localhost`. The previously hardcoded Windows/Linux origin
/// made every macOS navigation back to the launcher silently fail, strand-
ing users in the Server Connection Manager and after session clears.
fn launcher_origin() -> &'static str {
    if cfg!(target_os = "macos") {
        "tauri://localhost"
    } else {
        "http://tauri.localhost"
    }
}

/// FIN-030 (Phase 3) — DESKTOP MULTI-COMPANY CONTEXT. The web app now
/// announces every company-context change: a `finix:company-switched` DOM
/// event plus an active-company segment in the page's <title> (whose books
/// are open). The desktop shell — a window with NO address bar — mirrors
/// that title into the NATIVE title bar so the workstation shows the active
/// company at all times. Mechanism: on every page load (the workspace pages
/// are remote origins — a connected, verified Finix server) this hook
/// injects a tiny observer that pushes document.title through the Tauri
/// event channel (core:event:default, granted to remote origins by the
/// finix-remote-title capability — title-bar text only; the page body can
/// already render arbitrary text, so this adds no new capability), and the
/// Rust listener below applies it with a sane length clamp.
const FIN30_TITLE_BRIDGE: &str = r#"
(function () {
  function push() {
    try {
      if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.emit === 'function') {
        window.__TAURI__.event.emit('finix:page-title', document.title || '');
      }
    } catch (e) { /* bridge unavailable in this build — title stays page-local */ }
  }
  push();
  var el = document.querySelector('head title');
  if (el) {
    new MutationObserver(push).observe(el, { childList: true, characterData: true, subtree: true });
  } else if (document.head) {
    new MutationObserver(push).observe(document.head, { childList: true, subtree: true });
  }
})();"#;

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// FIN-032 (Phase 2) — clear the webview's persisted session data (cookies,
/// local/session storage, cache) of every previously connected server and
/// return to the launcher. Until now webview cookies survived restarts with
/// no clearing affordance, so a shared computer kept the last user signed in.
#[tauri::command]
fn clear_session(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        // wipes cookies + storage + cache of all origins loaded in this webview
        let _ = window.clear_all_browsing_data();
        // back to the verification launcher (NOT the last server URL) —
        // DSK-3: platform-correct origin instead of the hardcoded
        // Windows/Linux one that failed on macOS
        let _ = window.eval(&format!(
            "window.location.replace('{}')",
            launcher_origin()
        ));
    }
    Ok(())
}

/// FIN-034 (Phase 2) / DSK-1 — the update channel. The updater plugin is
/// registered unconditionally at startup (see `run`); this helper performs
/// one check against the signed update manifest served at the configured
/// endpoint (pubkey + endpoint live in tauri.conf.json plugins.updater).
/// Failures are logged, never fatal — an unreachable update server must
/// not take the HR workstation down.
#[cfg(desktop)]
fn check_for_updates(app: &tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match handle.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[finix] update channel unavailable (no release key configured?): {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                eprintln!(
                    "[finix] update available: v{} (current v{})",
                    update.version, update.current_version
                );
                match update
                    .download_and_install(|_chunk, _total| {}, || {})
                    .await
                {
                    Ok(()) => handle.restart(),
                    Err(e) => eprintln!("[finix] update install failed: {e}"),
                }
            }
            Ok(None) => {
                eprintln!("[finix] no update available");
            }
            Err(e) => eprintln!("[finix] update check failed: {e}"),
        }
    });
}

/// DSK-1 — re-check the signed update channel once a day: HR workstations
/// stay open for weeks, so a startup-only check would pin them to the
/// version they booted with. A plain OS thread keeps this dependency-free;
/// each tick just schedules `check_for_updates` on the async runtime.
#[cfg(desktop)]
fn spawn_daily_update_checks(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
        check_for_updates(&handle);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // DSK-1 — the updater plugin is now registered unconditionally:
        // the release pubkey is provisioned in tauri.conf.json
        // (plugins.updater.pubkey) and bundle.createUpdaterArtifacts is on,
        // so the shipped client actually polls the signed update channel.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // FIN-030 (Phase 3) — mirror the workspace page's <title> (which
        // carries the active company, set by the web app's
        // publishCompanyContext) into the native title bar.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(FIN30_TITLE_BRIDGE);
            }
        })
        .setup(|app| {
            // FIN-030 — the native title follows the page title events
            // (JSON-string payload; strip the quotes, clamp the length).
            {
                let handle = app.handle().clone();
                app.listen("finix:page-title", move |event| {
                    if let Some(window) = handle.get_webview_window("main") {
                        let raw = event.payload();
                        let title = raw
                            .trim_matches('"')
                            .replace("\\\"", "\"")
                            .replace("\\n", " ")
                            .trim();
                        let clamped: String = title.chars().take(120).collect();
                        if !clamped.is_empty() {
                            let _ = window.set_title(&clamped);
                        }
                    }
                });
            }

            // DSK-1 — the startup and daily checks only run when a release
            // pubkey is actually configured, so a blanked-pubkey build
            // degrades to log lines instead of failed update requests.
            let updater_configured = app
                .config()
                .plugins
                .get("updater")
                .and_then(|v| v.get("pubkey"))
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

            let switch_server_item = MenuItemBuilder::with_id("switch_server", "Server Connection Manager (Launcher)")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let reload_item = MenuItemBuilder::with_id("reload_app", "Reload Workspace")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            // FIN-032 — the missing session-clearing affordance
            let clear_session_item = MenuItemBuilder::with_id("clear_session", "Clear Session Data && Sign Out")
                .build(app)?;
            // FIN-034 — manual update check (the pinned update policy also
            // runs it on app start once the release key is configured)
            let check_updates_item = MenuItemBuilder::with_id("check_updates", "Check for Updates…")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit_app", "Quit Finix HR")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;

            let file_submenu = SubmenuBuilder::new(app, "Workspace")
                .items(&[&switch_server_item, &reload_item, &clear_session_item, &check_updates_item, &quit_item])
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&file_submenu])
                .build()?;

            app.set_menu(menu)?;

            // FIN-034/DSK-1 — pinned update policy: check for signed
            // updates at startup and then once a day whenever the channel
            // is configured (failures are logged, never fatal — an
            // unreachable update server must not take the HR workstation
            // down).
            if updater_configured {
                #[cfg(desktop)]
                {
                    let app_handle = app.handle().clone();
                    check_for_updates(&app_handle);
                    spawn_daily_update_checks(&app_handle);
                }
            }

            app.on_menu_event(move |app_handle, event| {
                if event.id() == "switch_server" {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        // DSK-3 — platform-correct launcher origin
                        let _ = window.eval(&format!(
                            "window.location.href = '{}'",
                            launcher_origin()
                        ));
                    }
                } else if event.id() == "reload_app" {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval("window.location.reload()");
                    }
                } else if event.id() == "clear_session" {
                    let _ = clear_session(app_handle.clone());
                } else if event.id() == "check_updates" {
                    #[cfg(desktop)]
                    check_for_updates(app_handle);
                } else if event.id() == "quit_app" {
                    app_handle.exit(0);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_version, clear_session])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
