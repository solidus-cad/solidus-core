import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { createPartDocument, type MeshPayload } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../../kernel-wasm/src/engine.ts";
import { pickDatumRef, type DatumPickInput } from "../src/datum-pick.ts";
import { mateRefOf, planarFace } from "../src/refpick.ts";

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

/** Orthographic top view: 1 px = 1 mm, screen center at (0, 0). */
function topCamera(): THREE.OrthographicCamera {
  const c = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 1000);
  c.position.set(0, 0, 500);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

/** Picking input: hit given on a face (first triangle), pointer at (sx, sy). */
function input(m: MeshPayload, face: number | null, sx = -5000, sy = -5000): DatumPickInput {
  let hit: DatumPickInput["hit"] = null;
  if (face !== null) {
    const k = m.faceGroups[face * 3]!;
    const p = (i: number) => new THREE.Vector3(m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!);
    const c = p(m.indices[k]!).add(p(m.indices[k + 1]!)).add(p(m.indices[k + 2]!)).divideScalar(3);
    hit = { key: null, point: c, triangle: k / 3 };
  }
  const ray = new THREE.Ray(new THREE.Vector3(sx - 100, 100 - sy, 500), new THREE.Vector3(0, 0, -1));
  return { targets: [{ key: null, payload: m, matrix: new THREE.Matrix4() }], camera: topCamera(), width: 200, height: 200, sx, sy, ray, hit, slack: 1 };
}

const faces = (m: MeshPayload) => Array.from({ length: m.faceGroups.length / 3 }, (_, i) => i);

describe("picking elements of a reference plane", () => {
  it("cylindrical face: cylinder (radius) or axis; planar face rejected for a cylinder", () => {
    const m = mesh([{ type: "cylinder", params: { radius: "10", height: "30", x: "0", y: "0", z: "0", axis: "z", op: "add" } }]);
    const side = faces(m).find((f) => mateRefOf(m, f)?.kind === "axis")!;
    const cyl = pickDatumRef("cylinder", input(m, side));
    expect(cyl).toMatchObject({ kind: "cylinder" });
    expect((cyl as { r: number }).r).toBeCloseTo(10, 1);
    const axis = pickDatumRef("axis", input(m, side));
    expect(axis?.kind).toBe("axis");
    expect(Math.abs((axis as { d: number[] }).d[2]!)).toBeCloseTo(1, 4);
    const top = faces(m).find((f) => planarFace(m, f) && planarFace(m, f)!.n[2] > 0.99)!;
    expect(pickDatumRef("cylinder", input(m, top))).toBeNull();
    const pl = pickDatumRef("plane", input(m, top));
    expect(pl?.kind).toBe("plane");
    expect((pl as { n: number[] }).n[2]).toBeCloseTo(1, 6);
  });

  it("point: vertex snapped under the pointer; axis: straight edge", () => {
    const m = mesh([{ type: "box", params: { width: "60", depth: "40", height: "20", x: "0", y: "0", z: "0", op: "add" } }]);
    // Corner (60, 40) in top view: px (160, 60).
    const p = pickDatumRef("point", input(m, null, 159, 61));
    expect(p?.kind).toBe("point");
    const q = (p as { p: number[] }).p;
    expect(q[0]).toBeCloseTo(60, 6);
    expect(q[1]).toBeCloseTo(40, 6);
    // Midpoint of the edge y = 0 (x from 0 to 60): px (130, 100).
    const a = pickDatumRef("axis", input(m, null, 130, 101));
    expect(a?.kind).toBe("axis");
    expect(Math.abs((a as { d: number[] }).d[0]!)).toBeCloseTo(1, 6);
  });
});
