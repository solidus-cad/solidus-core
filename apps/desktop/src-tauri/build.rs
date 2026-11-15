fn main() {
    // Update manifest of the edition (src/config.rs, official builds), set by the release script.
    println!("cargo:rerun-if-env-changed=CAD_UPDATE_ENDPOINT");
    println!("cargo:rerun-if-env-changed=CAD_LIBRARY_URL");
    println!("cargo:rerun-if-env-changed=CAD_AUTH_URL");
    tauri_build::build()
}
