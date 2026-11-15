import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, type MeshPayload } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../../kernel-wasm/src/engine.ts";
import { edgeRef, faceRef, matchRef, mateRefOf, planarFace } from "../src/refpick.ts";

let engine: WasmKernelEngine;
beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

function mesh(features: { type: string; params: Record<string, string> }[]): MeshPayload {
  const d = createPartDocument("t");
  d.features = features.map((f, i) => ({ ...f, id: `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return engine.recompute(d).mesh!;
}

const faces = (m: MeshPayload) => Array.from({ length: m.faceGroups.length / 3 }, (_, i) => i);

describe("mateRefOf", () => {
  it("recognizes the planar faces of a box", () => {
    const m = mesh([{ type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } }]);
    const refs = faces(m).map((f) => mateRefOf(m, f));
    expect(refs.every((r) => r?.kind === "plane")).toBe(true);
    const top = refs.find((r) => r!.d[2] > 0.99)!;
    expect(top.p[2]).toBeCloseTo(40, 6);
    expect(faces(m).every((f) => planarFace(m, f))).toBe(true);
  });

  it("finds the axis of a cylinder and that of a hole", () => {
    const cyl = mesh([{ type: "cylinder", params: { radius: "10", height: "30", x: "5", y: "7", z: "0", axis: "z", op: "add" } }]);
    const axis = faces(cyl).map((f) => mateRefOf(cyl, f)).find((r) => r?.kind === "axis")!;
    expect(axis).toBeTruthy();
    expect(Math.abs(axis.d[2])).toBeCloseTo(1, 4);
    expect(axis.p[0]).toBeCloseTo(5, 3);
    expect(axis.p[1]).toBeCloseTo(7, 3);

    const holed = mesh([
      { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
      { type: "cylinder", params: { radius: "8", height: "40", x: "50", y: "30", z: "0", axis: "z", op: "cut" } },
    ]);
    const hole = faces(holed).map((f) => mateRefOf(holed, f)).find((r) => r?.kind === "axis")!;
    expect(hole.p[0]).toBeCloseTo(50, 3);
    expect(hole.p[1]).toBeCloseTo(30, 3);
  });
});

describe("named references (MeshPayload.names, cad-core)", () => {
  const box = () => mesh([{ type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } }]);
  /** Dummy names, indexed by mesh id (3rd value of the group triplets; sparse array if needed). */
  const named = (m: MeshPayload): MeshPayload => {
    const faces: string[] = [];
    const edges: string[] = [];
    for (let k = 0; k < m.faceGroups.length / 3; k++) faces[m.faceGroups[k * 3 + 2]!] = `face${m.faceGroups[k * 3 + 2]}`;
    for (let k = 0; k < m.edgeGroups.length / 3; k++) edges[m.edgeGroups[k * 3 + 2]!] = `edge${m.edgeGroups[k * 3 + 2]}`;
    return { ...m, names: { faces, edges } };
  };

  it("attaches the name of the picked element to the reference", () => {
    const m = named(box());
    expect(faceRef(m, 2).name).toBe(`face${m.faceGroups[2 * 3 + 2]}`);
    expect(edgeRef(m, 3).name).toBe(`edge${m.edgeGroups[3 * 3 + 2]}`);
    // Without names (MeshPayload.names is optional): purely geometric reference.
    expect(faceRef({ ...box(), names: undefined }, 2).name).toBeUndefined();
  });

  it("finds the element by its name before its geometry", () => {
    const m = named(box());
    const ref = { ...edgeRef(m, 3), p: [999, 999, 999] as [number, number, number] };
    expect(matchRef(m, ref, 1e-3)).toBe(3);
    // Unknown name: geometric fallback (here, nothing within the tolerance).
    expect(matchRef(m, { ...ref, name: "absent" }, 1e-3)).toBe(-1);
  });
});
