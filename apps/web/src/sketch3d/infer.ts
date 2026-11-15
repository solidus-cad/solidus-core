import { AXIS_DIR, type Axis3, type Sk3Plane, type V3 } from "@solidus-cad/sdk";

/**
 * Aids for placing the points of the 3D sketch: snapping, axis inferences, alignments, work plane.
 * Pure functions (skeleton part frame), tested without the view.
 */

export type S2 = { x: number; y: number };

export const AXES: Axis3[] = ["X", "Y", "Z"];
export type BasePlane3 = "XY" | "XZ" | "YZ";
export const BASE_NORMAL: Record<BasePlane3, V3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => scale(a, 1 / (norm(a) || 1));

/** Point snap: tolerances in pixels. */
export const POINT_TOL = 9;
export const AXIS_TOL = 12;
export const ALIGN_TOL = 7;

export interface Ray {
  o: V3;
  d: V3;
}

/** Target point of the 3D sketch and constraints it implies. */
export interface Inference {
  p: V3;
  /** Existing point of the sketch (coincidence). */
  id?: string;
  /** Vertex, midpoint or centre of another part: the point will be fixed. */
  vertex?: boolean;
  /** Direction from the previous point (inferred or locked): axis constraint on the line. */
  axis?: Axis3;
  /** Plane of the targeted face or of the chosen work plane: "in the plane" constraint. */
  plane?: Sk3Plane;
  /** Displayed alignment guides (point aligned on an axis with another point). */
  align: { axis: Axis3; from: V3 }[];
  kind: "point" | "vertex" | "axis" | "lock" | "face" | "plane";
}

export interface InferContext {
  /** Part → screen frame (px). */
  toScreen: (p: V3) => S2;
  cursor: S2;
  ray: Ray;
  /** Points of the sketch. */
  points: { id: string; p: V3 }[];
  /** Notable points of the other parts. */
  vertices: V3[];
  /** Start point of the current segment. */
  from?: V3;
  fromId?: string;
  /** Direction imposed (X, Y or Z key). */
  lock?: Axis3 | null;
  /** Work plane; `fixed`: chosen by the user (constrains the points). */
  plane: Sk3Plane & { fixed?: boolean };
  /** Face of a part under the cursor: impact point, and plane if the face is planar. */
  face?: { point: V3; plane?: Sk3Plane } | null;
}

const d2 = (a: S2, b: S2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Point of the line (p, u) closest to the ray. */
export function closestOnLine(p: V3, u: V3, ray: Ray): V3 {
  const w = sub(p, ray.o);
  const a = dot(u, u);
  const b = dot(u, ray.d);
  const c = dot(ray.d, ray.d);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-12) return p; // line parallel to the ray (seen end-on)
  const t = (b * dot(ray.d, w) - c * dot(u, w)) / den;
  return add(p, scale(u, t));
}

export function intersectPlane(ray: Ray, plane: Sk3Plane): V3 | null {
  const den = dot(ray.d, plane.n);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(sub(plane.p, ray.o), plane.n) / den;
  return add(ray.o, scale(ray.d, t));
}

/** Principal plane most facing the camera (view direction in part frame). */
export function autoBase(viewDir: V3): BasePlane3 {
  const [x, y, z] = viewDir.map(Math.abs) as V3;
  return z >= x && z >= y ? "XY" : y >= x ? "XZ" : "YZ";
}

/** Screen distance from the cursor to the projected line (p, u). */
function screenDistToLine(ctx: InferContext, p: V3, u: V3): { q: V3; d: number } {
  const q = closestOnLine(p, u, ctx.ray);
  return { q, d: d2(ctx.toScreen(q), ctx.cursor) };
}

/** Adjusts `p`, movable along `u`, to the coordinate of an existing point (alignment), if the cursor is close to it. */
function alignAlong(ctx: InferContext, p: V3, axis: Axis3): { p: V3; align: { axis: Axis3; from: V3 }[] } {
  const i = AXES.indexOf(axis);
  let best: { p: V3; d: number; from: V3; axis: Axis3 } | null = null;
  for (const q of [...ctx.points.map((x) => x.p), ...ctx.vertices]) {
    const cand: V3 = [...p];
    cand[i] = q[i]!;
    const d = d2(ctx.toScreen(cand), ctx.toScreen(p));
    if (d < ALIGN_TOL && (!best || d < best.d) && norm(sub(cand, q)) > 1e-6) {
      // Guide: from q to the point, along the axis that best links them.
      const diff = sub(cand, q);
      const ax = AXES[[0, 1, 2].reduce((m, k) => (Math.abs(diff[k]!) > Math.abs(diff[m]!) ? k : m), 0)]!;
      best = { p: cand, d, from: q, axis: ax };
    }
  }
  return best ? { p: best.p, align: [{ axis: best.axis, from: best.from }] } : { p, align: [] };
}

/** Nearest snap among the sketch points, then the vertices of the other parts. */
function nearestPoint(ctx: InferContext): { id?: string; p: V3; vertex?: boolean } | null {
  let best: { id?: string; p: V3; vertex?: boolean; d: number } | null = null;
  for (const q of ctx.points) {
    if (q.id === ctx.fromId) continue;
    const d = d2(ctx.toScreen(q.p), ctx.cursor);
    if (d < POINT_TOL && (!best || d < best.d)) best = { id: q.id, p: q.p, d };
  }
  if (best) return best;
  for (const v of ctx.vertices) {
    const d = d2(ctx.toScreen(v), ctx.cursor);
    if (d < POINT_TOL && (!best || d < best.d)) best = { p: v, vertex: true, d };
  }
  return best;
}

export function infer(ctx: InferContext): Inference | null {
  const near = nearestPoint(ctx);

  // Locked direction: the point slides along the axis; a targeted point gives its coordinate along the axis.
  if (ctx.from && ctx.lock) {
    const u = AXIS_DIR[ctx.lock];
    if (near) {
      const p = add(ctx.from, scale(u, dot(sub(near.p, ctx.from), u)));
      return { p, axis: ctx.lock, align: [{ axis: ctx.lock, from: near.p }], kind: "lock" };
    }
    const { q } = screenDistToLine(ctx, ctx.from, u);
    const r = alignAlong(ctx, q, ctx.lock);
    return { p: r.p, axis: ctx.lock, align: r.align, kind: "lock" };
  }

  if (near?.id) return { p: near.p, id: near.id, align: [], kind: "point" };
  if (near?.vertex) return { p: near.p, vertex: true, align: [], kind: "vertex" };

  // Axis inference from the previous point.
  if (ctx.from) {
    let best: { axis: Axis3; q: V3; d: number } | null = null;
    for (const axis of AXES) {
      const u = AXIS_DIR[axis];
      // Axis seen end-on: unusable (the whole segment projects onto a point).
      const tip = ctx.toScreen(add(ctx.from, u));
      const base = ctx.toScreen(ctx.from);
      if (d2(tip, base) < 1e-3) continue;
      const { q, d } = screenDistToLine(ctx, ctx.from, u);
      if (d < AXIS_TOL && (!best || d < best.d)) best = { axis, q, d };
    }
    if (best) {
      const r = alignAlong(ctx, best.q, best.axis);
      return { p: r.p, axis: best.axis, align: r.align, kind: "axis" };
    }
  }

  if (ctx.face) {
    return { p: ctx.face.point, plane: ctx.face.plane, align: [], kind: "face" };
  }

  const hit = intersectPlane(ctx.ray, ctx.plane);
  if (!hit) return null;
  // Alignments: adjusts each coordinate of the plane (principal axes of the plane) to that of a nearby existing point.
  let p = hit;
  const align: { axis: Axis3; from: V3 }[] = [];
  for (const i of [0, 1, 2]) {
    if (Math.abs(ctx.plane.n[i]!) > 1e-6) continue;
    let best: { v: number; d: number; from: V3 } | null = null;
    for (const q of [...ctx.points.map((x) => x.p), ...ctx.vertices]) {
      const cand: V3 = [...p];
      cand[i] = q[i]!;
      const d = d2(ctx.toScreen(cand), ctx.toScreen(p));
      if (d < ALIGN_TOL && (!best || d < best.d)) best = { v: q[i]!, d, from: q };
    }
    if (best) {
      const cand: V3 = [...p];
      cand[i] = best.v;
      p = cand;
      const diff = sub(p, best.from);
      const k = [0, 1, 2].filter((j) => j !== i).reduce((m, j) => (Math.abs(diff[j]!) > Math.abs(diff[m]!) ? j : m), i === 0 ? 1 : 0);
      align.push({ axis: AXES[k]!, from: best.from });
    }
  }
  return { p, plane: ctx.plane.fixed ? { p: ctx.plane.p, n: ctx.plane.n } : undefined, align, kind: "plane" };
}

/** Plane through three points (null if they are aligned). */
export function planeFrom3(a: V3, b: V3, c: V3): Sk3Plane | null {
  const n = cross(sub(b, a), sub(c, a));
  const l = norm(n);
  return l < 1e-9 ? null : { p: a, n: scale(n, 1 / l) };
}

/**
 * Keyboard input during drawing:
 *  - "120": length in the current direction;
 *  - "x;y;z": absolute point; "@dx;dy;dz": displacement from the previous point.
 * The separator may be ";" or a space (the comma stays the decimal separator, as in French).
 */
export type TypedInput = { kind: "length"; value: number } | { kind: "absolute"; p: V3 } | { kind: "relative"; d: V3 };

export function parseTyped(text: string): TypedInput | null {
  const s = text.trim().replace(/,/g, ".");
  if (!s) return null;
  const rel = s.startsWith("@");
  const body = rel ? s.slice(1) : s;
  const parts = body.split(/[;\s]+/).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (!rel && nums.length === 1) return { kind: "length", value: nums[0]! };
  if (nums.length !== 3) return null;
  const v = nums as V3;
  return rel ? { kind: "relative", d: v } : { kind: "absolute", p: v };
}

/**
 * Notable points of a part mesh (part frame): edge endpoints and midpoints,
 * centres of the circular edges. `edges`: segments (two points each); `edgeGroups`: triplets [start, count, id] in points.
 */
export function meshSnapPoints(edges: Float32Array, edgeGroups: Int32Array): V3[] {
  const out: V3[] = [];
  const seen = new Set<string>();
  const push = (p: V3) => {
    const k = p.map((v) => Math.round(v * 1000)).join(",");
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  const at = (i: number): V3 => [edges[i * 3]!, edges[i * 3 + 1]!, edges[i * 3 + 2]!];
  for (let g = 0; g + 2 < edgeGroups.length; g += 3) {
    const start = edgeGroups[g]!;
    const count = edgeGroups[g + 1]!;
    if (count < 2) continue;
    // Edge polyline: first point of each segment, then the last point.
    const poly: V3[] = [];
    for (let i = start; i < start + count; i += 2) poly.push(at(i));
    poly.push(at(start + count - 1));
    const a = poly[0]!;
    const b = poly[poly.length - 1]!;
    const closed = norm(sub(a, b)) < 1e-6;
    if (!closed) {
      push(a);
      push(b);
    }
    // Midpoint by length.
    const lens = poly.slice(1).map((p, i) => norm(sub(p, poly[i]!)));
    const total = lens.reduce((s, l) => s + l, 0);
    if (total < 1e-9) continue;
    if (!closed) {
      let acc = 0;
      for (let i = 0; i < lens.length; i++) {
        if (acc + lens[i]! >= total / 2) {
          const t = (total / 2 - acc) / (lens[i]! || 1);
          push(add(poly[i]!, scale(sub(poly[i + 1]!, poly[i]!), t)));
          break;
        }
        acc += lens[i]!;
      }
    }
    // Arc or circle: centre of the circle through three points, if all points are equidistant from it.
    if (poly.length >= 4) {
      const c = circumcenter(poly[0]!, poly[Math.floor(poly.length / 3)]!, poly[Math.floor((2 * poly.length) / 3)]!);
      if (c) {
        const r = norm(sub(poly[0]!, c));
        if (r > 1e-6 && poly.every((p) => Math.abs(norm(sub(p, c)) - r) < r * 1e-3 + 1e-6)) push(c);
      }
    }
  }
  return out;
}

function circumcenter(a: V3, b: V3, c: V3): V3 | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-12) return null;
  const t = add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab)));
  return add(a, scale(t, 1 / (2 * n2)));
}
