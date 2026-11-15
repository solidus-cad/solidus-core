import { beforeAll, describe, expect, it } from "vitest";
import { emptySketch, type SkBSpline, type SketchData, type SkGeometry } from "@solidus-cad/sdk";
import { domain, evaluate, flatten, interpolate, project, segment, split } from "../src/bspline.ts";
import { analyzeProfiles, intersect, pointMap, SketchSolver, trimSketch } from "../src/index.ts";

let solver: SketchSolver;
beforeAll(async () => {
  solver = await SketchSolver.create();
});

/** Parabola arch: quadratic spline (0,0) → (100,0), middle pole (50,100); x = 100 t, y = 200 t (1 - t). */
function arch(): SkGeometry[] {
  return [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "m", type: "point", x: 50, y: 100, construction: true },
    { id: "b", type: "point", x: 100, y: 0 },
    { id: "s", type: "bspline", poles: ["a", "m", "b"], degree: 2 },
  ];
}

const spline = (g: SkGeometry[], id = "s") => g.find((x) => x.id === id) as SkBSpline;

describe("B-spline evaluation", () => {
  it("evaluates a quadratic Bézier and an open cubic through its end poles", () => {
    const g = arch();
    const s = flatten(spline(g), pointMap(g));
    expect(domain(s)).toEqual([0, 1]);
    expect(evaluate(s, 0)).toEqual({ x: 0, y: 0 });
    expect(evaluate(s, 1)).toEqual({ x: 100, y: 0 });
    const mid = evaluate(s, 0.5);
    expect(mid.x).toBeCloseTo(50, 12);
    expect(mid.y).toBeCloseTo(50, 12);
  });

  it("splits exactly: both pieces lie on the original curve", () => {
    const pts = new Map([
      ["p0", { x: 0, y: 0 }],
      ["p1", { x: 20, y: 40 }],
      ["p2", { x: 50, y: -10 }],
      ["p3", { x: 80, y: 30 }],
      ["p4", { x: 100, y: 0 }],
    ]);
    const s = flatten({ id: "s", type: "bspline", poles: [...pts.keys()], degree: 3 }, pts);
    const [lo, hi] = domain(s);
    const [left, right] = split(s, 0.7);
    expect(domain(left)).toEqual([lo, 0.7]);
    expect(domain(right)).toEqual([0.7, hi]);
    for (const u of [0, 0.1, 0.35, 0.6, 0.7]) expect(evaluate(left, u).y).toBeCloseTo(evaluate(s, u).y, 10);
    for (const u of [0.7, 1.1, 1.5, 2]) expect(evaluate(right, u).x).toBeCloseTo(evaluate(s, u).x, 10);
    const mid = segment(s, 0.3, 1.4);
    expect(evaluate(mid, 0.3).x).toBeCloseTo(evaluate(s, 0.3).x, 10);
    expect(evaluate(mid, 1.4).y).toBeCloseTo(evaluate(s, 1.4).y, 10);
  });

  it("interpolates through points, open and closed", () => {
    const through = [
      { x: 0, y: 0 },
      { x: 30, y: 20 },
      { x: 60, y: -5 },
      { x: 90, y: 15 },
      { x: 120, y: 0 },
    ];
    for (const closed of [false, true]) {
      const r = interpolate(through, closed)!;
      expect(r.poles).toHaveLength(through.length);
      const ids = r.poles.map((_, i) => `p${i}`);
      const s = flatten({ id: "s", type: "bspline", poles: ids, degree: r.degree, periodic: r.periodic }, new Map(ids.map((id, i) => [id, r.poles[i]!])));
      for (const p of through) expect(project(s, p).distance).toBeLessThan(1e-6);
    }
    expect(interpolate([{ x: 0, y: 0 }])).toBeNull();
  });
});

describe("B-spline in the sketch", () => {
  it("solves a point on a spline and a tangency to a line at a shared endpoint", () => {
    const s: SketchData = emptySketch();
    s.geometry = [
      ...arch(),
      { id: "c", type: "point", x: 30, y: 60 },
      { id: "z", type: "point", x: -40, y: -30 },
      { id: "l", type: "line", p1: "z", p2: "a" },
    ];
    s.constraints = [
      { id: "k1", type: "pointOnCurve", point: "c", curve: "s" },
      { id: "k2", type: "tangent", a: "l", b: "s" },
      { id: "k3", type: "fix", point: "a" },
      { id: "k4", type: "fix", point: "m" },
      { id: "k5", type: "fix", point: "b" },
    ];
    const r = solver.solve(s);
    expect(r.ok).toBe(true);
    const g = r.geometry;
    const pts = pointMap(g);
    expect(project(flatten(spline(g), pts), pts.get("c")!).distance).toBeLessThan(1e-6);
    // The line follows the end tangent of the spline: aligned with the pole "m".
    const z = pts.get("z")!;
    expect(Math.abs(z.x * 100 - z.y * 50)).toBeLessThan(1e-6);
  });

  it("forms a region with a line, and a closed spline is a loop on its own", () => {
    const g: SkGeometry[] = [...arch(), { id: "l", type: "line", p1: "b", p2: "a" }];
    const a = analyzeProfiles(g);
    expect(a.regions).toHaveLength(1);
    expect(a.chains).toHaveLength(0);
    // Area between a parabola arch and its chord: 2/3 of the triangle of the poles (polygon of the loop: within 1 %).
    expect(Math.abs(Math.abs(a.regions[0]!.outer.area) / ((2 / 3) * 5000) - 1)).toBeLessThan(0.01);

    const r = interpolate([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 0, y: 30 },
    ], true)!;
    const closed: SkGeometry[] = [
      ...r.poles.map((p, i): SkGeometry => ({ id: `q${i}`, type: "point", x: p.x, y: p.y, construction: true })),
      { id: "c", type: "bspline", poles: r.poles.map((_, i) => `q${i}`), degree: r.degree, periodic: true },
    ];
    const b = analyzeProfiles(closed);
    expect(b.loops).toHaveLength(1);
    expect(b.regions).toHaveLength(1);
  });

  it("intersects a spline with a line, exactly", () => {
    const g: SkGeometry[] = [...arch(), { id: "p", type: "point", x: 25, y: -10 }, { id: "q", type: "point", x: 25, y: 200 }, { id: "v", type: "line", p1: "p", p2: "q" }];
    const hits = intersect(spline(g), g.find((x) => x.id === "v")!, pointMap(g));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.x).toBeCloseTo(25, 9);
    expect(hits[0]!.y).toBeCloseTo(200 * 0.25 * 0.75, 6);
  });

  it("trims a spline between two lines: the pieces keep the curve, the second is \"<id>.1\"", () => {
    const s = emptySketch();
    s.geometry = [
      ...arch(),
      { id: "p1", type: "point", x: 30, y: -10 },
      { id: "q1", type: "point", x: 30, y: 200 },
      { id: "v1", type: "line", p1: "p1", p2: "q1" },
      { id: "p2", type: "point", x: 70, y: -10 },
      { id: "q2", type: "point", x: 70, y: 200 },
      { id: "v2", type: "line", p1: "p2", p2: "q2" },
    ];
    let n = 0;
    const out = trimSketch(s, "s", { x: 50, y: 50 }, () => `n${n++}`)!;
    expect(out).not.toBeNull();
    const left = spline(out.geometry, "s");
    const right = spline(out.geometry, "s.1");
    const pts = pointMap(out.geometry);
    expect(left.poles[0]).toBe("a");
    expect(right.poles[right.poles.length - 1]).toBe("b");
    expect(pts.get(left.poles[left.poles.length - 1]!)!.x).toBeCloseTo(30, 6);
    expect(pts.get(right.poles[0]!)!.x).toBeCloseTo(70, 6);
    // The pieces follow the original arch: y = 200 t (1 - t) with x = 100 t.
    for (const piece of [left, right]) {
      const f = flatten(piece, pts);
      const [lo, hi] = domain(f);
      for (let i = 0; i <= 8; i++) {
        const q = evaluate(f, lo + ((hi - lo) * i) / 8);
        expect(q.y).toBeCloseTo(200 * (q.x / 100) * (1 - q.x / 100), 6);
      }
    }
    // The middle pole is no longer used: removed.
    expect(out.geometry.some((x) => x.id === "m")).toBe(false);
  });
});
