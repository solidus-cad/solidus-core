// Re-attachment by topological name (cad-core kernel). Prerequisite: packages/kernel-wasm/dist/kernel.wasm.
import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, type MeshPayload } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../../kernel-wasm/src/engine.ts";
import { edgeGeom, faceGeom } from "../src/mate-pick.ts";
import { nameOf } from "../src/refpick.ts";
import { remapMateRef, resolveNamed, type RemapRef } from "../src/remap.ts";

let core: WasmKernelEngine;
beforeAll(async () => {
  core = await WasmKernelEngine.create(await SketchSolver.create());
});

/** Same document (same features), different parameter set: like two configurations of a family. */
function mesh(features: { type: string; params: Record<string, string> }[], P: string): MeshPayload {
  const d = createPartDocument("t");
  d.id = "fam";
  d.parameters = [{ name: "P", expr: P }];
  d.features = features.map((f, i) => ({ ...f, id: `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  const r = core.recompute(d);
  expect(r.statuses.every((s) => s.ok)).toBe(true);
  return r.mesh!;
}

/** Constraint reference of a named face, as at picking time. */
function faceNamed(m: MeshPayload, name: string): RemapRef {
  for (let f = 0; f < m.faceGroups.length / 3; f++) {
    if (nameOf(m, "face", f) !== name) continue;
    const g = faceGeom(m, f)!;
    return { kind: g.kind, p: [...g.p], d: [...g.d], topo: { element: "face", name } };
  }
  throw new Error(`face ${name} introuvable`);
}

/** Reference of a circular edge (center) whose name satisfies `test`. */
function circleEdge(m: MeshPayload, test: (name: string) => boolean): RemapRef {
  for (let e = 0; e < m.edgeGroups.length / 3; e++) {
    const name = nameOf(m, "edge", e);
    const g = name && test(name) ? edgeGeom(m, e) : null;
    if (g?.kind === "point") return { kind: "point", p: [...g.p], d: [...g.d], topo: { element: "edge", name: name! } };
  }
  throw new Error("arête introuvable");
}

describe("remapMateRef by name (cad-core)", () => {
  // f0: block of height P; f1: taller neighboring block (45). When P goes from 40 to 60, the top of f1 becomes
  // the closest +Z plane to the former top of f0: the geometry would be wrong, the name would not.
  const two = [
    { type: "box", params: { width: "100", depth: "60", height: "P", x: "0", y: "0", z: "0", op: "add" } },
    { type: "box", params: { width: "50", depth: "60", height: "45", x: "100", y: "0", z: "0", op: "add" } },
  ];

  it("finds the face by its name when a neighboring face is closer", () => {
    const a = mesh(two, "40");
    const b = mesh(two, "60");
    const top = faceNamed(a, "f0/top");
    expect(top.p[2]).toBeCloseTo(40, 6);
    const r = remapMateRef(top, a, b)!;
    expect(r.topo?.name).toBe("f0/top");
    expect(r.p[2]).toBeCloseTo(60, 6);
    // Without a name (kernel without naming), the geometric fallback picks the neighboring face (z = 45).
    const geometric = remapMateRef({ kind: top.kind, p: top.p, d: top.d }, null, b)!;
    expect(geometric.p[2]).toBeCloseTo(45, 6);
  });

  it("a reference without a name (older constraint) takes that of the original element", () => {
    const a = mesh(two, "40");
    const b = mesh(two, "60");
    const top = faceNamed(a, "f0/top");
    const r = remapMateRef({ kind: top.kind, p: top.p, d: top.d }, a, b)!;
    expect(r.topo?.name).toBe("f0/top");
    expect(r.p[2]).toBeCloseTo(60, 6);
  });

  it("reports a vanished element instead of attaching a neighbor", () => {
    // Hole f1 of depth P: at 40 it opens on the top (edge top|hole), at 20 it does not.
    const holed: Parameters<typeof mesh>[0] = [
      { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
      { type: "cylinder", params: { radius: "8", height: "P", x: "50", y: "30", z: "0", axis: "z", op: "cut" } },
    ];
    const a = mesh(holed, "40");
    const b = mesh(holed, "20");
    const rim = circleEdge(a, (n) => n.includes("f0/top") && n.includes("f1/"));
    expect(rim.p[2]).toBeCloseTo(40, 3);
    expect(resolveNamed(rim, b)).toBeNull();
    expect(remapMateRef(rim, a, b)).toBeNull();
  });
});
