#!/usr/bin/env node
/**
 * Prepares an npm package before `pnpm pack` / `pnpm publish` (called by the `prepack` script of the package).
 *
 *   node ../../tools/prepack.mjs <tsc output folder> [--kernel]
 *
 * - copies LICENSE into the package: MIT text for the packages declared "MIT", otherwise the AGPL-3.0 with the
 *   Solidus Plugin Exception (LICENSE-EXCEPTION.txt); THIRD_PARTY_LICENSES for the kernels;
 * - replaces, in the compiled output, the `./worker.ts` references (new URL(…, import.meta.url)) with `./worker.js`;
 * - --kernel: refuses to pack without dist/kernel.js and dist/kernel.wasm (produced by tools/build-kernel.sh).
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = process.cwd();
const out = process.argv[2];
const kernel = process.argv.includes("--kernel");

if (!out) {
  console.error("usage: prepack.mjs <output folder> [--kernel]");
  process.exit(1);
}

const mit = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).license === "MIT";
copyFileSync(join(root, mit ? "LICENSES/MIT.txt" : "LICENSE"), join(pkg, "LICENSE"));
if (!mit) copyFileSync(join(root, "LICENSES/AdditionRef-Solidus-Plugin-Exception.txt"), join(pkg, "LICENSE-EXCEPTION.txt"));
if (kernel) copyFileSync(join(root, "THIRD_PARTY_LICENSES"), join(pkg, "THIRD_PARTY_LICENSES"));

if (kernel) {
  for (const f of ["kernel.js", "kernel.wasm"]) {
    if (!existsSync(join(pkg, "dist", f))) {
      console.error(`✖ dist/${f} missing: run tools/build-occt.sh wasm then tools/build-kernel.sh wasm before publishing.`);
      process.exit(1);
    }
  }
}

if (!existsSync(join(pkg, out))) {
  console.error(`✖ ${out}/ missing: the build (tsc -p tsconfig.build.json) failed or did not run.`);
  process.exit(1);
}
for (const name of readdirSync(join(pkg, out)).filter((n) => n.endsWith(".js"))) {
  const file = join(pkg, out, name);
  const text = readFileSync(file, "utf8");
  const fixed = text.replace(/(new URL\(\s*["'])(\.\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
  if (fixed !== text) writeFileSync(file, fixed);
}
