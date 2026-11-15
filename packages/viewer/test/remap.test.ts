import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, type MeshPayload } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../../kernel-wasm/src/engine.ts";
import { mateRefOf } from "../src/refpick.ts";
import { remapMateRef } from "../src/remap.ts";

let engine: WasmKernelEngine;
beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

let n = 0;
function mesh(features: { type: string; params: Record<string, string> }[]): MeshPayload {
  const d = createPartDocument(`t${n++}`);
  d.features = features.map((f, i) => ({ ...f, id: `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return engine.recompute(d).mesh!;
}

const box = (h: string) => ({ type: "box", params: { width: "100", depth: "60", height: h, x: "0", y: "0", z: "0", op: "add" } });
const hole = (r: string) => ({ type: "cylinder", params: { radius: r, height: "100", x: "50", y: "30", z: "0", axis: "z", op: "cut" } });
const faces = (m: MeshPayload) => Array.from({ length: m.faceGroups.length / 3 }, (_, i) => i);

describe("remapMateRef", () => {
  it("follows a planar face moved along its normal (another size of the family)", () => {
    const a = mesh([box("40")]);
    const b = mesh([box("55")]);
    const top = faces(a).map((f) => mateRefOf(a, f)!).find((r) => r.d[2] > 0.99)!;
    const r = remapMateRef(top, a, b)!;
    expect(r.kind).toBe("plane");
    expect(r.d[2]).toBeCloseTo(1, 6);
    expect(r.p[2]).toBeCloseTo(55, 6);
    // The bottom face does not move.
    const bottom = faces(a).map((f) => mateRefOf(a, f)!).find((x) => x.d[2] < -0.99)!;
    expect(remapMateRef(bottom, a, b)!.p[2]).toBeCloseTo(0, 6);
  });

  it("finds the axis of a hole with a different radius", () => {
    const a = mesh([box("40"), hole("6")]);
    const b = mesh([box("40"), hole("8")]);
    const axis = faces(a).map((f) => mateRefOf(a, f)).find((r) => r?.kind === "axis")!;
    const r = remapMateRef(axis, a, b)!;
    expect(r.kind).toBe("axis");
    expect(r.p[0]).toBeCloseTo(50, 3);
    expect(r.p[1]).toBeCloseTo(30, 3);
    // Original direction kept.
    expect(Math.sign(r.d[2])).toBe(Math.sign(axis.d[2]));
  });

  it("finds nothing when the element has disappeared", () => {
    const a = mesh([box("40"), hole("6")]);
    const b = mesh([box("40")]);
    const axis = faces(a).map((f) => mateRefOf(a, f)).find((r) => r?.kind === "axis")!;
    expect(remapMateRef({ ...axis, kind: "axis" }, a, b)).toBeNull();
  });
});
