// Parity with the reference kernel (recorded results, see reference.ts): sheet metal (body and flat pattern),
// interferences, drawing views.
import { beforeAll, describe, expect, it } from "vitest";
import { emptySketch, sketchFrame, SKETCH_ORIGIN, type FlatPattern, type ProjectedView, type RecomputeResult, type SketchData } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";
import { length, reference, type RefFlat, type RefRecompute, type RefView } from "./reference.ts";
import { doc } from "./scenarios.ts";

let core: WasmKernelEngine;

beforeAll(async () => {
  core = await WasmKernelEngine.create(await SketchSolver.create());
});

const close = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

function sameBody(a: RefRecompute, b: RecomputeResult): void {
  expect(b.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(a.statuses.map((s) => (s.ok ? "ok" : s.error)));
  expect(b.mass === null).toBe(a.mass === null);
  if (a.mass && b.mass) expect(close(b.mass.volume, a.mass.volume, 1e-5), `volume ${b.mass.volume} ≠ ${a.mass.volume}`).toBe(true);
}

function sameFlat(a: RefFlat, b: FlatPattern): void {
  for (let i = 0; i < 4; i++) expect(b.bounds[i]).toBeCloseTo(a.bounds[i]!, 3);
  expect(b.bends.length).toBe(a.bends.length);
  b.bends.forEach((x, i) => {
    const y = a.bends[i]!;
    for (const k of ["x1", "y1", "x2", "y2", "angle"] as const) expect(x[k]).toBeCloseTo(y[k], 4);
    expect(x.up).toBe(y.up);
  });
  expect(length(b.outline)).toBeCloseTo(a.outline, 1);
  expect(b.circles.length).toBe(a.circles);
}

function sameView(a: RefView, b: ProjectedView): void {
  for (let i = 0; i < 4; i++) expect(b.bounds[i]).toBeCloseTo(a.bounds[i]!, 3);
  expect(length(b.visible)).toBeCloseTo(a.visible, 1);
  expect(length(b.hidden)).toBeCloseTo(a.hidden, 1);
  expect(b.circles.length).toBe(a.circles);
  expect((b.hatches ?? []).map((h) => h.key)).toEqual(a.hatches.map((h) => h.key));
  a.hatches.forEach((h, i) => expect(length(b.hatches![i]!.segments)).toBeCloseTo(h.length, 1));
}

// --- Sheet metal --------------------------------------------------------------------------

function rect(): SketchData {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "b", type: "point", x: 100, y: 0 },
    { id: "c", type: "point", x: 100, y: 60 },
    { id: "d", type: "point", x: 0, y: 60 },
    { id: "l1", type: "line", p1: SKETCH_ORIGIN, p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
    { id: "l3", type: "line", p1: "c", p2: "d" },
    { id: "l4", type: "line", p1: "d", p2: SKETCH_ORIGIN },
  ];
  return s;
}

function circle(base: "XY" | "XZ", x: number, y: number, r: number): SketchData {
  const s = emptySketch(base);
  s.geometry = [
    { id: "c", type: "point", x, y },
    { id: "k", type: "circle", c: "c", r },
  ];
  return s;
}

function lProfile(): SketchData {
  const s = emptySketch("XZ");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 50, y: 0 },
    { id: "c", type: "point", x: 50, y: 30 },
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
  ];
  return s;
}

const sheet = { thickness: "2", radius: "2", kFactor: "0.5", depth: "40", reverse: "no" };
const base = [
  { id: "sk", type: "sketch", params: {}, sketch: rect() },
  { id: "base", type: "sheetBase", params: { ...sheet, sketch: "sk" } },
];
const flange = {
  id: "fl",
  type: "edgeFlange",
  params: { length: "20", angle: "90", direction: "same" } as Record<string, string>,
  refs: [{ kind: "edge" as const, p: [50, 60, 2] as [number, number, number], size: 100 }],
};
const sideEdge = { kind: "edge" as const, p: [100, 30, 2] as [number, number, number], size: 60 };
const line = () => {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "a", type: "point", x: 50, y: -10 },
    { id: "b", type: "point", x: 50, y: 70 },
    { id: "l", type: "line", p1: "a", p2: "b" },
  ];
  return s;
};
const notch = () => {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "p1", type: "point", x: 40, y: 55 },
    { id: "p2", type: "point", x: 60, y: 55 },
    { id: "p3", type: "point", x: 60, y: 90 },
    { id: "p4", type: "point", x: 40, y: 90 },
    { id: "a", type: "line", p1: "p1", p2: "p2" },
    { id: "b", type: "line", p1: "p2", p2: "p3" },
    { id: "c", type: "line", p1: "p3", p2: "p4" },
    { id: "d", type: "line", p1: "p4", p2: "p1" },
  ];
  return s;
};
const bendHole = () => {
  const c = Math.SQRT1_2;
  const P: [number, number, number] = [50, 60 + 3 * c, 4 - 3 * c];
  const hole = emptySketch("XY");
  hole.plane.face = { p: P, n: [0, c, -c] };
  const f = sketchFrame(hole.plane, 0);
  const d = [P[0] - f.origin.x, P[1] - f.origin.y, P[2] - f.origin.z];
  hole.geometry = [
    { id: "c", type: "point", x: d[0]! * f.xDir.x + d[1]! * f.xDir.y + d[2]! * f.xDir.z, y: d[0]! * f.yDir.x + d[1]! * f.yDir.y + d[2]! * f.yDir.z },
    { id: "k", type: "circle", c: "c", r: 1.2 },
  ];
  return hole;
};
const withFlange = (params: Record<string, string>, refs = flange.refs) => ({ ...flange, params: { ...flange.params, ...params }, refs });
const flat = { type: "sheetFlat", params: {} };

/** Sheet metal parts: the flat pattern is compared when the part has a valid base sheet. */
const SHEETS: Record<string, () => Parameters<typeof doc>[0]> = {
  "flat sheet": () => base,
  "flange": () => [...base, flange],
  "flange, flattened": () => [...base, flange, flat],
  "flange below the sheet": () => [...base, withFlange({}, [{ kind: "edge", p: [50, 60, 0], size: 100 }])],
  "flange below the sheet, opposite direction": () => [...base, withFlange({ direction: "opposite" }, [{ kind: "edge", p: [50, 60, 0], size: 100 }])],
  "cut through the flange": () => [...base, flange, { id: "hole", type: "sketch", params: {}, sketch: circle("XZ", 50, 15, 4) }, { type: "sheetCut", params: { sketch: "hole" } }],
  "sheet from an open profile": () => [{ id: "p", type: "sketch", params: {}, sketch: lProfile() }, { type: "sheetBase", params: { ...sheet, sketch: "p" } }],
  "sheet from an open profile, reversed": () => [{ id: "p", type: "sketch", params: {}, sketch: lProfile() }, { type: "sheetBase", params: { ...sheet, sketch: "p", reverse: "yes" } }],
  "flange, material inside": () => [...base, withFlange({ position: "materialInside" })],
  "flange, material outside": () => [...base, withFlange({ position: "materialOutside" })],
  "rectangular reliefs": () => [...base, withFlange({ offsetStart: "10", offsetEnd: "10", relief: "rect" })],
  "round reliefs": () => [...base, withFlange({ offsetStart: "10", offsetEnd: "10", relief: "round" })],
  "no relief": () => [...base, withFlange({ offsetStart: "10", offsetEnd: "10", relief: "none" })],
  "sketched bend": () => [...base, { id: "ln", type: "sketch", params: {}, sketch: line() }, { type: "sketchedBend", params: { sketch: "ln", angle: "90", direction: "same", flip: "no" } }],
  "sketched bend with moving side": () => [
    ...base,
    { ...flange, id: "f2", refs: [sideEdge] },
    { id: "ln", type: "sketch", params: {}, sketch: line() },
    { type: "sketchedBend", params: { sketch: "ln", angle: "90", direction: "same", flip: "no" } },
  ],
  "open corner": () => [...base, withFlange({ corner: "open" }, [flange.refs[0]!, sideEdge])],
  "overlap corner": () => [...base, withFlange({ corner: "overlap" }, [flange.refs[0]!, sideEdge])],
  "butt corner": () => [...base, withFlange({ corner: "butt" }, [flange.refs[0]!, sideEdge])],
  "cut across a bend": () => [...base, flange, { id: "cut", type: "sketch", params: {}, sketch: notch() }, { type: "sheetCut", params: { sketch: "cut" } }],
  "cut across a bend, flattened": () => [...base, flange, { id: "cut", type: "sketch", params: {}, sketch: notch() }, { type: "sheetCut", params: { sketch: "cut" } }, flat],
  "hole in the bend": () => [...base, flange, { id: "h", type: "sketch", params: {}, sketch: bendHole() }, { type: "sheetCut", params: { sketch: "h" } }],
  "flange without a base sheet": () => [{ type: "box", params: { width: "10", depth: "10", height: "10", x: "0", y: "0", z: "0", op: "add" } }, flange],
  "second base sheet": () => [...base, { type: "sheetBase", params: { ...sheet, sketch: "sk" } }],
};

describe("Sheet metal: parity", () => {
  for (const [name, make] of Object.entries(SHEETS)) {
    it(name, () => {
      const d = doc(make());
      const a = reference.recompute(d);
      const b = core.recompute(d);
      sameBody(a, b);
      let fa: RefFlat | Error;
      try {
        fa = reference.flatPattern(d);
      } catch (e) {
        fa = e as Error;
      }
      if (fa instanceof Error) expect(() => core.flatPattern(d)).toThrow();
      else sameFlat(fa, core.flatPattern(d));
    });
  }
});

// --- Interferences and drawing ------------------------------------------------------------

const box = (w: string) => ({ type: "box", params: { width: w, depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } });
const drilled = () => doc([box("100"), { type: "cylinder", params: { radius: "10", height: "40", x: "50", y: "30", z: "0", axis: "z", op: "cut" } }]);
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

describe("Interference and drawing: parity", () => {
  it("measures the same common volume", () => {
    const part = doc([box("100")]);
    const parts = [
      { key: "A", doc: part, matrix: at(0) },
      { key: "B", doc: part, matrix: at(90) },
      { key: "C", doc: part, matrix: at(300) },
    ];
    const a = reference.interferences(parts);
    const b = core.interferences(parts);
    expect(b.map((x) => [x.a, x.b])).toEqual(a.map((x) => [x.a, x.b]));
    b.forEach((x, i) => expect(close(x.volume, a[i]!.volume)).toBe(true));
  });

  it("projects the same views", () => {
    const part = drilled();
    const kinds = ["front", "top", "right", "left", "bottom", "back", "iso"] as const;
    const a = reference.project(part, [...kinds]);
    const b = core.project(part, [...kinds]);
    kinds.forEach((_, i) => sameView(a[i]!, b[i]!));
  });

  it("sections the same way, including excluded parts", () => {
    const plate = drilled();
    const pin = doc([{ type: "cylinder", params: { radius: "9", height: "60", x: "50", y: "30", z: "-10", axis: "z", op: "add" } }]);
    const items = [
      { key: "A", doc: plate, matrix: I },
      { key: "P", doc: pin, matrix: I, cut: false },
    ];
    const views = [{ kind: "front" as const, section: { depth: -30 } }, { kind: "front" as const }];
    const a = reference.projectScene(items, views);
    const b = core.projectScene(items, views);
    views.forEach((_, i) => sameView(a[i]!, b[i]!));
  });

  it("rejects a scene without volume", () => {
    const empty = doc([]);
    expect(() => core.projectScene([{ key: "E", doc: empty, matrix: I }], [{ kind: "front" }])).toThrow("Aucune pièce");
  });
});
