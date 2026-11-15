import { describe, expect, it } from "vitest";
import { emptySketch, SKETCH_ORIGIN, type SketchData, type SkGeometry } from "@solidus-cad/sdk";
import { analyzeProfiles, closeGaps, filletCorner, findGaps, intersect, offsetCurves, pointMap, trimSketch } from "../src/index.ts";

let n = 0;
const newId = () => `n${n++}`;

/** Cross: horizontal line (-50,0)→(50,0) and vertical line (0,-50)→(0,50). */
function cross(): SketchData {
  const s = emptySketch();
  s.geometry = [
    { id: "a", type: "point", x: -50, y: 0 },
    { id: "b", type: "point", x: 50, y: 0 },
    { id: "c", type: "point", x: 0, y: -50 },
    { id: "d", type: "point", x: 0, y: 50 },
    { id: "h", type: "line", p1: "a", p2: "b" },
    { id: "v", type: "line", p1: "c", p2: "d" },
  ];
  s.constraints = [{ id: "hh", type: "horizontal", a: "h" }];
  return s;
}

const curves = (s: SketchData) => s.geometry.filter((g) => g.type !== "point");
const pt = (s: SketchData, id: string) => pointMap(s.geometry).get(id)!;

describe("intersect", () => {
  it("intersects lines, circles and arcs", () => {
    const s = cross();
    s.geometry.push({ id: "o", type: "point", x: 0, y: 0 }, { id: "circ", type: "circle", c: "o", r: 20 });
    const pts = pointMap(s.geometry);
    const g = (id: string) => s.geometry.find((x) => x.id === id)! as SkGeometry;
    expect(intersect(g("h"), g("v"), pts)).toEqual([{ x: 0, y: 0 }]);
    expect(intersect(g("h"), g("circ"), pts)).toHaveLength(2);
  });
});

describe("trimSketch", () => {
  it("trims the end of a line beyond the intersection", () => {
    const s = trimSketch(cross(), "h", { x: 30, y: 0 }, newId)!;
    const h = s.geometry.find((g) => g.id === "h") as { p1: string; p2: string };
    expect(pt(s, h.p2).x).toBeCloseTo(0);
    expect(s.geometry.some((g) => g.id === "b")).toBe(false); // orphaned point removed
    expect(s.constraints.some((c) => c.type === "pointOnCurve")).toBe(true);
  });

  it("splits a line trimmed between two intersections", () => {
    const sk = cross();
    sk.geometry.push({ id: "e", type: "point", x: 20, y: -50 }, { id: "f", type: "point", x: 20, y: 50 }, { id: "v2", type: "line", p1: "e", p2: "f" });
    const s = trimSketch(sk, "h", { x: 10, y: 0 }, newId)!;
    const lines = s.geometry.filter((g) => g.type === "line" && g.id !== "v" && g.id !== "v2");
    expect(lines).toHaveLength(2);
    // The second piece inherits the horizontal constraint.
    expect(s.constraints.filter((c) => c.type === "horizontal")).toHaveLength(2);
  });

  it("removes a line without intersection and turns a trimmed circle into an arc", () => {
    const s = trimSketch(cross(), "v", { x: 0, y: 40 }, newId)!;
    expect(curves(s)).toHaveLength(2);
    const lone = emptySketch();
    lone.geometry = [
      { id: "p", type: "point", x: 0, y: 0 },
      { id: "q", type: "point", x: 10, y: 0 },
      { id: "l", type: "line", p1: "p", p2: "q" },
    ];
    expect(curves(trimSketch(lone, "l", { x: 5, y: 0 }, newId)!)).toHaveLength(0);

    const c = cross();
    c.geometry.push({ id: "o", type: "point", x: 0, y: 0 }, { id: "circ", type: "circle", c: "o", r: 20 });
    const t = trimSketch(c, "circ", { x: 20, y: 0.5 }, newId)!;
    const arc = t.geometry.find((g) => g.type === "arc")!;
    expect(arc).toBeTruthy();
  });
});

describe("filletCorner", () => {
  it("rounds the corner of a rectangle while keeping a closed profile", () => {
    const s = emptySketch();
    s.geometry = [
      { id: "b", type: "point", x: 40, y: 0 },
      { id: "c", type: "point", x: 40, y: 20 },
      { id: "d", type: "point", x: 0, y: 20 },
      { id: "l1", type: "line", p1: SKETCH_ORIGIN, p2: "b" },
      { id: "l2", type: "line", p1: "b", p2: "c" },
      { id: "l3", type: "line", p1: "c", p2: "d" },
      { id: "l4", type: "line", p1: "d", p2: SKETCH_ORIGIN },
    ];
    const f = filletCorner(s, "c", 5, newId)!;
    expect(f.geometry.some((g) => g.type === "arc")).toBe(true);
    expect(f.geometry.some((g) => g.id === "c")).toBe(false);
    const a = analyzeProfiles(f.geometry);
    expect(a.regions).toHaveLength(1);
    // Area: rectangle minus the corner (r² − πr²/4).
    expect(Math.abs(a.regions[0]!.outer.area)).toBeCloseTo(40 * 20 - (25 - (Math.PI * 25) / 4), 0);
    expect(filletCorner(s, "c", 50, newId)).toBeNull();
  });
});

describe("offsetCurves", () => {
  it("offsets a closed loop outward with sharp joins", () => {
    const s = emptySketch();
    s.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 40, y: 0 },
      { id: "c", type: "point", x: 40, y: 20 },
      { id: "d", type: "point", x: 0, y: 20 },
      { id: "l1", type: "line", p1: "a", p2: "b" },
      { id: "l2", type: "line", p1: "b", p2: "c" },
      { id: "l3", type: "line", p1: "c", p2: "d" },
      { id: "l4", type: "line", p1: "d", p2: "a" },
    ];
    const o = offsetCurves(s, ["l1", "l2", "l3", "l4"], 5, newId)!;
    const a = analyzeProfiles(o.geometry);
    expect(a.loops).toHaveLength(2);
    const areas = a.loops.map((l) => Math.abs(l.area)).sort((x, y) => x - y);
    expect(areas[1]).toBeCloseTo(50 * 30, 6);
  });
});

describe("trim then close", () => {
  /** Three lines crossing beyond their ends: triangle (0,0) (100,0) (0,100). */
  function overhangs(): SketchData {
    const s = emptySketch();
    s.geometry = [
      { id: "a1", type: "point", x: -20, y: 0 },
      { id: "a2", type: "point", x: 120, y: 0 },
      { id: "b1", type: "point", x: 0, y: -20 },
      { id: "b2", type: "point", x: 0, y: 120 },
      { id: "c1", type: "point", x: -20, y: 120 },
      { id: "c2", type: "point", x: 120, y: -20 },
      { id: "L1", type: "line", p1: "a1", p2: "a2" },
      { id: "L2", type: "line", p1: "b1", p2: "b2" },
      { id: "L3", type: "line", p1: "c1", p2: "c2" },
    ];
    return s;
  }

  it("successive trims at the same crossing share the point: the contour is closed", () => {
    let s = overhangs();
    for (const [id, at] of [
      ["L1", { x: -10, y: 0 }],
      ["L1", { x: 110, y: 0 }],
      ["L2", { x: 0, y: -10 }],
      ["L2", { x: 0, y: 110 }],
      ["L3", { x: -10, y: 110 }],
      ["L3", { x: 110, y: -10 }],
    ] as const) s = trimSketch(s, id, at, newId)!;
    const p = analyzeProfiles(s.geometry);
    expect(p.chains).toHaveLength(0);
    expect(p.regions).toHaveLength(1);
    expect(Math.abs(p.loops[0]!.area)).toBeCloseTo(5000);
    expect(s.geometry.filter((g) => g.type === "point")).toHaveLength(3);
    // No redundant "point on curve" left on an endpoint.
    expect(s.constraints.filter((c) => c.type === "pointOnCurve")).toHaveLength(0);
  });

  it("finds and welds nearby endpoints that do not touch", () => {
    const s = emptySketch();
    s.geometry = [
      { id: "p0", type: "point", x: 0, y: 0 },
      { id: "p1", type: "point", x: 10, y: 0 },
      { id: "p2", type: "point", x: 10, y: 10 },
      { id: "p3", type: "point", x: 0, y: 10 },
      { id: "q0", type: "point", x: 0.05, y: 0.02 },
      { id: "s1", type: "line", p1: "p0", p2: "p1" },
      { id: "s2", type: "line", p1: "p1", p2: "p2" },
      { id: "s3", type: "line", p1: "p2", p2: "p3" },
      { id: "s4", type: "line", p1: "p3", p2: "q0" },
    ];
    s.dimensions = [{ id: "d", type: "distance", a: "p0", b: "q0", value: "0", driving: false }];
    expect(analyzeProfiles(s.geometry).regions).toHaveLength(0);
    const gaps = findGaps(s.geometry, 0.1);
    expect(gaps).toHaveLength(1);
    expect(new Set([gaps[0]!.a, gaps[0]!.b])).toEqual(new Set(["p0", "q0"]));
    expect(findGaps(s.geometry, 0.01)).toHaveLength(0);
    const closed = closeGaps(s, 0.1)!;
    expect(analyzeProfiles(closed.geometry).regions).toHaveLength(1);
    expect(closed.dimensions).toHaveLength(0); // dimension between the two welded points: degenerate
    expect(closeGaps(closed, 0.1)).toBeNull();
  });

  it("does not weld the two ends of the same short line", () => {
    const s = emptySketch();
    s.geometry = [
      { id: "u", type: "point", x: 0, y: 0 },
      { id: "w", type: "point", x: 0.01, y: 0 },
      { id: "l", type: "line", p1: "u", p2: "w" },
    ];
    expect(findGaps(s.geometry, 1)).toHaveLength(0);
  });
});
