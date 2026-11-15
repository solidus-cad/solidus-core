// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Extensions included in the build: `CAD_EXTENSIONS` is a comma-separated list of modules (package name
 * or file path, relative to apps/web) whose default export is an `AppExtension` (@solidus-cad/sdk).
 * The open modules of `modules/` (BUILTIN) are always included, before those of `CAD_EXTENSIONS`. Example:
 *   CAD_EXTENSIONS=../../ext/cam/src/extension.tsx pnpm build
 *
 * JavaScript file (not TypeScript): the application does not have the Node types.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const ID = "virtual:cad-extensions";

/** Open modules of this repository, part of every build. */
const BUILTIN = ["../../modules/gears/src/extension.tsx", "../../modules/motion/src/extension.tsx"];

/** Names of the open modules (folder of `modules/`). */
const builtinNames = BUILTIN.map((s) => s.split("/")[3]);

/** @returns {string[]} extension modules, with absolute paths */
function specs() {
  return [...BUILTIN, ...(process.env.CAD_EXTENSIONS ?? "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith(".") || path.isAbsolute(s) ? path.resolve(here, s).split(path.sep).join("/") : s))
    .filter((s, i, all) => all.indexOf(s) === i)
    .filter((s) => {
      // A module of ext/ that has since become an open module of modules/: the open one is already included.
      const ext = /\/ext\/([^/]+)\/src\/extension\.tsx$/.exec(s);
      if (!ext || !builtinNames.includes(ext[1])) return true;
      console.warn(`[cad-extensions] ${s}: ignored, "${ext[1]}" is an open module of modules/`);
      return false;
    });
}

/** Vite plugin: virtual module `virtual:cad-extensions` (array of extensions). */
export function cadExtensions() {
  const list = specs();
  return {
    name: "cad-extensions",
    /** Extension folders outside the repository, to allow on the development server. */
    config: () => ({
      server: { fs: { allow: [path.resolve(here, "../.."), ...list.filter((s) => path.isAbsolute(s)).map((s) => path.dirname(path.dirname(s)))] } },
    }),
    /** @param {string} source */
    resolveId: (source) => (source === ID ? "\0" + ID : null),
    /** @param {string} id */
    load(id) {
      if (id !== "\0" + ID) return null;
      return list.map((s, i) => `import e${i} from ${JSON.stringify(s)};\n`).join("") + `export default [${list.map((_, i) => "e" + i).join(", ")}];\n`;
    },
  };
}
