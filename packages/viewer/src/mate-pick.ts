import * as THREE from "three";
import type { MeshPayload, MateRefKind, MateTopo } from "@solidus-cad/sdk";
import { faceOfTriangle, mateRefOf, nameOf } from "./refpick.ts";
import { fitCircle } from "./snap.ts";

/**
 * Picking of the elements of an assembly constraint: vertex, edge (straight or circular) or face
 * (planar or cylindrical) of an occurrence, filtered by what the current constraint accepts.
 */

type V3 = [number, number, number];

export interface MateGeom {
  kind: MateRefKind;
  /** Local coordinate system of the part. */
  p: V3;
  d: V3;
}

export interface MatePick {
  /** Occurrence (part path). */
  key: string;
  element: "face" | "edge" | "vertex";
  /** Index of the face or edge in the mesh (-1 for a vertex). */
  index: number;
  /** Constraint geometry of the element (local coordinate system of the part). */
  geom: MateGeom;
  /** Topological name of the element (kernel with naming); for a vertex, that of its edge and endpoint. */
  topo?: MateTopo;
}

export interface MatePickTarget {
  key: string;
  payload: MeshPayload;
  matrix: THREE.Matrix4;
}

const VERTEX_PX = 9;
const EDGE_PX = 7;

const local = (a: Float32Array, i: number) => new THREE.Vector3(a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!);
const arr = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];

/** Polyline of edge `e` in local coordinates. */
export function edgePoints(m: MeshPayload, e: number): THREE.Vector3[] {
  const start = m.edgeGroups[e * 3]!;
  const count = m.edgeGroups[e * 3 + 1]!;
  if (count < 2) return [];
  const pts: THREE.Vector3[] = [];
  for (let k = start; k < start + count; k += 2) pts.push(local(m.edges, k));
  pts.push(local(m.edges, start + count - 1));
  return pts;
}

/** Geometries computed per mesh (faces and edges), since hovering requests them repeatedly. */
const cache = new WeakMap<MeshPayload, { faces: Map<number, MateGeom | null>; edges: Map<number, MateGeom | null> }>();
function cached(m: MeshPayload) {
  let c = cache.get(m);
  if (!c) cache.set(m, (c = { faces: new Map(), edges: new Map() }));
  return c;
}

/** Planar face (plane) or cylindrical face (axis); null otherwise. */
export function faceGeom(m: MeshPayload, face: number): MateGeom | null {
  const c = cached(m).faces;
  if (!c.has(face)) c.set(face, mateRefOf(m, face));
  return c.get(face)!;
}

/** Straight edge (axis carried by the edge) or circular edge (point at the center, circle normal); null otherwise. */
export function edgeGeom(m: MeshPayload, e: number): MateGeom | null {
  const c = cached(m).edges;
  if (c.has(e)) return c.get(e)!;
  const pts = edgePoints(m, e);
  let g: MateGeom | null = null;
  if (pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const dir = b.clone().sub(a);
    const len = dir.length();
    const tol = Math.max(len * 1e-4, 1e-6);
    if (len > 1e-9 && pts.every((p) => p.clone().sub(a).cross(dir).length() / len <= tol)) {
      g = { kind: "axis", p: arr(a.clone().lerp(b, 0.5)), d: arr(dir.normalize()) };
    } else {
      const circle = fitCircle(pts);
      if (circle) g = { kind: "point", p: arr(circle.center), d: arr(circle.normal) };
    }
  }
  c.set(e, g);
  return g;
}

/**
 * Element under the pointer: vertex, then edge, then face, keeping only those accepted by `accept`.
 * `hit`: visible face under the pointer (vertices and edges behind it are ignored).
 */
export function mateEntityAt(
  targets: MatePickTarget[],
  camera: THREE.Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
  ray: THREE.Ray,
  hit: { key: string; point: THREE.Vector3; triangle: number } | null,
  slack: number,
  accept: (key: string, kind: MateRefKind) => boolean,
): MatePick | null {
  const mouse = new THREE.Vector2(sx, sy);
  const toScreen = (p: THREE.Vector3) => {
    const v = p.clone().project(camera);
    return new THREE.Vector2(((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height);
  };
  const depthOf = (p: THREE.Vector3) => p.clone().sub(ray.origin).dot(ray.direction);
  const maxDepth = hit ? depthOf(hit.point) + slack : Infinity;

  let vertex: { pick: MatePick; d: number } | null = null;
  let edge: { pick: MatePick; d: number } | null = null;
  for (const t of targets) {
    const m = t.payload;
    const vertexOk = accept(t.key, "point");
    for (let e = 0; e < m.edgeGroups.length / 3; e++) {
      const pts = edgePoints(m, e);
      if (pts.length < 2) continue;
      const world = pts.map((p) => p.clone().applyMatrix4(t.matrix));
      // Vertices: endpoints of an open edge.
      const closed = pts[0]!.distanceTo(pts[pts.length - 1]!) <= 1e-9;
      if (vertexOk && !closed) {
        for (const i of [0, pts.length - 1]) {
          const d = toScreen(world[i]!).distanceTo(mouse);
          if (d <= VERTEX_PX && (!vertex || d < vertex.d) && depthOf(world[i]!) <= maxDepth) {
            const name = nameOf(m, "edge", e);
            const topo: MateTopo | undefined = name ? { element: "vertex", name, end: i === 0 ? "start" : "end" } : undefined;
            vertex = { pick: { key: t.key, element: "vertex", index: -1, geom: { kind: "point", p: arr(pts[i]!), d: [0, 0, 1] }, topo }, d };
          }
        }
      }
      let near = Infinity;
      for (let i = 0; i + 1 < world.length; i++) {
        const a = toScreen(world[i]!);
        const b = toScreen(world[i + 1]!);
        const ab = b.clone().sub(a);
        const len2 = ab.lengthSq();
        const u = len2 > 0 ? THREE.MathUtils.clamp(mouse.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
        const d = a.clone().addScaledVector(ab, u).distanceTo(mouse);
        if (d < near && depthOf(world[i]!.clone().lerp(world[i + 1]!, u)) <= maxDepth) near = d;
      }
      if (near > EDGE_PX || (edge && near >= edge.d)) continue;
      const g = edgeGeom(m, e);
      const name = nameOf(m, "edge", e);
      if (g && accept(t.key, g.kind)) edge = { pick: { key: t.key, element: "edge", index: e, geom: g, topo: name ? { element: "edge", name } : undefined }, d: near };
    }
  }
  if (vertex) return vertex.pick;
  if (edge) return edge.pick;
  if (!hit) return null;
  const target = targets.find((t) => t.key === hit.key);
  if (!target) return null;
  const face = faceOfTriangle(target.payload, hit.triangle);
  const g = faceGeom(target.payload, face);
  const name = nameOf(target.payload, "face", face);
  return g && accept(hit.key, g.kind) ? { key: hit.key, element: "face", index: face, geom: g, topo: name ? { element: "face", name } : undefined } : null;
}
