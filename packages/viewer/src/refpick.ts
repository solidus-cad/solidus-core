import * as THREE from "three";
import type { GeomRef, MeshPayload } from "@solidus-cad/sdk";

/**
 * References built from the display mesh: the topological name of the element (MeshPayload.names,
 * provided by cad-core), and its geometry, used as a fallback: a point on the element, its direction (tangent or
 * normal) and its size. The kernel resolves the name first, then the geometry (core/part/refs.cpp).
 */

/** Topological name of a mesh edge or face (index of the group triplet), if known. */
export function nameOf(m: MeshPayload, kind: "edge" | "face", index: number): string | undefined {
  const groups = kind === "edge" ? m.edgeGroups : m.faceGroups;
  const id = groups[index * 3 + 2];
  return id === undefined ? undefined : (kind === "edge" ? m.names?.edges : m.names?.faces)?.[id] || undefined;
}

/** Body (multi-body) of a mesh edge or face, from the id ranges of MeshPayload.bodies. */
export function bodyOf(m: MeshPayload, kind: "edge" | "face", index: number): string | undefined {
  const id = (kind === "edge" ? m.edgeGroups : m.faceGroups)[index * 3 + 2];
  if (id === undefined || !m.bodies || m.bodies.length < 2) return undefined;
  return m.bodies.find((b) => {
    const [start, count] = kind === "edge" ? b.edges : b.faces;
    return id >= start && id < start + count;
  })?.id;
}

/** Picking filter (RefGroup.filter): elements of a solid, of a surface, or free edges of a surface. */
export type RefFilter = "solid" | "surface" | "freeEdge";

/** Can the element (edge or face at index `index`) be picked with this filter? Without a filter: always. */
export function acceptsRef(m: MeshPayload, kind: "edge" | "face", index: number, filter: RefFilter | undefined): boolean {
  if (!filter) return true;
  const id = (kind === "edge" ? m.edgeGroups : m.faceGroups)[index * 3 + 2];
  if (id === undefined) return false;
  if (filter === "freeEdge") return kind === "edge" && !!m.freeEdges?.includes(id);
  const body = m.bodies?.find((b) => {
    const [start, count] = kind === "edge" ? b.edges : b.faces;
    return id >= start && id < start + count;
  });
  return (body?.kind ?? "solid") === filter;
}

function named(ref: GeomRef, name: string | undefined, body: string | undefined): GeomRef {
  return { ...ref, ...(name ? { name } : {}), ...(body ? { body } : {}) };
}

const P = (a: Float32Array, i: number) => new THREE.Vector3(a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!);

/** Edge reference: midpoint (by length) of its polyline. */
export function edgeRef(m: MeshPayload, edge: number): GeomRef {
  const start = m.edgeGroups[edge * 3]!;
  const count = m.edgeGroups[edge * 3 + 1]!;
  const segs: [THREE.Vector3, THREE.Vector3, number][] = [];
  let total = 0;
  for (let k = start; k + 1 < start + count; k += 2) {
    const a = P(m.edges, k);
    const b = P(m.edges, k + 1);
    const l = a.distanceTo(b);
    segs.push([a, b, l]);
    total += l;
  }
  let acc = 0;
  for (const [a, b, l] of segs) {
    if (acc + l >= total / 2 && l > 0) {
      const p = a.clone().lerp(b, (total / 2 - acc) / l);
      const d = b.clone().sub(a).normalize();
      return named({ kind: "edge", p: [p.x, p.y, p.z], d: [d.x, d.y, d.z], size: total }, nameOf(m, "edge", edge), bodyOf(m, "edge", edge));
    }
    acc += l;
  }
  const a = segs[0]?.[0] ?? new THREE.Vector3();
  return named({ kind: "edge", p: [a.x, a.y, a.z], size: total }, nameOf(m, "edge", edge), bodyOf(m, "edge", edge));
}

/** Face reference: center of the largest triangle (always on the face), normal and area. */
export function faceRef(m: MeshPayload, face: number): GeomRef {
  const start = m.faceGroups[face * 3]!;
  const count = m.faceGroups[face * 3 + 1]!;
  const tri = new THREE.Triangle();
  let area = 0;
  let best = -1;
  let bestP = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let k = start; k < start + count; k += 3) {
    tri.set(P(m.positions, m.indices[k]!), P(m.positions, m.indices[k + 1]!), P(m.positions, m.indices[k + 2]!));
    const a = tri.getArea();
    area += a;
    if (a > best) {
      best = a;
      tri.getMidpoint(bestP);
      tri.getNormal(n);
    }
  }
  bestP = bestP.clone();
  return named({ kind: "face", p: [bestP.x, bestP.y, bestP.z], d: [n.x, n.y, n.z], size: area }, nameOf(m, "face", face), bodyOf(m, "face", face));
}

function distToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const line = new THREE.Line3(a, b);
  return line.closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p);
}

/**
 * Mesh element matching a reference (or -1 if there is none within `tol`): by its topological name
 * when the mesh and the reference both have one, otherwise by its geometry.
 */
export function matchRef(m: MeshPayload, ref: GeomRef, tol: number): number {
  if (ref.name && m.names) {
    const groups = ref.kind === "edge" ? m.edgeGroups : m.faceGroups;
    const names = ref.kind === "edge" ? m.names.edges : m.names.faces;
    for (let k = 0; k < groups.length / 3; k++) if (names[groups[k * 3 + 2]!] === ref.name) return k;
  }
  const p = new THREE.Vector3(...ref.p);
  let best = -1;
  let bestD = tol;
  if (ref.kind === "edge") {
    for (let e = 0; e < m.edgeGroups.length / 3; e++) {
      const start = m.edgeGroups[e * 3]!;
      const count = m.edgeGroups[e * 3 + 1]!;
      for (let k = start; k + 1 < start + count; k += 2) {
        const d = distToSegment(p, P(m.edges, k), P(m.edges, k + 1));
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
    }
    return best;
  }
  const tri = new THREE.Triangle();
  const q = new THREE.Vector3();
  for (let f = 0; f < m.faceGroups.length / 3; f++) {
    const start = m.faceGroups[f * 3]!;
    const count = m.faceGroups[f * 3 + 1]!;
    for (let k = start; k < start + count; k += 3) {
      tri.set(P(m.positions, m.indices[k]!), P(m.positions, m.indices[k + 1]!), P(m.positions, m.indices[k + 2]!));
      const d = tri.closestPointToPoint(p, q).distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
  }
  return best;
}

/**
 * Edge closest to the pointer, in pixels (or -1 beyond `tolPx`).
 * `occlusion`: distance of the visible surface under the pointer; edges behind it are ignored.
 */
export function pickEdge(
  m: MeshPayload,
  camera: THREE.Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
  tolPx: number,
  occlusion?: { ray: THREE.Ray; maxDist: number },
  accept?: (edge: number) => boolean,
): number {
  const proj = (i: number) => {
    const v = P(m.edges, i).project(camera);
    return new THREE.Vector2(((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height);
  };
  const p = new THREE.Vector2(sx, sy);
  let best = -1;
  let bestD = tolPx;
  for (let e = 0; e < m.edgeGroups.length / 3; e++) {
    if (accept && !accept(e)) continue;
    const start = m.edgeGroups[e * 3]!;
    const count = m.edgeGroups[e * 3 + 1]!;
    for (let k = start; k + 1 < start + count; k += 2) {
      const a = proj(k);
      const b = proj(k + 1);
      const ab = b.clone().sub(a);
      const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
      const d = a.add(ab.multiplyScalar(t)).distanceTo(p);
      if (d < bestD && occlusion) {
        const w = P(m.edges, k).lerp(P(m.edges, k + 1), t);
        if (occlusion.ray.origin.distanceTo(w) > occlusion.maxDist) continue;
      }
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  return best;
}

/**
 * Plane of a planar face: point on the face and outward normal (oriented like the mesh normals).
 * Returns null if the face is not planar.
 */
export function planarFace(m: MeshPayload, face: number): { p: [number, number, number]; n: [number, number, number] } | null {
  const ref = faceRef(m, face);
  const n = new THREE.Vector3(...ref.d!);
  const start = m.faceGroups[face * 3]!;
  const count = m.faceGroups[face * 3 + 1]!;
  const tri = new THREE.Triangle();
  const tn = new THREE.Vector3();
  let vertexNormal = new THREE.Vector3();
  for (let k = start; k < start + count; k += 3) {
    tri.set(P(m.positions, m.indices[k]!), P(m.positions, m.indices[k + 1]!), P(m.positions, m.indices[k + 2]!));
    if (tri.getArea() < 1e-12) continue;
    tri.getNormal(tn);
    if (Math.abs(tn.dot(n)) < 0.9999) return null;
    vertexNormal = vertexNormal.add(P(m.normals, m.indices[k]!));
  }
  // The winding order of the triangles may differ: the vertex normals give the material side.
  if (vertexNormal.dot(n) < 0) n.negate();
  return { p: ref.p, n: [n.x, n.y, n.z] };
}

/** Mesh face containing a triangle (triangle index in the full mesh). */
export function faceOfTriangle(m: MeshPayload, triangle: number): number {
  const offset = triangle * 3;
  let lo = 0;
  let hi = m.faceGroups.length / 3 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m.faceGroups[mid * 3]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Assembly constraint reference of a face, in the local coordinate system of the part:
 * plane (point + normal) for a planar face, axis (point + direction) for a cylindrical face of revolution.
 */
export function mateRefOf(m: MeshPayload, face: number): { kind: "plane" | "axis"; p: [number, number, number]; d: [number, number, number] } | null {
  const plane = planarFace(m, face);
  if (plane) return { kind: "plane", p: plane.p, d: plane.n };
  const cyl = cylinderOfFace(m, face);
  return cyl ? { kind: "axis", p: cyl.p, d: cyl.d } : null;
}

/** Cylinder carried by a face (part coordinate system): point on the axis, direction and radius; null if the face is not cylindrical. */
export function cylinderOfFace(m: MeshPayload, face: number): { p: [number, number, number]; d: [number, number, number]; r: number } | null {
  if (planarFace(m, face)) return null;
  const start = m.faceGroups[face * 3]!;
  const count = m.faceGroups[face * 3 + 1]!;
  const verts = [...new Set(Array.from(m.indices.subarray(start, start + count)))];
  if (verts.length < 6) return null;
  // Axis: direction of least spread of the normals (eigenvector of the smallest eigenvalue of Σ n nᵀ).
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of verts) {
    const n = P(m.normals, v).normalize();
    const a = [n.x, n.y, n.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j]! += a[i]! * a[j]!;
  }
  const axis = smallestEigenvector(S);
  // Center: q_i = c + r·m_i in the plane perpendicular to the axis (least squares on c and r).
  const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  const w = new THREE.Vector3().crossVectors(axis, u);
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  let along = 0;
  for (const v of verts) {
    const q = P(m.positions, v);
    const n = P(m.normals, v).normalize();
    along += q.dot(axis);
    const rows: [number[], number][] = [
      [[1, 0, n.dot(u)], q.dot(u)],
      [[0, 1, n.dot(w)], q.dot(w)],
    ];
    for (const [row, rhs] of rows) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i * 3 + j]! += row[i]! * row[j]!;
        b[i]! += row[i]! * rhs;
      }
    }
  }
  const sol = solve3(A, b);
  if (!sol || Math.abs(sol[2]) < 1e-6) return null;
  const c = u.clone().multiplyScalar(sol[0]).add(w.clone().multiplyScalar(sol[1])).add(axis.clone().multiplyScalar(along / verts.length));
  // Check: all vertices at the same distance from the axis (otherwise, this is not a cylinder).
  const r = Math.abs(sol[2]);
  for (const v of verts) {
    const d = P(m.positions, v).sub(c);
    const radial = d.sub(axis.clone().multiplyScalar(d.dot(axis))).length();
    if (Math.abs(radial - r) > Math.max(r * 0.02, 1e-3)) return null;
  }
  return { p: [c.x, c.y, c.z], d: [axis.x, axis.y, axis.z], r };
}

function solve3(A: number[], b: number[]): [number, number, number] | null {
  const det = (m: number[]) => m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return null;
  const col = (k: number) => A.map((v, i) => (i % 3 === k ? b[Math.floor(i / 3)]! : v));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3×3 matrix (shifted inverse iteration). */
function smallestEigenvector(S: number[]): THREE.Vector3 {
  const M = new THREE.Matrix3().fromArray(S).transpose();
  const shift = 1e-9;
  const A = M.clone();
  const e = A.elements;
  e[0]! += shift;
  e[4]! += shift;
  e[8]! += shift;
  const inv = A.clone().invert();
  let v = new THREE.Vector3(1, 0.7, 0.3).normalize();
  for (let i = 0; i < 50; i++) {
    const nv = v.clone().applyMatrix3(inv);
    if (nv.lengthSq() < 1e-30 || !Number.isFinite(nv.x)) break;
    v = nv.normalize();
  }
  return v;
}
