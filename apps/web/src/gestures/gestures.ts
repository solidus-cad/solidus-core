import { createSignal } from "solid-js";
import { readUserFile, writeUserFile } from "../userdata.ts";
import { actionsOfScope, CONTEXTS, type ShortcutAction } from "../keymap/registry.ts";

/**
 * Gesture menu (right-button drag, SolidWorks style): a wheel of 4 or 8 commands per workspace,
 * configurable in Settings › Mouse gestures. The commands are the actions of the shortcut registry.
 */

/** Workspaces with their own wheel (the machine of a CAM program uses that of the assembly). */
export type GestureContext = Exclude<keyof typeof CONTEXTS, "machine" | "motion">;
export const GESTURE_CONTEXTS: GestureContext[] = ["part", "sketch", "sketch3d", "assembly", "frame", "analysis", "drawing", "cam", "quote"];

export const toGestureContext = (c: keyof typeof CONTEXTS): GestureContext => (c === "machine" || c === "motion" ? "assembly" : c);

/** 8 slots, clockwise from the top: N, NE, E, SE, S, SW, W, NW ("" = empty). */
export type Slots = string[];
export type GestureCount = 4 | 8;
/** Slots used in 4-direction mode: N, E, S, W. */
export const CARDINALS = [0, 2, 4, 6];

/**
 * Default wheels: the most used tools of each workspace (the views stay on the cube and in the shortcuts).
 * The 4 main directions (N, E, S, W) carry the most common ones: they are the ones that remain in 4-direction mode.
 */
export const DEFAULT_SLOTS: Record<GestureContext, Slots> = {
  part: ["part.sketch", "part.revolve", "part.extrude", "part.chamfer", "part.fillet", "part.shell", "part.hole", "part.plane"],
  sketch: ["sketch.line", "sketch.arc", "sketch.rect", "sketch.trim", "sketch.dim", "sketch.construction", "sketch.circle", "sketch.fillet"],
  sketch3d: ["sketch3d.line", "sketch3d.lookAt", "sketch3d.point", "sketch3d.delete", "sketch3d.dimension", "sketch3d.undo", "sketch3d.select", "sketch3d.plane"],
  assembly: ["assembly.insert", "assembly.copy", "assembly.move", "assembly.fix", "assembly.rotate", "assembly.delete", "assembly.partCatalog", "assembly.bom"],
  frame: ["frame.newStep", "", "frame.cutList", "", "frame.undo", "", "frame.redo", ""],
  analysis: ["analysis.run", "analysis.stress", "analysis.solid.fixture", "analysis.solid.force", "analysis.deformed", "analysis.result.probe", "analysis.solid.mesh", "analysis.solid.material"],
  drawing: ["drawing.dimension", "drawing.diameter", "drawing.note", "drawing.leader", "drawing.balloon", "drawing.gdt", "drawing.text", "drawing.line"],
  cam: ["cam.op.contour", "cam.op.face", "cam.op.pocket", "cam.showMachine", "cam.post", "cam.addSetup", "cam.op.drill", "cam.library"],
  quote: ["quote.importDrawing", "quote.recognize", "quote.importPart", "quote.save", "quote.undo", "", "quote.redo", ""],
};

export interface GesturesFile {
  version: 1;
  enabled: boolean;
  count: GestureCount;
  /** Wheels modified by the user (the others follow the default values). */
  slots: Partial<Record<GestureContext, Slots>>;
}

const DEFAULT_FILE: GesturesFile = { version: 1, enabled: true, count: 8, slots: {} };

const [settings, setSettings] = createSignal<GesturesFile>(DEFAULT_FILE);
export { settings as gestureSettings };

export const gesturesEnabled = (): boolean => settings().enabled;
export const gestureCount = (): GestureCount => settings().count;

/** Wheel of a workspace (8 slots). */
export const slotsFor = (ctx: GestureContext): Slots => settings().slots[ctx] ?? DEFAULT_SLOTS[ctx];

export const isCustomized = (ctx: GestureContext): boolean => !!settings().slots[ctx];

/** Actions offered in a workspace's wheel: those of its active scopes, excluding locked keys. */
export function actionsForContext(ctx: GestureContext): ShortcutAction[] {
  return CONTEXTS[ctx].flatMap((s) => actionsOfScope(s).filter((a) => !a.locked));
}

/**
 * Slot targeted by a movement (dx, dy in screen pixels, y downward):
 * index 0…7 clockwise from the top; in 4-direction mode, only N/E/S/W.
 */
export function sectorAt(dx: number, dy: number, count: GestureCount): number {
  const a = Math.atan2(dx, -dy); // 0 = haut, sens horaire
  const step = (2 * Math.PI) / count;
  const i = ((Math.round(a / step) % count) + count) % count;
  return count === 8 ? i : i * 2;
}

// --- Changes ------------------------------------------------------------------------------

let save: () => void = () => {};

function update(fn: (s: GesturesFile) => GesturesFile): void {
  setSettings(fn(settings()));
  save();
}

export const setGesturesEnabled = (enabled: boolean) => update((s) => ({ ...s, enabled }));
export const setGestureCount = (count: GestureCount) => update((s) => ({ ...s, count }));

export function setSlot(ctx: GestureContext, index: number, actionId: string): void {
  const next = [...slotsFor(ctx)];
  next[index] = actionId;
  update((s) => ({ ...s, slots: { ...s.slots, [ctx]: next } }));
}

export function resetContext(ctx: GestureContext): void {
  update((s) => {
    const slots = { ...s.slots };
    delete slots[ctx];
    return { ...s, slots };
  });
}

export const resetGestures = () => update(() => DEFAULT_FILE);

// --- Device file `gestures.json` ---------------------------------------------------------------

export const GESTURES_FILE = "gestures.json";

/** Parses `gestures.json`; corrupted data is ignored (an unknown identifier gives an empty slot in the display). */
export function parseGesturesFile(text: string | null): GesturesFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return DEFAULT_FILE;
  }
  if (!raw || typeof raw !== "object") return DEFAULT_FILE;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return DEFAULT_FILE;
  const out: GesturesFile = {
    version: 1,
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_FILE.enabled,
    count: o.count === 4 ? 4 : 8,
    slots: {},
  };
  if (o.slots && typeof o.slots === "object") {
    for (const [ctx, v] of Object.entries(o.slots as Record<string, unknown>)) {
      if (!(GESTURE_CONTEXTS as string[]).includes(ctx) || !Array.isArray(v)) continue;
      out.slots[ctx as GestureContext] = Array.from({ length: 8 }, (_, i) => (typeof v[i] === "string" ? (v[i] as string) : ""));
    }
  }
  return out;
}

/** Loads `gestures.json` at startup and writes it on each change. Returns the stop function. */
export function initGesturesPersistence(): () => void {
  let disposed = false;
  let touched = false;
  let writing: Promise<void> = Promise.resolve();
  save = () => {
    touched = true;
    const text = JSON.stringify(settings(), null, 2);
    writing = writing.then(() => writeUserFile(GESTURES_FILE, text));
  };
  void readUserFile(GESTURES_FILE).then((text) => {
    if (!disposed && !touched) setSettings(parseGesturesFile(text));
  });
  return () => {
    disposed = true;
    save = () => {};
  };
}
