// Parity with the reference kernel (recorded results, see reference.ts): linked elements in sketches
// (projected body edges, model vertices, polylines of another part, skeleton sketch).
import { beforeAll, describe, expect, it } from "vitest";
import { emptySketch, SKETCH_ORIGIN, type PartDocument, type RecomputeResult, type SketchData } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";
import { reference, type RefRecompute } from "./reference.ts";
import { doc } from "./scenarios.ts";

let core: WasmKernelEngine;

beforeAll(async () => {
  core = await WasmKernelEngine.create(await SketchSolver.create());
});

type Make = Parameters<typeof doc>[0];

/** Same document (same identifier): reference kernel response, then cad-core. */
function both(features: Make, parameters: PartDocument["parameters"] = [], id = "projected"): [RefRecompute, RecomputeResult] {
  const d = doc(features, parameters);
  d.id = id;
  return [reference.recompute(d), core.recompute(d)];
}

function pt(r: RecomputeResult, sketch: string, id: string): { x: number; y: number; r?: number } {
  return r.sketches[sketch]!.geometry.find((g) => g.id === id) as { x: number; y: number; r?: number };
}

function same(a: RefRecompute, b: RecomputeResult): void {
  expect(b.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(a.statuses.map((s) => (s.ok ? "ok" : s.error)));
  expect(Object.keys(b.sketches).sort()).toEqual(Object.keys(a.sketches).sort());
  for (const [id, s] of Object.entries(a.sketches)) {
    const t = b.sketches[id]!;
    expect(t.dof).toBe(s.dof);
    for (const g of s.geometry) {
      const h = t.geometry.find((x) => x.id === g.id)!;
      if (g.type === "point" && h.type === "point") {
        expect(h.x).toBeCloseTo(g.x, 6);
        expect(h.y).toBeCloseTo(g.y, 6);
      } else if (g.type === "circle" && h.type === "circle") expect(h.r).toBeCloseTo(g.r, 6);
    }
  }
  if (a.mass) expect(b.mass!.volume).toBeCloseTo(a.mass.volume, 3);
}

const box = (w: string) => ({ type: "box", params: { width: w, depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } });

/** Sketch on top of the block, which projects the front-top edge (y = 0, z = 40). */
function edgeSketch(): SketchData {
  const sk = emptySketch("XY");
  sk.plane.face = { p: [50, 30, 40], n: [0, 0, 1] };
  sk.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 100, y: 0 },
    { id: "l", type: "line", p1: "a", p2: "b", projected: { kind: "edge", p: [50, 0, 40], size: 100 } },
  ];
  return sk;
}

/** Dimensioned point 10 mm from the vertex (100, 0, 40) of the front-top edge. */
function vertexSketch(): SketchData {
  const sk = emptySketch("XY");
  sk.plane.face = { p: [50, 30, 40], n: [0, 0, 1] };
  sk.geometry = [
    { id: "v", type: "point", x: 100, y: 0, anchor: "end", projected: { kind: "edge", p: [50, 0, 40], size: 100 }, construction: true, external: true },
    { id: "q", type: "point", x: 110, y: 0 },
  ];
  sk.constraints = [{ id: "f", type: "pointOnCurve", point: "q", curve: "axis:H" }];
  sk.dimensions = [{ id: "dx", type: "horizontalDistance", a: "v", b: "q", value: "10", driving: true }];
  return sk;
}

/** Circle projecting the top circular edge of a Ø20 hole at (50, 30). */
function circleSketch(): SketchData {
  const sk = emptySketch("XY");
  sk.plane.face = { p: [50, 30, 40], n: [0, 0, 1] };
  sk.geometry = [
    { id: "c", type: "point", x: 0, y: 0 },
    { id: "o", type: "circle", c: "c", r: 1, projected: { kind: "edge", p: [60, 30, 40], size: 2 * Math.PI * 10 } },
  ];
  return sk;
}

const ext = (points: [number, number, number][]) => ({ kind: "external" as const, asm: "A", path: "src", target: "dst", ref: { kind: "edge" as const, p: points[0]!, size: 1 }, points });

describe("Linked sketch entities: parity", () => {
  it("follows the projected edge when the upstream model changes", () => {
    for (const w of ["100", "120"]) {
      const [a, b] = both([box(w), { id: "sk", type: "sketch", params: {}, sketch: edgeSketch() }]);
      same(a, b);
      expect(pt(b, "sk", "b").x).toBeCloseTo(Number(w), 6);
    }
  });

  it("keeps the sketch solved when the kernel reuses its cache", () => {
    const features = [box("100"), { id: "sk", type: "sketch", params: {}, sketch: edgeSketch() }];
    const [, first] = both(features, [], "cached");
    const [, again] = both(features, [], "cached");
    expect(again.rebuilt).toBe(0);
    expect(again.sketches.sk).toEqual(first.sketches.sk);
  });

  it("a dimension to a model vertex follows the model", () => {
    for (const w of ["100", "105", "130"]) {
      const [a, b] = both([box(w), { id: "sk", type: "sketch", params: {}, sketch: vertexSketch() }]);
      same(a, b);
    }
  });

  it("projects a circular body edge as a circle, then extrudes it", () => {
    const [a, b] = both([
      box("100"),
      { type: "cylinder", params: { radius: "10", height: "40", x: "50", y: "30", z: "0", axis: "z", op: "cut" } },
      { id: "sk", type: "sketch", params: {}, sketch: circleSketch() },
      { type: "extrude", params: { sketch: "sk", mode: "blind", depth: "5", reverse: "no", op: "add" } },
    ]);
    same(a, b);
    expect(pt(b, "sk", "o").r).toBeCloseTo(10, 6);
  });

  it("reports a projected edge with no body, or one that no longer exists", () => {
    same(...both([{ id: "sk", type: "sketch", params: {}, sketch: edgeSketch() }]));
    const gone = edgeSketch();
    (gone.geometry[2] as { projected: { p: number[] } }).projected.p = [500, 0, 40];
    same(...both([box("100"), { id: "sk", type: "sketch", params: {}, sketch: gone }]));
  });

  it("projects another part's polyline, with no body in the part", () => {
    for (const pts of [[[10, 5, 30], [60, 5, 30]], [[25, 5, 30], [75, 5, 30]]] as [number, number, number][][]) {
      const sk = emptySketch("XY");
      sk.geometry = [
        { id: "a", type: "point", x: 0, y: 0 },
        { id: "b", type: "point", x: 0, y: 0 },
        { id: "l", type: "line", p1: "a", p2: "b", projected: ext(pts) },
      ];
      same(...both([{ id: "sk", type: "sketch", params: {}, sketch: sk }]));
    }
  });

  it("a sketch referencing the skeleton follows its dimensions", () => {
    const skel = emptySketch("XY");
    skel.geometry = [
      { id: "e", type: "point", x: 50, y: 0 },
      { id: "axe", type: "line", p1: SKETCH_ORIGIN, p2: "e", construction: true },
    ];
    skel.constraints = [{ id: "h", type: "horizontal", a: "axe" }];
    skel.dimensions = [{ id: "dl", type: "distance", a: "axe", value: "L", driving: true }];
    const prof = emptySketch("XY");
    prof.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 50, y: 0 },
      { id: "c", type: "point", x: 50, y: 10 },
      { id: "d", type: "point", x: 0, y: 10 },
      { id: "ref", type: "line", p1: "a", p2: "b", projected: { kind: "sketch", sketch: "skel", entity: "axe" } },
      { id: "l2", type: "line", p1: "b", p2: "c" },
      { id: "l3", type: "line", p1: "c", p2: "d" },
      { id: "l4", type: "line", p1: "d", p2: "a" },
    ];
    prof.constraints = [
      { id: "v1", type: "vertical", a: "l2" },
      { id: "v2", type: "vertical", a: "l4" },
      { id: "h3", type: "horizontal", a: "l3" },
    ];
    prof.dimensions = [{ id: "dh", type: "distance", a: "l2", value: "10", driving: true }];
    for (const L of ["50", "80"]) {
      same(
        ...both(
          [
            { id: "skel", type: "sketch", params: {}, sketch: skel },
            { id: "prof", type: "sketch", params: {}, sketch: prof },
            { type: "extrude", params: { sketch: "prof", mode: "blind", depth: "5", reverse: "no", op: "add" } },
          ],
          [{ name: "L", expr: L }],
        ),
      );
    }
  });
});
