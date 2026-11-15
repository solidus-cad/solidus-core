import { describe, expect, it } from "vitest";
import type { Sk3Geometry, Sketch3DData } from "@solidus-cad/sdk";
import { measure3D, solveSketch3D } from "../src/solver3d.ts";

const pt = (id: string, x: number, y: number, z: number): Sk3Geometry => ({ id, type: "point", x, y, z });
const ln = (id: string, p1: string, p2: string): Sk3Geometry => ({ id, type: "line", p1, p2 });
const P = (data: Sketch3DData, id: string) => {
  const g = data.geometry.find((x) => x.id === id);
  return g?.type === "point" ? [g.x, g.y, g.z] : null;
};

/** L-shaped polyline in space: fixed origin, then X, Z, Y, each segment dimensioned. */
function frame(): Sketch3DData {
  return {
    geometry: [pt("a", 0, 0, 0), pt("b", 95, 3, -2), pt("c", 101, 4, 48), pt("d", 98, 70, 52), ln("l1", "a", "b"), ln("l2", "b", "c"), ln("l3", "c", "d")],
    constraints: [
      { id: "f", type: "fix", point: "a" },
      { id: "x", type: "axis", line: "l1", axis: "X" },
      { id: "z", type: "axis", line: "l2", axis: "Z" },
      { id: "y", type: "axis", line: "l3", axis: "Y" },
    ],
    dimensions: [
      { id: "d1", type: "length", a: "l1", value: "100", driving: true },
      { id: "d2", type: "length", a: "l2", value: "H", driving: true },
      { id: "d3", type: "length", a: "l3", value: "60", driving: true },
    ],
  };
}

describe("solveSketch3D", () => {
  it("solves a polyline constrained to the axes and dimensioned", () => {
    const r = solveSketch3D(frame(), { scope: new Map([["H", 50]]) });
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    const out = { ...frame(), geometry: r.geometry };
    expect(P(out, "b")).toEqual([expect.closeTo(100, 5), expect.closeTo(0, 5), expect.closeTo(0, 5)]);
    expect(P(out, "c")).toEqual([expect.closeTo(100, 5), expect.closeTo(0, 5), expect.closeTo(50, 5)]);
    expect(P(out, "d")).toEqual([expect.closeTo(100, 5), expect.closeTo(60, 5), expect.closeTo(50, 5)]);
  });

  it("follows a parameter", () => {
    const r = solveSketch3D(frame(), { scope: new Map([["H", 120]]) });
    expect(measure3D({ ...frame(), geometry: r.geometry }, { type: "length", a: "l2" })).toBeCloseTo(120, 5);
  });

  it("counts the remaining degrees of freedom", () => {
    const d = frame();
    d.dimensions = [];
    // Three free lengths.
    expect(solveSketch3D(d).dof).toBe(3);
    d.constraints = d.constraints.filter((c) => c.type !== "fix");
    expect(solveSketch3D(d).dof).toBe(6);
  });

  it("reports incompatible constraints", () => {
    const d = frame();
    d.constraints.push({ id: "bad", type: "perpendicular", a: "l1", b: "l1" });
    const r = solveSketch3D(d, { scope: new Map([["H", 50]]) });
    expect(r.ok).toBe(false);
    expect(r.conflicting.length).toBeGreaterThan(0);
  });

  it("moves a point while respecting constraints", () => {
    const d = frame();
    d.dimensions = d.dimensions.filter((x) => x.id !== "d3");
    const r = solveSketch3D(d, { scope: new Map([["H", 50]]), targets: { d: [140, 80, 90] } });
    expect(r.ok).toBe(true);
    const out = { ...d, geometry: r.geometry };
    // The point stays on the Y axis from c: only its Y coordinate follows the target.
    expect(P(out, "d")).toEqual([expect.closeTo(100, 3), expect.closeTo(80, 1), expect.closeTo(50, 3)]);
  });

  it("places a point in a plane and on a line", () => {
    const d: Sketch3DData = {
      geometry: [pt("a", 0, 0, 0), pt("b", 10, 10, 10), pt("p", 3, 9, 1), ln("l", "a", "b")],
      constraints: [
        { id: "fa", type: "fix", point: "a" },
        { id: "fb", type: "fix", point: "b" },
        { id: "on", type: "pointOnLine", point: "p", line: "l" },
        { id: "pl", type: "inPlane", target: "p", plane: { p: [0, 0, 4], n: [0, 0, 1] } },
      ],
      dimensions: [],
    };
    const r = solveSketch3D(d);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    expect(P({ ...d, geometry: r.geometry }, "p")).toEqual([expect.closeTo(4, 5), expect.closeTo(4, 5), expect.closeTo(4, 5)]);
  });

  /** Two segments of a polyline (shared vertex b), the first along X (entered as "@100;0;0"), without dimensions. */
  function corner(c: Sketch3DData["constraints"][number] | null, dims: Sketch3DData["dimensions"] = []): Sketch3DData {
    return {
      geometry: [pt("a", 0, 0, 0), pt("b", 100, 0, 0), pt("c", 60, 50, 50), ln("l1", "a", "b"), ln("l2", "b", "c")],
      constraints: [{ id: "x", type: "axis", line: "l1", axis: "X" }, ...(c ? [c] : [])],
      dimensions: dims,
    };
  }
  const lengths = (d: Sketch3DData, geometry: Sk3Geometry[]) =>
    ["l1", "l2"].map((a) => measure3D({ ...d, geometry }, { type: "length", a })!);

  // An orientation constraint rotates the lines: their free lengths must neither shrink nor stretch.
  it.each([
    ["perpendicular", corner({ id: "k", type: "perpendicular", a: "l1", b: "l2" }), 90],
    ["parallel", corner({ id: "k", type: "parallel", a: "l1", b: "l2" }), 0],
    ["angle dimension 45°", corner(null, [{ id: "k", type: "angle", a: "l1", b: "l2", value: "45", driving: true }]), 45],
    ["angle dimension 100°", corner(null, [{ id: "k", type: "angle", a: "l1", b: "l2", value: "100", driving: true }]), 100],
  ])("%s: the lines rotate without changing length", (_, d, angle) => {
    const before = lengths(d, d.geometry);
    const r = solveSketch3D(d);
    expect(r.ok).toBe(true);
    const a = measure3D({ ...d, geometry: r.geometry }, { type: "angle", a: "l1", b: "l2" })!;
    expect(angle === 0 ? Math.min(a, 180 - a) : a).toBeCloseTo(angle, 4);
    lengths(d, r.geometry).forEach((l, i) => expect(l).toBeCloseTo(before[i]!, 1));
  });
});
