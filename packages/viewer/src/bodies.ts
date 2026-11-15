import * as THREE from "three";
import type { MeshPayload } from "@solidus-cad/sdk";

/** Color of the free edges of surfaces. */
const FREE_EDGE_COLOR = 0xd0661e;

/** Body (id) of each mesh face, by index k into `faceGroups`; undefined without body information. */
export function faceBodies(m: MeshPayload): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(m.faceGroups.length / 3).fill(undefined);
  if (!m.bodies?.length) return out;
  for (let k = 0; k < out.length; k++) {
    const id = m.faceGroups[k * 3 + 2]!;
    out[k] = m.bodies.find((b) => id >= b.faces[0] && id < b.faces[0] + b.faces[1])?.id;
  }
  return out;
}

/**
 * Mesh without the hidden bodies: their triangles and edges are removed, while the face and edge ids
 * (third value of the triplets) are kept, so that picking and topological names remain valid.
 * Positions and normals are shared with the original mesh.
 */
export function hideBodies(m: MeshPayload, hidden: ReadonlySet<string>): MeshPayload {
  const bodies = m.bodies?.filter((b) => hidden.has(b.id)) ?? [];
  if (!bodies.length) return m;
  const inRange = (id: number, ranges: [number, number][]) => ranges.some(([s, n]) => id >= s && id < s + n);
  const faceRanges = bodies.map((b) => b.faces);
  const edgeRanges = bodies.map((b) => b.edges);

  const indices: number[] = [];
  const faceGroups: number[] = [];
  for (let g = 0; g < m.faceGroups.length; g += 3) {
    const [start, count, id] = [m.faceGroups[g]!, m.faceGroups[g + 1]!, m.faceGroups[g + 2]!];
    if (inRange(id, faceRanges)) continue;
    faceGroups.push(indices.length, count, id);
    for (let i = start; i < start + count; i++) indices.push(m.indices[i]!);
  }
  // Edges: segments of two points (6 values); edgeGroups counted in points.
  const edges: number[] = [];
  const edgeGroups: number[] = [];
  for (let g = 0; g < m.edgeGroups.length; g += 3) {
    const [start, count, id] = [m.edgeGroups[g]!, m.edgeGroups[g + 1]!, m.edgeGroups[g + 2]!];
    if (inRange(id, edgeRanges)) continue;
    edgeGroups.push(edges.length / 3, count, id);
    for (let i = start * 3; i < (start + count) * 3; i++) edges.push(m.edges[i]!);
  }
  return {
    ...m,
    indices: Uint32Array.from(indices),
    faceGroups: Int32Array.from(faceGroups),
    edges: Float32Array.from(edges),
    edgeGroups: Int32Array.from(edgeGroups),
  };
}

/**
 * Free edges of surfaces (MeshPayload.freeEdges), drawn as a colored line over the regular edges; null if there are none.
 * Positions are copied: the layer is independent of the edge mesh.
 */
export function freeEdgeLines(m: MeshPayload): THREE.LineSegments | null {
  if (!m.freeEdges?.length) return null;
  const free = new Set(m.freeEdges);
  const pts: number[] = [];
  for (let g = 0; g < m.edgeGroups.length; g += 3) {
    if (!free.has(m.edgeGroups[g + 2]!)) continue;
    const [start, count] = [m.edgeGroups[g]!, m.edgeGroups[g + 1]!];
    for (let i = start * 3; i < (start + count) * 3; i++) pts.push(m.edges[i]!);
  }
  if (!pts.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: FREE_EDGE_COLOR }));
  lines.raycast = () => {};
  lines.renderOrder = 1;
  return lines;
}
