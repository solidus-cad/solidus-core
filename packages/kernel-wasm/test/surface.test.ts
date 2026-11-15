import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, emptySketch, SKETCH_AXIS_V, type Feature, type PartDocument } from "@solidus-cad/sdk";
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

/** Open L-shaped chain in the XY plane: l1 from (0, 0) to (w, 0), l2 from (w, 0) to (w, 40). */
function elbow(w = 60): Omit<Feature, "name"> {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: w, y: 0 },
    { id: "c", type: "point", x: w, y: 40 },
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
  ];
  return { id: "sk", type: "sketch", params: {}, sketch: s };
}

const extrude = (depth = "30") => ({ id: "sx", type: "surfaceExtrude", params: { sketch: "sk", mode: "blind", depth, depth2: "10", reverse: "no" } });
const step = (docId: string) => new TextDecoder().decode(engine.exportShape("step", docId));
const count = (text: string, word: string) => text.split(word).length - 1;

describe("Surfaces", () => {
  it("surface extrusion of an open chain: surface body, named free edges, area, STEP", () => {
    const r = engine.recompute(doc("surface", [elbow(), extrude()]));
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok"]);
    expect(r.mesh!.bodies).toEqual([{ id: "sx", faces: [0, 2], edges: [0, 7], kind: "surface" }]);
    expect(new Set(r.topology.faces)).toEqual(new Set(["sx/side(l1)", "sx/side(l2)"]));
    expect(r.topology.edges).toContain("e(sx/side(l1)|sx/start)");
    expect(r.topology.edges).toContain("e(sx/end|sx/side(l2))");
    expect(r.topology.edges).toContain("e(sx/side(l1)|~)");
    // Free edges: start and end of each curve, plus the two side edges (the common edge is not one of them).
    expect(r.mesh!.freeEdges).toHaveLength(6);
    expect(r.mesh!.freeEdges!.map((k) => r.topology.edges[k])).not.toContain("e(sx/side(l1)|sx/side(l2))");
    // Part without a solid: zero volume, area of both faces; no active body (default target is a solid).
    expect(r.mass!.volume).toBe(0);
    expect(r.mass!.area).toBeCloseTo((60 + 40) * 30, 6);
    expect(r.activeBody).toBeUndefined();
    const text = step("surface");
    expect(count(text, "SHELL_BASED_SURFACE_MODEL")).toBeGreaterThan(0);
    expect(count(text, "MANIFOLD_SOLID_BREP")).toBe(0);
  });

  it("identical names when a dimension changes; edge resolution", () => {
    const a = engine.recompute(doc("stable", [elbow(60), extrude("30")]));
    const b = engine.recompute(doc("stable", [elbow(90), extrude("55")]));
    expect(new Set(b.topology.edges)).toEqual(new Set(a.topology.edges));
    expect(engine.resolveName("stable", "e(sx/end|sx/side(l2))")).toBeGreaterThanOrEqual(0);
  });

  it("solid and surface: mass of solids only, surface area per body, default target is a solid", () => {
    const box = { id: "bx", type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } };
    const hole = { id: "cy", type: "cylinder", params: { radius: "10", height: "40", x: "50", y: "30", z: "0", axis: "z", op: "cut" } };
    const r = engine.recompute(doc("mixed", [box, elbow(), extrude(), hole]));
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.mesh!.bodies!.map((b) => [b.id, b.kind])).toEqual([
      ["bx", "solid"],
      ["sx", "surface"],
    ]);
    // The cylinder removes material from the box: the surface is not the default target.
    expect(r.activeBody).toBe("bx");
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40 - Math.PI * 100 * 40, 3);
    expect(r.mass!.bodies!.find((b) => b.id === "sx")).toMatchObject({ volume: 0 });
    const text = step("mixed");
    expect(count(text, "MANIFOLD_SOLID_BREP")).toBe(1);
    expect(count(text, "SHELL_BASED_SURFACE_MODEL")).toBeGreaterThan(0);
    // A volume feature on the surface is rejected.
    const bad = engine.recompute(doc("mixed", [box, elbow(), extrude(), { ...hole, body: "sx" }]));
    expect(bad.statuses.at(-1)).toMatchObject({ ok: false, error: "Le corps cible est une surface : choisissez un corps solide" });
  });

  it("surface revolve: cylinder of radius 20 and height 40", () => {
    const s = emptySketch("XY");
    s.geometry = [
      { id: "a", type: "point", x: 20, y: 0 },
      { id: "b", type: "point", x: 20, y: 40 },
      { id: "l1", type: "line", p1: "a", p2: "b" },
    ];
    const r = engine.recompute(
      doc("revolve", [
        { id: "sk", type: "sketch", params: {}, sketch: s },
        { id: "rv", type: "surfaceRevolve", params: { sketch: "sk", axis: SKETCH_AXIS_V, angle: "360" } },
      ]),
    );
    expect(r.statuses.every((x) => x.ok)).toBe(true);
    expect(r.mesh!.bodies![0]!.kind).toBe("surface");
    expect(r.mass!.area).toBeCloseTo(2 * Math.PI * 20 * 40, 2);
  });

  it("thickening: a solid from the surface, which stays consumed", () => {
    const d = doc("thicken", [elbow(), extrude(), { id: "th", type: "thicken", params: { surfaces: "sx", thickness: "2", side: "normal", op: "new" } }]);
    const r = engine.recompute(d);
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok", "ok"]);
    expect(r.mesh!.bodies!.map((b) => [b.id, b.kind, b.consumed ?? false])).toEqual([
      ["sx", "surface", true],
      ["th", "solid", false],
    ]);
    expect(r.mass!.volume).toBeGreaterThan(0);
    const text = step("thicken");
    expect(count(text, "MANIFOLD_SOLID_BREP")).toBe(1);
    expect(count(text, "SHELL_BASED_SURFACE_MODEL")).toBe(0);
  });
});
