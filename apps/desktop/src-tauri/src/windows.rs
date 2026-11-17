//! Application windows: the main window, and additional windows opened by Window › New window (one per screen,
//! for example a part on one and the assembly or drawing that uses it on the other).
//! Each window has its own documents and its own kernel process (kernel.rs); they share only the files on disk,
//! and the interface reloads its references when another window saves them (apps/web/src/docfiles/sync.ts).
//! Position, size and screen of each window are restored from one session to the next (window-state plugin,
//! keyed by window label: the first additional window of a session reopens where the previous one was).

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Script injected before any page script in every window (`window.__CAD_CONFIG__`).
pub struct InitScript(pub String);

/// Number of the next additional window (`w-2`, `w-3`…).
static NEXT: AtomicU32 = AtomicU32::new(2);

fn build(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    // `__CAD_WINDOW__`: the interface keeps the autosave for the main window (apps/web/src/desktop.ts).
    let script = format!("{}\nwindow.__CAD_WINDOW__ = {label:?};", app.state::<InitScript>().0);
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        // Product name (productName of tauri.conf.json, which the release script of the official builds may set).
        .title(&app.package_info().name)
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .maximized(label == "main")
        .initialization_script(&script)
        // HTML5 drag and drop in the page (opening files, tree view, etc.).
        .disable_drag_drop_handler()
        // The window never leaves the application: on a remote page every command would be refused by the ACL
        // (no native kernel, no file dialogs). Web pages go to the default browser.
        .on_navigation(|url| {
            if is_app_url(url) {
                return true;
            }
            if url.scheme() == "https" {
                let _ = crate::links::open_external(url.to_string());
            }
            false
        })
        .build()
}

/// Pages of the application: `tauri://localhost` (Linux, macOS), `http(s)://tauri.localhost` (Windows),
/// the Vite server in development, and blank documents.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            host == "tauri.localhost" || (cfg!(debug_assertions) && (host == "localhost" || host == "127.0.0.1"))
        }
        _ => false,
    }
}

pub fn open_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    build(app, "main")
}

/// Opens an additional window (Window › New window).
#[tauri::command]
pub async fn window_new(app: AppHandle) -> Result<(), String> {
    let label = format!("w-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let window = build(&app, &label).map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(u: &str) -> bool {
        is_app_url(&Url::parse(u).unwrap())
    }

    #[test]
    fn stays_in_the_application() {
        assert!(app("tauri://localhost/"));
        assert!(app("http://tauri.localhost/index.html#access_token=x"));
        assert!(app("https://tauri.localhost/"));
        assert!(app("about:blank"));
        assert!(!app("https://app.solidus-cad.com/"));
        assert!(!app("https://auth.solidus-cad.com/authorize?provider=google"));
        assert!(!app("http://tauri.localhost.example.com/"));
        assert!(!app("file:///etc/passwd"));
    }
}
