import { describe, expect, it } from "vitest";
import { assemblyDatumPlanes, datumPlane, partDatumPlanes, type DatumContext, type DatumPlaneDef, type PlaneFrame } from "../src/datum.ts";
import { sketchFrame, type Vec3 } from "../src/sketch.ts";
import type { Feature } from "../src/document.ts";

const ctx: DatumContext = { num: (e, fb) => (e === undefined ? fb : Number(e)), datum: () => undefined };
const plane = (def: Partial<DatumPlaneDef> & Pick<DatumPlaneDef, "method" | "refs">) => datumPlane(def as DatumPlaneDef, ctx).frame;

/** Is the point on the plane? */
const onPlane = (f: PlaneFrame, p: Vec3) => (p.x - f.origin.x) * f.normal.x + (p.y - f.origin.y) * f.normal.y + (p.z - f.origin.z) * f.normal.z;
const near = (a: Vec3, b: Vec3) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
  expect(a.z).toBeCloseTo(b.z, 6);
};

describe("datum planes", () => {
  it("offset from a base plane: same frame as the offset base plane", () => {
    const f = plane({ method: "offset", refs: [{ kind: "base", name: "XZ" }], distance: "15" });
    const g = sketchFrame({ base: "XZ", offset: "0" }, 15);
    near(f.origin, g.origin);
    near(f.normal, g.normal);
    near(f.xDir, g.xDir);
    near(f.yDir, g.yDir);
  });

  it("offset from a face, inverted side", () => {
    const f = plane({ method: "offset", refs: [{ kind: "plane", p: [5, 5, 10], n: [0, 0, 1] }], distance: "4", flip: true });
    expect(onPlane(f, { x: 0, y: 0, z: 6 })).toBeCloseTo(0);
  });

  it("parallel passing through a point", () => {
    const f = plane({ method: "parallel", refs: [{ kind: "base", name: "YZ" }, { kind: "point", p: [12, 3, 4] }] });
    near(f.normal, { x: 1, y: 0, z: 0 });
    expect(onPlane(f, { x: 12, y: 0, z: 0 })).toBeCloseTo(0);
  });

  it("midplane of two parallel faces (opposite normals)", () => {
    const f = plane({ method: "midplane", refs: [{ kind: "plane", p: [0, 0, 0], n: [0, 0, -1] }, { kind: "plane", p: [3, 3, 40], n: [0, 0, 1] }] });
    expect(onPlane(f, { x: 0, y: 0, z: 20 })).toBeCloseTo(0);
  });

  it("bisector plane of two intersecting planes", () => {
    const f = plane({ method: "midplane", refs: [{ kind: "base", name: "XY" }, { kind: "base", name: "YZ" }] });
    // Contains the Y axis and the point (1, 0, 1) or (1, 0, -1).
    expect(onPlane(f, { x: 0, y: 7, z: 0 })).toBeCloseTo(0);
    expect(Math.abs(f.normal.x)).toBeCloseTo(Math.SQRT1_2);
    expect(Math.abs(f.normal.z)).toBeCloseTo(Math.SQRT1_2);
  });

  it("inclined around an axis", () => {
    const f = plane({ method: "angle", refs: [{ kind: "base", name: "X" }, { kind: "base", name: "XY" }], angle: "90" });
    // XY rotated by 90° around X: XZ plane.
    expect(Math.abs(f.normal.y)).toBeCloseTo(1);
    expect(onPlane(f, { x: 30, y: 0, z: 0 })).toBeCloseTo(0);
  });

  it("inclined: axis perpendicular to the datum plane rejected", () => {
    expect(() => plane({ method: "angle", refs: [{ kind: "base", name: "Z" }, { kind: "base", name: "XY" }], angle: "30" })).toThrow(/perpendiculaire/);
  });

  it("passing through an axis and a point", () => {
    const f = plane({ method: "axisPoint", refs: [{ kind: "axis", p: [0, 0, 5], d: [1, 0, 0] }, { kind: "point", p: [0, 10, 5] }] });
    near({ x: Math.abs(f.normal.x), y: Math.abs(f.normal.y), z: Math.abs(f.normal.z) }, { x: 0, y: 0, z: 1 });
    expect(onPlane(f, { x: 0, y: 0, z: 5 })).toBeCloseTo(0);
  });

  it("tangent to a cylinder, parallel to a plane", () => {
    const cyl = { kind: "cylinder" as const, p: [0, 0, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number], r: 10, at: [10, 0, 5] as [number, number, number] };
    const f = plane({ method: "tangent", refs: [cyl, { kind: "base", name: "XZ" }] });
    expect(Math.abs(f.normal.y)).toBeCloseTo(1);
    expect(Math.abs(onPlane(f, { x: 0, y: 0, z: 0 }))).toBeCloseTo(10);
    // Without a plane: tangent at the picked point.
    const g = plane({ method: "tangent", refs: [cyl, null] });
    near(g.normal, { x: 1, y: 0, z: 0 });
    expect(onPlane(g, { x: 10, y: 3, z: 0 })).toBeCloseTo(0);
  });

  it("through three points", () => {
    const f = plane({ method: "threePoints", refs: [{ kind: "point", p: [0, 0, 2] }, { kind: "point", p: [1, 0, 2] }, { kind: "point", p: [0, 1, 2] }] });
    near(f.normal, { x: 0, y: 0, z: 1 });
    expect(onPlane(f, { x: 9, y: 9, z: 2 })).toBeCloseTo(0);
    expect(() => plane({ method: "threePoints", refs: [{ kind: "point", p: [0, 0, 0] }, { kind: "point", p: [1, 0, 0] }, { kind: "point", p: [2, 0, 0] }] })).toThrow(/alignés/);
  });

  it("normal to an axis", () => {
    const f = plane({ method: "normal", refs: [{ kind: "axis", p: [0, 0, 0], d: [0, 2, 0] }, { kind: "point", p: [0, 8, 0] }] });
    near(f.normal, { x: 0, y: 1, z: 0 });
    expect(onPlane(f, { x: 0, y: 8, z: 0 })).toBeCloseTo(0);
  });

  it("part: plane on plane, parameters, isolated errors", () => {
    const features: Feature[] = [
      { id: "p1", type: "plane", name: "Plan1", params: {}, datum: { method: "offset", refs: [{ kind: "base", name: "XY" }], distance: "H" } },
      { id: "p2", type: "plane", name: "Plan2", params: {}, datum: { method: "offset", refs: [{ kind: "datum", id: "p1" }], distance: "5" } },
      { id: "p3", type: "plane", name: "Plan3", params: {}, datum: { method: "parallel", refs: [{ kind: "base", name: "XY" }, null] } },
    ];
    const out = partDatumPlanes(features, new Map([["H", 10]]));
    expect(out.get("p2")!.frame!.origin.z).toBeCloseTo(15);
    expect(out.get("p3")!.error).toMatch(/Point/);
    // Sketch on a datum plane, offset.
    const f = sketchFrame({ base: "XY", offset: "0", datum: "p2" }, 1, (id) => out.get(id)?.frame);
    expect(f.origin.z).toBeCloseTo(16);
  });

  it("assembly: face of a moved occurrence", () => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
    const out = assemblyDatumPlanes([{ id: "a", name: "Plan1", def: { method: "offset", refs: [{ kind: "plane", p: [10, 0, 0], n: [1, 0, 0], component: "c1" }], distance: "5" } }], (k) => (k === "c1" ? m : undefined));
    expect(onPlane(out.get("a")!.frame!, { x: 115, y: 0, z: 0 })).toBeCloseTo(0);
  });
});
