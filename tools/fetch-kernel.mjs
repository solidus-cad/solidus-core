#!/usr/bin/env node
/**
 * Places the precompiled WebAssembly kernel in packages/kernel-wasm/dist/ (kernel.js, kernel.wasm, kernel.d.ts) without
 * rebuilding OCCT (several tens of minutes). For contributors who do not touch the C++ code: the CIs,
 * for their part, build the kernel of the commit (.github/actions/kernel-wasm).
 *
 *   node tools/fetch-kernel.mjs                       release pinned in tools/kernel-version.json (GitHub Releases)
 *   node tools/fetch-kernel.mjs --from file.tar.gz    local archive of the same format (testing, offline)
 *   node tools/fetch-kernel.mjs --force               replaces an existing dist/
 *
 * The `kernel-wasm-<release>.tar.gz` archive (contents of dist/ at the root) is attached to the releases of the
 * repository named in tools/kernel-version.json. Integrity: its SHA-512 (sri) is compared to that of tools/kernel-version.json when it is set.
 * The downloaded kernel matches the C++ of this release: after a change in core/, rebuild it.
 * To rebuild it yourself: tools/build-occt.sh wasm && tools/build-kernel.sh wasm.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/kernel-wasm/dist");
const args = process.argv.slice(2);
const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : undefined;
const force = args.includes("--force");

if (!force && existsSync(join(dist, "kernel.wasm")) && existsSync(join(dist, "kernel.js"))) {
  console.log("Kernel already present (packages/kernel-wasm/dist): nothing to do (--force to replace it).");
  process.exit(0);
}

const { release, repository, integrity } = JSON.parse(readFileSync(join(root, "tools/kernel-version.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "kernel-"));
try {
  // tar in the current folder with a relative name: a path such as "C:…" would be taken for a remote machine by GNU tar.
  const archive = join(tmp, "kernel.tar.gz");
  if (from) copyFileSync(resolve(from), archive);
  else {
    const url = `https://github.com/${repository}/releases/download/${release}/kernel-wasm-${release}.tar.gz`;
    console.log(`Downloading kernel ${release}: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (is the release published? is tools/kernel-version.json up to date?)`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }
  if (integrity) {
    const sri = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
    if (sri !== integrity) throw new Error(`Integrity mismatch: expected ${integrity}, got ${sri}`);
  } else console.warn("⚠ tools/kernel-version.json: no `integrity` hash set (pin it after the first release).");
  const out = join(tmp, "dist");
  mkdirSync(out);
  execFileSync("tar", ["-xzf", "../kernel.tar.gz"], { cwd: out, stdio: "inherit" });
  for (const f of ["kernel.js", "kernel.wasm"]) if (!existsSync(join(out, f))) throw new Error(`${f} missing from the archive`);
  mkdirSync(dist, { recursive: true });
  cpSync(out, dist, { recursive: true });
  console.log(`Kernel installed in ${dist}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
