import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, emptySketch, type Feature, type PartDocument } from "@solidus-cad/sdk";
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

describe("Surface analyses", () => {
  it("curvature of a sphere at every vertex of the displayed mesh", () => {
    const R = 25;
    const s = emptySketch("XZ");
    s.geometry = [
      { id: "ctr", type: "point", x: 0, y: 0 },
      { id: "s", type: "point", x: 0, y: -R },
      { id: "n", type: "point", x: 0, y: R },
      { id: "a1", type: "arc", c: "ctr", start: "s", end: "n" },
      { id: "l1", type: "line", p1: "n", p2: "s" },
    ];
    const d = doc("sphere", [
      { id: "sk", type: "sketch", params: {}, sketch: s },
      { id: "rv", type: "revolve", params: { sketch: "sk", axis: "axis:V", angle: "360", op: "add" } },
    ]);
    const r = engine.recompute(d);
    expect(r.statuses.every((x) => x.ok)).toBe(true);
    const values = engine.surfaceAnalysis(d, "gaussian");
    expect(values.length).toBe(r.mesh!.positions.length / 3);
    const defined = Array.from(values).filter(Number.isFinite);
    expect(defined.length).toBeGreaterThan(values.length * 0.9);
    for (const v of defined) expect(Math.abs(v * R * R - 1)).toBeLessThan(0.01);
  });

  it("continuity: G1 between a fillet and its face, G0 on a sharp edge", () => {
    const d = doc("fillet", [
      { id: "f0", type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
      { id: "f2", type: "fillet", params: { radius: "5" }, refs: [{ kind: "edge", name: "e(f0/front|f0/top)", p: [50, 0, 40], size: 100 }] },
    ]);
    expect(engine.recompute(d).statuses.every((x) => x.ok)).toBe(true);
    const smooth = engine.continuity(d, "e(f0/top|f2/fillet(e(f0/front|f0/top)))");
    expect(smooth.length).toBe(21);
    expect(Math.max(...smooth.map((x) => x.g1))).toBeLessThan(0.1);
    const sharp = engine.continuity(d, "e(f0/back|f0/top)");
    expect(sharp[0]!.g1).toBeCloseTo(90, 6);
    expect(() => engine.continuity(d, "e(x|y)")).toThrow("Arête introuvable");
  });
});
