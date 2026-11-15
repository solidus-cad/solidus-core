import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, emptySketch, type Feature, type PartDocument, type SkGeometry } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";

let engine: WasmKernelEngine;

beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

function doc(id: string, features: (Omit<Feature, "id" | "name"> & { id?: string })[]): PartDocument {
  const d = createPartDocument(id);
  d.id = id;
  d.features = features.map((f, i) => ({ ...f, id: f.id ?? `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return d;
}

/** Parabola arch (0,0) → (100,0), middle pole at height `top`, closed by its chord. */
function archSketch(top: string): Omit<Feature, "name"> {
  const s = emptySketch("XY");
  const geometry: SkGeometry[] = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "m", type: "point", x: 50, y: 90, construction: true },
    { id: "b", type: "point", x: 100, y: 0 },
    { id: "s", type: "bspline", poles: ["a", "m", "b"], degree: 2 },
    { id: "l", type: "line", p1: "b", p2: "a" },
  ];
  s.geometry = geometry;
  s.constraints = [
    { id: "f", type: "fix", point: "a" },
    { id: "h", type: "horizontal", a: "l" },
  ];
  s.dimensions = [
    { id: "w", type: "horizontalDistance", a: "a", b: "b", value: "100", driving: true },
    { id: "t", type: "verticalDistance", a: "a", b: "m", value: top, driving: true },
    { id: "x", type: "horizontalDistance", a: "a", b: "m", value: "50", driving: true },
  ];
  return { id: "sk", type: "sketch", params: {}, sketch: s };
}

const extrude = { id: "ex", type: "extrude", params: { sketch: "sk", mode: "blind", depth: "10", reverse: "no", op: "add" } };

describe("Sketch splines", () => {
  it("extrudes a region bounded by a spline: exact volume, stable names when a dimension changes", () => {
    const r = engine.recompute(doc("spline", [archSketch("100"), extrude]));
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok"]);
    // 2/3 of the triangle of the poles (100 × 100 / 2), 10 deep.
    expect(r.mass!.volume).toBeCloseTo((2 / 3) * 5000 * 10, 6);
    expect(r.topology.faces).toContain("ex/side(s)");
    const h = engine.recompute(doc("spline", [archSketch("60"), extrude]));
    expect(h.mass!.volume).toBeCloseTo((2 / 3) * 3000 * 10, 6);
    expect(new Set(h.topology.faces)).toEqual(new Set(r.topology.faces));
  });
});
