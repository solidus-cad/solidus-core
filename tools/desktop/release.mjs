#!/usr/bin/env node
/**
 * Desktop application (apps/desktop, Tauri): version and local installers.
 * Windows: NSIS (.exe). Linux: .deb and AppImage (tauri.linux.conf.json).
 *
 *   node tools/desktop/release.mjs version 2027.1.0   sets the version (apps/desktop/package.json)
 *   node tools/desktop/release.mjs build              builds the installers for the current platform
 *   CAD_DESKTOP_TARGET=x86_64-pc-windows-msvc node tools/desktop/release.mjs build   Windows installer from Linux
 *
 * Modules built in: `CAD_EXTENSIONS` (comma-separated entry points, see docs/MODULES.md); none by default.
 * The installers built here have no automatic updates. The official builds (signed updates, license keys)
 * use the release script of the private account module (ext/account/desktop/release.mjs), which takes over every
 * command when that module is present.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const official = join(root, "ext/account/desktop/release.mjs");
if (existsSync(official)) {
  await import(pathToFileURL(official).href);
} else {
  const desktop = join(root, "apps/desktop");
  const pkgPath = join(desktop, "package.json");
  const crossTarget = process.env.CAD_DESKTOP_TARGET || "";
  const bundleDir = join(desktop, crossTarget ? `src-tauri/target/${crossTarget}/release/bundle` : "src-tauri/target/release/bundle");

  const fail = (msg) => {
    console.error(`\n✘ ${msg}`);
    process.exit(1);
  };
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

  const [command, value] = process.argv.slice(2);
  switch (command) {
    case "version": {
      if (!/^\d+\.\d+\.\d+$/.test(value ?? "")) fail("expected version: x.y.z (e.g. 2027.1.0)");
      const pkg = readJson(pkgPath);
      pkg.version = value;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`Desktop application version: ${value}`);
      break;
    }
    case "build": {
      if (spawnSync("cargo", ["--version"], { shell: process.platform === "win32" }).status !== 0) fail("Rust not found (https://rustup.rs).");
      if (!existsSync(join(desktop, "src-tauri/icons/icon.ico"))) run("pnpm", ["--filter", "@solidus-cad/desktop", "icons"]);
      process.env.VITE_DESKTOP_VERSION = readJson(pkgPath).version;
      const args = ["--filter", "@solidus-cad/desktop", "tauri", "build"];
      if (crossTarget) args.push("--runner", "cargo-xwin", "--target", crossTarget);
      run("pnpm", args);
      console.log(`\n✔ Installer(s) ${readJson(pkgPath).version}: ${bundleDir}`);
      break;
    }
    default:
      fail("expected command: version <x.y.z> | build");
  }
}
