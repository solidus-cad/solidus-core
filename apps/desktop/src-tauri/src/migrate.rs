//! Data of the versions published under a former application identifier: settings (Linux), window positions, web
//! view storage (preferences, session, recent files) and, on Linux, the device key file. At the first start under the
//! current identifier, each folder is moved once, before any window exists.

use tauri::{AppHandle, Manager};

/// Former identifiers, most recent first: `fr.coposoftware.cad` (first 2026.1.6 build), `fr.industriapp.cad` (up to
/// 2026.1.5). The first one found is moved; an older one left beside it stays as it is.
const FORMER_IDENTIFIERS: [&str; 2] = ["fr.coposoftware.cad", "fr.industriapp.cad"];

pub fn former_identifier(app: &AppHandle) {
    let current = app.config().identifier.clone();
    let path = app.path();
    // Windows: Roaming (data, config) and Local (WebView2 profile); Linux: ~/.local/share, ~/.config, ~/.cache.
    for base in [path.data_dir(), path.local_data_dir(), path.config_dir(), path.cache_dir()].into_iter().flatten() {
        let new = base.join(&current);
        if new.exists() {
            continue;
        }
        let Some(former) = FORMER_IDENTIFIERS.iter().filter(|f| **f != current).map(|f| base.join(f)).find(|f| f.is_dir()) else {
            continue;
        };
        if let Err(e) = std::fs::rename(&former, &new) {
            eprintln!("[migrate] {} -> {}: {e}", former.display(), new.display());
        }
    }
}
