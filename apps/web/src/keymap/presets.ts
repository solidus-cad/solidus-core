import { parseCombo } from "./keys.ts";

export type PresetId = "cad" | "solidworks" | "fusion" | "freecad";
export const PRESET_IDS: PresetId[] = ["cad", "solidworks", "fusion", "freecad"];
export const DEFAULT_PRESET: PresetId = "cad";

/** Overrides relative to the CAD profile: Record<actionId, combos>. */
export type PresetOverrides = Partial<Record<string, string[]>>;

/**
 * Predefined profiles inspired by other CAD software. A profile only overrides the
 * listed actions; the others keep their CAD profile shortcut (or their shared action's).
 * Unknown ids have no effect (no action reads them).
 */
export const PRESETS: Record<PresetId, PresetOverrides> = {
  cad: {},
  // SolidWorks: orientations Ctrl+1…8 (Ctrl+8 = normal to), F = zoom to fit, Delete only.
  solidworks: {
    "view.front": ["Ctrl+1"],
    "view.back": ["Ctrl+2"],
    "view.left": ["Ctrl+3"],
    "view.right": ["Ctrl+4"],
    "view.top": ["Ctrl+5"],
    "view.bottom": ["Ctrl+6"],
    "view.iso": ["Ctrl+7"],
    "sketch3d.lookAt": ["Ctrl+8"],
    "common.delete": ["Delete"],
    "common.redo": ["Ctrl+Y"],
  },
  // Fusion 360: S = search box, E extrude, H hole, F fillet, F6 zoom to fit…
  fusion: {
    "app.search": ["Ctrl+K", "S"],
    "common.select": [],
    "view.fit": ["F6"],
    "part.extrude": ["E"],
    "part.hole": ["H"],
    "part.fillet": ["F"],
    "sketch.construction": ["X"],
    "sketch.offset": ["O"],
    "sketch.trim": ["T"],
    "sketch.project": ["P"],
    "assembly.move": ["M"],
    "common.redo": ["Ctrl+Y", "Ctrl+Shift+Z"],
  },
  // FreeCAD: views on the keypad (0 iso, 1 front…), sequences "V F", "V 3", "G L"…
  freecad: {
    "view.iso": ["0"],
    "view.front": ["1"],
    "view.top": ["2"],
    "view.right": ["3"],
    "view.back": ["4"],
    "view.bottom": ["5"],
    "view.left": ["6"],
    "view.fit": ["V F"],
    "mode.shadedEdges": ["V 2"],
    "mode.shaded": ["V 3"],
    "mode.wireframe": ["V 4"],
    "mode.hiddenLines": ["V 6"],
    "sketch.line": ["G L"],
    "sketch.rect": ["G R"],
    "sketch.circle": ["G C"],
    "sketch.arc": ["G A"],
    "sketch.point": ["G Y"],
    "sketch.fillet": ["G F"],
    "sketch.trim": ["G T"],
    "sketch.construction": ["G N"],
    "sketch.c.coincident": ["C"],
    "sketch.c.horizontal": ["H"],
  },
};

/** Normalizes a profile override: valid combos only, ids with an action only. */
export function sanitizeOverrides(overrides: PresetOverrides, known: (id: string) => boolean): PresetOverrides {
  const out: PresetOverrides = {};
  for (const [id, combos] of Object.entries(overrides)) {
    if (!known(id) || !Array.isArray(combos)) continue;
    const valid = combos.filter((c): c is string => typeof c === "string" && parseCombo(c) !== null);
    if (valid.length) out[id] = valid;
  }
  return out;
}
