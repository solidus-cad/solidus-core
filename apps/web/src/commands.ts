import { createSignal } from "solid-js";
import type { DisplayMode, StandardView } from "@solidus-cad/viewer";
import { t, tx, type TKey } from "./i18n.ts";
import { openNewWindow } from "./desktop.ts";
import {
  benchContext,
  cancelEdit,
  cancelSketchFor,
  confirmEdit,
  getViewer,
  newDocument,
  redo,
  setDisplayMode,
  showFeatureDims,
  state,
  toggleGrid,
  toggleRealistic,
  undo,
} from "./store.ts";
import { exportAs, importDocument, openDocument, packActive, saveActive, saveActiveAs } from "./files.ts";
import { openRecentDialog } from "./docfiles/RecentDialog.tsx";
import { docFs } from "./docfiles/fs.ts";
import { openAssemblyExport } from "./components/ExportAssemblyDialog.tsx";
import { openCheckpointCreate, openCheckpointList } from "./components/CheckpointDialog.tsx";
import * as wsp from "./workspace.ts";
import { toggleSection } from "./section.ts";
import { installKeymapDispatcher } from "./keymap/dispatcher.ts";
import { registerActions, unregisterActions, type Scope, type ShortcutAction } from "./keymap/registry.ts";
import { benchRegistry } from "./plugins/benches.ts";
import { createRegistry } from "./plugins/registry.ts";
import type { Bench } from "@solidus-cad/sdk";
import { runSearch } from "./keymap/keymap.ts";
import { initKeymapPersistence } from "./keymap/persist.ts";
import { openShortcutsDialog } from "./keymap/ShortcutsDialog.tsx";
import { openUserSettings } from "./components/UserDialog.tsx";
import { openAboutDialog } from "./components/AboutDialog.tsx";
import { openGesturesDialog } from "./gestures/GesturesDialog.tsx";
import { openPluginsDialog } from "./plugins/PluginsDialog.tsx";
import { openAppearance } from "./components/AppearanceDialog.tsx";
import { theme, toggleTheme } from "./theme.ts";
import { toggleLengthUnit } from "./units.ts";
import { initGesturesPersistence } from "./gestures/gestures.ts";
import "./keymap/common.ts";
import { openBugReport } from "./bugreport/BugReportDialog.tsx";
import { openFirstPartTour } from "./tour/FirstPartTour.tsx";
import { emit } from "./events.ts";

/** Application command: used by the menus, the ribbon and search. */
export interface AppCommand {
  id: string;
  label: () => string;
  /** Shorter label inside a submenu (e.g. "STEP" under "Export as"). */
  menuLabel?: () => string;
  icon?: string;
  enabled?: () => boolean;
  run: () => void;
}

const fixed = (key: TKey) => () => t(key);

const views: StandardView[] = ["front", "back", "top", "bottom", "left", "right", "iso"];

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
/** Faces of a cube seen in isometric view: top, left (front face), right. */
const FACE = { top: "M12 3 20 7.5 12 12 4 7.5z", left: "M4 7.5v9l8 4.5v-9z", right: "M20 7.5v9L12 21v-9z" };
const CUBE = `<path d="${FACE.top}"/><path d="M4 7.5v9l8 4.5 8-4.5v-9M12 12v9"/>`;
/** Cube with a solid face (visible face) or a dashed face (hidden face: back, left, bottom). */
const cubeFace = (face: keyof typeof FACE, hidden = false) =>
  svg(`${CUBE}<path d="${FACE[face]}" fill="currentColor" opacity="${hidden ? 0.3 : 0.75}"${hidden ? ' stroke-dasharray="2 2"' : ""}/>`);
const VIEW_ICONS: Record<StandardView, string> = {
  front: cubeFace("left"),
  back: cubeFace("right", true),
  top: cubeFace("top"),
  bottom: cubeFace("top", true),
  left: cubeFace("left", true),
  right: cubeFace("right"),
  iso: svg(`${CUBE}<path d="${FACE.top}" fill="currentColor" opacity=".25"/><path d="${FACE.left}" fill="currentColor" opacity=".75"/><path d="${FACE.right}" fill="currentColor" opacity=".5"/>`),
};
const FIT_ICON = svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8.5" y="8.5" width="7" height="7"/>');
const modes: DisplayMode[] = ["shaded", "shadedEdges", "wireframe", "hiddenLines"];

/** Active assembly: choice of exported parts (dialog); otherwise export of the active part. */
const exportEnabled = () => wsp.activeKind() === "assembly" || (wsp.activeKind() === "part" && !!state.mass);
const exportCommand = (format: "step" | "stl" | "obj" | "3mf") => (wsp.activeKind() === "assembly" ? openAssemblyExport(format) : void exportAs(format));

const builtin: AppCommand[] = [
  { id: "file.new", label: fixed("cmd.new"), run: newDocument },
  { id: "file.open", label: fixed("cmd.open"), run: openDocument },
  { id: "file.openRecent", label: fixed("file.openRecent"), run: openRecentDialog },
  { id: "file.save", label: fixed("cmd.save"), run: () => void saveActive() },
  { id: "file.saveAs", label: fixed("cmd.saveAs"), run: () => void saveActiveAs() },
  { id: "file.import", label: fixed("cmd.import"), run: importDocument },
  // Web: project folder where parts, assemblies and drawings live (the desktop app uses real paths).
  ...(docFs.kind === "desktop"
    ? []
    : [{ id: "file.projectFolder", label: () => (docFs.rootName() ? `${t("file.projectFolder")} (${docFs.rootName()})` : t("file.projectFolder")) + "…", run: () => void docFs.ensureRoot(true) }]),
  { id: "file.newPart", label: fixed("ws.newPart"), run: wsp.newPart },
  { id: "file.newAssembly", label: fixed("ws.newAssembly"), run: wsp.newAssembly },
  { id: "file.checkpoint", label: fixed("ckpt.createMenu"), enabled: () => wsp.activeKind() !== "drawing", run: () => openCheckpointCreate() },
  { id: "file.versions", label: fixed("ckpt.versionsMenu"), enabled: () => wsp.activeKind() !== "drawing", run: () => openCheckpointList() },
  { id: "file.exportStep", label: fixed("cmd.exportStep"), menuLabel: () => "STEP", enabled: exportEnabled, run: () => exportCommand("step") },
  { id: "file.exportStl", label: fixed("cmd.exportStl"), menuLabel: () => "STL", enabled: exportEnabled, run: () => exportCommand("stl") },
  { id: "file.exportObj", label: fixed("cmd.exportObj"), menuLabel: () => "OBJ", enabled: exportEnabled, run: () => exportCommand("obj") },
  { id: "file.export3mf", label: fixed("cmd.export3mf"), menuLabel: () => "3MF", enabled: exportEnabled, run: () => exportCommand("3mf") },
  { id: "file.pack", label: fixed("cmd.pack"), enabled: () => wsp.activeKind() === "assembly" || wsp.activeKind() === "drawing", run: () => void packActive() },
  { id: "edit.undo", label: fixed("cmd.undo"), enabled: () => state.canUndo || !!state.editing, run: undo },
  { id: "edit.redo", label: fixed("cmd.redo"), enabled: () => state.canRedo, run: redo },
  { id: "view.fit", label: fixed("cmd.fit"), icon: FIT_ICON, run: () => getViewer()?.fit() },
  ...views.map((v) => ({ id: `view.${v}`, label: fixed(`view.${v}`), icon: VIEW_ICONS[v], run: () => getViewer()?.setView(v) })),
  ...modes.map((m) => ({ id: `mode.${m}`, label: fixed(`mode.${m}`), run: () => setDisplayMode(m) })),
  { id: "view.grid", label: fixed("cmd.grid"), run: toggleGrid },
  { id: "view.realistic", label: fixed("cmd.realistic"), run: toggleRealistic },
  // Other screen: a window with its own documents; files saved in one are reloaded in the others (docfiles/sync.ts).
  { id: "view.newWindow", label: fixed("cmd.newWindow"), run: openNewWindow },
  { id: "view.section", label: fixed("sec.toggle"), enabled: () => wsp.activeKind() !== "drawing", run: toggleSection },
  { id: "settings.appearance", label: fixed("cmd.appearance"), run: openAppearance },
  // Light/dark toggle: search and shortcuts only; the menu goes through Appearance (themes, accent, activation code).
  { id: "settings.theme", label: () => t(theme() === "dark" ? "theme.toLight" : "theme.toDark"), run: toggleTheme },
  { id: "settings.units", label: fixed("units.cmd"), run: toggleLengthUnit },
  { id: "settings.shortcuts", label: fixed("cmd.shortcutsSettings"), run: () => openShortcutsDialog() },
  { id: "settings.user", label: fixed("cmd.userSettings"), run: () => openUserSettings() },
  { id: "settings.gestures", label: fixed("cmd.gesturesSettings"), run: () => openGesturesDialog() },
  { id: "settings.plugins", label: fixed("cmd.plugins"), run: () => openPluginsDialog() },
  { id: "help.tour", label: fixed("tour.menu"), run: openFirstPartTour },
  { id: "help.bugReport", label: fixed("bug.button"), run: openBugReport },
  { id: "help.about", label: fixed("cmd.about"), run: () => openAboutDialog() },
];

/** Ribbon commands of a part workbench. */
const benchCommands = (b: Bench): AppCommand[] =>
  b.ribbon.flatMap((g) =>
    g.commands.map((c) => ({
      id: c.id,
      label: () => tx(c.label),
      icon: c.icon,
      enabled: () => state.kernel !== "loading" && state.kernel !== "error",
      run: () => c.run(benchContext),
    })),
  );

/** Commands of the application, workbenches and plugins (reactive: a plugin adds or removes some). */
export const commandRegistry = createRegistry<AppCommand>([...builtin, ...benchRegistry.list().flatMap(benchCommands)]);

export const commands = (): AppCommand[] => commandRegistry.list();
export const commandById = { get: (id: string): AppCommand | undefined => commandRegistry.get(id) };

// Workbench added or removed (plugin): its commands follow.
benchRegistry.subscribe((added, removed) => {
  commandRegistry.remove(...removed.flatMap(benchCommands).map((c) => c.id));
  commandRegistry.add(...added.flatMap(benchCommands));
});

export function runCommand(id: string): void {
  const c = commandById.get(id);
  if (c && (c.enabled?.() ?? true)) {
    emit({ type: "command", id, label: c.label(), via: "ui" });
    c.run();
  }
}

/** Menu entry: command, separator or submenu. */
export type MenuEntry = string | { label: TKey; items: string[] };

export const menus: { label: TKey; items: MenuEntry[] }[] = [
  { label: "menu.file", items: ["file.newPart", "file.newAssembly", "file.open", "file.openRecent", "file.save", "file.saveAs", "-", ...(docFs.kind === "desktop" ? [] : ["file.projectFolder"]), "file.import", "-", "file.checkpoint", "file.versions", "-", { label: "cmd.exportMenu", items: ["file.exportStep", "file.exportStl", "file.exportObj", "file.export3mf"] }, "file.pack"] },
  { label: "menu.edit", items: ["edit.undo", "edit.redo"] },
  { label: "menu.view", items: ["view.fit", "-", ...views.map((v) => `view.${v}`), "-", ...modes.map((m) => `mode.${m}`), "-", "view.section", "view.grid", "view.realistic", "-", "view.newWindow"] },
  { label: "menu.settings", items: ["settings.user", "settings.shortcuts", "settings.gestures", "-", "settings.appearance"] },
  { label: "menu.help", items: ["help.tour", "-", "help.bugReport", "help.about"] },
];

/** Menu entries added later (extensions), per menu: at the end, or right after a given entry. */
const [extraMenuItems, setExtraMenuItems] = createSignal<Partial<Record<TKey, string[]>>>({});
const [placedItems, setPlacedItems] = createSignal<{ menu: TKey; after: string; id: string }[]>([]);
export const menuItems = (menu: (typeof menus)[number]): MenuEntry[] => {
  const extra = extraMenuItems()[menu.label] ?? [];
  const placed = placedItems().filter((p) => p.menu === menu.label);
  const items = placed.length ? menu.items.flatMap((e) => [e, ...placed.filter((p) => p.after === e).map((p) => p.id)]) : menu.items;
  return extra.length ? [...items, "-", ...extra] : items;
};

/** Adds a command to a menu right after the entry `after` (module command among the built-in ones: File › New drawing). */
export function insertMenuCommand(menu: TKey, after: string, c: AppCommand): void {
  if (commandById.get(c.id)) return;
  commandRegistry.add(c);
  setPlacedItems((all) => [...all, { menu, after, id: c.id }]);
}

/** Adds a command to a menu, to search and to the configurable shortcuts. */
export function addMenuCommand(menu: TKey, c: AppCommand): void {
  if (commandById.get(c.id)) return;
  commandRegistry.add(c); // search and shortcuts: via the registry subscription
  setExtraMenuItems((m) => ({ ...m, [menu]: [...(m[menu] ?? []), c.id] }));
}

// --- Registration of shortcut actions (CAD profile = original behaviour) ----------------

/** Workbench (scope) of a command, derived from its identifier prefix. */
const scopeOf = (id: string): Scope =>
  id.startsWith("view.") || id.startsWith("mode.")
    ? "view"
    : id.startsWith("part.") || id.startsWith("edit.") // undo/redo of the part: no fallback to other workbenches
      ? "part"
      : id.startsWith("sheetmetal.")
        ? "sheetmetal"
        : "global";

/** CAD profile shortcuts (undo/redo: common actions, keymap/common.ts). */
const CAD_DEFAULTS: Record<string, string[]> = {
  "file.open": ["Ctrl+O"],
  "file.save": ["Ctrl+S"],
  "view.fit": ["F"],
};

const shortcutOf = (c: AppCommand): ShortcutAction => ({
  id: c.id,
  scope: scopeOf(c.id),
  label: c.label,
  icon: c.icon,
  defaults: CAD_DEFAULTS[c.id] ?? [],
  run: c.run,
  enabled: c.enabled,
  allowInInput: c.id === "file.open" || c.id === "file.save" || undefined,
});

commandRegistry.subscribe((added, removed) => {
  unregisterActions(removed.map((c) => c.id));
  registerActions(added.map(shortcutOf));
});

registerActions([
  ...commands().map(shortcutOf),
  { id: "app.search", scope: "global", label: () => t("menu.search"), defaults: ["Ctrl+K"], allowInInput: true, run: runSearch },
  { id: "global.confirm", scope: "global", label: () => t("key.confirm"), defaults: ["Enter"], locked: true, enabled: () => !!state.editing, run: () => confirmEdit() },
  {
    id: "global.cancel",
    scope: "global",
    label: () => t("key.cancel"),
    defaults: ["Escape"],
    locked: true,
    run: () => {
      if (state.editing) cancelEdit();
      else if (state.sketchFor) cancelSketchFor();
      else if (state.dimsFeature && wsp.activeKind() === "part") showFeatureDims(null);
      else getViewer()?.clearSelection();
    },
  },
]);

/** Keyboard shortcuts: a single listener, delegated to the keymap dispatcher. */
export function installShortcuts(focusSearch: () => void): () => void {
  const stopPersist = initKeymapPersistence();
  const stopGestures = initGesturesPersistence();
  const stopDispatch = installKeymapDispatcher(focusSearch);
  return () => {
    stopDispatch();
    stopGestures();
    stopPersist();
  };
}
