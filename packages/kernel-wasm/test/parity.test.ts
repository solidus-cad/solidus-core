// Parity with the reference kernel (recorded results, see reference.ts):
// same documents, same results.
import { beforeAll, describe, expect, it } from "vitest";
import { createImportedPart, type FeatureStatus } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";
import { faceCount, reference } from "./reference.ts";
import { block, doc, hole, L, SCENARIOS } from "./scenarios.ts";

let core: WasmKernelEngine;

beforeAll(async () => {
  core = await WasmKernelEngine.create(await SketchSolver.create());
});

const close = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

describe("cad-core parity with the reference kernel", () => {
  for (const [name, make] of Object.entries(SCENARIOS)) {
    it(name, () => {
      const a = reference.recompute(make());
      const b = core.recompute(make());
      expect(b.statuses.map((s) => s.ok)).toEqual(a.statuses.map((s) => s.ok));
      expect(Object.keys(b.sketches).sort()).toEqual(Object.keys(a.sketches).sort());
      expect(b.parameterErrors).toEqual(a.parameterErrors);
      expect(b.rebuilt).toBe(a.rebuilt);
      expect(b.mass === null).toBe(a.mass === null);
      if (a.mass && b.mass) {
        expect(close(b.mass.volume, a.mass.volume), `volume ${b.mass.volume} ≠ ${a.mass.volume}`).toBe(true);
        expect(close(b.mass.area, a.mass.area), `area ${b.mass.area} ≠ ${a.mass.area}`).toBe(true);
        for (let i = 0; i < 3; i++) expect(b.mass.center[i]).toBeCloseTo(a.mass.center[i]!, 6);
      }
      expect(faceCount(b)).toBe(a.faces);
      // Same error messages, except OCCT ones (free text): only the status is compared for those.
      a.statuses.forEach((s, i) => {
        const t = b.statuses[i]!;
        if (!s.ok && !t.ok && !/\(Std|\(Standard_/.test(s.error)) expect(t.error).toBe(s.error);
      });
    });
  }

  it("imports a STEP file, then cuts a hole in the imported body", () => {
    core.recompute(doc([block, hole], L(100)));
    const part = createImportedPart("palier.step", core.exportShape("step"));
    part.features.push({ id: "c", name: "Trou", type: "cylinder", params: { radius: "5", height: "40", x: "10", y: "10", z: "0", axis: "z", op: "cut" } });
    part.rollback = part.features.length;
    const a = reference.recompute(part);
    const b = core.recompute(part);
    // The import feature id is random on each creation: only status and message are compared.
    const states = (r: { statuses: FeatureStatus[] }) => r.statuses.map((s) => (s.ok ? "ok" : s.error));
    expect(states(b)).toEqual(states(a));
    expect(close(b.mass!.volume, a.mass!.volume)).toBe(true);
    const bad = createImportedPart("bad.step", new TextEncoder().encode("pas un STEP"));
    expect(states(core.recompute(bad))).toEqual(states(reference.recompute(bad)));
  });

  it("computes the same inertia tensor", () => {
    const a = reference.recompute(doc([block, hole], L(100))).mass!.inertia!;
    const b = core.recompute(doc([block, hole], L(100))).mass!.inertia!;
    for (const k of ["xx", "yy", "zz", "xy", "xz", "yz"] as const) expect(close(b[k], a[k], 1e-6) || Math.abs(b[k] - a[k]) < 1e-3, k).toBe(true);
  });

  it("shows the body before a feature (meshBefore), with the mass of the final body", () => {
    const d = doc([block, hole, { type: "fillet", params: { radius: "3" } }], L(100));
    const a = reference.recompute(d, { meshBefore: d.features[2]!.id });
    const b = core.recompute(d, { meshBefore: d.features[2]!.id });
    expect(faceCount(b)).toBe(a.faces);
    expect(close(b.mass!.volume, a.mass!.volume)).toBe(true);
  });

  it("featureAt: same source feature for each face", () => {
    const fillet = { type: "fillet", params: { radius: "3" } };
    const d = doc([block, hole, fillet], L(100));
    reference.recompute(d);
    const r = core.recompute(d);
    const m = r.mesh!;
    // One point per face: the centroid of the triangle farthest from the body edges. The reference kernel infers the
    // source feature from the distance to successive bodies; a point close to an edge lies within tolerance of the
    // neighboring face (fillet strips all have the same area), which would make the answer meaningless.
    const vertex = (k: number) => [0, 1, 2].map((c) => m.positions[m.indices[k]! * 3 + c]!);
    const segDist = (q: number[], a: number[], b: number[]) => {
      const ab = [0, 1, 2].map((k) => b[k]! - a[k]!);
      const aq = [0, 1, 2].map((k) => q[k]! - a[k]!);
      const t = Math.max(0, Math.min(1, (aq[0]! * ab[0]! + aq[1]! * ab[1]! + aq[2]! * ab[2]!) / (ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2 || 1)));
      return Math.hypot(...[0, 1, 2].map((k) => aq[k]! - t * ab[k]!));
    };
    const edgeDist = (q: number[]) => {
      let d = Infinity;
      for (let k = 0; k + 5 < m.edges.length; k += 6) d = Math.min(d, segDist(q, [m.edges[k]!, m.edges[k + 1]!, m.edges[k + 2]!], [m.edges[k + 3]!, m.edges[k + 4]!, m.edges[k + 5]!]));
      return d;
    };
    for (let i = 0; i < m.faceGroups.length; i += 3) {
      let p: [number, number, number] = [0, 0, 0];
      let best = -1;
      for (let t = m.faceGroups[i]!; t + 2 < m.faceGroups[i]! + m.faceGroups[i + 1]!; t += 3) {
        const [a, b, c] = [vertex(t), vertex(t + 1), vertex(t + 2)];
        const q = [0, 1, 2].map((k) => (a[k]! + b[k]! + c[k]!) / 3);
        const d = edgeDist(q);
        if (d > best) {
          best = d;
          p = q as [number, number, number];
        }
      }
      const faceId = m.faceGroups[i + 2]!;
      expect(reference.featureAt(d.id!, p), r.topology.faces[faceId]).toBe(core.featureAt(d.id!, faceId));
    }
  });

  it("mesh: same layout as MeshPayload", () => {
    const r = core.recompute(doc([block, hole], L(100)));
    const m = r.mesh!;
    expect(m.positions.length).toBe(m.normals.length);
    expect(m.positions.length % 3).toBe(0);
    expect(m.edges.length % 6).toBe(0);
    // Contiguous, increasing face ranges covering the whole index buffer.
    let next = 0;
    for (let i = 0; i < m.faceGroups.length; i += 3) {
      expect(m.faceGroups[i]).toBe(next);
      next += m.faceGroups[i + 1]!;
    }
    expect(next).toBe(m.indices.length);
    for (let i = 0; i < m.indices.length; i++) expect(m.indices[i]!).toBeLessThan(m.positions.length / 3);
    // Unit normals.
    for (let i = 0; i < m.normals.length; i += 3) {
      expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 4);
    }
  });
});

describe("Topological naming (cad-core)", () => {
  it("names every face and edge of the mesh", () => {
    const r = core.recompute(doc([block, hole], L(100)));
    const m = r.mesh!;
    for (let i = 2; i < m.faceGroups.length; i += 3) expect(r.topology.faces[m.faceGroups[i]!]).toBeTruthy();
    for (let i = 2; i < m.edgeGroups.length; i += 3) expect(r.topology.edges[m.edgeGroups[i]!]).toMatch(/^e\(/);
    expect(new Set(r.topology.faces)).toEqual(new Set(["f0/back", "f0/bottom", "f0/front", "f0/left", "f0/right", "f0/top", "f1/lateral"]));
  });

  it("keeps the same names when dimensions change, and resolves them to the right face", () => {
    const fillet = { type: "fillet", params: { radius: "3" } };
    const d = doc([block, hole, fillet], L(100));
    const a = core.recompute(d);
    // Same document, modified dimension.
    const b = core.recompute({ ...d, parameters: L(140) });
    expect(new Set(b.topology.faces)).toEqual(new Set(a.topology.faces));
    expect(new Set(b.topology.edges)).toEqual(new Set(a.topology.edges));
    const id = core.resolveName(d.id!, "f0/right");
    expect(b.topology.faces[id]).toBe("f0/right");
  });

  it("names extrusion faces after the sketch curves", () => {
    const r = core.recompute(SCENARIOS["extruded sketch with hole"]!());
    expect(new Set(r.topology.faces)).toEqual(
      new Set(["f1/side(l1)", "f1/side(l2)", "f1/side(l3)", "f1/side(l4)", "f1/side(hole)", "f1/start(l1)", "f1/end(l1)"]),
    );
  });
});
