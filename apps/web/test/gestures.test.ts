import { describe, expect, test } from "vitest";
import { DEFAULT_SLOTS, GESTURE_CONTEXTS, parseGesturesFile, sectorAt } from "../src/gestures/gestures.ts";

describe("sectorAt", () => {
  test("8 directions, clockwise from the top (screen y pointing down)", () => {
    expect(sectorAt(0, -50, 8)).toBe(0);
    expect(sectorAt(40, -40, 8)).toBe(1);
    expect(sectorAt(50, 0, 8)).toBe(2);
    expect(sectorAt(40, 40, 8)).toBe(3);
    expect(sectorAt(0, 50, 8)).toBe(4);
    expect(sectorAt(-40, 40, 8)).toBe(5);
    expect(sectorAt(-50, 0, 8)).toBe(6);
    expect(sectorAt(-40, -40, 8)).toBe(7);
  });
  test("4 directions: N/E/S/W slots only", () => {
    expect(sectorAt(10, -50, 4)).toBe(0);
    expect(sectorAt(50, 20, 4)).toBe(2);
    expect(sectorAt(-10, 50, 4)).toBe(4);
    expect(sectorAt(-50, -20, 4)).toBe(6);
  });
});

describe("parseGesturesFile", () => {
  test("missing or unreadable file: default values", () => {
    expect(parseGesturesFile(null)).toEqual({ version: 1, enabled: true, count: 8, slots: {} });
    expect(parseGesturesFile("{oops")).toEqual({ version: 1, enabled: true, count: 8, slots: {} });
    expect(parseGesturesFile('{"version":2,"enabled":false}').enabled).toBe(true);
  });
  test("wheels completed to 8 slots, unknown workbenches ignored", () => {
    const f = parseGesturesFile(JSON.stringify({ version: 1, enabled: false, count: 4, slots: { sketch: ["sketch.line", 3], nope: ["x"] } }));
    expect(f.enabled).toBe(false);
    expect(f.count).toBe(4);
    expect(f.slots.sketch).toEqual(["sketch.line", "", "", "", "", "", "", ""]);
    expect(Object.keys(f.slots)).toEqual(["sketch"]);
  });
  test("each workbench has a default wheel of 8 slots", () => {
    for (const c of GESTURE_CONTEXTS) expect(DEFAULT_SLOTS[c]).toHaveLength(8);
  });
});
