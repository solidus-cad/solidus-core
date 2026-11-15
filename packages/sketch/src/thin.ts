import type { OrientedCurve, Pt } from "./profiles.ts";

/**
 * Outline of a thin wall: an open chain (lines and arcs) thickened on one side, the other, or both.
 * Used by the kernel for thin extrusion; 2D computation in the sketch frame.
 */

/** Element traversed from `a` to `b`; an arc turns counterclockwise if `ccw`. */
export type ThinPrim = { type: "line"; a: Pt; b: Pt } | { type: "arc"; c: Pt; r: number; a: Pt; b: Pt; ccw: boolean };

const EPS = 1e-9;

const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, y: p.y - q.y });
const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
const cross = (u: Pt, v: Pt) => u.x * v.y - u.y * v.x;

/** Elements of the chain in traversal order. */
export function chainPrims(chain: OrientedCurve[], pts: Map<string, Pt>): ThinPrim[] {
  return chain.map(({ curve: c, reversed }) => {
    if (c.type === "line") {
      const [a, b] = reversed ? [c.p2, c.p1] : [c.p1, c.p2];
      return { type: "line", a: pts.get(a)!, b: pts.get(b)! };
    }
    if (c.type === "circle") throw new Error("Un cercle ne fait pas partie d'une chaîne ouverte");
    if (c.type === "bspline") throw new Error("Une spline ne peut pas former une paroi mince");
    const center = pts.get(c.c)!;
    const s = pts.get(c.start)!;
    const e = pts.get(c.end)!;
    const r = dist(s, center);
    return reversed ? { type: "arc", c: center, r, a: e, b: s, ccw: false } : { type: "arc", c: center, r, a: s, b: e, ccw: true };
  });
}

/** Offsets an element by `d` to the left of the traversal direction; null if the arc vanishes. */
function offsetPrim(p: ThinPrim, d: number): ThinPrim | null {
  if (p.type === "line") {
    const l = dist(p.a, p.b);
    const n = { x: (-(p.b.y - p.a.y) / l) * d, y: ((p.b.x - p.a.x) / l) * d };
    return { type: "line", a: { x: p.a.x + n.x, y: p.a.y + n.y }, b: { x: p.b.x + n.x, y: p.b.y + n.y } };
  }
  // Left of a counterclockwise arc: toward the center.
  const r = p.ccw ? p.r - d : p.r + d;
  if (r <= EPS) return null;
  const k = r / p.r;
  const scale = (q: Pt): Pt => ({ x: p.c.x + (q.x - p.c.x) * k, y: p.c.y + (q.y - p.c.y) * k });
  return { ...p, r, a: scale(p.a), b: scale(p.b) };
}

/** Intersections of the extended supports (infinite line, full circle). */
function supportIntersections(p: ThinPrim, q: ThinPrim): Pt[] {
  if (p.type === "line" && q.type === "line") {
    const u = sub(p.b, p.a);
    const v = sub(q.b, q.a);
    const den = cross(u, v);
    if (Math.abs(den) < EPS * Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)) return [];
    const t = cross(sub(q.a, p.a), v) / den;
    return [{ x: p.a.x + t * u.x, y: p.a.y + t * u.y }];
  }
  if (p.type === "arc" && q.type === "arc") {
    const d = dist(p.c, q.c);
    if (d < EPS || d > p.r + q.r + EPS || d < Math.abs(p.r - q.r) - EPS) return [];
    const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, p.r * p.r - a * a));
    const m = { x: p.c.x + ((q.c.x - p.c.x) * a) / d, y: p.c.y + ((q.c.y - p.c.y) * a) / d };
    const o = { x: (-(q.c.y - p.c.y) * h) / d, y: ((q.c.x - p.c.x) * h) / d };
    return [
      { x: m.x + o.x, y: m.y + o.y },
      { x: m.x - o.x, y: m.y - o.y },
    ];
  }
  const [line, arc] = (p.type === "line" ? [p, q] : [q, p]) as [Extract<ThinPrim, { type: "line" }>, Extract<ThinPrim, { type: "arc" }>];
  const u = sub(line.b, line.a);
  const f = sub(line.a, arc.c);
  const A = u.x * u.x + u.y * u.y;
  const B = 2 * (f.x * u.x + f.y * u.y);
  const C = f.x * f.x + f.y * f.y - arc.r * arc.r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].map((t) => ({ x: line.a.x + t * u.x, y: line.a.y + t * u.y }));
}

/** Rounded join arc around the vertex `v`, from `from` to `to` (the shorter one). */
function roundJoin(v: Pt, from: Pt, to: Pt): ThinPrim {
  return { type: "arc", c: v, r: dist(v, from), a: from, b: to, ccw: cross(sub(from, v), sub(to, v)) > 0 };
}

/**
 * Chain offset by `d` to the left of the traversal direction. Sharp corners are extended up to the
 * intersection (rounded join if the supports do not intersect). Null if the thickness is too large.
 */
export function offsetChain(prims: ThinPrim[], d: number): ThinPrim[] | null {
  if (d === 0) return prims.map((p) => ({ ...p }));
  const shifted: ThinPrim[] = [];
  for (const p of prims) {
    const o = offsetPrim(p, d);
    if (!o) return null;
    shifted.push(o);
  }
  const out: ThinPrim[] = [shifted[0]!];
  const tol = 1e-7 * Math.max(1, Math.abs(d));
  for (let i = 1; i < shifted.length; i++) {
    const prev = out[out.length - 1]!;
    const next = shifted[i]!;
    if (dist(prev.b, next.a) < tol) {
      next.a = prev.b;
    } else {
      const v = prims[i]!.a;
      const candidates = supportIntersections(prev, next).filter((x) => dist(x, v) < 4 * Math.abs(d) + tol);
      candidates.sort((x, y) => dist(x, v) - dist(y, v));
      const x = candidates[0];
      if (x) {
        prev.b = x;
        next.a = x;
      } else {
        out.push(roundJoin(v, prev.b, next.a));
      }
    }
    out.push(next);
  }
  // A segment shortened beyond its length reverses: thickness too large.
  for (let i = 0; i < shifted.length; i++) {
    const p = shifted[i]!;
    const o = prims[i]!;
    if (p.type !== "line") continue;
    if (dist(p.a, p.b) < tol || (p.b.x - p.a.x) * (o.b.x - o.a.x) + (p.b.y - p.a.y) * (o.b.y - o.a.y) <= 0) return null;
  }
  return out;
}

function reversedPrim(p: ThinPrim): ThinPrim {
  return p.type === "line" ? { type: "line", a: p.b, b: p.a } : { ...p, a: p.b, b: p.a, ccw: !p.ccw };
}

/**
 * Closed outline of the wall: edge offset by `d1`, join, edge offset by `d2` traversed in reverse, join.
 * Null if an offset fails (thickness too large relative to the radii or the lengths).
 */
export function thinOutline(prims: ThinPrim[], d1: number, d2: number): ThinPrim[] | null {
  const a = offsetChain(prims, d1);
  const b = offsetChain(prims, d2);
  if (!a || !b) return null;
  return [
    ...a,
    { type: "line", a: a[a.length - 1]!.b, b: b[b.length - 1]!.b },
    ...[...b].reverse().map(reversedPrim),
    { type: "line", a: b[0]!.a, b: a[0]!.a },
  ];
}
