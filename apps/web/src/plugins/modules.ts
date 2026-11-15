import { createSignal } from "solid-js";
import { t } from "../i18n.ts";

/**
 * User choices on modules and plugins, kept from one session to the next (no dependency: imported by the ribbon).
 * - Modules: optional built-in workbenches (Sheet metal, CAM…), enabled by default; when disabled, their tab disappears from the ribbon.
 * - Installed catalog plugins: see settings.ts.
 * - First startup: `done` stays false until the wizard has been validated.
 */

export interface ModuleDef {
  id: string;
  label: () => string;
  hint: () => string;
}

/**
 * Workbenches that can be removed (Part, Assembly and Measure always remain available): Sheet metal, then those
 * announced by modules (`registerModules`), available when their module is in the build, otherwise "coming soon".
 */
const [moduleDefs, setModuleDefs] = createSignal<readonly ModuleDef[]>([{ id: "sheetmetal", label: () => t("bench.sheetmetal"), hint: () => t("mod.sheetmetal") }]);
export const MODULES = moduleDefs;
export function registerModules(defs: readonly ModuleDef[]): void {
  setModuleDefs((all) => [...all.filter((m) => !defs.some((d) => d.id === m.id)), ...defs]);
}

export interface StoredPlugin {
  version: string;
  enabled: boolean;
}

export interface Prefs {
  done: boolean;
  /** Explicitly disabled modules (absent: enabled). */
  off: string[];
  plugins: Record<string, StoredPlugin>;
}

const KEY = "cad.plugins";

function read(): Prefs {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Prefs> | null;
    if (s) return { done: s.done === true, off: Array.isArray(s.off) ? s.off.filter((x) => typeof x === "string") : [], plugins: s.plugins && typeof s.plugins === "object" ? s.plugins : {} };
  } catch {
    /* unreadable: original values */
  }
  return { done: false, off: [], plugins: {} };
}

const [prefs, setPrefs] = createSignal<Prefs>(read());
export { prefs };

export function updatePrefs(fn: (s: Prefs) => Prefs): void {
  const next = fn(prefs());
  setPrefs(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: choice valid for this session only */
  }
}

/**
 * Workbenches compiled but not shipped in this build (`VITE_HIDDEN_MODULES`, e.g. "sheetmetal"), or hidden by a module
 * (`hideModules`: workbenches of another edition, with their note): shown as "coming soon" in the module choice, absent
 * from the ribbon and the menus.
 */
const HIDDEN: readonly string[] = String(import.meta.env.VITE_HIDDEN_MODULES ?? "")
  .split(/[\s,]+/)
  .filter(Boolean);
const [hiddenByModule, setHiddenByModule] = createSignal<{ ids: readonly string[]; note: () => string } | null>(null);
export function hideModules(ids: readonly string[], note: () => string): void {
  setHiddenByModule({ ids, note });
}
/** Note of a workbench hidden by a module (workbench of another edition…), otherwise undefined. */
export const hiddenNote = (id: string): string | undefined => (hiddenByModule()?.ids.includes(id) ? hiddenByModule()!.note() : undefined);
export const moduleShipped = (id: string): boolean => !HIDDEN.includes(id) && !hiddenByModule()?.ids.includes(id);

/** Built-in workbench active? (reactive) Identifiers outside MODULES are always active, unless hidden from the build. */
export const moduleEnabled = (id: string): boolean => moduleShipped(id) && !prefs().off.includes(id);

export const setModuleEnabled = (id: string, on: boolean): void =>
  updatePrefs((s) => ({ ...s, off: on ? s.off.filter((x) => x !== id) : s.off.includes(id) ? s.off : [...s.off, id] }));

export const firstRunPending = (): boolean => !prefs().done;
export const completeFirstRun = (): void => updatePrefs((s) => ({ ...s, done: true }));
