# Desktop application (Tauri 2)

Tauri shell around the web application (`apps/web/dist`), with the native kernel. Installers: NSIS (`.exe`) on
Windows, `.deb` and AppImage on Linux. A build from this repository works offline: no account, no server.

## Prerequisites (build machine)
- Node 22+, pnpm 9 (same as the web application).
- Rust: `winget install Rustlang.Rustup`, then Visual Studio Build Tools with "Desktop development with C++".

## Native CAD kernel
The desktop application computes with the **native** cad-core, 2 to 3 times faster than the browser WASM build. It runs as a separate process, `cad-kernel`, launched on demand by `src-tauri/src/kernel.rs`. It is bundled in the installer (`bundle.externalBin`). Build it before `tauri dev` or `tauri build`:
```sh
tools/build-occt.sh native     # once: native OCCT (long)
tools/build-kernel.sh native   # cad-core + copy to src-tauri/binaries/cad-kernel-<triplet>
```
If it is missing or fails to start, the interface falls back to the WASM cad-core, with a warning in the console. Details: `core/CONCEPTION.md`, "Native (desktop)".

## Commands (from the repository root)
```sh
pnpm desktop:dev                     # desktop window on the Vite server (hot reload)
pnpm desktop:version 0.2.0           # sets the version (apps/desktop/package.json, single source of truth)
pnpm desktop:build                   # installer → apps/desktop/src-tauri/target/release/bundle/nsis/ (Linux: deb/, appimage/)
CAD_DESKTOP_TARGET=x86_64-pc-windows-msvc pnpm desktop:build   # Windows installer from Linux (cargo-xwin, NSIS)
```
Modules can be built in with `CAD_EXTENSIONS` (see docs/MODULES.md). Installers built from this repository have no
automatic updates.

## Settings: `cad.config.toml`
The template is at the root of the repository. The installer places it at the root of the installation folder
(`%LOCALAPPDATA%\Solidus\cad.config.toml`, per-user installation, no administrator rights required):
- created at first installation, **never overwritten by an update** (hook `src-tauri/windows/hooks.nsh`);
- deleted only if the user checks "Delete application data" when uninstalling;
- missing key ⇒ default value; invalid file ⇒ warning at startup and default values;
- `CAD_CONFIG=<path>` forces another file (tests, deployment).

The settings used by the interface are injected into `window.__CAD_CONFIG__` before the page loads
(see `apps/web/src/desktop.ts`).

## Updates
- A more recent `setup.exe` run manually also performs the update (same application identifier).
