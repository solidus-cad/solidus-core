import { describe, expect, it } from "vitest";
import type { Sketch3DData, V3 } from "@solidus-cad/sdk";
import { interpolate3, sampleSpline3, sketch3DCurves } from "../src/index.ts";

const pt = (id: string, x: number, y: number, z: number) => ({ id, type: "point" as const, x, y, z });
const line = (id: string, p1: string, p2: string) => ({ id, type: "line" as const, p1, p2 });
const near = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("3D splines", () => {
  it("passes through its points, ends included", () => {
    const through: V3[] = [[0, 0, 0], [0, 0, 30], [30, 0, 60], [60, 20, 80], [70, 40, 70]];
    const sp = interpolate3(through)!;
    expect(sp.degree).toBe(3);
    expect(sp.poles).toHaveLength(5);
    expect(sp.mults[0]).toBe(4);
    const samples = sampleSpline3(through, 64);
    expect(near(samples[0]!, through[0]!)).toBeLessThan(1e-9);
    expect(near(samples.at(-1)!, through.at(-1)!)).toBeLessThan(1e-9);
    // Every point of passage is reached by the sampled curve.
    for (const p of through) expect(Math.min(...samples.map((s) => near(s, p)))).toBeLessThan(0.5);
  });

  it("two points: a straight segment", () => {
    const sp = interpolate3([[0, 0, 0], [10, 0, 0]])!;
    expect(sp.degree).toBe(1);
    expect(sampleSpline3([[0, 0, 0], [10, 0, 0]], 4).every((p) => Math.abs(p[1]) + Math.abs(p[2]) < 1e-12)).toBe(true);
  });
});

describe("3D sketch curves for the kernel", () => {
  it("chains lines and splines end to end, oriented, and stops at branches", () => {
    // T-shaped skeleton: a → b → c along a line and a spline, and a branch b → d.
    const data: Sketch3DData = {
      geometry: [
        pt("a", 0, 0, 0),
        pt("b", 0, 0, 40),
        pt("m", 10, 0, 50),
        pt("c", 30, 0, 50),
        pt("d", 0, 30, 40),
        line("l1", "a", "b"),
        { id: "sp", type: "spline", points: ["c", "m", "b"] },
        line("l2", "b", "d"),
        { ...line("cx", "a", "d"), construction: true },
      ],
      constraints: [],
      dimensions: [],
    };
    const r = sketch3DCurves(data);
    expect(Object.keys(r.curves).sort()).toEqual(["l1", "l2", "sp"]);
    // b is shared by three curves: one chain per curve.
    expect(r.chains).toEqual([[{ id: "l1", reversed: false }], [{ id: "sp", reversed: false }], [{ id: "l2", reversed: false }]]);
    expect(r.curves.sp).toMatchObject({ type: "bspline", a: "c", b: "b", degree: 2 });

    // Without the branch: a single chain a → b → c, the spline reversed.
    const chain = sketch3DCurves({ ...data, geometry: data.geometry.filter((g) => g.id !== "l2") });
    expect(chain.chains).toEqual([[{ id: "l1", reversed: false }, { id: "sp", reversed: true }]]);
  });

  it("re-solves the points with the current parameters", () => {
    const data: Sketch3DData = {
      geometry: [pt("a", 0, 0, 0), pt("b", 0, 0, 10), line("l1", "a", "b")],
      constraints: [{ id: "f", type: "fix", point: "a" }, { id: "z", type: "axis", line: "l1", axis: "Z" }],
      dimensions: [{ id: "d", type: "length", a: "l1", value: "H", driving: true }],
    };
    const r = sketch3DCurves(data, new Map([["H", 25]]));
    expect(r.points.b![2]).toBeCloseTo(25, 6);
  });
});
