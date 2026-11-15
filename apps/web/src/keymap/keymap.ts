import { createSignal } from "solid-js";
import { lang } from "../i18n.ts";
import { actionById, actions, actionsOfScope, CONTEXTS, membersOf, parentOf, type Scope, type ShortcutAction } from "./registry.ts";
import { DEFAULT_PRESET, PRESET_IDS, PRESETS, type PresetId } from "./presets.ts";
import { formatCombo, validateCombo } from "./keys.ts";

/** User overrides: Record<actionId, combos>; `[]` = shortcut deliberately removed. */
export type UserOverrides = Partial<Record<string, string[]>>;

/** Version counter: forces reactivity when actions are registered after startup. */
const [version, setVersion] = createSignal(0);
const [preset, setPresetSignal] = createSignal<PresetId>(DEFAULT_PRESET);
const [overrides, setOverrides] = createSignal<UserOverrides>({});
/** Suspends the dispatcher while the shortcut settings window is open. */
const [capturing, setCapturing] = createSignal(false);

export { preset, overrides, capturing, setCapturing };

/** Applies a loaded state (startup, other tab, import). */
export function loadState(p: PresetId, o: UserOverrides): void {
  setPresetSignal(p);
  setOverrides(o);
  setVersion((v) => v + 1);
}

/**
 * Combos currently bound to an action (reactive):
 * user override ?? profile override ?? shared action's shortcut ?? CAD defaults of the action.
 */
export const shortcutsFor = (id: string): string[] => {
  void version();
  return overrides()[id] ?? PRESETS[preset()][id] ?? inheritedOrDefaults(id);
};

/** Shortcut inherited from the shared action, otherwise the defaults declared by the action. */
function inheritedOrDefaults(id: string): string[] {
  const parent = parentOf(id);
  return parent ? shortcutsFor(parent) : (actionById(id)?.defaults ?? []);
}

/** True if the action follows the shortcut of its shared action (no own override). */
export const isInherited = (id: string): boolean => {
  void version();
  return !!parentOf(id) && overrides()[id] === undefined && PRESETS[preset()][id] === undefined;
};

/** Label of an action's combos, for tooltip/menu ("L", "Suppr / Retour arr." (French label), "V F"). */
export const formatShortcuts = (id: string): string => shortcutsFor(id).map((c) => formatCombo(c, lang())).join(" / ");

/** Button tooltip: "Line (L)" — without suffix if no shortcut is bound. */
export const shortcutTitle = (label: string, id: string | undefined): string => {
  const sc = id ? formatShortcuts(id) : "";
  return sc ? `${label} (${sc})` : label;
};

/** Action resolved for a combination in the given scopes (`locked` ones are handled in code). */
export function resolve(combo: string, scopes: Scope[]): ShortcutAction | undefined {
  for (const s of scopes) {
    for (const a of actionsOfScope(s)) {
      if (!a.locked && shortcutsFor(a.id).includes(combo)) return a;
    }
  }
  return undefined;
}

/** Locked action (Escape, Enter…) resolved in the given scopes. */
export function resolveLocked(combo: string, scopes: Scope[]): ShortcutAction | undefined {
  for (const s of scopes) {
    for (const a of actionsOfScope(s)) {
      if (a.locked && shortcutsFor(a.id).includes(combo)) return a;
    }
  }
  return undefined;
}

/** Two scopes at the same level, active at the same time (part: part + sheetmetal). */
function coActive(a: Scope, b: Scope): boolean {
  return (a === "part" && b === "sheetmetal") || (a === "sheetmetal" && b === "part");
}

/** Two scopes active together in at least one context (e.g. sketch and view). */
const together = (a: Scope, b: Scope): boolean => Object.values(CONTEXTS).some((c: Scope[]) => c.includes(a) && c.includes(b));

/**
 * Conflicts for a combination: `blocking` = actions of the same workbench already bound
 * (to be replaced), `shadowed` = actions of a workbench active at the same time, hidden or hiding
 * (warning). A shared action is checked in each of the workbenches that inherit it;
 * workbench actions that follow a shared action are then reported by that one.
 */
export function conflicts(actionId: string, combo: string): { blocking: ShortcutAction[]; shadowed: ShortcutAction[] } {
  const self = actionById(actionId);
  const blocking = new Set<ShortcutAction>();
  const shadowed = new Set<ShortcutAction>();
  if (!self) return { blocking: [], shadowed: [] };
  const common = self.scope === "common";
  const members = common ? membersOf(self.id) : [];
  const own: Scope[] = common ? [...new Set(members.map((m) => m.scope))] : [self.scope];
  const memberIds = new Set(members.map((m) => m.id));
  for (const other of actions()) {
    if (other.id === actionId || other.scope === "common" || memberIds.has(other.id)) continue;
    if (!shortcutsFor(other.id).includes(combo)) continue;
    const parent = parentOf(other.id);
    const shown = common && parent && isInherited(other.id) ? actionById(parent)! : other;
    if (!other.locked && own.some((s) => s === other.scope || coActive(s, other.scope))) blocking.add(shown);
    else if (own.some((s) => together(s, other.scope))) shadowed.add(shown);
  }
  for (const b of blocking) shadowed.delete(b);
  return { blocking: [...blocking], shadowed: [...shadowed] };
}

/** True if the action differs from the current profile ("modified" indicator). */
export function isModified(id: string): boolean {
  const current = shortcutsFor(id);
  const base = PRESETS[preset()][id] ?? inheritedOrDefaults(id);
  return current.length !== base.length || current.some((c, i) => c !== base[i]);
}

// --- Device file `shortcuts.json` -----------------------------------------------------------

export interface ShortcutsFile {
  version: number;
  preset: PresetId;
  overrides: UserOverrides;
}

/** Renamed actions: a custom shortcut under the old identifier moves to the new one. */
const RENAMED: Record<string, string> = {
  "assembly.machineDefine": "cam.machineDefine",
  "assembly.machineCatalog": "cam.machineCatalog",
  "assembly.machinePublish": "cam.machinePublish",
};

/** Parses the content of `shortcuts.json`; corrupted or unknown data is ignored. */
export function parseShortcutsFile(text: string | null): { preset: PresetId; overrides: UserOverrides } {
  const out = { preset: DEFAULT_PRESET, overrides: {} as UserOverrides };
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  if (o.version !== undefined && o.version !== 1) return out;
  if (typeof o.preset === "string" && (PRESET_IDS as string[]).includes(o.preset)) out.preset = o.preset as PresetId;
  if (o.overrides && typeof o.overrides === "object") {
    for (const [old, v] of Object.entries(o.overrides as Record<string, unknown>)) {
      const id = RENAMED[old] ?? old;
      if (!actionById(id) || !Array.isArray(v)) continue;
      out.overrides[id] = v.filter((c): c is string => typeof c === "string" && validateCombo(c));
    }
  }
  return out;
}

/** Serializes the current state (export + disk write). */
export function serializeShortcuts(): string {
  const file: ShortcutsFile = { version: 1, preset: preset(), overrides: overrides() };
  return JSON.stringify(file, null, 2);
}

// --- User changes ----------------------------------------------------------------

/** Registers the saver (hooked up by persist.ts, to avoid an import cycle). */
let saver: () => void = () => {};
export function setSaver(fn: () => void): void {
  saver = fn;
}

/** Changes the predefined profile. */
export function setPreset(p: PresetId): void {
  setPresetSignal(p);
  saver();
}

/** Modifies the combos of an action (`undefined` = back to the profile). */
export function setOverride(actionId: string, combos: string[] | undefined): void {
  const o = { ...overrides() };
  if (combos === undefined) delete o[actionId];
  else o[actionId] = combos;
  setOverrides(o);
  saver();
}

/** Imports a shortcut file (replaces the current state); false if the JSON is unreadable. */
export function importShortcuts(text: string): boolean {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object") return false;
  } catch {
    return false;
  }
  const { preset: p, overrides: o } = parseShortcutsFile(text);
  loadState(p, o);
  saver();
  return true;
}

/** Resets everything: CAD profile, no overrides. */
export function resetAll(): void {
  setPresetSignal(DEFAULT_PRESET);
  setOverrides({});
  saver();
}

// --- Search (Ctrl+K) ------------------------------------------------------------------------

let searchHandler: (() => void) | null = null;
export function setSearchHandler(fn: () => void): void {
  searchHandler = fn;
}
export function runSearch(): void {
  searchHandler?.();
}
