import { bsplineKnots, type SkBSpline } from "@solidus-cad/sdk";
import { solveLinear } from "./lm.ts";

/**
 * B-splines of the sketch: evaluation, sampling, projection, split, interpolation through points.
 * The computations run on a "flat" form: homogeneous poles (x·w, y·w, w) and the knot sequence expanded by
 * multiplicities. A periodic spline is unrolled into an open one over one or more periods.
 */

interface P2 {
  x: number;
  y: number;
}

type H = [number, number, number];

export interface FlatSpline {
  poles: H[];
  /** Knot sequence: poles.length + degree + 1 values. */
  flat: number[];
  degree: number;
}

/** Flat form of a sketch spline; a periodic spline is unrolled over `periods` periods. */
export function flatten(g: SkBSpline, pts: Map<string, P2>, periods = 1): FlatSpline {
  const p = g.degree;
  const poles = g.poles.map((id, i): H => {
    const q = pts.get(id);
    if (!q) throw new Error(`Pôle introuvable ${id}`);
    const w = g.weights?.[i] ?? 1;
    return [q.x * w, q.y * w, w];
  });
  const { knots, mults } = bsplineKnots(g);
  if (!g.periodic) return { poles, flat: knots.flatMap((k, i) => Array<number>(mults[i]!).fill(k)), degree: p };
  const n = poles.length;
  const period = knots[n]! - knots[0]!;
  const knotAt = (m: number) => knots[((m % n) + n) % n]! + period * Math.floor(m / n);
  return {
    poles: Array.from({ length: periods * n + p }, (_, j) => poles[j % n]!),
    flat: Array.from({ length: periods * n + 2 * p + 1 }, (_, j) => knotAt(j - p)),
    degree: p,
  };
}

/** Parameter range of a flat spline. */
export function domain(s: FlatSpline): [number, number] {
  return [s.flat[s.degree]!, s.flat[s.poles.length]!];
}

/** Index k of the knot span containing u: flat[k] <= u < flat[k + 1] (last non-empty span at the end of the range). */
function span(s: FlatSpline, u: number): number {
  const p = s.degree;
  const m = s.poles.length;
  if (u >= s.flat[m]!) {
    let k = m - 1;
    while (k > p && s.flat[k]! >= s.flat[k + 1]!) k--;
    return k;
  }
  let k = p;
  while (k < m - 1 && u >= s.flat[k + 1]!) k++;
  return k;
}

/** Point of the spline at parameter u (de Boor). */
export function evaluate(s: FlatSpline, u: number): P2 {
  const p = s.degree;
  const k = span(s, u);
  const d = s.poles.slice(k - p, k + 1).map((q): H => [...q]);
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = s.flat[i + p - r + 1]! - s.flat[i]!;
      const a = den === 0 ? 0 : (u - s.flat[i]!) / den;
      d[j] = [(1 - a) * d[j - 1]![0] + a * d[j]![0], (1 - a) * d[j - 1]![1] + a * d[j]![1], (1 - a) * d[j - 1]![2] + a * d[j]![2]];
    }
  }
  const [x, y, w] = d[p]!;
  return { x: x / w, y: y / w };
}

/** Parameters of a regular sampling: `perSpan` intervals per non-empty knot span, ends included. */
export function sampleParams(s: FlatSpline, perSpan = 16): number[] {
  const out: number[] = [];
  const [a, b] = domain(s);
  const knots = [...new Set(s.flat.filter((k) => k >= a && k <= b))].sort((x, y) => x - y);
  for (let i = 0; i + 1 < knots.length; i++) {
    for (let j = 0; j < perSpan; j++) out.push(knots[i]! + ((knots[i + 1]! - knots[i]!) * j) / perSpan);
  }
  out.push(b);
  return out;
}

/** Polyline of a sketch spline, in its natural direction (closed spline: last point = first point). */
export function sampleBSpline(g: SkBSpline, pts: Map<string, P2>, perSpan = 16): P2[] {
  const s = flatten(g, pts);
  return sampleParams(s, perSpan).map((u) => evaluate(s, u));
}

/** Closest point of the spline to `p`: parameter, point, distance. */
export function project(s: FlatSpline, p: P2): { t: number; point: P2; distance: number } {
  const dist = (u: number) => {
    const q = evaluate(s, u);
    return Math.hypot(q.x - p.x, q.y - p.y);
  };
  const params = sampleParams(s, 32);
  let best = 0;
  for (let i = 1; i < params.length; i++) if (dist(params[i]!) < dist(params[best]!)) best = i;
  // Golden-section search between the neighbouring samples.
  let lo = params[Math.max(best - 1, 0)]!;
  let hi = params[Math.min(best + 1, params.length - 1)]!;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 60; i++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (dist(a) < dist(b)) hi = b;
    else lo = a;
  }
  const t = (lo + hi) / 2;
  const point = evaluate(s, t);
  return { t, point, distance: Math.hypot(point.x - p.x, point.y - p.y) };
}

/** Inserts the knot u once (Boehm). */
function insertKnot(s: FlatSpline, u: number): FlatSpline {
  const p = s.degree;
  const k = span(s, u);
  const poles: H[] = [];
  for (let i = 0; i <= s.poles.length; i++) {
    if (i <= k - p) poles.push(s.poles[i]!);
    else if (i > k) poles.push(s.poles[i - 1]!);
    else {
      const a = (u - s.flat[i]!) / (s.flat[i + p]! - s.flat[i]!);
      const q0 = s.poles[i - 1]!;
      const q1 = s.poles[i]!;
      poles.push([(1 - a) * q0[0] + a * q1[0], (1 - a) * q0[1] + a * q1[1], (1 - a) * q0[2] + a * q1[2]]);
    }
  }
  const flat = [...s.flat.slice(0, k + 1), u, ...s.flat.slice(k + 1)];
  return { poles, flat, degree: p };
}

/** Splits the spline at the parameter u (inside its range) into two open splines. */
export function split(s: FlatSpline, u: number): [FlatSpline, FlatSpline] {
  const p = s.degree;
  let cur = s;
  const mult = () => cur.flat.filter((k) => Math.abs(k - u) < 1e-12).length;
  while (mult() < p) cur = insertKnot(cur, u);
  let r = -1;
  cur.flat.forEach((k, i) => {
    if (Math.abs(k - u) < 1e-12) r = i;
  });
  return [
    { poles: cur.poles.slice(0, r - p + 1), flat: [...cur.flat.slice(0, r + 1), u], degree: p },
    { poles: cur.poles.slice(r - p), flat: [u, ...cur.flat.slice(r - p + 1)], degree: p },
  ];
}

/** Part of the spline between the parameters a < b. */
export function segment(s: FlatSpline, a: number, b: number): FlatSpline {
  const [lo, hi] = domain(s);
  let out = s;
  if (b < hi - 1e-12) out = split(out, b)[0];
  if (a > lo + 1e-12) out = split(out, a)[1];
  return out;
}

/** Back from the flat form: poles, weights (absent if all equal to 1), knots and multiplicities. */
export function unflatten(s: FlatSpline): { poles: P2[]; weights?: number[]; knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (const k of s.flat) {
    if (knots.length && Math.abs(k - knots[knots.length - 1]!) < 1e-12) mults[mults.length - 1]!++;
    else {
      knots.push(k);
      mults.push(1);
    }
  }
  const poles = s.poles.map(([x, y, w]) => ({ x: x / w, y: y / w }));
  const rational = s.poles.some((q) => Math.abs(q[2] - 1) > 1e-12);
  return { poles, ...(rational ? { weights: s.poles.map((q) => q[2]) } : {}), knots, mults };
}

/** Values of the basis functions at u: the influence of each pole (flat form, unit weights). */
function basis(s: FlatSpline, u: number): number[] {
  return s.poles.map((_, j) => {
    const unit: FlatSpline = { ...s, poles: s.poles.map((_, i): H => [i === j ? 1 : 0, 0, 1]) };
    return evaluate(unit, u).x;
  });
}

/** Interpolation system of `n` points: unit-pole spline and the basis matrix at the interpolation parameters. */
function interpolationSystem(n: number, closed: boolean): { s: FlatSpline; A: number[][] } {
  const degree = Math.min(3, n - 1);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const unit = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
  const s = flatten({ id: "", type: "bspline", poles: ids, degree, periodic: closed }, unit);
  const params = closed
    ? // Even degree: middle of the spans (at the knots, the matrix of an even number of poles is singular).
      Array.from({ length: n }, (_, i) => s.flat[degree]! + i + (degree % 2 === 0 ? 0.5 : 0))
    : Array.from({ length: n }, (_, i) => s.flat.slice(i + 1, i + degree + 1).reduce((a, b) => a + b, 0) / degree);
  const A = params.map((u) => {
    const b = basis(s, u);
    const row = Array<number>(n).fill(0);
    b.forEach((v, j) => (row[j % n]! += v));
    return row;
  });
  return { s, A };
}

/**
 * Spline through the points `through` (as many poles as points), of degree 3 at most. Open: uniform clamped knots,
 * parameters at the Greville abscissae (always a solvable system). Closed: periodic spline.
 */
export function interpolate(through: P2[], closed = false): { poles: P2[]; degree: number; periodic: boolean } | null {
  const n = through.length;
  if (n < (closed ? 3 : 2)) return null;
  const { s, A } = interpolationSystem(n, closed);
  const xs = solveLinear(A.map((r) => [...r]), through.map((p) => p.x));
  const ys = solveLinear(A.map((r) => [...r]), through.map((p) => p.y));
  if (!xs || !ys) return null;
  return { poles: xs.map((x, i) => ({ x, y: ys[i]! })), degree: s.degree, periodic: closed };
}

type V3 = [number, number, number];

/** Open 3D spline through points, in the OCCT convention (poles, distinct knots, multiplicities). */
export interface Spline3 {
  poles: V3[];
  degree: number;
  knots: number[];
  mults: number[];
}

/** Open spline through 3D points (3D sketch spline): same scheme as `interpolate`, solved on each coordinate. */
export function interpolate3(through: V3[]): Spline3 | null {
  const n = through.length;
  if (n < 2) return null;
  const { s, A } = interpolationSystem(n, false);
  const cols = [0, 1, 2].map((k) => solveLinear(A.map((r) => [...r]), through.map((p) => p[k]!)));
  if (cols.some((c) => !c)) return null;
  const { knots, mults } = bsplineKnots({ id: "", type: "bspline", poles: through.map((_, i) => `p${i}`), degree: s.degree });
  return { poles: through.map((_, i): V3 => [cols[0]![i]!, cols[1]![i]!, cols[2]![i]!]), degree: s.degree, knots, mults };
}

/** Points along the 3D spline through `through` (`perSpan` per knot span), its ends included. */
export function sampleSpline3(through: V3[], perSpan = 16): V3[] {
  const sp = interpolate3(through);
  if (!sp) return through;
  const flat = sp.knots.flatMap((k, i) => Array<number>(sp.mults[i]!).fill(k));
  const xy: FlatSpline = { poles: sp.poles.map((p): H => [p[0], p[1], 1]), flat, degree: sp.degree };
  const z: FlatSpline = { ...xy, poles: sp.poles.map((p): H => [p[2], 0, 1]) };
  return sampleParams(xy, perSpan).map((u): V3 => {
    const a = evaluate(xy, u);
    return [a.x, a.y, evaluate(z, u).x];
  });
}
