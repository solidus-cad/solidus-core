//! Settings read from `cad.config.toml` (root of the installation folder, see the template at the root of the repository).
//! Any missing key takes its default value: a file from an older version remains valid.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const FILE_NAME: &str = "cad.config.toml";
/// Template installed next to the executable, replaced in every version.
const DEFAULT_FILE_NAME: &str = "cad.config.default.toml";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    #[cfg(feature = "official")]
    pub library: Library,
    #[cfg(feature = "official")]
    pub updates: Updates,
    pub network: Network,
    pub ui: Ui,
}

/// Server of the official builds (`[library]`, read by the account module).
#[cfg(feature = "official")]
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Library {
    pub url: String,
    pub id: String,
    pub retries: u32,
    /// Authentication service (GoTrue); empty: sign in with a pasted token.
    pub auth_url: String,
}

#[cfg(feature = "official")]
impl Default for Library {
    fn default() -> Self {
        // Server of the official builds, set at build time by their release script.
        let url = option_env!("CAD_LIBRARY_URL").unwrap_or_default();
        let auth_url = option_env!("CAD_AUTH_URL").unwrap_or_default();
        Self { url: url.into(), id: "cad-library".into(), retries: 1, auth_url: auth_url.into() }
    }
}

/// Updates of the official builds (`[updates]`).
#[cfg(feature = "official")]
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Updates {
    pub enabled: bool,
    pub endpoint: String,
    pub check_on_startup: bool,
}

#[cfg(feature = "official")]
impl Default for Updates {
    fn default() -> Self {
        // Update manifest, set at build time by the release script.
        let endpoint = option_env!("CAD_UPDATE_ENDPOINT").unwrap_or_default();
        Self { enabled: true, endpoint: endpoint.into(), check_on_startup: true }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Network {
    pub proxy: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Ui {
    pub language: String,
}

impl Default for Ui {
    fn default() -> Self {
        Self { language: "auto".into() }
    }
}

impl Config {
    /// Settings used by the interface, injected into `window.__CAD_CONFIG__` (see apps/web/src/desktop.ts).
    pub fn frontend(&self, version: &str) -> Value {
        #[allow(unused_mut)]
        let mut v = json!({
            "desktop": { "version": version, "hostname": hostname() },
            "ui": { "language": self.ui.language },
        });
        #[cfg(feature = "official")]
        {
            v["library"] = json!({ "url": self.library.url, "id": self.library.id, "retries": self.library.retries, "authUrl": self.library.auth_url });
            v["updates"] = json!({ "enabled": self.updates.enabled, "checkOnStartup": self.updates.check_on_startup });
        }
        v
    }
}

/// Computer name (floating license: the name, e.g. "PC-ATELIER", is shown to colleagues).
fn hostname() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default()
}

pub struct Loaded {
    pub config: Config,
    /// Message to show the user (unreadable or invalid file); default values apply.
    pub error: Option<String>,
}

/// Candidate files, from highest to lowest priority.
fn candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(p) = std::env::var_os("CAD_CONFIG") {
        list.push(PathBuf::from(p));
    }
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)) {
        dirs.push(dir);
    }
    // Linux: the installation folder (/usr/bin, /usr/lib/Solidus) is owned by root; settings live in ~/.config.
    if cfg!(target_os = "linux") {
        if let Ok(dir) = app.path().app_config_dir() {
            dirs.push(dir);
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir);
    }
    // `tauri dev`: the file at the root of the repository.
    if cfg!(debug_assertions) {
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    }
    list.extend(dirs.iter().map(|d| d.join(FILE_NAME)));
    list.extend(dirs.iter().map(|d| d.join(DEFAULT_FILE_NAME)));
    list
}

pub fn load(app: &AppHandle) -> Loaded {
    let Some(path) = candidates(app).into_iter().find(|p| p.is_file()) else {
        return Loaded { config: Config::default(), error: None };
    };
    let parsed = std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| toml::from_str::<Config>(&text).map_err(|e| e.to_string()));
    match parsed {
        Ok(config) => Loaded { config, error: None },
        Err(e) => Loaded {
            config: Config::default(),
            error: Some(format!(
                "Le fichier de paramètres est invalide ; les valeurs par défaut sont utilisées.\nThe settings file is invalid; the default values are used.\n\n{}\n\n{e}",
                path.display()
            )),
        },
    }
}
