//! External links: web pages (customer area, payment, licence texts) opened in the default browser of the system.
//! The webview opens no new window: `window.open` and links with `target="_blank"` of the page come here
//! (apps/web/src/desktop.ts). HTTPS addresses only, passed as a single argument (no shell).

use std::process::Command;

/// Opens `url` in the default browser. Refuses anything but `https://` (local files, other schemes).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let ok = url.starts_with("https://") && url.len() <= 4096 && !url.chars().any(|c| c.is_control() || c == ' ' || c == '"');
    if !ok {
        return Err("adresse refusée (https:// uniquement)".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // rundll32 receives the address as one argument; `cmd /c start` would interpret its "&" characters.
        let mut c = Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("navigateur introuvable : {e}"))
}
