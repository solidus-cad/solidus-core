import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, emptySketch, type Feature, type PartDocument, type Sketch3DData } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";

/**
 * Memory check (Surfaces workshop, lot 10): a heavy surface part recomputed 60 times with a changing dimension, its
 * curvature analysed each time. The memory allocated by the kernel must stabilise: the cache only keeps the last state of
 * each document, and the OCCT shapes of the previous states are freed. About 3 minutes: outside of `test`, run by
 * `pnpm --filter @solidus-cad/kernel-wasm test:memory`.
 */

let engine: WasmKernelEngine;

beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

function square(id: string, half: number, z: string): Omit<Feature, "name"> {
  const s = emptySketch("XY");
  s.plane.offset = z;
  s.geometry = [
    { id: "A", type: "point", x: -half, y: -half },
    { id: "B", type: "point", x: half, y: -half },
    { id: "C", type: "point", x: half, y: half },
    { id: "D", type: "point", x: -half, y: half },
    { id: "q1", type: "line", p1: "A", p2: "B" },
    { id: "q2", type: "line", p1: "B", p2: "C" },
    { id: "q3", type: "line", p1: "C", p2: "D" },
    { id: "q4", type: "line", p1: "D", p2: "A" },
  ];
  return { id, type: "sketch", params: {}, sketch: s };
}

function heavyPart(h: number): PartDocument {
  const d = createPartDocument("heavy");
  d.id = "heavy";
  d.parameters = [{ name: "H", expr: String(h) }];
  const path: Sketch3DData = {
    geometry: [
      { id: "P0", type: "point", x: 0, y: 30, z: 0 },
      { id: "P1", type: "point", x: 10, y: 30, z: 20 },
      { id: "P2", type: "point", x: 30, y: 40, z: 30 },
      { id: "P3", type: "point", x: 50, y: 30, z: 45 },
      { id: "sp", type: "spline", points: ["P0", "P1", "P2", "P3"] },
    ],
    constraints: [],
    dimensions: [],
  };
  const profile = emptySketch("XY");
  profile.geometry = [
    { id: "a", type: "point", x: -5, y: 30 },
    { id: "b", type: "point", x: 5, y: 30 },
    { id: "s1", type: "line", p1: "a", p2: "b" },
  ];
  const features: Omit<Feature, "name">[] = [
    square("s0", 10, "0"),
    square("s1", 6, "H"),
    square("s2", 12, "2 * H"),
    { id: "lf", type: "surfaceLoft", params: { sections: "s0,s1,s2", guides: "", ruled: "no" } },
    { id: "of", type: "offsetSurface", params: { surfaces: "lf", distance: "1", reverse: "no" } },
    { id: "th", type: "thicken", params: { surfaces: "of", thickness: "1.5", side: "normal", op: "new" } },
    { id: "p3", type: "sketch3d", params: {}, sketch3d: path },
    { id: "pr", type: "sketch", params: {}, sketch: profile },
    { id: "sw", type: "surfaceSweep", params: { profile: "pr", path: "p3", orientation: "corrected" } },
  ];
  d.features = features.map((f, i) => ({ ...f, name: `F${i}` }));
  d.rollback = d.features.length;
  return d;
}

describe("Memory", () => {
  it("60 recomputes of a heavy surface part: the allocated memory stabilises", () => {
    const used: number[] = [];
    const heap: number[] = [];
    for (let k = 0; k < 60; k++) {
      const doc = heavyPart(20 + k);
      const r = engine.recompute(doc);
      expect(r.statuses.map((s) => (s.ok ? "ok" : `${s.id}: ${s.error}`)).filter((s) => s !== "ok")).toEqual([]);
      engine.surfaceAnalysis(doc, "mean");
      used.push(engine.memory().used);
      heap.push(engine.memory().heap);
    }
    // After the warm-up, the allocated memory no longer grows: last 10 recomputes vs. 10 after the warm-up.
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const early = avg(used.slice(10, 20));
    const late = avg(used.slice(50, 60));
    console.info(`kernel memory: ${(early / 2 ** 20).toFixed(1)} MiB → ${(late / 2 ** 20).toFixed(1)} MiB, heap ${(engine.memory().heap / 2 ** 20).toFixed(0)} MiB`);
    expect(late).toBeLessThan(early * 1.05 + 2 ** 20);
    // The WASM heap only grows: it must have reached its size during the warm-up.
    expect(heap[59]).toBe(heap[19]);
  }, 600_000);
});
