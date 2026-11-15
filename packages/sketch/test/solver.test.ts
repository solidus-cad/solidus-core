import { beforeAll, describe, expect, it } from "vitest";
import { SKETCH_AXIS_H, SKETCH_ORIGIN, emptySketch, type SketchData, type SkGeometry } from "@solidus-cad/sdk";
import { SketchSolver, analyzeProfiles, measureDimension } from "../src/index.ts";

let solver: SketchSolver;
beforeAll(async () => {
  solver = await SketchSolver.create();
});

/** Approximate rectangle with one corner at the origin (shared points). */
function rectangle(): SketchData {
  const s = emptySketch();
  s.geometry = [
    { id: "b", type: "point", x: 48, y: 1 },
    { id: "c", type: "point", x: 52, y: 31 },
    { id: "d", type: "point", x: -2, y: 29 },
    { id: "l1", type: "line", p1: SKETCH_ORIGIN, p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
    { id: "l3", type: "line", p1: "c", p2: "d" },
    { id: "l4", type: "line", p1: "d", p2: SKETCH_ORIGIN },
  ];
  s.constraints = [
    { id: "h1", type: "horizontal", a: "l1" },
    { id: "h2", type: "horizontal", a: "l3" },
    { id: "v1", type: "vertical", a: "l2" },
    { id: "v2", type: "vertical", a: "l4" },
  ];
  return s;
}

const pt = (g: SkGeometry[], id: string) => g.find((x) => x.id === id) as { x: number; y: number };

describe("SketchSolver", () => {
  it("solves a constrained and dimensioned rectangle", () => {
    const s = rectangle();
    s.dimensions = [
      { id: "w", type: "distance", a: "l1", value: "L", driving: true },
      { id: "h", type: "verticalDistance", a: SKETCH_ORIGIN, b: "c", value: "L / 2", driving: true },
    ];
    const r = solver.solve(s, { scope: new Map([["L", 80]]) });
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    expect(pt(r.geometry, "b").x).toBeCloseTo(80, 6);
    expect(pt(r.geometry, "b").y).toBeCloseTo(0, 6);
    expect(pt(r.geometry, "c").y).toBeCloseTo(40, 6);
    expect(pt(r.geometry, "d").x).toBeCloseTo(0, 6);
  });

  it("counts the degrees of freedom", () => {
    const r = solver.solve(rectangle());
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(2);
  });

  it("keeps the chosen side for a horizontal dimension", () => {
    const s = rectangle();
    s.dimensions = [{ id: "w", type: "horizontalDistance", a: "b", b: SKETCH_ORIGIN, value: "30", driving: true }];
    const r = solver.solve(s);
    expect(pt(r.geometry, "b").x).toBeCloseTo(30, 6);
  });

  it("detects conflicting constraints", () => {
    const s = rectangle();
    s.dimensions = [
      { id: "w1", type: "distance", a: "l1", value: "50", driving: true },
      { id: "w2", type: "distance", a: "l3", value: "60", driving: true },
    ];
    const r = solver.solve(s);
    expect(r.conflicting.length + r.redundant.length).toBeGreaterThan(0);
  });

  it("applies radius, tangency and angle", () => {
    const s = emptySketch();
    s.geometry = [
      { id: "c0", type: "point", x: 10, y: 12 },
      { id: "circ", type: "circle", c: "c0", r: 4 },
      { id: "p1", type: "point", x: -20, y: 3 },
      { id: "p2", type: "point", x: 30, y: 5 },
      { id: "line", type: "line", p1: "p1", p2: "p2" },
    ];
    s.constraints = [{ id: "t", type: "tangent", a: "line", b: "circ" }];
    s.dimensions = [
      { id: "r", type: "diameter", a: "circ", value: "20", driving: true },
      { id: "ang", type: "angle", a: SKETCH_AXIS_H, b: "line", value: "0", driving: true },
    ];
    const r = solver.solve(s);
    expect(r.ok).toBe(true);
    expect(r.dimensionErrors).toEqual({});
    const circ = r.geometry.find((g) => g.id === "circ") as { r: number };
    expect(circ.r).toBeCloseTo(10, 6);
    // horizontal line (angle 0 with the H axis) and tangent: 10 mm from the center
    const p1 = pt(r.geometry, "p1");
    const p2 = pt(r.geometry, "p2");
    const c0 = pt(r.geometry, "c0");
    expect(p1.y).toBeCloseTo(p2.y, 6);
    expect(Math.abs(p1.y - c0.y)).toBeCloseTo(10, 6);
  });

  it("follows the mouse without violating constraints", () => {
    const s = rectangle();
    const r = solver.solve(s, { drag: { points: { c: { x: 100, y: 70 } } } });
    expect(r.ok).toBe(true);
    expect(pt(r.geometry, "c").x).toBeCloseTo(100, 3);
    expect(pt(r.geometry, "b").y).toBeCloseTo(0, 6);
    expect(pt(r.geometry, "b").x).toBeCloseTo(100, 3);
  });
});

describe("analyzeProfiles", () => {
  it("finds a region with a hole", () => {
    const s = rectangle();
    s.geometry.push({ id: "hc", type: "point", x: 25, y: 15 }, { id: "hole", type: "circle", c: "hc", r: 5 });
    const a = analyzeProfiles(s.geometry);
    expect(a.loops).toHaveLength(2);
    expect(a.regions).toHaveLength(1);
    expect(a.regions[0]!.holes).toHaveLength(1);
    expect(a.selfIntersecting).toBe(false);
  });

  it("separates open chains and loops", () => {
    const s = rectangle();
    s.geometry = s.geometry.filter((g) => g.id !== "l4");
    const a = analyzeProfiles(s.geometry);
    expect(a.loops).toHaveLength(0);
    expect(a.chains).toHaveLength(1);
    expect(a.chains[0]).toHaveLength(3);
  });

  it("ignores construction geometry", () => {
    const s = rectangle();
    s.geometry = s.geometry.map((g) => (g.id === "l2" ? { ...g, construction: true } : g));
    expect(analyzeProfiles(s.geometry).loops).toHaveLength(0);
  });
});

describe("measureDimension", () => {
  it("measures length, radius and angle", () => {
    const s = rectangle();
    const r = solver.solve(s, { drag: { points: { c: { x: 50, y: 30 } } } });
    expect(measureDimension({ id: "x", type: "distance", a: "l1", value: "0", driving: false }, r.geometry)).toBeCloseTo(50, 2);
    expect(measureDimension({ id: "y", type: "angle", a: "l1", b: "l2", value: "0", driving: false }, r.geometry)).toBeCloseTo(90, 4);
  });
});

describe("projected geometry", () => {
  it("stays fixed during solving", () => {
    const s = emptySketch();
    s.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 30, y: 5 },
      { id: "l", type: "line", p1: "a", p2: "b", projected: { kind: "edge", p: [15, 2.5, 0], size: 30.4 } },
      { id: "c", type: "point", x: 10, y: 20 },
      { id: "m", type: "line", p1: "b", p2: "c" },
    ];
    s.constraints = [{ id: "h", type: "horizontal", a: "l" }];
    const r = solver.solve(s);
    // The horizontal constraint cannot move a projected line: conflict, the line does not move.
    expect(pt(r.geometry, "b").y).toBeCloseTo(5, 6);
    const free = solver.solve({ ...s, constraints: [{ id: "v", type: "vertical", a: "m" }] });
    expect(free.ok).toBe(true);
    expect(pt(free.geometry, "c").x).toBeCloseTo(30, 6); // only the free line moves
  });
});
