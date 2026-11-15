/** Registry of shortcut actions: each workbench registers its own. */

/**
 * Workbench (displayed category). `common` groups the actions repeated across several workbenches
 * (undo, delete, line…): their shortcut is set once for all workbenches.
 */
export type Scope = "common" | "global" | "view" | "part" | "sheetmetal" | "sketch" | "sketch3d" | "assembly" | "frame" | "analysis" | "drawing" | "cam" | "quote" | "motion";

/** Display order of the workbenches in the settings window. */
export const SCOPES: Scope[] = ["common", "global", "view", "part", "sheetmetal", "sketch", "sketch3d", "assembly", "frame", "analysis", "drawing", "cam", "quote", "motion"];

/**
 * Active scopes depending on the context, by decreasing priority (the first found wins).
 * The `common` scope is never active: its shortcuts go through the actions that inherit them.
 */
export const CONTEXTS = {
  sketch: ["sketch", "view", "global"],
  sketch3d: ["sketch3d", "view", "global"],
  frame: ["frame", "view", "global"],
  analysis: ["analysis", "view", "global"],
  assembly: ["assembly", "view", "global"],
  /** Motion workbench: its commands (playback…) first, then the assembly ones (undo…). */
  motion: ["motion", "assembly", "view", "global"],
  drawing: ["drawing", "global"],
  cam: ["cam", "view", "global"],
  /** Machine of a CAM program modified in context: the active assembly first (undo…), then the machine commands. */
  machine: ["assembly", "cam", "view", "global"],
  part: ["part", "sheetmetal", "view", "global"],
  quote: ["quote", "view", "global"],
} satisfies Record<string, Scope[]>;

export interface ShortcutAction {
  id: string; // ex. "sketch.line", "view.front", "part.extrude"
  scope: Scope; // workbench = displayed category
  label: () => string; // localized
  icon?: string; // SVG 24×24 (innerHTML)
  defaults: string[]; // combinations of the "CAD" profile (0, 1 or several); ignored if the action inherits
  run: () => void;
  enabled?: () => boolean;
  /** Non-modifiable contextual key (Escape, Enter, Tab, X/Y/Z…): displayed, greyed out. */
  locked?: boolean;
  /** Active even when focus is in a field (search, save, open). */
  allowInInput?: boolean;
}

/** Shared action: shortcut template shared by workbench actions (`members`). */
export interface CommonAction {
  id: string; // ex. "common.undo"
  label: () => string;
  icon?: string;
  defaults: string[];
  members: string[]; // ex. ["sketch.undo", "assembly.undo", …]
}

const registry = new Map<string, ShortcutAction>();
/** Workbench action → shared action from which it inherits the shortcut. */
const parents = new Map<string, string>();
/** Shared action → workbench actions that inherit from it. */
const children = new Map<string, string[]>();

/** Registers (or replaces) actions. */
export function registerActions(list: ShortcutAction[]): void {
  for (const a of list) registry.set(a.id, a);
}

/** Removes actions (plugin disabled); their custom shortcuts remain stored. */
export function unregisterActions(ids: string[]): void {
  for (const id of ids) registry.delete(id);
}

/** Registers shared actions; they never run themselves (`common` scope never active). */
export function registerCommon(list: CommonAction[]): void {
  for (const c of list) {
    registry.set(c.id, { id: c.id, scope: "common", label: c.label, icon: c.icon, defaults: c.defaults, run: () => {} });
    children.set(c.id, [...c.members]);
    for (const m of c.members) parents.set(m, c.id);
  }
}

export const actions = (): ShortcutAction[] => [...registry.values()];

export const actionById = (id: string): ShortcutAction | undefined => registry.get(id);

export const actionsOfScope = (scope: Scope): ShortcutAction[] => actions().filter((a) => a.scope === scope);

/** Shared action inherited by `id` (if registered). */
export const parentOf = (id: string): string | undefined => {
  const p = parents.get(id);
  return p && registry.has(p) ? p : undefined;
};

/** Registered workbench actions that inherit from the shared action `id`. */
export const membersOf = (id: string): ShortcutAction[] => (children.get(id) ?? []).map((m) => registry.get(m)).filter((a): a is ShortcutAction => !!a);
