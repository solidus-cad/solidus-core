//! Document files (parts, assemblies, drawings): an assembly references its parts by their path, so the
//! interface reads and writes neighboring files (see apps/web/src/docfiles/fs.ts).
//! Only document extensions are accessible: the rest of the disk stays out of the page's reach.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const EXTENSIONS: [&str; 4] = ["vpart", "vasm", "vdrw", "vcam"];
/// Documents, and the packs exported as zip archives (never read back through this API).
const WRITABLE: [&str; 5] = ["vpart", "vasm", "vdrw", "vcam", "zip"];

fn checked_among(path: &str, allowed: &[&str]) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !p.is_absolute() || !allowed.contains(&ext.as_str()) {
        return Err(format!("path refused: {path}"));
    }
    Ok(p)
}

fn checked(path: &str) -> Result<PathBuf, String> {
    checked_among(path, &EXTENSIONS)
}

fn shown(p: PathBuf) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Decodes `encodeURIComponent` output (`x-path` header).
fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_read(path: String) -> Result<Response, String> {
    let p = checked(&path)?;
    tauri::async_runtime::spawn_blocking(move || std::fs::read(&p))
        .await
        .map_err(|e| e.to_string())?
        .map(Response::new)
        .map_err(|e| format!("{path} : {e}"))
}

/// Raw body = content; path in the `x-path` header. Writes to a temporary file, then renames it:
/// an interrupted save never leaves a half-written document behind.
#[tauri::command]
pub async fn fs_write(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("contenu binaire attendu".into());
    };
    let header = request.headers().get("x-path").ok_or("missing x-path header")?.to_str().map_err(|e| e.to_string())?;
    let path = percent_decode(header)?;
    let p = checked_among(&path, &WRITABLE)?;
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = p.with_extension("tmp-solidus");
        std::fs::write(&tmp, &data)?;
        std::fs::rename(&tmp, &p)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{path} : {e}"))
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    checked(&path).map(|p| p.is_file()).unwrap_or(false)
}

#[derive(Deserialize)]
pub struct Filter {
    name: String,
    exts: Vec<String>,
}

/// File dialog, modal to the window that asked for it.
fn file_dialog(app: &AppHandle, window: &WebviewWindow, filters: &[Filter]) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut d = app.dialog().file().set_parent(window);
    for f in filters {
        let exts: Vec<&str> = f.exts.iter().map(String::as_str).collect();
        d = d.add_filter(&f.name, &exts);
    }
    d
}

#[tauri::command]
pub async fn fs_pick_open(app: AppHandle, window: WebviewWindow, filters: Vec<Filter>) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    file_dialog(&app, &window, &filters).pick_file(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(shown)
}

#[tauri::command]
pub async fn fs_pick_save(app: AppHandle, window: WebviewWindow, name: String, dir: Option<String>, filters: Vec<Filter>) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut d = file_dialog(&app, &window, &filters).set_file_name(&name);
    if let Some(dir) = dir.as_deref().map(Path::new).filter(|d| d.is_dir()) {
        d = d.set_directory(dir);
    }
    d.save_file(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(shown)
}

#[tauri::command]
pub async fn fs_pick_dir(app: AppHandle, window: WebviewWindow) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    file_dialog(&app, &window, &[]).pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = if cfg!(windows) { "C:/p/" } else { "/p/" };

    #[test]
    fn documents_are_readable_and_writable() {
        for ext in ["vpart", "vasm", "vdrw", "vcam"] {
            let path = format!("{DIR}a.{ext}");
            assert!(checked(&path).is_ok(), "{path}");
            assert!(checked_among(&path, &WRITABLE).is_ok(), "{path}");
        }
    }

    #[test]
    fn packs_are_write_only_and_other_files_refused() {
        let pack = format!("{DIR}a.zip");
        assert!(checked(&pack).is_err());
        assert!(checked_among(&pack, &WRITABLE).is_ok());
        assert!(checked(&format!("{DIR}a.exe")).is_err());
        assert!(checked("a.vpart").is_err());
    }
}
