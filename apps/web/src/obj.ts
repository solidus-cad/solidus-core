/** Conversion of STL meshes (binary or ASCII): merging of placed parts, STL, Wavefront OBJ or 3MF output. */

import { strToU8, zipSync } from "fflate";

/** Triangle: 3 vertices × (x, y, z). */
export type Tri = [number, number, number, number, number, number, number, number, number];

export function readTriangles(stl: Uint8Array): Tri[] {
  const tris: Tri[] = [];
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  // A binary STL has an exact size: 84 + 50 × n.
  if (stl.length >= 84) {
    const n = view.getUint32(80, true);
    if (84 + 50 * n === stl.length) {
      for (let i = 0; i < n; i++) {
        const o = 84 + 50 * i + 12;
        const t = [] as unknown as Tri;
        for (let k = 0; k < 9; k++) t.push(view.getFloat32(o + 4 * k, true));
        tris.push(t);
      }
      return tris;
    }
  }
  const text = new TextDecoder().decode(stl);
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const v: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    v.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v.length === 9) tris.push(v.splice(0, 9) as Tri);
  }
  if (!tris.length) throw new Error("STL illisible");
  return tris;
}

/** Triangles of an STL placed by a 4×4 column-major matrix. */
export function placeTriangles(stl: Uint8Array, matrix?: number[]): Tri[] {
  const tris = readTriangles(stl);
  const m = matrix;
  if (!m) return tris;
  return tris.map((t) => {
    const out = [] as unknown as Tri;
    for (let k = 0; k < 9; k += 3) {
      const x = t[k]!, y = t[k + 1]!, z = t[k + 2]!;
      out.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
    }
    return out;
  });
}

/** Binary STL. */
export function trianglesToStl(tris: Tri[]): Uint8Array {
  const out = new Uint8Array(84 + 50 * tris.length);
  const view = new DataView(out.buffer);
  view.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + 50 * i;
    const ux = t[3]! - t[0]!, uy = t[4]! - t[1]!, uz = t[5]! - t[2]!;
    const vx = t[6]! - t[0]!, vy = t[7]! - t[1]!, vz = t[8]! - t[2]!;
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (let k = 0; k < 3; k++) view.setFloat32(o + 4 * k, n[k]! / len, true);
    for (let k = 0; k < 9; k++) view.setFloat32(o + 12 + 4 * k, t[k]!, true);
  });
  return out;
}

/** Welds identical vertices: coordinates (x, y, z per vertex) and triangles (3 indices from 0), without the degenerate ones. */
function weld(tris: Tri[]): { verts: number[]; faces: number[] } {
  const index = new Map<string, number>();
  const verts: number[] = [];
  const faces: number[] = [];
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let i = index.get(key);
    if (i === undefined) {
      i = verts.length / 3;
      verts.push(x, y, z);
      index.set(key, i);
    }
    return i;
  };
  for (const t of tris) {
    const a = vertex(t[0], t[1], t[2]);
    const b = vertex(t[3], t[4], t[5]);
    const c = vertex(t[6], t[7], t[8]);
    if (a !== b && b !== c && a !== c) faces.push(a, b, c);
  }
  return { verts, faces };
}

/** OBJ, with welding of identical vertices. */
export function trianglesToObj(tris: Tri[], name = "part"): Uint8Array {
  const { verts, faces } = weld(tris);
  const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("\n");
  const v = lines(verts.length / 3, (i) => `v ${verts[i * 3]} ${verts[i * 3 + 1]} ${verts[i * 3 + 2]}`);
  const f = lines(faces.length / 3, (i) => `f ${faces[i * 3]! + 1} ${faces[i * 3 + 1]! + 1} ${faces[i * 3 + 2]! + 1}`);
  return new TextEncoder().encode(`# ${name}\no ${name}\n${v}\n${f}\n`);
}

export function stlToObj(stl: Uint8Array, name = "part"): Uint8Array {
  return trianglesToObj(readTriangles(stl), name);
}

/** A 3MF object: its mesh, and one build item per occurrence (4×4 matrix, column-major; absent: in place). */
export interface PrintObject {
  name: string;
  tris: Tri[];
  placements: (number[] | undefined)[];
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

/** Text of an XML attribute (control characters are forbidden in XML 1.0). */
const xmlAttr = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");

/** Coordinate in mm: the STL float32 written without its binary noise (0.1, not 0.10000000149). */
const mm = (x: number) => String(+x.toFixed(5));

/** Transform of a build item: the columns of the matrix, without the last row (3MF multiplies row vectors). */
const transformOf = (m: number[]) => [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((i) => m[i]).join(" ");

/** 3MF package (core specification, millimeters). */
export function objectsTo3mf(objects: PrintObject[]): Uint8Array {
  const resources: string[] = [];
  const items: string[] = [];
  objects.forEach((o, n) => {
    const { verts, faces } = weld(o.tris);
    if (!faces.length) return;
    const id = n + 1;
    const xml = [`<object id="${id}" type="model" name="${xmlAttr(o.name)}"><mesh><vertices>`];
    for (let i = 0; i < verts.length; i += 3) xml.push(`<vertex x="${mm(verts[i]!)}" y="${mm(verts[i + 1]!)}" z="${mm(verts[i + 2]!)}"/>`);
    xml.push("</vertices><triangles>");
    for (let i = 0; i < faces.length; i += 3) xml.push(`<triangle v1="${faces[i]}" v2="${faces[i + 1]}" v3="${faces[i + 2]}"/>`);
    xml.push("</triangles></mesh></object>");
    resources.push(xml.join(""));
    for (const m of o.placements) items.push(`<item objectid="${id}"${m ? ` transform="${transformOf(m)}"` : ""}/>`);
  });
  if (!items.length) throw new Error("Aucune géométrie à exporter");
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">Solidus</metadata><resources>${resources.join("")}</resources><build>${items.join("")}</build></model>`;
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(RELS),
    "3D/3dmodel.model": strToU8(model),
  });
}
