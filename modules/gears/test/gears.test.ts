import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, validateRecipe, type Feature, type GeometryRecipe } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "@solidus-cad/kernel-wasm/engine";
import {
  bevelInfo,
  bevelRecipe,
  centerDistance,
  GearError,
  pitchConeAngle,
  rackOutline,
  rackPitch,
  rackRecipe,
  spurGeometry,
  spurInfo,
  spurOutline,
  spurRecipe,
  type SpurParams,
} from "../src/engine/index.ts";

let engine: WasmKernelEngine;
beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

let n = 0;
const volume = (recipe: GeometryRecipe): number => {
  expect(validateRecipe(recipe)).toEqual([]);
  const d = createPartDocument("engrenage");
  d.id = `engrenage${n++}`; // one id per computation: the engine caches the documents
  const f: Feature = { id: "f0", name: "F0", type: "com.test/gear", params: {}, plugin: { id: "com.test", version: "1.0.0", recipe } };
  d.features = [f];
  d.rollback = 1;
  const r = engine.recompute(d);
  expect(r.statuses[0]).toEqual({ id: "f0", ok: true });
  return r.mass!.volume;
};

const spur: SpurParams = { module: 2, teeth: 20, width: 10, bore: 8, pressure: 20, shift: 0, helix: 0, hand: 1, representation: "detailed" };

describe("spur gear", () => {
  it("computes the reference radii", () => {
    const g = spurGeometry(2, 20, 20);
    expect(g.rp).toBe(20);
    expect(g.rb).toBeCloseTo(20 * Math.cos(Math.PI / 9), 9);
    expect(g.ra).toBe(22);
    expect(g.rf).toBeCloseTo(17.5, 9);
  });

  it("generates a contour whose vertices stay between the root and the tip", () => {
    const pts = spurOutline(2, 20, 20);
    const r = pts.map(([x, y]) => Math.hypot(x, y));
    expect(Math.min(...r)).toBeGreaterThan(17.5 - 1e-6);
    expect(Math.max(...r)).toBeLessThan(22 + 1e-6);
    expect(Math.max(...r)).toBeCloseTo(22, 6);
  });

  it("gives a volume between the root and tip circles, close to the pitch", () => {
    const v = volume(spurRecipe(spur));
    const bore = Math.PI * 16 * 10;
    expect(v).toBeGreaterThan(Math.PI * 17.5 ** 2 * 10 - bore);
    expect(v).toBeLessThan(Math.PI * 22 ** 2 * 10 - bore);
    expect(v / (Math.PI * 20 ** 2 * 10 - bore)).toBeCloseTo(1, 1);
  });

  it("keeps the volume of an equivalent straight gear for helical toothing", () => {
    const helical = { ...spur, helix: 20 };
    const info = spurInfo(helical);
    const recipe = spurRecipe(helical);
    expect(recipe.solid.op).toBe("twistExtrude");
    // Same apparent profile: straight gear with the apparent module and apparent pressure angle.
    const equivalent = spurRecipe({ ...spur, module: info.mt, pressure: info.alphaT });
    expect(volume(recipe)).toBeCloseTo(volume(equivalent), -1);
  });

  it("models the simplified version at the apparent pitch diameter", () => {
    expect(volume(spurRecipe({ ...spur, representation: "simplified" }))).toBeCloseTo(Math.PI * (20 ** 2 - 16) * 10, 0);
    const rp = spurInfo({ ...spur, helix: 15 }).rp;
    expect(volume(spurRecipe({ ...spur, representation: "simplified", helix: 15 }))).toBeCloseTo(Math.PI * (rp ** 2 - 16) * 10, 0);
  });

  it("computes the apparent module and centre distance of a helical gear", () => {
    const info = spurInfo({ ...spur, helix: 20 });
    expect(info.mt).toBeCloseTo(2 / Math.cos((20 * Math.PI) / 180), 9);
    expect(centerDistance(2, 20, 40)).toBe(60);
    expect(centerDistance(2, 20, 40, 20)).toBeCloseTo(60 / Math.cos((20 * Math.PI) / 180), 9);
  });

  it("rejects invalid values", () => {
    for (const bad of [{ teeth: 3 }, { module: 0 }, { width: -1 }, { bore: 40 }, { helix: 50 }, { shift: 2 }])
      expect(() => spurRecipe({ ...spur, ...bad })).toThrow(GearError);
  });
});

describe("rack", () => {
  const rack = { module: 2, teeth: 5, width: 10, base: 6, pressure: 20, representation: "detailed" as const };

  it("has a pitch of π·m and a closed contour of 4 vertices per tooth", () => {
    expect(rackPitch(2)).toBeCloseTo(2 * Math.PI, 12);
    expect(rackOutline(rack)).toHaveLength(4 + 4 * 5);
  });

  it("gives the volume of the base plus that of the teeth (trapezoids)", () => {
    const pitch = 2 * Math.PI;
    const length = 5 * pitch;
    const t = Math.tan((20 * Math.PI) / 180);
    const [ha, hf] = [2, 2.5];
    const tooth = ((pitch / 2 + 2 * hf * t + pitch / 2 - 2 * ha * t) / 2) * (ha + hf);
    expect(volume(rackRecipe(rack))).toBeCloseTo((length * 6 + 5 * tooth) * 10, 1);
    expect(volume(rackRecipe({ ...rack, representation: "simplified" }))).toBeCloseTo(length * 6 * 10, 1);
  });

  it("rejects a degenerate profile", () => {
    expect(() => rackRecipe({ ...rack, pressure: 35 })).toThrow(GearError);
    expect(() => rackRecipe({ ...rack, teeth: 0 })).toThrow(GearError);
  });
});

describe("simplified bevel gear", () => {
  const bevel = { module: 2, teeth: 20, mateTeeth: 20, shaftAngle: 90, faceWidth: 10, bore: 0 };

  it("gives a 45° pitch cone for two identical gears at 90°", () => {
    expect(pitchConeAngle(bevel)).toBeCloseTo(45, 9);
    expect(bevelInfo(bevel).pitchDiameter).toBe(40);
  });

  it("computes the volume of the truncated cone", () => {
    const d = Math.PI / 4;
    const r1 = 20;
    const r2 = r1 - 10 * Math.sin(d);
    const h = 10 * Math.cos(d);
    const expected = (Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
    expect(volume(bevelRecipe(bevel))).toBeCloseTo(expected, 0);
    expect(volume(bevelRecipe({ ...bevel, bore: 6 }))).toBeCloseTo(expected - Math.PI * 9 * h, 0);
  });

  it("rejects a face width greater than the generatrix", () => {
    expect(() => bevelRecipe({ ...bevel, faceWidth: 100 })).toThrow(GearError);
  });
});
