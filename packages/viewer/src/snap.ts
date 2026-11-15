import * as THREE from "three";
import type { MeshPayload } from "@solidus-cad/sdk";
import { cylinderOfFace, faceOfTriangle } from "./refpick.ts";

/**
 * Snapping of measurement points: vertex, midpoint of an edge, center of a circle, point on an edge or point on a face,
 * from the display mesh (part coordinate system) and the world matrix of the part.
 */

export type SnapKind = "vertex" | "midpoint" | "center" | "edge" | "face";

export interface SnapPoint {
  point: [number, number, number];
  kind: SnapKind;
  /** Assembly occurrence (null: single part). */
  key: string | null;
}

export interface SnapTarget {
  key: string | null;
  payload: MeshPayload;
  matrix: THREE.Matrix4;
}

/** Snap tolerances in pixels. */
const VERTEX_PX = 10;
const MIDPOINT_PX = 10;
const CENTER_PX = 12;
const EDGE_PX = 7;

const at = (a: Float32Array, i: number, m: THREE.Matrix4) => new THREE.Vector3(a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!).applyMatrix4(m);

/** Circle carried by a polyline (full circle or arc), or null if it is not circular. */
export function fitCircle(pts: THREE.Vector3[]): { center: THREE.Vector3; normal: THREE.Vector3; radius: number; closed: boolean; angle: number } | null {
  if (pts.length < 4) return null;
  const closed = pts[0]!.distanceTo(pts[pts.length - 1]!) <= 1e-6 * (1 + pts[0]!.length());
  const n = pts.length - 1;
  // Circumscribed circle through three points spread along the polyline.
  const a = pts[0]!;
  const b = pts[Math.floor(n / (closed ? 3 : 2))]!;
  const c = pts[closed ? Math.floor((2 * n) / 3) : n]!;
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const nrm = ab.clone().cross(ac);
  const d = 2 * nrm.lengthSq();
  if (d < 1e-12) return null;
  const center = a
    .clone()
    .add(nrm.clone().cross(ab).multiplyScalar(ac.lengthSq()).add(ac.clone().cross(nrm).multiplyScalar(ab.lengthSq())).divideScalar(d));
  const r0 = center.distanceTo(a);
  const normal = nrm.normalize();
  const tol = Math.max(r0 * 0.005, 1e-4);
  let sum = 0;
  for (const p of pts) {
    const q = p.clone().sub(center);
    if (Math.abs(q.length() - r0) > tol || Math.abs(q.dot(normal)) > tol) return null;
    sum += q.length();
  }
  // Covered angle: sum of the angles between successive points.
  let angle = 0;
  for (let i = 0; i + 1 < pts.length; i++) angle += pts[i]!.clone().sub(center).angleTo(pts[i + 1]!.clone().sub(center));
  return { center, normal, radius: sum / pts.length, closed, angle: closed ? Math.PI * 2 : angle };
}

/** Point halfway along the polyline (arc length), or null for a closed polyline. */
export function polylineMidpoint(pts: THREE.Vector3[]): THREE.Vector3 | null {
  if (pts.length < 2 || pts[0]!.distanceTo(pts[pts.length - 1]!) <= 1e-9) return null;
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) total += pts[i]!.distanceTo(pts[i + 1]!);
  let rest = total / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = pts[i]!.distanceTo(pts[i + 1]!);
    if (rest <= l) return pts[i]!.clone().lerp(pts[i + 1]!, l > 0 ? rest / l : 0);
    rest -= l;
  }
  return pts[pts.length - 1]!.clone();
}

function circleCenter(pts: THREE.Vector3[]): THREE.Vector3 | null {
  return fitCircle(pts)?.center ?? null;
}

/** Polyline of edge `e` (world coordinates). */
function edgePolyline(m: MeshPayload, e: number, matrix: THREE.Matrix4): THREE.Vector3[] {
  const start = m.edgeGroups[e * 3]!;
  const count = m.edgeGroups[e * 3 + 1]!;
  if (count < 2) return [];
  // Segments are stored in pairs: the polyline is the first point of each pair, then the last point.
  const pts: THREE.Vector3[] = [];
  for (let k = start; k < start + count; k += 2) pts.push(at(m.edges, k, matrix));
  pts.push(at(m.edges, start + count - 1, matrix));
  return pts;
}

/** Points of a circle (world coordinates), for display. */
export function circlePoints(center: [number, number, number], normal: [number, number, number], radius: number, segments = 96): [number, number, number][] {
  const n = new THREE.Vector3(...normal).normalize();
  const u = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  const c = new THREE.Vector3(...center);
  const out: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(c.clone().addScaledVector(u, radius * Math.cos(a)).addScaledVector(w, radius * Math.sin(a)).toArray() as [number, number, number]);
  }
  return out;
}

/** Circle picked for measuring a diameter or a radius. */
export interface CirclePick {
  /** Circular edge (circle or arc) or cylindrical face. */
  kind: "edge" | "face";
  center: [number, number, number];
  /** Normal of the circle (cylinder axis). */
  normal: [number, number, number];
  radius: number;
  /** Edge: full circle; false for an arc. Face: always true. */
  closed: boolean;
  /** Covered angle (radians): 2π for a full circle. */
  angle: number;
  key: string | null;
  /** Cylindrical face: axial extent of the face relative to `center`, along `normal` (min, max; mm). */
  span?: [number, number];
}

/**
 * Circle under the pointer: closest circular edge (within `EDGE_PX`), otherwise the cylindrical face hit
 * (the circle is then the section of the cylinder at the height of the hit point).
 */
export function circleAt(
  targets: SnapTarget[],
  camera: THREE.Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
  ray: THREE.Ray,
  hit: { key: string | null; point: THREE.Vector3; triangle: number } | null,
  slack: number,
): CirclePick | null {
  const toScreen = (p: THREE.Vector3) => {
    const v = p.clone().project(camera);
    return new THREE.Vector2(((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height);
  };
  const mouse = new THREE.Vector2(sx, sy);
  const depthOf = (p: THREE.Vector3) => p.clone().sub(ray.origin).dot(ray.direction);
  const maxDepth = hit ? depthOf(hit.point) + slack : Infinity;

  let best: { t: SnapTarget; pts: THREE.Vector3[]; d: number } | null = null;
  for (const t of targets) {
    if (hit && t.key !== hit.key) continue;
    for (let e = 0; e < t.payload.edgeGroups.length / 3; e++) {
      const pts = edgePolyline(t.payload, e, t.matrix);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = toScreen(pts[i]!);
        const b = toScreen(pts[i + 1]!);
        const ab = b.clone().sub(a);
        const len2 = ab.lengthSq();
        const u = len2 > 0 ? THREE.MathUtils.clamp(mouse.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
        const d = a.clone().addScaledVector(ab, u).distanceTo(mouse);
        if (d > EDGE_PX || (best && d >= best.d)) continue;
        if (depthOf(pts[i]!.clone().lerp(pts[i + 1]!, u)) > maxDepth) continue;
        best = { t, pts, d };
      }
    }
  }
  const found = best as { t: SnapTarget; pts: THREE.Vector3[] } | null;
  const c = found ? fitCircle(found.pts) : null;
  if (found && c) {
    return {
      kind: "edge",
      center: c.center.toArray() as [number, number, number],
      normal: c.normal.toArray() as [number, number, number],
      radius: c.radius,
      closed: c.closed,
      angle: c.angle,
      key: found.t.key,
    };
  }
  if (!hit) return null;
  const t = targets.find((x) => x.key === hit.key);
  if (!t) return null;
  const cyl = cylinderOfFace(t.payload, faceOfTriangle(t.payload, hit.triangle));
  if (!cyl) return null;
  const p = new THREE.Vector3(...cyl.p).applyMatrix4(t.matrix);
  const axis = new THREE.Vector3(...cyl.d).transformDirection(t.matrix);
  const center = p.addScaledVector(axis, hit.point.clone().sub(p).dot(axis));
  // Axial extent of the face, measured in the part frame (the occurrence matrices are rigid).
  const face = faceOfTriangle(t.payload, hit.triangle);
  const start = t.payload.faceGroups[face * 3]!;
  const count = t.payload.faceGroups[face * 3 + 1]!;
  const local = new THREE.Vector3(...cyl.p);
  const dir = new THREE.Vector3(...cyl.d);
  const along = center.clone().applyMatrix4(t.matrix.clone().invert()).sub(local).dot(dir);
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = start; k < start + count; k++) {
    const v = t.payload.indices[k]!;
    const a = new THREE.Vector3(t.payload.positions[v * 3]!, t.payload.positions[v * 3 + 1]!, t.payload.positions[v * 3 + 2]!).sub(local).dot(dir) - along;
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  return {
    kind: "face",
    center: center.toArray() as [number, number, number],
    normal: axis.toArray() as [number, number, number],
    radius: cyl.r,
    closed: true,
    angle: Math.PI * 2,
    key: t.key,
    ...(lo <= hi ? { span: [lo, hi] as [number, number] } : {}),
  };
}

/**
 * Snapped point under the pointer (CSS px `sx`, `sy`).
 * `hit`: ray hit on the faces (null: pointer over empty space); only the elements of the hit target
 * and not hidden by material (within `slack`) are kept.
 */
export function snapAt(
  targets: SnapTarget[],
  camera: THREE.Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
  ray: THREE.Ray,
  hit: { key: string | null; point: THREE.Vector3 } | null,
  slack: number,
): SnapPoint | null {
  const toScreen = (p: THREE.Vector3) => {
    const v = p.clone().project(camera);
    return new THREE.Vector2(((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height);
  };
  const mouse = new THREE.Vector2(sx, sy);
  const depthOf = (p: THREE.Vector3) => p.clone().sub(ray.origin).dot(ray.direction);
  const maxDepth = hit ? depthOf(hit.point) + slack : Infinity;
  const visible = (p: THREE.Vector3) => depthOf(p) <= maxDepth;

  let best: { p: THREE.Vector3; kind: SnapKind; key: string | null; d: number } | null = null;
  let edge: { p: THREE.Vector3; key: string | null; d: number } | null = null;
  const consider = (p: THREE.Vector3, kind: SnapKind, key: string | null, tol: number) => {
    const d = toScreen(p).distanceTo(mouse);
    if (d <= tol && (!best || d < best.d) && visible(p)) best = { p, kind, key, d };
  };

  for (const t of targets) {
    if (hit && t.key !== hit.key) continue;
    const m = t.payload;
    for (let e = 0; e < m.edgeGroups.length / 3; e++) {
      const pts = edgePolyline(m, e, t.matrix);
      if (pts.length < 2) continue;
      const center = circleCenter(pts);
      if (center) consider(center, "center", t.key, CENTER_PX);
      // Endpoints, except for a full circle (its start point is not a useful vertex).
      if (!center || pts[0]!.distanceTo(pts[pts.length - 1]!) > 1e-9) {
        consider(pts[0]!, "vertex", t.key, VERTEX_PX);
        consider(pts[pts.length - 1]!, "vertex", t.key, VERTEX_PX);
      }
      const mid = polylineMidpoint(pts);
      if (mid) consider(mid, "midpoint", t.key, MIDPOINT_PX);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = toScreen(pts[i]!);
        const b = toScreen(pts[i + 1]!);
        const ab = b.clone().sub(a);
        const len2 = ab.lengthSq();
        const u = len2 > 0 ? THREE.MathUtils.clamp(mouse.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
        const d = a.clone().addScaledVector(ab, u).distanceTo(mouse);
        if (d > EDGE_PX || (edge && d >= edge.d)) continue;
        // Interpolation in space (orthographic view: linear).
        const p = pts[i]!.clone().lerp(pts[i + 1]!, u);
        if (visible(p)) edge = { p, key: t.key, d };
      }
    }
  }
  const b = best as { p: THREE.Vector3; kind: SnapKind; key: string | null } | null;
  if (b) return { point: b.p.toArray() as [number, number, number], kind: b.kind, key: b.key };
  const e = edge as { p: THREE.Vector3; key: string | null } | null;
  if (e) return { point: e.p.toArray() as [number, number, number], kind: "edge", key: e.key };
  if (hit) return { point: hit.point.toArray() as [number, number, number], kind: "face", key: hit.key };
  return null;
}
