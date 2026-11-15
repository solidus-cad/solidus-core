import { strFromU8, unzipSync } from "fflate";
import { compareVersions, PLUGIN_SDK_VERSION, validateManifest, type PluginManifest } from "@solidus-cad/sdk";

/** Plugin package `.vplug`: zip containing `plugin.json` and the ES module (a single file, already bundled). */
export interface PluginPackage {
  manifest: PluginManifest;
  /** Code of the entry module. */
  code: string;
}

export class PluginPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginPackageError";
  }
}

/** Maximum size of an unzipped package. */
const MAX_BYTES = 20 * 1024 * 1024;

/** Reads and validates a package; `appVersion` is used to check `minAppVersion` (ignored if absent). */
export function readPluginPackage(bytes: Uint8Array, appVersion?: string): PluginPackage {
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_BYTES) throw new PluginPackageError("paquet trop volumineux");
        return true;
      },
    });
  } catch (e) {
    throw e instanceof PluginPackageError ? e : new PluginPackageError("archive illisible");
  }
  // Manifest at the root, or in the archive's only folder (zip of a folder).
  const manifestPath = Object.keys(files)
    .filter((p) => p === "plugin.json" || /^[^/]+\/plugin\.json$/.test(p))
    .sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) throw new PluginPackageError("plugin.json absent");
  const root = manifestPath.slice(0, -"plugin.json".length);
  return parsePlugin(strFromU8(files[manifestPath]!), (path) => {
    const f = files[root + path];
    return f ? strFromU8(f) : undefined;
  }, appVersion);
}

/** Validates a manifest (JSON text) and reads its entry module with `read`. */
export function parsePlugin(manifestText: string, read: (path: string) => string | undefined, appVersion?: string): PluginPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    throw new PluginPackageError("plugin.json : JSON invalide");
  }
  const errors = validateManifest(raw);
  if (errors.length) throw new PluginPackageError(errors.join(" ; "));
  const manifest = raw as PluginManifest;
  if (manifest.sdkVersion !== PLUGIN_SDK_VERSION) throw new PluginPackageError(`API plugin ${manifest.sdkVersion} non prise en charge`);
  if (appVersion && manifest.minAppVersion && compareVersions(appVersion, manifest.minAppVersion) < 0)
    throw new PluginPackageError(`application ${manifest.minAppVersion} ou plus récente requise`);
  const code = read(manifest.entry.replace(/^\.\//, ""));
  if (code === undefined) throw new PluginPackageError(`module ${manifest.entry} absent du paquet`);
  return { manifest, code };
}
