// No console in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod files;
mod kernel;
mod links;
mod migrate;
mod oauth;
mod windows;

// Official builds: updates and device key (account module, private repository cloned into ext/account).
#[cfg(feature = "official")]
#[path = "../../../../ext/account/desktop/device.rs"]
mod device;
#[cfg(feature = "official")]
#[path = "../../../../ext/account/desktop/updates.rs"]
mod updates;

use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(kernel::Kernel::default());
    #[cfg(not(feature = "official"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        kernel::kernel_exchange,
        files::fs_read,
        files::fs_write,
        files::fs_exists,
        files::fs_pick_open,
        files::fs_pick_save,
        files::fs_pick_dir,
        windows::window_new,
        links::open_external,
        oauth::oauth_loopback,
    ]);
    #[cfg(feature = "official")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).invoke_handler(tauri::generate_handler![
        kernel::kernel_exchange,
        files::fs_read,
        files::fs_write,
        files::fs_exists,
        files::fs_pick_open,
        files::fs_pick_save,
        files::fs_pick_dir,
        windows::window_new,
        links::open_external,
        oauth::oauth_loopback,
        updates::check_updates,
        updates::pending_update,
        device::device_key,
        device::device_sign,
    ]);
    builder
        .on_window_event(|window, event| {
            // A closed window no longer needs its kernel.
            if let WindowEvent::Destroyed = event {
                window.app_handle().state::<kernel::Kernel>().release(window.label());
            }
        })
        .setup(|app| {
            migrate::former_identifier(app.handle());
            let loaded = config::load(app.handle());
            let version = app.package_info().version.to_string();
            // Injected before any page script: the interface reads its settings synchronously.
            app.manage(windows::InitScript(format!("window.__CAD_CONFIG__ = {};", loaded.config.frontend(&version))));
            windows::open_main(app.handle())?;
            if let Some(error) = loaded.error {
                app.dialog().message(error).title("Solidus — cad.config.toml").kind(MessageDialogKind::Warning).show(|_| {});
            }
            app.manage(loaded.config);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Solidus failed to start");
}
