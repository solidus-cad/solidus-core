import { describe, expect, test } from "vitest";
import { browserBlocked, eventToCombo, formatCombo, isReserved, parseCombo, validateCombo } from "../src/keymap/keys.ts";
import { registerActions, registerCommon, type Scope, type ShortcutAction } from "../src/keymap/registry.ts";
import { conflicts, importShortcuts, isInherited, isModified, loadState, setPreset, parseShortcutsFile, resolve, resolveLocked, setOverride, shortcutsFor } from "../src/keymap/keymap.ts";

const action = (id: string, scope: Scope, defaults: string[]): ShortcutAction => ({ id, scope, label: () => id, defaults, run: () => {} });

describe("parseCombo", () => {
  test("modifiers in canonical order", () => {
    expect(parseCombo("shift+ctrl+z")).toBe("Ctrl+Shift+Z");
    expect(parseCombo("Z")).toBe("Z");
    expect(parseCombo("ctrl+o")).toBe("Ctrl+O");
  });
  test("French aliases", () => {
    expect(parseCombo("Suppr")).toBe("Delete");
    expect(parseCombo("Échap")).toBe("Escape");
    expect(parseCombo("Entrée")).toBe("Enter");
    expect(parseCombo("Maj+S")).toBe("Shift+S");
  });
  test("two-key sequence", () => {
    expect(parseCombo("V F")).toBe("V F");
    expect(parseCombo("G L")).toBe("G L");
  });
  test("invalid", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("Ctrl+")).toBeNull();
    expect(parseCombo("Ctrl+Ctrl+Z")).toBeNull();
    expect(parseCombo("Truc")).toBeNull();
    expect(parseCombo("A B C")).toBeNull();
    expect(parseCombo("Ctrl")).toBeNull();
  });
});

describe("eventToCombo", () => {
  test("letters via ev.key (L stays L on AZERTY)", () => {
    expect(eventToCombo({ key: "l", code: "KeyL" })).toBe("L");
    expect(eventToCombo({ key: "a", code: "KeyQ" })).toBe("A"); // AZERTY: the Q key produces "a"
  });
  test("digits via ev.code (AZERTY: ev.key would give &, é...)", () => {
    expect(eventToCombo({ key: "&", code: "Digit1" })).toBe("1");
    expect(eventToCombo({ key: "é", code: "Digit2" })).toBe("2");
    expect(eventToCombo({ key: "1", code: "Digit1", shiftKey: true })).toBe("Shift+1");
  });
  test("Meta = Ctrl", () => {
    expect(eventToCombo({ key: "s", code: "KeyS", metaKey: true })).toBe("Ctrl+S");
  });
  test("lone modifier or dead key ignored", () => {
    expect(eventToCombo({ key: "Control", code: "ControlLeft" })).toBeNull();
    expect(eventToCombo({ key: "Shift", code: "ShiftLeft" })).toBeNull();
    expect(eventToCombo({ key: "Dead", code: "Quote" })).toBeNull();
  });
  test("named keys", () => {
    expect(eventToCombo({ key: "Escape" })).toBe("Escape");
    expect(eventToCombo({ key: "Enter" })).toBe("Enter");
    expect(eventToCombo({ key: "Delete" })).toBe("Delete");
    expect(eventToCombo({ key: "F2" })).toBe("F2");
    expect(eventToCombo({ key: " ", code: "Space" })).toBe("Space");
  });
  test("full combination", () => {
    expect(eventToCombo({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Z");
  });
});

describe("formatCombo", () => {
  test("localized labels", () => {
    expect(formatCombo("Ctrl+Shift+Z", "fr")).toBe("Ctrl+Maj+Z");
    expect(formatCombo("Ctrl+Shift+Z", "en")).toBe("Ctrl+Shift+Z");
    expect(formatCombo("Delete", "fr")).toBe("Suppr");
    expect(formatCombo("Delete", "en")).toBe("Del");
    expect(formatCombo("Escape", "fr")).toBe("Échap");
    expect(formatCombo("Enter", "fr")).toBe("Entrée");
    expect(formatCombo("Backspace", "fr")).toBe("Retour arr.");
  });
  test("sequence", () => {
    expect(formatCombo("V F", "fr")).toBe("V F");
  });
});

describe("reserved combinations", () => {
  test("rejected", () => {
    for (const c of ["Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+Shift+T", "Ctrl+Tab", "F11", "F12"]) {
      expect(isReserved(c)).toBe(true);
      expect(validateCombo(c)).toBe(false);
    }
    expect(validateCombo("Ctrl+S")).toBe(true);
    expect(validateCombo("L")).toBe(true);
    expect(validateCombo("V F")).toBe(true);
  });
});

describe("resolution and conflicts", () => {
  registerActions([
    action("test.line", "sketch", ["L"]),
    action("test.select", "sketch", ["S"]),
    action("test.fit", "view", ["F"]),
    action("test.extrude", "part", []),
    action("test.flange", "sheetmetal", []),
    { ...action("test.cancel", "sketch", ["Escape"]), locked: true },
  ]);
  loadState("cad", {});

  test("resolve by scope priority", () => {
    expect(resolve("L", ["sketch", "view", "global"])?.id).toBe("test.line");
    expect(resolve("F", ["part", "sheetmetal", "view", "global"])?.id).toBe("test.fit");
    expect(resolve("L", ["part", "view", "global"])).toBeUndefined(); // sketch not active
    expect(resolve("Escape", ["sketch", "view", "global"])).toBeUndefined(); // locked: handled in code
  });
  test("resolveLocked finds the contextual keys", () => {
    expect(resolveLocked("Escape", ["sketch", "view", "global"])?.id).toBe("test.cancel");
  });
  test("user override ([] = shortcut removed, undefined = back to the profile)", () => {
    setOverride("test.line", ["K"]);
    expect(shortcutsFor("test.line")).toEqual(["K"]);
    expect(isModified("test.line")).toBe(true);
    setOverride("test.line", []);
    expect(shortcutsFor("test.line")).toEqual([]);
    setOverride("test.line", undefined);
    expect(shortcutsFor("test.line")).toEqual(["L"]);
    expect(isModified("test.line")).toBe(false);
  });
  test("same-scope conflict = blocking, enclosing scope = warning", () => {
    const same = conflicts("test.line", "S");
    expect(same.blocking.map((a) => a.id)).toEqual(["test.select"]);
    expect(same.shadowed).toEqual([]);
    const shadow = conflicts("test.line", "F");
    expect(shadow.blocking).toEqual([]);
    expect(shadow.shadowed.map((a) => a.id)).toEqual(["test.fit"]);
  });
  test("part and sheetmetal are co-active (blocking conflict)", () => {
    setOverride("test.flange", ["X"]);
    const co = conflicts("test.extrude", "X");
    expect(co.blocking.map((a) => a.id)).toEqual(["test.flange"]);
    setOverride("test.flange", undefined);
  });
});

describe("shortcuts.json file", () => {
  test("corrupted data ignored without crashing", () => {
    expect(parseShortcutsFile("corrompu")).toEqual({ preset: "cad", overrides: {} });
    expect(parseShortcutsFile(null)).toEqual({ preset: "cad", overrides: {} });
    expect(parseShortcutsFile('{"version": 2}')).toEqual({ preset: "cad", overrides: {} });
    expect(parseShortcutsFile('{"preset": "inconnu"}')).toEqual({ preset: "cad", overrides: {} });
  });
  test("unknown ids and invalid combos filtered", () => {
    const parsed = parseShortcutsFile(
      JSON.stringify({ version: 1, preset: "fusion", overrides: { "test.line": ["K", "bidon", "Ctrl+W"], "inconnu.x": ["L"], "test.fit": "L" } }),
    );
    expect(parsed.preset).toBe("fusion");
    expect(parsed.overrides["test.line"]).toEqual(["K"]); // "Ctrl+W" reserved, "bidon" invalid
    expect(parsed.overrides["inconnu.x"]).toBeUndefined();
    expect(parsed.overrides["test.fit"]).toBeUndefined(); // not an array
  });
  test("shortcut of a renamed action carried over under the new identifier", () => {
    registerActions([action("cam.machineCatalog", "cam", [])]);
    const parsed = parseShortcutsFile(JSON.stringify({ version: 1, preset: "cad", overrides: { "assembly.machineCatalog": ["Shift+M"] } }));
    expect(parsed.overrides["cam.machineCatalog"]).toEqual(["Shift+M"]);
    expect(parsed.overrides["assembly.machineCatalog"]).toBeUndefined();
  });
});

describe("actions shared by the workbenches", () => {
  registerActions([
    action("c1.sketch.undo", "sketch", []),
    action("c1.drawing.undo", "drawing", []),
    action("c1.sketch.trim", "sketch", ["T"]),
    action("c1.drawing.text", "drawing", ["Ctrl+U"]),
    action("c1.assembly.u", "assembly", ["Ctrl+U"]),
    action("c1.view.thing", "view", ["Q"]),
  ]);
  registerCommon([{ id: "c1.common.undo", label: () => "undo", defaults: ["Ctrl+Z"], members: ["c1.sketch.undo", "c1.drawing.undo"] }]);
  loadState("cad", {});

  test("workbenches inherit the shared shortcut", () => {
    expect(shortcutsFor("c1.sketch.undo")).toEqual(["Ctrl+Z"]);
    expect(isInherited("c1.drawing.undo")).toBe(true);
    expect(resolve("Ctrl+Z", ["drawing", "global"])?.id).toBe("c1.drawing.undo");
    expect(resolve("Ctrl+Z", ["sketch", "view", "global"])?.id).toBe("c1.sketch.undo");
  });
  test("changing the shared one changes all workbenches", () => {
    setOverride("c1.common.undo", ["Ctrl+Alt+Z"]);
    expect(shortcutsFor("c1.sketch.undo")).toEqual(["Ctrl+Alt+Z"]);
    expect(shortcutsFor("c1.drawing.undo")).toEqual(["Ctrl+Alt+Z"]);
    expect(isModified("c1.sketch.undo")).toBe(false); // always follows the shared one
    setOverride("c1.common.undo", undefined);
  });
  test("local override of a workbench, then back to the shared one", () => {
    setOverride("c1.sketch.undo", ["Alt+Z"]);
    expect(isInherited("c1.sketch.undo")).toBe(false);
    expect(isModified("c1.sketch.undo")).toBe(true);
    expect(shortcutsFor("c1.drawing.undo")).toEqual(["Ctrl+Z"]);
    setOverride("c1.sketch.undo", undefined);
    expect(isInherited("c1.sketch.undo")).toBe(true);
  });
  test("conflicts of a shared action checked in each member workbench", () => {
    expect(conflicts("c1.common.undo", "T").blocking.map((a) => a.id)).toEqual(["c1.sketch.trim"]);
    expect(conflicts("c1.common.undo", "Ctrl+U").blocking.map((a) => a.id)).toEqual(["c1.drawing.text"]); // the assembly is not a member
    expect(conflicts("c1.common.undo", "Q").shadowed.map((a) => a.id)).toEqual(["c1.view.thing"]); // view active with the sketch
  });
  test("a member workbench in conflict with another shared action is flagged by the shared action", () => {
    registerActions([action("c1.sketch.redo", "sketch", [])]);
    registerCommon([{ id: "c1.common.redo", label: () => "redo", defaults: ["Ctrl+Y"], members: ["c1.sketch.redo"] }]);
    expect(conflicts("c1.common.undo", "Ctrl+Y").blocking.map((a) => a.id)).toEqual(["c1.common.redo"]);
  });
  test("workbenches never active together: no conflict", () => {
    const c = conflicts("c1.drawing.text", "Ctrl+U");
    expect(c.blocking).toEqual([]);
    expect(c.shadowed).toEqual([]);
  });
});

describe("profiles and import", () => {
  test("a profile overrides without erasing user changes", () => {
    loadState("cad", { "test.line": ["K"] });
    setPreset("freecad");
    expect(shortcutsFor("test.line")).toEqual(["K"]);
    loadState("cad", {});
  });
  test("import: unreadable JSON rejected, valid applied", () => {
    expect(importShortcuts("pas du json")).toBe(false);
    expect(importShortcuts(JSON.stringify({ version: 1, preset: "solidworks", overrides: { "test.line": ["J"] } }))).toBe(true);
    expect(shortcutsFor("test.line")).toEqual(["J"]);
    loadState("cad", {});
  });
  test("Ctrl+digit flagged as captured by the browser", () => {
    expect(browserBlocked("Ctrl+1")).toBe(true);
    expect(browserBlocked("1")).toBe(false);
    expect(browserBlocked("Ctrl+K")).toBe(false);
  });
});
