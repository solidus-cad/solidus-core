import type { MateRefKind, MateTopo, MeshPayload } from "@solidus-cad/sdk";
import { edgeGeom, edgePoints, faceGeom } from "./mate-pick.ts";
import { cylinderOfFace, faceRef, nameOf } from "./refpick.ts";

/**
 * Re-attachment of a constraint reference (plane, axis, point in local coordinates) to the mesh of another part:
 * replacing an occurrence with another size of the family or with another part, or a modified part.
 * With the cad-core kernel, the element is found by its topological name (core/NAMING.md): exact, whatever
 * the dimensions. Otherwise (kernel without naming, part unrelated to the previous one), by its geometry: same kind,
 * same direction, closest to the previous one, with comparable size (area, radius, length).
 */

type V3 = [number, number, number];

export interface RemapRef {
  kind: MateRefKind;
  p: V3;
  d: V3;
  topo?: MateTopo;
}

interface Candidate extends RemapRef {
  /** Size of the element: area of a planar face, radius of a cylinder, length of an edge (0 for a vertex). */
  size: number;
  element: "face" | "edge" | "vertex";
  topo?: MateTopo;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

const candidatesCache = new WeakMap<MeshPayload, Candidate[]>();

/** Constraint elements of a mesh: planar and cylindrical faces, straight and circular edges, vertices. */
function candidates(m: MeshPayload): Candidate[] {
  const hit = candidatesCache.get(m);
  if (hit) return hit;
  const out: Candidate[] = [];
  for (let f = 0; f < m.faceGroups.length / 3; f++) {
    const g = faceGeom(m, f);
    if (!g) continue;
    const size = g.kind === "axis" ? (cylinderOfFace(m, f)?.r ?? 0) : faceRef(m, f).size;
    const name = nameOf(m, "face", f);
    out.push({ kind: g.kind, p: [...g.p], d: [...g.d], size, element: "face", topo: name ? { element: "face", name } : undefined });
  }
  for (let e = 0; e < m.edgeGroups.length / 3; e++) {
    const pts = edgePoints(m, e);
    if (pts.length < 2) continue;
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += pts[i]!.distanceTo(pts[i - 1]!);
    const g = edgeGeom(m, e);
    const name = nameOf(m, "edge", e);
    if (g) out.push({ kind: g.kind, p: [...g.p], d: [...g.d], size: l, element: "edge", topo: name ? { element: "edge", name } : undefined });
    const closed = pts[0]!.distanceTo(pts[pts.length - 1]!) <= 1e-9;
    if (!closed) {
      for (const [q, end] of [[pts[0]!, "start"], [pts[pts.length - 1]!, "end"]] as const) {
        out.push({ kind: "point", p: [q.x, q.y, q.z], d: [0, 0, 1], size: 0, element: "vertex", topo: name ? { element: "vertex", name, end } : undefined });
      }
    }
  }
  candidatesCache.set(m, out);
  return out;
}

/** Diagonal of the mesh bounding box (tolerance scale). */
function diagonal(m: MeshPayload): number {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = m.positions[i + k]!;
      if (v < lo[k]!) lo[k] = v;
      if (v > hi[k]!) hi[k] = v;
    }
  }
  return Number.isFinite(lo[0]) ? len(sub(hi, lo)) : 1;
}

/** Compatible direction (plane: same outward normal; axis: same line, in either direction); returns the sign to apply. */
function aligned(ref: RemapRef, c: Candidate): 1 | -1 | 0 {
  if (ref.kind === "point") return 1;
  const k = dot(ref.d, c.d) / (len(ref.d) * len(c.d) || 1);
  if (k > 0.999) return 1;
  if (ref.kind === "axis" && k < -0.999) return -1;
  return 0;
}

/** Position gap between the reference and an element of the same kind and direction. */
function distance(ref: RemapRef, c: Candidate): number {
  const v = sub(c.p, ref.p);
  if (ref.kind === "plane") {
    // Offset along the normal; for equal offsets (coplanar faces), the closest in the plane.
    const off = Math.abs(dot(v, ref.d));
    return off + 0.01 * len(sub(v, ref.d.map((x) => x * dot(v, ref.d)) as V3));
  }
  if (ref.kind === "axis") {
    const dl = len(ref.d) || 1;
    return len(cross(v, ref.d)) / dl + 0.01 * Math.abs(dot(v, ref.d)) / dl;
  }
  return len(v);
}

/** Element of the old mesh that coincides with the reference (size, kind and original name), or null. */
function originOf(ref: RemapRef, m: MeshPayload): Candidate | null {
  let best: Candidate | null = null;
  let bestD = 1e-3 * diagonal(m);
  for (const c of candidates(m)) {
    if (c.kind !== ref.kind || !aligned(ref, c)) continue;
    const d = distance(ref, c);
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

const sameTopo = (a: MateTopo, b: MateTopo | undefined) => !!b && a.element === b.element && a.name === b.name && (a.end ?? "") === (b.end ?? "");

/** Feature (id) that created a named element: "f0/top", "e(f0/front|f0/top)" → "f0". */
function featureOf(name: string): string | null {
  return /^(?:[ev]\()?([^/()|#]+)\//.exec(name)?.[1] ?? null;
}

/** True if the mesh contains elements created by this feature. */
function hasFeature(m: MeshPayload, feature: string): boolean {
  const prefix = `${feature}/`;
  const has = (list: string[] | undefined) => !!list?.some((n) => n.startsWith(prefix) || n.includes(`(${prefix}`) || n.includes(`|${prefix}`));
  return has(m.names?.faces) || has(m.names?.edges);
}

/** Result: geometry of the found element, original direction kept for an axis, updated name. */
function result(ref: RemapRef, c: Candidate): RemapRef {
  const sign = ref.kind === "axis" && dot(ref.d, c.d) < 0 ? -1 : 1;
  const d = ref.kind === "point" ? ref.d : (c.d.map((x) => x * sign) as V3);
  return { kind: ref.kind, p: [...c.p], d: [...d], ...(c.topo ? { topo: { ...c.topo } } : {}) };
}

/**
 * Named element of a reference in a mesh: found (up-to-date geometry), null if it has disappeared,
 * undefined if the name is not conclusive (no name, kernel without naming, other part).
 */
export function resolveNamed(ref: RemapRef, m: MeshPayload): RemapRef | null | undefined {
  const topo = ref.topo;
  if (!topo || !m.names) return undefined;
  const hit = candidates(m).find((c) => c.kind === ref.kind && sameTopo(topo, c.topo));
  if (hit) return result(ref, hit);
  const feature = featureOf(topo.name);
  return feature && hasFeature(m, feature) ? null : undefined;
}

/**
 * Element of the new mesh matching `ref` (taken from `oldMesh`), or null if there is none.
 * The original direction is kept (axis direction unchanged).
 */
export function remapMateRef(ref: RemapRef, oldMesh: MeshPayload | null, newMesh: MeshPayload): RemapRef | null {
  const origin = oldMesh ? originOf(ref, oldMesh) : null;
  // By name: that of the reference, otherwise that of the original element (constraints created without naming).
  const topo = ref.topo ?? origin?.topo;
  // The original feature exists in the new part but no longer the element (e.g. a configuration without this hole):
  // null, without geometric fallback, which would wrongly attach a neighboring element.
  const named = topo ? resolveNamed({ ...ref, topo }, newMesh) : undefined;
  if (named !== undefined) return named;
  // By geometry: same kind, same direction, closest, with comparable size.
  const diag = diagonal(newMesh);
  const size = origin?.size ?? null;
  const element = origin?.element ?? null;
  let best: { c: Candidate; score: number } | null = null;
  for (const c of candidates(newMesh)) {
    if (c.kind !== ref.kind || (element && c.element !== element) || !aligned(ref, c)) continue;
    const rel = size !== null && (size > 0 || c.size > 0) ? Math.abs(c.size - size) / Math.max(size, c.size) : 0;
    const score = distance(ref, c) + 0.2 * diag * rel;
    if (!best || score < best.score) best = { c, score };
  }
  if (!best || best.score > 0.5 * diag) return null;
  return result(ref, best.c);
}
