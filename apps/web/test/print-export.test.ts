import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { objectsTo3mf, trianglesToObj, type Tri } from "../src/obj.ts";

/** Closed tetrahedron, written as an STL would: each triangle repeats its vertices. */
const A = [0, 0, 0], B = [10, 0, 0], C = [0, 10, 0], D = [0, 0, 10];
const TETRA = [[A, C, B], [A, B, D], [B, C, D], [C, A, D]].map((t) => t.flat() as Tri);

const modelOf = (zip: Uint8Array) => strFromU8(unzipSync(zip)["3D/3dmodel.model"]!);
const count = (xml: string, tag: string) => xml.split(`<${tag} `).length - 1;

describe("3MF export", () => {
  it("writes a package with its content types and its relationship to the model", () => {
    const files = unzipSync(objectsTo3mf([{ name: "p", tris: TETRA, placements: [undefined] }]));
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    expect(strFromU8(files["_rels/.rels"]!)).toContain('Target="/3D/3dmodel.model"');
    expect(strFromU8(files["[Content_Types].xml"]!)).toContain("3dmanufacturing-3dmodel+xml");
  });

  it("welds the vertices: the mesh is closed, in millimeters", () => {
    const xml = modelOf(objectsTo3mf([{ name: "p", tris: TETRA, placements: [undefined] }]));
    expect(xml).toContain('unit="millimeter"');
    expect(count(xml, "vertex")).toBe(4);
    expect(count(xml, "triangle")).toBe(4);
    const edges = new Map<string, number>();
    for (const m of xml.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
      const [a, b, c] = [m[1]!, m[2]!, m[3]!];
      for (const e of [`${a}>${b}`, `${b}>${c}`, `${c}>${a}`]) edges.set(e, (edges.get(e) ?? 0) + 1);
    }
    // Manifold and consistently oriented: each edge is crossed once in each direction.
    for (const [e, n] of edges) {
      const [a, b] = e.split(">");
      expect(n).toBe(1);
      expect(edges.get(`${b}>${a}`)).toBe(1);
    }
  });

  it("drops the triangles that welding makes degenerate", () => {
    const flat = [0, 0, 0, 0, 0, 0, 1, 0, 0] as Tri;
    expect(count(modelOf(objectsTo3mf([{ name: "p", tris: [...TETRA, flat], placements: [undefined] }])), "triangle")).toBe(4);
  });

  it("removes the binary noise of STL coordinates", () => {
    const f = Math.fround(0.1);
    const xml = modelOf(objectsTo3mf([{ name: "p", tris: [[f, 0, 0, 1, 0, 0, 0, 1, 0]], placements: [undefined] }]));
    expect(xml).toContain('x="0.1"');
  });

  it("keeps one object per part and one placed item per occurrence", () => {
    const shift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    const rot = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const xml = modelOf(
      objectsTo3mf([
        { name: "a", tris: TETRA, placements: [shift, rot] },
        { name: "b", tris: TETRA, placements: [shift] },
      ]),
    );
    expect(count(xml, "object")).toBe(2);
    expect(xml).toContain('<item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 6 7"/>');
    expect(xml).toContain('<item objectid="1" transform="0 1 0 -1 0 0 0 0 1 0 0 0"/>');
    expect(xml).toContain('<item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 6 7"/>');
  });

  it("escapes the name of a part", () => {
    expect(modelOf(objectsTo3mf([{ name: 'a<b>&"c"\u0001', tris: TETRA, placements: [undefined] }]))).toContain('name="a&lt;b>&amp;&quot;c&quot;"');
  });

  it("refuses an empty model", () => {
    expect(() => objectsTo3mf([{ name: "p", tris: [], placements: [undefined] }])).toThrow();
  });
});

describe("OBJ export", () => {
  it("welds the vertices, with indices from 1", () => {
    const text = new TextDecoder().decode(trianglesToObj(TETRA, "p"));
    expect(text.startsWith("# p\no p\nv 0 0 0\nv 0 10 0\nv 10 0 0\nv 0 0 10\nf 1 2 3\nf 1 3 4\n")).toBe(true);
  });
});
