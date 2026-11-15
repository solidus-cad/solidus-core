import { SEQUENCE_MS, eventToCombo } from "./keys.ts";
import { actionsOfScope, type ShortcutAction } from "./registry.ts";
import { capturing, resolve, resolveLocked, setSearchHandler, shortcutsFor } from "./keymap.ts";
import { activeScopes } from "./scopes.ts";
import * as wsp from "../workspace.ts";
import * as s3d from "../sketch3d/session.ts";
import { emit } from "../events.ts";
import { activeKeyMode } from "../host.ts";

/**
 * Keyboard dispatcher: a single `window` listener, which resolves each combination in the
 * active scopes. The original rules are kept:
 * - nothing when typing in a field, except the `allowInInput` actions (search, save, open);
 * - `preventDefault` only if an action was executed;
 * - the contextual logic of the 3D sketch (length/coordinate input, X/Y/Z locks,
 *   Tab, Enter/Escape cascade) and the Enter/Escape of the frame stay in code (`locked` actions);
 * - in the 3D sketch and in the frame, unrecognized single keys are swallowed (as before).
 * The separate listeners (measure, drawing polyline, Shift of the 3D sketch, dialogs) are not touched.
 */
export function installKeymapDispatcher(focusSearch: () => void): () => void {
  setSearchHandler(focusSearch);
  /** Current sequence: first key and time (FreeCAD style, "V F" within 800 ms). */
  let seq: { first: string; at: number } | null = null;
  /** Last key combination typed (bug log). */
  let lastCombo = "";

  const enabled = (a: ShortcutAction): boolean => a.enabled?.() ?? true;
  /** Runs the action if it is active; returns true if executed. */
  const tryRun = (a: ShortcutAction | undefined): boolean => {
    if (!a || !enabled(a)) return false;
    emit({ type: "command", id: a.id, label: a.label(), via: "key", combo: lastCombo });
    a.run();
    return true;
  };

  /** Resolves the second key of the current sequence. */
  const seqResolve = (combo: string, scopes: ReturnType<typeof activeScopes>): ShortcutAction | undefined => {
    if (seq && Date.now() - seq.at < SEQUENCE_MS) {
      const a = resolve(seq.first + " " + combo, scopes);
      seq = null;
      if (a) return a;
    } else seq = null;
    return undefined;
  };

  /** True if an action in the active scopes has a sequence starting with this combination. */
  const seqStart = (combo: string, scopes: ReturnType<typeof activeScopes>): boolean => {
    for (const s of scopes) {
      for (const a of actionsOfScope(s)) {
        if (a.locked) continue;
        for (const b of shortcutsFor(a.id)) {
          const parts = b.split(" ");
          if (parts.length === 2 && parts[0] === combo) {
            seq = { first: combo, at: Date.now() };
            return true;
          }
        }
      }
    }
    return false;
  };

  const onKey = (ev: KeyboardEvent) => {
    if (capturing()) return; // key capture in the settings window: dispatcher suspended
    const target = ev.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
    const combo = eventToCombo(ev);
    if (!combo) return;
    lastCombo = seq && Date.now() - seq.at < SEQUENCE_MS ? seq.first + " " + combo : combo;
    const scopes = activeScopes();

    // Shortcuts active even in a field: search, save, open — only their
    // modified combinations (Ctrl/Alt) or function keys, so as not to steal typing ("S" in Fusion).
    if (typing) {
      if (!/(^|\+)(Ctrl|Alt)\+|^F\d+$/.test(combo)) return;
      const a = resolve(combo, scopes);
      if (a?.allowInInput && tryRun(a)) ev.preventDefault();
      return;
    }

    const key = ev.key.toLowerCase();
    const ctrl = ev.ctrlKey || ev.metaKey;

    // --- 3D sketch: input, axis locks, contextual Enter/Escape/Tab (in code) ------------
    if (wsp.ws.sketch3d) {
      if (ctrl) {
        // Undo/redo and other modified combos: resolved by the registry.
        if (tryRun(seqResolve(combo, scopes) ?? resolve(combo, scopes))) ev.preventDefault();
        return;
      }
      const s = s3d.s3;
      if (key === "enter") {
        ev.preventDefault();
        s3d.applyTypedOrFinish();
        return;
      }
      if (key === "backspace" && s.typed) {
        ev.preventDefault();
        s3d.setS3("typed", (x) => x.slice(0, -1));
        return;
      }
      if (key === "escape") {
        ev.preventDefault();
        s3d.escapeCascade();
        return;
      }
      if (key === "tab") {
        ev.preventDefault();
        s3d.cyclePlane();
        return;
      }
      // Input: digits and separators; after "=", the whole formula.
      const drawing = s.tool === "line" || s.tool === "point";
      const formula = s.typed.startsWith("=");
      if (drawing && ev.key.length === 1 && (formula || /[0-9.,;@\\-]/.test(ev.key) || (ev.key === " " && s.typed) || (ev.key === "=" && !s.typed))) {
        ev.preventDefault();
        s3d.setS3("typed", (x) => x + ev.key);
        return;
      }
      if ((key === "x" || key === "y" || key === "z") && drawing) {
        ev.preventDefault();
        const axis = key.toUpperCase() as "X" | "Y" | "Z";
        s3d.setS3("lock", (l) => (l === axis ? null : axis));
        return;
      }
      // Tools, deletion, views…: resolved by the registry; the rest is swallowed (as before).
      if (tryRun(seqResolve(combo, scopes) ?? resolve(combo, scopes))) {
        ev.preventDefault();
        return;
      }
      if (seqStart(combo, scopes)) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      return;
    }

    // --- Editing mode of a module (welded frame: Enter validates the step, Escape deselects then closes) ---
    const keyMode = activeKeyMode();
    if (keyMode) {
      if (ctrl) {
        if (tryRun(seqResolve(combo, scopes) ?? resolve(combo, scopes))) ev.preventDefault();
        return;
      }
      if (keyMode.key(key)) {
        ev.preventDefault();
        return;
      }
      if (tryRun(seqResolve(combo, scopes) ?? resolve(combo, scopes))) {
        ev.preventDefault();
        return;
      }
      if (seqStart(combo, scopes)) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault(); // assembly shortcuts are inactive during editing
      return;
    }

    // --- General case: sketch, assembly, drawing, part ----------------------------------------
    const seqAction = seqResolve(combo, scopes);
    if (seqAction) {
      if (tryRun(seqAction)) ev.preventDefault();
      return;
    }
    // Action configurable.
    const a = resolve(combo, scopes);
    if (a) {
      if (tryRun(a)) ev.preventDefault();
      return;
    }
    // Contextual locked keys (Escape/Enter of the workbenches, global validate/cancel).
    // As originally, the global actions (validate/cancel) do not block the default key.
    const locked = resolveLocked(combo, scopes);
    if (locked) {
      if (tryRun(locked) && locked.scope !== "global") ev.preventDefault();
      return;
    }
    // Start of a sequence?
    if (seqStart(combo, scopes)) ev.preventDefault();
  };

  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
