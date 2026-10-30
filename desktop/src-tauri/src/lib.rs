use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Manager;

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let switch_server_item = MenuItemBuilder::with_id("switch_server", "Server Connection Manager (Launcher)")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let reload_item = MenuItemBuilder::with_id("reload_app", "Reload Workspace")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit_app", "Quit Finix HR")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;

            let file_submenu = SubmenuBuilder::new(app, "Workspace")
                .items(&[&switch_server_item, &reload_item, &quit_item])
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&file_submenu])
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                if event.id() == "switch_server" {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval("window.location.href = 'http://tauri.localhost'");
                    }
                } else if event.id() == "reload_app" {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval("window.location.reload()");
                    }
                } else if event.id() == "quit_app" {
                    app_handle.exit(0);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
