#!/usr/bin/env node
/**
 * Builds the Explorer thumbnail handler (solidus_thumbnail.dll), installed beside the application by the Windows
 * installer (tauri.windows.conf.json: resources, beforeBuildCommand; registration in windows/hooks.nsh).
 * On Windows: cargo; on Linux (cross-built installer): cargo-xwin, as the application itself.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const target = "x86_64-pc-windows-msvc";
const args = process.platform === "win32" ? ["build", "--release", "--target", target] : ["xwin", "build", "--release", "--target", target];
const r = spawnSync("cargo", args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
