/** Extensions selected at build time (see vite.config.ts, `CAD_EXTENSIONS`). */
declare module "virtual:cad-extensions" {
  import type { AppExtension } from "@solidus-cad/sdk";
  const extensions: AppExtension[];
  export default extensions;
}
