import * as THREE from "three";
import type { DatumRef, DatumRole } from "@solidus-cad/sdk";
import { faceOfTriangle, mateRefOf, planarFace } from "./refpick.ts";
import { snapAt, type SnapTarget } from "./snap.ts";

/**
 * Picking of the construction elements of a reference plane (single part or assembly occurrences):
 * planar face, axis (straight edge, circle, cylindrical face), point (vertex, center, point on an edge or face)
 * or cylindrical face. Coordinates are expressed in the coordinate system of the picked part (`component` = occurrence key
 * in an assembly), like the references of assembly constraints.
 */

const EDGE_PX = 8;

type T3 = [number, number, number];
const arr = (v: THREE.Vector3): T3 => [v.x, v.y, v.z];

export interface DatumPickInput {
  targets: SnapTarget[];
  camera: THREE.Camera;
  width: number;
  height: number;
  sx: number;
  sy: number;
  ray: THREE.Ray;
  /** Hit on faces: target, point (world) and triangle of the target's mesh. */
  hit: { key: string | null; point: THREE.Vector3; triangle: number } | null;
  slack: number;
}

function withComponent<R extends DatumRef>(ref: R, key: string | null): R {
  return key ? { ...ref, component: key } : ref;
}

/** Edge closest to the pointer (px), on the hit target: points of its polyline in local coordinates. */
function edgeUnder(inp: DatumPickInput): { key: string | null; pts: THREE.Vector3[] } | null {
  const mouse = new THREE.Vector2(inp.sx, inp.sy);
  const toScreen = (p: THREE.Vector3) => {
    const v = p.clone().project(inp.camera);
    return new THREE.Vector2(((v.x + 1) / 2) * inp.width, ((1 - v.y) / 2) * inp.height);
  };
  const depthOf = (p: THREE.Vector3) => p.clone().sub(inp.ray.origin).dot(inp.ray.direction);
  const maxDepth = inp.hit ? depthOf(inp.hit.point) + inp.slack : Infinity;
  let best: { key: string | null; pts: THREE.Vector3[]; d: number } | null = null;
  for (const t of inp.targets) {
    if (inp.hit && t.key !== inp.hit.key) continue;
    const m = t.payload;
    for (let e = 0; e < m.edgeGroups.length / 3; e++) {
      const start = m.edgeGroups[e * 3]!;
      const count = m.edgeGroups[e * 3 + 1]!;
      if (count < 2) continue;
      const local: THREE.Vector3[] = [];
      for (let k = start; k < start + count; k += 2) local.push(new THREE.Vector3(m.edges[k * 3]!, m.edges[k * 3 + 1]!, m.edges[k * 3 + 2]!));
      const l = start + count - 1;
      local.push(new THREE.Vector3(m.edges[l * 3]!, m.edges[l * 3 + 1]!, m.edges[l * 3 + 2]!));
      const world = local.map((p) => p.clone().applyMatrix4(t.matrix));
      for (let i = 0; i + 1 < world.length; i++) {
        const a = toScreen(world[i]!);
        const b = toScreen(world[i + 1]!);
        const ab = b.clone().sub(a);
        const u = ab.lengthSq() > 0 ? THREE.MathUtils.clamp(mouse.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1) : 0;
        const d = a.clone().addScaledVector(ab, u).distanceTo(mouse);
        if (d > EDGE_PX || (best && d >= best.d)) continue;
        if (depthOf(world[i]!.clone().lerp(world[i + 1]!, u)) > maxDepth) continue;
        best = { key: t.key, pts: local, d };
      }
    }
  }
  return best;
}

/** Axis of an edge polyline: line (endpoints) or circle (center, normal). */
function edgeAxis(pts: THREE.Vector3[]): { p: THREE.Vector3; d: THREE.Vector3 } | null {
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const ab = b.clone().sub(a);
  if (ab.length() > 1e-9) {
    const u = ab.clone().normalize();
    const straight = pts.every((p) => p.clone().sub(a).cross(u).length() < Math.max(ab.length() * 1e-4, 1e-6));
    if (straight) return { p: a.clone().lerp(b, 0.5), d: u };
  }
  // Closed edge or arc: plane of the points, center of the circumscribed circle.
  if (pts.length < 3) return null;
  const p0 = pts[0]!;
  const p1 = pts[Math.floor(pts.length / 3)]!;
  const p2 = pts[Math.floor((2 * pts.length) / 3)]!;
  const v1 = p1.clone().sub(p0);
  const v2 = p2.clone().sub(p0);
  const n = v1.clone().cross(v2);
  const den = 2 * n.lengthSq();
  if (den < 1e-12) return null;
  const c = p0.clone().add(n.clone().cross(v1).multiplyScalar(v2.lengthSq()).add(v2.clone().cross(n).multiplyScalar(v1.lengthSq())).divideScalar(den));
  const r = c.distanceTo(p0);
  if (pts.some((p) => Math.abs(p.distanceTo(c) - r) > Math.max(r * 0.01, 1e-4))) return null;
  return { p: c, d: n.normalize() };
}

/** Element picked under the pointer for the requested role, or null. */
export function pickDatumRef(role: DatumRole, inp: DatumPickInput): DatumRef | null {
  const target = inp.hit ? inp.targets.find((t) => t.key === inp.hit!.key) : undefined;
  const local = target ? inp.hit!.point.clone().applyMatrix4(target.matrix.clone().invert()) : null;
  const face = target ? faceOfTriangle(target.payload, inp.hit!.triangle) : -1;

  if (role === "point") {
    const s = snapAt(inp.targets, inp.camera, inp.width, inp.height, inp.sx, inp.sy, inp.ray, inp.hit, inp.slack);
    if (!s) return null;
    const t = inp.targets.find((x) => x.key === s.key);
    const p = new THREE.Vector3(...s.point);
    if (t) p.applyMatrix4(t.matrix.clone().invert());
    return withComponent({ kind: "point", p: arr(p) }, s.key);
  }

  if (role === "axis") {
    const e = edgeUnder(inp);
    const ax = e ? edgeAxis(e.pts) : null;
    if (e && ax) return withComponent({ kind: "axis", p: arr(ax.p), d: arr(ax.d) }, e.key);
  }

  if (!target || !local || face < 0) return null;

  if (role === "plane") {
    const pl = planarFace(target.payload, face);
    return pl ? withComponent({ kind: "plane", p: pl.p, n: pl.n }, target.key) : null;
  }

  // Cylindrical face: axis, radius (distance from the picked point to the axis) and picked point.
  const m = mateRefOf(target.payload, face);
  if (!m || m.kind !== "axis") return null;
  const c = new THREE.Vector3(...m.p);
  const d = new THREE.Vector3(...m.d).normalize();
  const rel = local.clone().sub(c);
  const r = rel.sub(d.clone().multiplyScalar(rel.dot(d))).length();
  if (role === "axis") return withComponent({ kind: "axis", p: m.p, d: m.d }, target.key);
  return withComponent({ kind: "cylinder", p: m.p, d: m.d, r, at: arr(local) }, target.key);
}
