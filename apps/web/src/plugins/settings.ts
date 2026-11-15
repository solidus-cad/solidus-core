import { createSignal } from "solid-js";
import { setMessage } from "../store.ts";
import { readUserFile, writeUserFile } from "../userdata.ts";
import { activatePlugin, deactivatePlugin } from "./manager.ts";
import { completeFirstRun, MODULES, prefs, setModuleEnabled, updatePrefs, type StoredPlugin } from "./modules.ts";
import { readPluginPackage } from "./package.ts";

/** Catalog plugins: installation, activation, reactivation at startup, and the first-startup wizard. */

/** Plugin of the catalog (latest published version). Texts per language (`fr`, `en`…). */
export interface PluginSummary {
  id: string;
  name: Record<string, string>;
  description: Record<string, string>;
  version: string;
  author: string;
  /** Suggested as checked on first startup. */
  recommended: boolean;
  sdkVersion: number;
  permissions: string[];
  minAppVersion?: string;
  bytes: number;
  sha256: string;
  publishedAt: string;
}

/**
 * Online plugin catalog, provided by a module (account of the official builds). Without it, plugins are installed from
 * a local `.vplug` package only.
 */
export interface PluginCatalogSource {
  list(): Promise<PluginSummary[]>;
  /** Package of the latest (or given) version. */
  download(id: string, version?: string): Promise<{ version: string; bytes: Uint8Array }>;
  /** The catalog requires a signed-in account. */
  signedIn(): boolean;
  /** Signs in, then calls `then`. */
  signIn(then: () => void): void;
  errorText(e: unknown): string;
}
const [catalogSource, setCatalogSource] = createSignal<PluginCatalogSource | null>(null);
export { catalogSource };
export function registerPluginCatalog(source: PluginCatalogSource): void {
  setCatalogSource(source);
}

/** Catalog plugins installed on this device (reactive). */
export const installedPlugins = (): Record<string, StoredPlugin> => prefs().plugins;

// --- Packages kept on the device ---------------------------------------------------------------------------

const fileName = (id: string) => `plugin-${id}.vplug.b64`;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function cachedPackage(id: string): Promise<Uint8Array | null> {
  const text = await readUserFile(fileName(id));
  if (!text) return null;
  try {
    return fromBase64(text);
  } catch {
    return null;
  }
}

/** Downloads a catalog plugin (latest version), activates it and remembers it. */
export async function installPlugin(id: string): Promise<void> {
  const source = catalogSource();
  if (!source) throw new Error("catalogue indisponible");
  const { version, bytes } = await source.download(id);
  const pkg = readPluginPackage(bytes);
  if (pkg.manifest.id !== id) throw new Error(`le paquet contient « ${pkg.manifest.id} », pas « ${id} »`);
  // Catalog plugins always run isolated: only development mode may import them into the application.
  await activatePlugin(pkg, { trusted: false, source: "store" });
  await writeUserFile(fileName(id), toBase64(bytes));
  updatePrefs((s) => ({ ...s, plugins: { ...s.plugins, [id]: { version, enabled: true } } }));
}

/** Enables or disables an installed plugin (the package stays on the device). */
export async function setPluginEnabled(id: string, on: boolean): Promise<void> {
  const entry = prefs().plugins[id];
  if (!entry) return;
  if (on) {
    const bytes = await cachedPackage(id);
    if (!bytes) return installPlugin(id);
    await activatePlugin(readPluginPackage(bytes), { trusted: false, source: "store" });
  } else await deactivatePlugin(id);
  updatePrefs((s) => ({ ...s, plugins: { ...s.plugins, [id]: { ...entry, enabled: on } } }));
}

/** Uninstalls a plugin: deactivated and package erased from the device. */
export async function uninstallPlugin(id: string): Promise<void> {
  await deactivatePlugin(id);
  await writeUserFile(fileName(id), "");
  updatePrefs((s) => {
    const { [id]: _removed, ...plugins } = s.plugins;
    return { ...s, plugins };
  });
}

/** At startup: reactivates the catalog plugins that were active in the last session. A failure does not prevent the others. */
export async function restorePlugins(): Promise<void> {
  for (const [id, entry] of Object.entries(prefs().plugins)) {
    if (!entry.enabled) continue;
    try {
      const bytes = await cachedPackage(id);
      if (!bytes) throw new Error("paquet absent du poste");
      await activatePlugin(readPluginPackage(bytes), { trusted: false, source: "store" });
    } catch (e) {
      setMessage(`Plugin ${id} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// --- Server catalog ----------------------------------------------------------------------------------

const [catalog, setCatalog] = createSignal<PluginSummary[]>([]);
export { catalog as pluginCatalog };

/** Reloads the catalog (requires a signed-in account). Throws the server's error. */
export async function refreshCatalog(): Promise<PluginSummary[]> {
  const list = (await catalogSource()?.list()) ?? [];
  setCatalog(list);
  return list;
}

/** Applied when the wizard is validated: installs the checked plugins and remembers the module choice. */
export async function applyFirstRun(choice: { modules: Record<string, boolean>; plugins: string[] }): Promise<string[]> {
  for (const m of MODULES()) setModuleEnabled(m.id, choice.modules[m.id] !== false);
  const failed: string[] = [];
  for (const id of choice.plugins) {
    try {
      await installPlugin(id);
    } catch (e) {
      failed.push(`${id} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  completeFirstRun();
  return failed;
}
