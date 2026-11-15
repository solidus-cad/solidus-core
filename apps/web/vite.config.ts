import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { cadExtensions } from "./vite-extensions.js";

export default defineConfig({
  // cadExtensions: private extensions selected at build time (CAD_EXTENSIONS), none by default.
  plugins: [solid(), cadExtensions()],
  worker: { format: "es" },
  // @app: internal application modules, for the modules compiled with it (ext/*, see docs/MODULES.md).
  // dedupe: a single instance of Solid and Three, even if a module is in another folder.
  resolve: { alias: { "@app": fileURLToPath(new URL("./src", import.meta.url)) }, dedupe: ["solid-js", "three"] },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
