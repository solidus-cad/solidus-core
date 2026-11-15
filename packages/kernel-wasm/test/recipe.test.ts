import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, validateRecipe, type Feature, type FeatureStatus, type GeometryRecipe, type PartDocument } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";

let engine: WasmKernelEngine;

beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

function doc(features: Omit<Feature, "id" | "name">[]): PartDocument {
  const d = createPartDocument("recette");
  d.id = "recette";
  d.features = features.map((f, i) => ({ ...f, id: `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return d;
}

const plugin = (recipe?: GeometryRecipe, error?: string): Omit<Feature, "id" | "name"> => ({
  type: "com.exemple.test/forme",
  params: {},
  plugin: { id: "com.exemple.test", version: "1.0.0", recipe, error },
});

const errorOf = (s: FeatureStatus | undefined): string => (s && !s.ok ? s.error : "");

const block = { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } };

describe("plugin recipes", () => {
  it("extrudes a pierced profile and builds a cone", () => {
    const plate: GeometryRecipe = {
      solid: {
        op: "extrude",
        h: 10,
        profile: { outer: { kind: "polygon", points: [[0, 0], [50, 0], [50, 30], [0, 30]] }, holes: [{ kind: "circle", center: [25, 15], r: 5 }] },
      },
    };
    const r = engine.recompute(doc([plugin(plate)]));
    expect(r.statuses[0]).toEqual({ id: "f0", ok: true });
    expect(r.mass!.volume).toBeCloseTo(50 * 30 * 10 - Math.PI * 25 * 10, 0);

    const cone = engine.recompute(doc([plugin({ solid: { op: "cone", r1: 10, r2: 5, h: 30, dir: [1, 0, 0] } })]));
    expect(cone.mass!.volume).toBeCloseTo((Math.PI * 30 * (100 + 50 + 25)) / 3, 0);
  });

  it("removes material from the previous body, and combines transforms and booleans", () => {
    const pocket: GeometryRecipe = { mode: "cut", solid: { op: "translate", by: [10, 10, 30], solid: { op: "box", size: [20, 20, 10] } } };
    const r = engine.recompute(doc([block, plugin(pocket)]));
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40 - 20 * 20 * 10, 0);

    // Replacement: body ∩ sphere (the recipe never releases the body).
    const cap: GeometryRecipe = { mode: "replace", solid: { op: "intersect", solids: [{ op: "body" }, { op: "sphere", r: 30 }] } };
    const c = engine.recompute(doc([block, plugin(cap)]));
    expect(c.mass!.volume).toBeCloseTo((4 / 3) * Math.PI * 30 ** 3 / 8, 0);
  });

  it("reports the plugin error, the missing plugin and an invalid recipe without breaking the tree", () => {
    const r = engine.recompute(doc([block, plugin(undefined, "module bloqué"), plugin(), plugin({ solid: { op: "box", size: [1, -1, 1] } }), { ...block, params: { ...block.params, x: "200" } }]));
    expect(r.statuses.map((s) => s.ok)).toEqual([true, false, false, false, true]);
    expect(errorOf(r.statuses[1])).toContain("module bloqué");
    expect(errorOf(r.statuses[2])).toContain("absent");
    expect(errorOf(r.statuses[3])).toContain("Recette invalide");
    expect(r.mass!.volume).toBeCloseTo(2 * 100 * 60 * 40, 0);
  });

  it("bounds the size of recipes", () => {
    const many = { op: "union" as const, solids: Array.from({ length: 6000 }, () => ({ op: "box" as const, size: [1, 1, 1] as [number, number, number] })) };
    expect(validateRecipe({ solid: many })[0]).toMatch(/nœuds/);
    expect(validateRecipe({ solid: { op: "eval" } })[0]).toMatch(/inconnue/);
  });
});

describe("recipe: twisted extrusion", () => {
  const profile = { outer: { kind: "polygon" as const, points: [[0, 0], [20, 0], [20, 10], [0, 10]] as [number, number][] }, holes: [{ kind: "circle" as const, center: [10, 5] as [number, number], r: 2 }] };

  it("keeps the prism volume and rejects an out-of-bounds twist", () => {
    const r = engine.recompute(doc([plugin({ solid: { op: "twistExtrude", profile, h: 10, twist: 60 } })]));
    expect(r.statuses[0]).toEqual({ id: "f0", ok: true });
    expect(r.mass!.volume).toBeCloseTo(20 * 10 * 10 - Math.PI * 4 * 10, 0);
    expect(validateRecipe({ solid: { op: "twistExtrude", profile, h: 10, twist: 900 } })).not.toEqual([]);
  });
});
