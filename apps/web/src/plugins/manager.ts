import { createSignal } from "solid-js";
import type { Plugin, PluginManifest } from "@solidus-cad/sdk";
import { setMessage } from "../store.ts";
import { createHostApi, type HostApi } from "./host.ts";
import { readPluginPackage, type PluginPackage } from "./package.ts";
import { startSandbox } from "./sandbox.ts";

/**
 * Active plugins: loading a package, activation in the chosen host, deactivation.
 * - "trusted" host: the module is imported into the application (verified publisher);
 * - "sandbox" host: the module runs in an isolated Worker (unverified publisher), see sandbox.ts.
 */

export type PluginSource = "dev" | "store";

export interface ActivePlugin {
  manifest: PluginManifest;
  trusted: boolean;
  source: PluginSource;
}

interface Running extends ActivePlugin {
  host: HostApi;
  /** Deactivates the plugin (module's deactivate, Worker stop). */
  stop(): Promise<void>;
}

const running = new Map<string, Running>();
const [list, setList] = createSignal<ActivePlugin[]>([]);
/** Active plugins (reactive). */
export const activePlugins = list;

const refresh = () => setList([...running.values()].map(({ manifest, trusted, source }) => ({ manifest, trusted, source })));

function reporter(id: string) {
  return (e: unknown) => {
    console.error(`[plugin ${id}]`, e);
    setMessage(`Plugin ${id} : ${e instanceof Error ? e.message : String(e)}`);
  };
}

/** Imports the module of a trusted plugin (blob URL: the module cannot import other files of the package). */
async function importTrusted(code: string): Promise<Plugin> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { default?: Plugin };
    if (!mod.default || typeof mod.default.activate !== "function") throw new Error("export par défaut definePlugin({ activate }) attendu");
    return mod.default;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Activates a plugin (replaces it if already active). On failure, its partial contributions are removed. */
export async function activatePlugin(pkg: PluginPackage, opts: { trusted: boolean; source: PluginSource }): Promise<void> {
  const { manifest } = pkg;
  if (running.has(manifest.id)) await deactivatePlugin(manifest.id);
  const host = createHostApi(manifest, reporter(manifest.id));
  let stop: () => Promise<void>;
  try {
    if (opts.trusted) {
      const plugin = await importTrusted(pkg.code);
      await plugin.activate(host.ctx);
      stop = async () => void (await plugin.deactivate?.());
    } else stop = (await startSandbox(manifest, pkg.code, host)).stop;
  } catch (e) {
    host.dispose();
    throw e;
  }
  running.set(manifest.id, { manifest, trusted: opts.trusted, source: opts.source, host, stop });
  refresh();
}

export async function deactivatePlugin(id: string): Promise<void> {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  try {
    await r.stop();
  } catch (e) {
    reporter(id)(e);
  } finally {
    r.host.dispose();
    refresh();
  }
}

/**
 * Development mode: loads a `.vplug` package (or the zip of a plugin folder) chosen by the user.
 * Sandbox by default, like a plugin from an unverified publisher; `trusted` to try the trusted host.
 */
export async function loadDevPackage(bytes: Uint8Array, trusted = false): Promise<PluginManifest> {
  const pkg = readPluginPackage(bytes);
  await activatePlugin(pkg, { trusted, source: "dev" });
  return pkg.manifest;
}
