import { describe, expect, it } from "vitest";
import type { MeshPayload } from "@solidus-cad/sdk";
import { faceBodies, freeEdgeLines, hideBodies } from "../src/bodies.ts";
import { faceColorsOf } from "../src/paint.ts";
import { acceptsRef, bodyOf, edgeRef, faceRef } from "../src/refpick.ts";

/** Two bodies: "a" (faces 0 and 1, edge 0), "b" (face 2, edge 1); one triangle per face. */
function mesh(): MeshPayload {
  return {
    positions: new Float32Array(9 * 3),
    normals: new Float32Array(9 * 3),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    faceGroups: Int32Array.from([0, 3, 0, 3, 3, 1, 6, 3, 2]),
    edges: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    edgeGroups: Int32Array.from([0, 2, 0, 2, 2, 1]),
    names: { faces: ["a/top", "a/bottom", "b/top"], edges: ["e(a/bottom|a/top)", "e(b/top)"] },
    bodies: [
      { id: "a", faces: [0, 2], edges: [0, 1] },
      { id: "b", faces: [2, 1], edges: [1, 1] },
    ],
  };
}

describe("mesh bodies", () => {
  it("assigns each face to its body", () => {
    expect(faceBodies(mesh())).toEqual(["a", "a", "b"]);
  });

  it("hides a body while keeping the ids of the others", () => {
    const m = hideBodies(mesh(), new Set(["a"]));
    expect(Array.from(m.faceGroups)).toEqual([0, 3, 2]);
    expect(Array.from(m.indices)).toEqual([6, 7, 8]);
    expect(Array.from(m.edgeGroups)).toEqual([0, 2, 1]);
    expect(Array.from(m.edges)).toEqual([0, 1, 0, 1, 1, 0]);
    expect(hideBodies(mesh(), new Set())).toEqual(mesh());
  });

  it("attaches a pick to the body of the element", () => {
    expect([0, 1, 2].map((k) => bodyOf(mesh(), "face", k))).toEqual(["a", "a", "b"]);
    expect(bodyOf(mesh(), "edge", 1)).toBe("b");
    expect(faceRef(mesh(), 2)).toMatchObject({ name: "b/top", body: "b" });
    expect(edgeRef(mesh(), 0)).toMatchObject({ name: "e(a/bottom|a/top)", body: "a" });
    // A single body: nothing is written (single-body documents unchanged).
    expect(faceRef({ ...mesh(), bodies: [{ id: "a", faces: [0, 3], edges: [0, 2] }] }, 2).body).toBeUndefined();
  });

  it("filters picks by body kind and free edges", () => {
    // "b" is a surface whose edge 1 is a free edge.
    const m: MeshPayload = { ...mesh(), freeEdges: [1] };
    m.bodies![1] = { ...m.bodies![1]!, kind: "surface" };
    expect([0, 1, 2].map((k) => acceptsRef(m, "face", k, "surface"))).toEqual([false, false, true]);
    expect([0, 1, 2].map((k) => acceptsRef(m, "face", k, "solid"))).toEqual([true, true, false]);
    expect([0, 1].map((k) => acceptsRef(m, "edge", k, "freeEdge"))).toEqual([false, true]);
    expect(acceptsRef(m, "face", 0, undefined)).toBe(true);
    // Free-edge layer: the only segment of edge 1.
    const lines = freeEdgeLines(m)!;
    expect(Array.from(lines.geometry.getAttribute("position").array)).toEqual([0, 1, 0, 1, 1, 0]);
    expect(freeEdgeLines(mesh())).toBeNull();
  });

  it("colors a body with feature colors", () => {
    const colors = faceColorsOf(mesh(), { color: "#888", features: { b: "#f00" } }, ["a", "a", "b"], { a: { color: "#00f" }, b: { color: "#0f0" } });
    expect(colors).toEqual(["#00f", "#00f", "#f00"]);
  });
});
