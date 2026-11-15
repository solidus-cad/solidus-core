import { createSignal, type Component } from "solid-js";
import type { AssemblyDocument, FixtureDefinition, MachineDefinition } from "@solidus-cad/sdk";
import type { Feature } from "./license.ts";
import type { Viewer } from "@solidus-cad/viewer";

/**
 * Application extension points for the modules (CAM…) compiled with it (`CAD_EXTENSIONS`, see
 * vite-extensions.js). The core knows no module: it consults these registries. A module registers when its
 * `AppExtension` is activated (before the first render); everything is reactive, so the registration order
 * does not matter for the interface.
 *
 * Modules are first-party (same build repository, same types): they import the application's internal modules
 * through the `@app/*` alias. Third-party plugins go through `definePlugin` (@solidus-cad/sdk) instead.
 */

// --- Re-edit guards ----------------------------------------------------------------------

/** Guard of a function type (paid module): calls `run` if the right is granted, otherwise explains the refusal. */
export type EditGuard = (run: () => void) => void;

const [editGuards, setEditGuards] = createSignal<Record<string, EditGuard>>({});

/**
 * Functions of these types are modified (re-edit, dimensions in the view) only through `guard`: the commands of a
 * module's ribbon are already guarded; re-editing an existing function goes through here.
 */
export function registerEditGuard(types: readonly string[], guard: EditGuard): void {
  setEditGuards((g) => ({ ...g, ...Object.fromEntries(types.map((t) => [t, guard])) }));
}

/** Runs `run` under the guard of the function type, if it has one. */
export function guardEdit(type: string, run: () => void): void {
  const guard = editGuards()[type];
  if (guard) guard(run);
  else run();
}

// --- Document types ------------------------------------------------------------------------

/** Document type provided by a module (CAM program…) and plugged into the workspace. */
export interface DocKindExtension {
  kind: string;
  /** Icon and name shown in the document tabs. */
  icon: string;
  label: () => string;
  /** The document becomes active / is no longer active / stays open but its history may be compressed. */
  enter(id: string): void;
  leave(id: string): void;
  pack(activeId: string): void;
  /** Content to compare to detect changes; source document (part) it depends on. */
  doc(id: string): object | undefined;
  source(id: string): string | undefined;
  /** Is document `id` (part, assembly) used by a document of this type? */
  usesDoc(id: string): boolean;
  forget(id: string): void;
  /** Saves the active document; false if the user cancels. */
  save(): Promise<boolean>;
  /** Opens the most recent document of this type, or creates one. */
  openOrCreate(): void;
  /** Paid function required to create a document of this type. */
  feature?: Feature;
  /** Creation from the "+" menu of the tabs. */
  create?(): void;
  /** File extensions opened by this type (".vcam") and how they are loaded. */
  files?: { ext: string; load(data: Uint8Array): void }[];
  /** Kinematics shown when this document type is active (machine of the program). */
  machine?: () => MachineDefinition | FixtureDefinition | null;
  machineAsm?: () => AssemblyDocument | null;
  /** Drawing linked to this document, if it is open (a quote points back to the drawing it comes from). */
  drawingId?(id: string): string | undefined;
  /** Label of the creation entry of the "+" menu (default: `label`). */
  newLabel?: () => string;
  /** Workbench whose deactivation (module choice) hides the creation entries, e.g. "drawing". */
  module?: string;
  /** No checkpoints for this type (tab context menu). */
  noCheckpoints?: boolean;
  /** A part or assembly dragged onto a tab of this type (Documents panel, tabs): accepted / dropped. */
  acceptsDrop?(sourceId: string): boolean;
  drop?(targetId: string, sourceId: string): void;
  /** Entry of the context menu of a part or assembly tab: creates a document of this type from it. */
  createFrom?: { label: () => string; run(sourceId: string): void };
}

const [kinds, setKinds] = createSignal<readonly DocKindExtension[]>([]);

export function registerDocKind(k: DocKindExtension): void {
  setKinds((all) => [...all.filter((x) => x.kind !== k.kind), k]);
}
export const docKind = (kind: string): DocKindExtension | undefined => kinds().find((k) => k.kind === kind);
export const docKinds = (): readonly DocKindExtension[] => kinds();

// --- Interface components -------------------------------------------------------------------

export interface Slots {
  /** Dialog windows, permanently rendered at the root of the application (they hide themselves). */
  dialogs: { id: string; component: Component };
  /** Left panel: the first one whose `when()` is true replaces the default tree. */
  leftPanels: { id: string; when: () => boolean; component: Component };
  /** Banner above the assembly tree (editing context of a machine). */
  assemblyBanners: { id: string; component: Component };
  /** Buttons of the 3D view toolbar. */
  viewportTools: { id: string; component: Component };
  /** Floating panels of the 3D view. */
  viewportOverlays: { id: string; component: Component };
  /** Replaces the 3D view (kept mounted, hidden) while `when()` is true: drawing sheet. */
  centerViews: { id: string; when: () => boolean; component: Component };
  /** Footer of the central area, below the 3D view (timeline of a motion study). */
  centerFooters: { id: string; when: () => boolean; component: Component };
  /** Extra column to the right of the 3D view (quote scene). */
  stages: { id: string; when: () => boolean; component: Component };
  /** Right panel: the first one whose `when()` is true replaces the Documents/Library panel. */
  rightPanels: { id: string; when: () => boolean; component: Component };
  /**
   * Tab of the right band (AI assistant…), after the built-in tabs: SVG icon (24×24), label, legend shown by the
   * tips pane, panel width while open (CSS length, default 250px), class of the panel body and position (built-in tabs:
   * tips 0, documents 20, properties 30, appearance 40; default 100).
   */
  rightTabs: { id: string; icon: string; label: () => string; legend?: () => string; width?: string; bodyClass?: string; order?: number; component: Component };
  /** CSS class added to the application (`app`), the work area (`workspace`) or the central area (`center`) while `when()` is true. */
  classes: { id: string; target: "app" | "workspace" | "center"; name: string; when: () => boolean };
  /** Called when the 3D view is created; optionally returns a cleanup function. */
  viewerBinders: { id: string; bind: (viewer: Viewer) => void | (() => void) };
  /** Editor drawn over the 3D view, which receives the viewer (welded frame editor…), while `when()` is true. */
  viewerEditors: { id: string; when: () => boolean; component: Component<{ viewer: Viewer }> };
  /** Extra field of Settings › Appearance (activation code of the themes…), after the accents. */
  appearanceFields: { id: string; component: Component };
  /** Indicator of the status bar (license, update…), at its right end. */
  statusFlags: { id: string; component: Component };
  /** Menu of the menu bar, before the built-in menus (desktop downloads…): open state and actions given by the bar. */
  menuBarMenus: { id: string; component: Component<{ open: boolean; toggle(): void; hover(): void; close(): void }> };
  /** Banner at the top of the first-startup wizard (offer, edition…). */
  firstRunBanners: { id: string; component: Component };
  /** Paragraph of the About window, after its text (licence agreement of the official builds…). */
  aboutItems: { id: string; component: Component };
  /** Banner under the menu bar (read-only state…). */
  appBanners: { id: string; component: Component };
}

type Store = { [S in keyof Slots]: Slots[S][] };
const [store, setStore] = createSignal<Store>({ dialogs: [], leftPanels: [], assemblyBanners: [], viewportTools: [], viewportOverlays: [], centerFooters: [], stages: [], rightPanels: [], rightTabs: [], classes: [], viewerBinders: [], viewerEditors: [], appearanceFields: [], statusFlags: [], menuBarMenus: [], firstRunBanners: [], appBanners: [], centerViews: [], aboutItems: [] });

export function contribute<S extends keyof Slots>(slot: S, item: Slots[S]): void {
  setStore((s) => ({ ...s, [slot]: [...(s[slot] as { id: string }[]).filter((x) => x.id !== item.id), item] }) as Store);
}
export const contributions = <S extends keyof Slots>(slot: S): Slots[S][] => store()[slot];

// --- Server of the official builds ------------------------------------------------------------------------

/** Server and token of the signed-in user, provided by the account module (`ctx.library` of the extensions). */
export interface LibraryAccess {
  url: string;
  accessToken(): string | null;
}
const [libraryAccess, setLibraryAccessSignal] = createSignal<LibraryAccess | null>(null);
export { libraryAccess };
export function setLibraryAccess(a: LibraryAccess): void {
  setLibraryAccessSignal(a);
}

// --- Startup -------------------------------------------------------------------------------------------

/**
 * Asynchronous work of a module awaited before the first render (local license or activation codes read back), so that
 * locked workbenches or themes do not flash. Registered from `activate`; a failure is ignored (logged).
 */
const startups: (() => Promise<void> | void)[] = [];
export function registerStartup(fn: () => Promise<void> | void): void {
  startups.push(fn);
}
export async function runStartup(): Promise<void> {
  for (const f of startups) {
    try {
      await f();
    } catch (e) {
      console.error(e);
    }
  }
}

// --- Named actions --------------------------------------------------------------------------

/**
 * Actions a module provides to the core ("catalog.machines", "project.publish", "frame.start", "library.pick"…), with
 * optional arguments (identifiers, callback). The interface shows the button or command only if the action exists.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModuleAction = (...args: any[]) => void;
const [actions, setActions] = createSignal<Readonly<Record<string, ModuleAction>>>({});

export function registerModuleAction(id: string, run: ModuleAction): void {
  setActions((a) => ({ ...a, [id]: run }));
}
export const hasModuleAction = (id: string): boolean => id in actions();
export const runModuleAction = (id: string, ...args: unknown[]): void => actions()[id]?.(...args);

// --- Keyboard of a module editing mode -------------------------------------------------------------

/**
 * Editing mode of a module (welded frame…) that owns the keyboard while `active()`: `key` receives the
 * normalised key ("enter", "escape"…) and returns true if it handled it. Shortcuts of the registry still apply
 * (scope given by `registerContextProvider` or keymap/scopes.ts); other keys are swallowed.
 */
export interface KeyMode {
  id: string;
  active(): boolean;
  key(key: string): boolean;
}
const [keyModes, setKeyModes] = createSignal<readonly KeyMode[]>([]);
export function registerKeyMode(m: KeyMode): void {
  setKeyModes((all) => [...all.filter((x) => x.id !== m.id), m]);
}
export const activeKeyMode = (): KeyMode | undefined => keyModes().find((m) => m.active());

// --- Overlays (analysis…) and editing contexts (motion study…) ---------------------------------------

/** Workspace overlaid on the document (Calculation): the core knows whether it is active and can close it without knowing it. */
export interface OverlayExtension {
  id: string;
  isOn(): boolean;
  close(): void;
}
const [overlays, setOverlays] = createSignal<readonly OverlayExtension[]>([]);
export function registerOverlay(o: OverlayExtension): void {
  setOverlays((all) => [...all.filter((x) => x.id !== o.id), o]);
}
export const moduleOverlayOn = (): boolean => overlays().some((o) => o.isOn());
export function closeModuleOverlays(): void {
  for (const o of overlays()) if (o.isOn()) o.close();
}

/** Editing contexts to finish by returning to the Assembly workspace (end of a motion study…). */
const [contextClosers, setContextClosers] = createSignal<readonly (() => void)[]>([]);
export function registerContextCloser(fn: () => void): void {
  setContextClosers((all) => [...all, fn]);
}
export function closeModuleContexts(): void {
  for (const f of contextClosers()) f();
}

/** Body of the part hidden by a module (volume calculation displays its mesh instead). */
const [bodyHiders, setBodyHiders] = createSignal<readonly (() => boolean)[]>([]);
export function registerBodyHider(fn: () => boolean): void {
  setBodyHiders((all) => [...all, fn]);
}
export const moduleHidesBody = (): boolean => bodyHiders().some((f) => f());

/** Shortcut context provided by a module (key of CONTEXTS, keymap/registry.ts); the first non-null one wins. */
const [contextProviders, setContextProviders] = createSignal<readonly (() => string | undefined)[]>([]);
export function registerContextProvider(fn: () => string | undefined): void {
  setContextProviders((all) => [...all, fn]);
}
export const moduleContext = (): string | undefined => {
  for (const f of contextProviders()) {
    const c = f();
    if (c) return c;
  }
  return undefined;
};
