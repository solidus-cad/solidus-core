//! Native CAD kernel (cad-core): a separate `cad-kernel` process, driven by frames over stdin / stdout
//! (protocol: bindings/native/kernel_main.cpp; client: packages/kernel-wasm/src/native.ts).
//!
//! A single command, `kernel_exchange`: sends a frame to the kernel and returns its next frame (result, callback
//! or error), as raw binary. Callbacks (deferred sketch preparation) are simply additional exchanges:
//! the client replies, and the kernel resumes. The client serializes its requests.
//! A kernel that has stopped (OCCT crash) is restarted on the next request: the application stays open.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::ipc::Response;
use tauri::{AppHandle, Manager, WebviewWindow};

struct Process {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One kernel process per window: each window holds its own documents in its own kernel, and two windows never
/// interleave their frames (a window's client serializes its requests, not those of the other windows).
#[derive(Default)]
pub struct Kernel {
    windows: Mutex<HashMap<String, Arc<Mutex<Option<Process>>>>>,
}

const EXE: &str = if cfg!(windows) { "cad-kernel.exe" } else { "cad-kernel" };

/// Kernel location: `CAD_KERNEL`, then next to the executable (installed: `bundle.externalBin`),
/// then the output of `tools/build-kernel.sh native` (development).
fn locate() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CAD_KERNEL") {
        return Some(PathBuf::from(path));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) {
        let path = dir.join(EXE);
        if path.exists() {
            return Some(path);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../build/core-native/bindings").join(EXE);
    dev.exists().then_some(dev)
}

impl Kernel {
    fn start() -> Result<Process, String> {
        let path = locate().ok_or("Noyau natif introuvable (cad-kernel) : lancer tools/build-kernel.sh native")?;
        let mut cmd = Command::new(&path);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("cannot start the native kernel ({}): {e}", path.display()))?;
        let stdin = child.stdin.take().ok_or("native kernel: stdin unavailable")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("native kernel: stdout unavailable")?);
        Ok(Process { child, stdin, stdout })
    }

    /// Kernel slot of a window (created empty: the process starts on its first request).
    fn slot(&self, window: &str) -> Result<Arc<Mutex<Option<Process>>>, String> {
        let mut windows = self.windows.lock().map_err(|_| "native kernel: poisoned lock".to_string())?;
        Ok(windows.entry(window.to_string()).or_default().clone())
    }

    /// Window closed: its kernel process is stopped (`Process::drop`), once its current exchange is over.
    pub fn release(&self, window: &str) {
        if let Ok(mut windows) = self.windows.lock() {
            windows.remove(window);
        }
    }

    /// Sends a frame to the kernel of `window` and reads the next one: [u32 length][payload], little-endian.
    fn exchange(&self, window: &str, frame: &[u8]) -> Result<Vec<u8>, String> {
        let slot = self.slot(window)?;
        let mut guard = slot.lock().map_err(|_| "native kernel: poisoned lock".to_string())?;
        if guard.is_none() {
            *guard = Some(Self::start()?);
        }
        let process = guard.as_mut().expect("process started");
        let result = (|| -> std::io::Result<Vec<u8>> {
            process.stdin.write_all(&(frame.len() as u32).to_le_bytes())?;
            process.stdin.write_all(frame)?;
            process.stdin.flush()?;
            let mut len = [0u8; 4];
            process.stdout.read_exact(&mut len)?;
            let mut data = vec![0u8; u32::from_le_bytes(len) as usize];
            process.stdout.read_exact(&mut data)?;
            Ok(data)
        })();
        result.map_err(|e| {
            // Process stopped or protocol broken: restarted on the next request.
            *guard = None;
            format!("Le noyau natif s'est arrêté ({e}) ; il sera relancé à la prochaine requête")
        })
    }
}

/// Exchanges a frame with the native kernel (see packages/kernel-wasm/src/native.ts, `tauriExchange`).
#[tauri::command]
pub async fn kernel_exchange(app: AppHandle, window: WebviewWindow, frame: String) -> Result<Response, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || app.state::<Kernel>().exchange(&label, frame.as_bytes()).map(Response::new))
        .await
        .map_err(|e| e.to_string())?
}
