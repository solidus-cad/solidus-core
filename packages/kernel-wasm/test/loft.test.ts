import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, emptySketch, type Feature, type PartDocument, type Sketch3DData } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";

let engine: WasmKernelEngine;

beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

function doc(id: string, features: (Omit<Feature, "id" | "name"> & { id?: string })[], parameters: PartDocument["parameters"] = []): PartDocument {
  const d = createPartDocument(id);
  d.id = id;
  d.parameters = parameters;
  d.features = features.map((f, i) => ({ ...f, id: f.id ?? `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return d;
}

const statuses = (r: { statuses: { ok: boolean; error?: string }[] }) => r.statuses.map((s) => (s.ok ? "ok" : s.error));

/** Square of side `a` centred on the axis, in the plane parallel to XY at `z`. */
function square(id: string, a: number, z = 0): Omit<Feature, "name"> {
  const s = emptySketch("XY");
  s.plane.offset = String(z);
  const h = a / 2;
  s.geometry = [
    { id: "A", type: "point", x: -h, y: -h },
    { id: "B", type: "point", x: h, y: -h },
    { id: "C", type: "point", x: h, y: h },
    { id: "D", type: "point", x: -h, y: h },
    { id: "q1", type: "line", p1: "A", p2: "B" },
    { id: "q2", type: "line", p1: "B", p2: "C" },
    { id: "q3", type: "line", p1: "C", p2: "D" },
    { id: "q4", type: "line", p1: "D", p2: "A" },
  ];
  return { id, type: "sketch", params: {}, sketch: s };
}

/** Segment of width 10 along X, in the XY plane. */
function segment(id: string): Omit<Feature, "name"> {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "a", type: "point", x: -5, y: 0 },
    { id: "b", type: "point", x: 5, y: 0 },
    { id: "s1", type: "line", p1: "a", p2: "b" },
  ];
  return { id, type: "sketch", params: {}, sketch: s };
}

/** 3D sketch: a spline from the origin up and away, through four points; the height of the second is dimensioned by `H`. */
function spline3d(): Omit<Feature, "name"> {
  const data: Sketch3DData = {
    geometry: [
      { id: "P0", type: "point", x: 0, y: 0, z: 0 },
      { id: "P1", type: "point", x: 0, y: 0, z: 30 },
      { id: "P2", type: "point", x: 30, y: 0, z: 60 },
      { id: "P3", type: "point", x: 60, y: 20, z: 80 },
      { id: "sp", type: "spline", points: ["P0", "P1", "P2", "P3"] },
    ],
    constraints: [],
    dimensions: [],
  };
  return { id: "p3", type: "sketch3d", params: {}, sketch3d: data };
}

describe("3D sketch, sweep and loft", () => {
  it("surface sweep of a segment along a 3D spline: surface body named by the path and profile curves", () => {
    const r = engine.recompute(doc("sweep3d", [segment("pr"), spline3d(), { id: "sw", type: "surfaceSweep", params: { profile: "pr", path: "p3", orientation: "corrected" } }]));
    expect(statuses(r)).toEqual(["ok", "ok", "ok"]);
    expect(r.mesh!.bodies).toMatchObject([{ id: "sw", kind: "surface" }]);
    expect(r.topology.faces).toEqual(["sw/side(sp|s1)"]);
    expect(r.topology.edges).toContain("e(sw/side(sp|s1)|sw/start)");
    // Ribbon 10 wide along a curve 118 long (interpolated through the points): the profile is not normal to the start
    // tangent of the spline, the ribbon is narrower than 10.
    expect(r.mass!.area).toBeGreaterThan(10 * 118 * 0.5);
    expect(r.mass!.area).toBeLessThan(10 * 118);
  });

  it("solid tube swept along a 3D polyline", () => {
    const data: Sketch3DData = {
      geometry: [
        { id: "P0", type: "point", x: 0, y: 0, z: 0 },
        { id: "P1", type: "point", x: 30, y: 0, z: 40 },
        { id: "k1", type: "line", p1: "P0", p2: "P1" },
      ],
      constraints: [],
      dimensions: [],
    };
    const r = engine.recompute(
      doc("tube3d", [
        { id: "p3", type: "sketch3d", params: {}, sketch3d: data },
        { id: "sw", type: "sweep", params: { path: "p3", profile: "circle", diameter: "10", inner: "6", profileSketch: "", op: "add" } },
      ]),
    );
    expect(statuses(r)).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(Math.PI * 16 * 50, 3);
  });

  it("solid loft of three squares on datum planes, names stable when a plane moves", () => {
    const loft = { id: "lf", type: "loft", params: { sections: "s0,s1,s2", guides: "", ruled: "no", op: "add" } };
    const at = (z1: number, z2: number) => [square("s0", 20), square("s1", 20, z1), square("s2", 20, z2), loft];
    const a = engine.recompute(doc("loft", at(20, 40)));
    expect(statuses(a).every((s) => s === "ok")).toBe(true);
    expect(a.mass!.volume).toBeCloseTo(20 * 20 * 40, 3);
    expect(a.topology.faces).toContain("lf/start");
    expect(a.topology.faces).toContain("lf/side(q1)");
    const b = engine.recompute(doc("loft", at(35, 70)));
    expect(b.mass!.volume).toBeCloseTo(20 * 20 * 70, 3);
    expect(new Set(b.topology.faces)).toEqual(new Set(a.topology.faces));
  });

  it("surface loft guided by a 3D curve, and an explicit error for a single section", () => {
    const data: Sketch3DData = {
      geometry: [
        { id: "G0", type: "point", x: 0, y: 0, z: 0 },
        { id: "G1", type: "point", x: 0, y: 0, z: 60 },
        { id: "k1", type: "line", p1: "G0", p2: "G1" },
      ],
      constraints: [],
      dimensions: [],
    };
    const features = [square("s0", 20), square("s1", 12, 60), { id: "g", type: "sketch3d", params: {}, sketch3d: data }];
    const r = engine.recompute(doc("guided", [...features, { id: "lf", type: "surfaceLoft", params: { sections: "s0,s1", guides: "g", ruled: "no" } }]));
    expect(statuses(r).every((s) => s === "ok")).toBe(true);
    expect(r.mesh!.bodies).toMatchObject([{ id: "lf", kind: "surface" }]);
    expect(r.mass!.area).toBeGreaterThan(0);
    const one = engine.recompute(doc("guided", [...features, { id: "lf", type: "surfaceLoft", params: { sections: "s0", guides: "", ruled: "no" } }]));
    expect(one.statuses.at(-1)).toMatchObject({ ok: false, error: "Choisissez au moins deux esquisses de section" });
  });
});
