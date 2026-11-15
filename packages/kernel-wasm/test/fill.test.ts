import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, emptySketch, type Feature, type GeomRef, type PartDocument } from "@solidus-cad/sdk";
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

const statuses = (r: { statuses: { ok: boolean; error?: string }[] }) => r.statuses.map((s) => (s.ok ? "ok" : s.error));

/** Circle of radius 10 at the origin. */
function circle(): Omit<Feature, "name"> {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "ctr", type: "point", x: 0, y: 0 },
    { id: "c1", type: "circle", c: "ctr", r: 10 },
  ];
  return { id: "sk", type: "sketch", params: {}, sketch: s };
}

const tube = { id: "tb", type: "surfaceExtrude", params: { sketch: "sk", mode: "blind", depth: "30", depth2: "0", reverse: "no" } };
const edge = (name: string, choice?: string): GeomRef => ({ kind: "edge", name, p: [1e5, 1e5, 1e5], size: 1, group: "edges", ...(choice ? { choice } : {}) });
const fill = (id: string, name: string, choice?: string) => ({ id, type: "fillSurface", params: { usePoints: "no", quality: "normal" }, refs: [edge(name, choice)] });

describe("Fill and planar surfaces", () => {
  it("both ends of a tube plugged, then closed into a cylinder", () => {
    const r = engine.recompute(
      doc("plug", [
        circle(),
        tube,
        fill("ft", "e(tb/end|tb/side(c1))", "G0"),
        { id: "pb", type: "planarSurface", params: { source: "edges" }, refs: [edge("e(tb/side(c1)|tb/start)")] },
        { id: "cl", type: "closeSurface", params: { surfaces: "tb,ft,pb", op: "new" } },
      ]),
    );
    expect(statuses(r)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(Math.PI * 100 * 30, -1);
    expect(r.topology.faces).toContain("cl/closed(ft/fill)");
  });

  it("G1 fill over a revolved cone frustum in less than 2 s (WASM): a dome larger than the disc", () => {
    // Slanted line revolved around Z: radius 20 at z = 0, 15 at z = 10; its top circle designated by its geometry.
    const s = emptySketch("XZ");
    s.geometry = [
      { id: "a", type: "point", x: 20, y: 0 },
      { id: "b", type: "point", x: 15, y: 10 },
      { id: "g", type: "line", p1: "a", p2: "b" },
    ];
    const top: GeomRef = { kind: "edge", p: [15, 0, 10], size: 2 * Math.PI * 15, group: "edges" };
    const features = (choice: string): Omit<Feature, "name">[] => [
      { id: "sk", type: "sketch", params: {}, sketch: s },
      { id: "rv", type: "surfaceRevolve", params: { sketch: "sk", axis: "axis:V", angle: "360" } },
      { id: "ft", type: "fillSurface", params: { usePoints: "no", quality: "normal" }, refs: [{ ...top, choice }] },
    ];
    const flat = engine.recompute(doc("dome", features("G0")));
    expect(statuses(flat)).toEqual(["ok", "ok", "ok"]);
    const t0 = performance.now();
    const r = engine.recompute(doc("dome", features("G1")));
    const ms = performance.now() - t0;
    expect(statuses(r)).toEqual(["ok", "ok", "ok"]);
    expect(ms).toBeLessThan(2000);
    const fillArea = (m: typeof r) => m.mass!.bodies!.find((b) => b.id === "ft")!.area;
    expect(fillArea(flat)).toBeCloseTo(Math.PI * 15 * 15, 0);
    expect(fillArea(r)).toBeGreaterThan(fillArea(flat) * 1.05);
  });

  it("a tangency out of reach (vertical wall) is reported", () => {
    const r = engine.recompute(doc("wall", [circle(), tube, fill("ft", "e(tb/end|tb/side(c1))")]));
    expect(r.statuses.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining("Tangence (G1) impossible") });
  });
});
