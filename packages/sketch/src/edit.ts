import { curveEnds, SKETCH_ORIGIN, type SkArc, type SkBSpline, type SkCircle, type SkConstraint, type SkCurve, type SketchData, type SkGeometry, type SkLine } from "@solidus-cad/sdk";
import { domain, evaluate, flatten, project, sampleBSpline, sampleParams, segment, unflatten, type FlatSpline } from "./bspline.ts";
import { pointMap, type Pt } from "./profiles.ts";

/**
 * Pure sketch editing tools (testable): trim, sketch fillet, offset.
 * Each tool returns a new sketch, or null if the operation is impossible.
 */

type NewId = () => string;

const TAU = 2 * Math.PI;
const EPS = 1e-9;

function clone(s: SketchData): SketchData {
  return JSON.parse(JSON.stringify(s)) as SketchData;
}

const norm = (a: number) => ((a % TAU) + TAU) % TAU;

/** Parameter of a point on a curve: t ∈ [0, 1] for a line; angle (rad) for a circle or an arc. */
function lineParam(a: Pt, b: Pt, p: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1);
}

/** Is the point `p` of the circle of `g` on the arc `g` (always true for a circle)? */
function onRound(g: SkCircle | SkArc, p: Pt, pts: Map<string, Pt>): boolean {
  if (g.type === "circle") return true;
  const c = pts.get(g.c)!;
  const s = pts.get(g.start)!;
  const e = pts.get(g.end)!;
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const span = norm(Math.atan2(e.y - c.y, e.x - c.x) - a0) || TAU;
  return norm(Math.atan2(p.y - c.y, p.x - c.x) - a0) <= span + 1e-9;
}

function circleOf(g: SkCircle | SkArc, pts: Map<string, Pt>): { c: Pt; r: number } {
  const c = pts.get(g.c)!;
  if (g.type === "circle") return { c, r: g.r };
  const s = pts.get(g.start)!;
  return { c, r: Math.hypot(s.x - c.x, s.y - c.y) };
}

/** Crossing of the segments ab and cd, ends included, or null. */
function segmentCrossing(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < EPS) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/**
 * Intersections of a spline with another curve. With a line, a circle or an arc: changes of sign of the distance along
 * the sampled spline, refined by bisection. With another spline: crossings of the two polylines.
 */
function splineIntersections(sp: SkBSpline, other: SkCurve, pts: Map<string, Pt>): Pt[] {
  const s = flatten(sp, pts);
  const ts = sampleParams(s, 32);
  const out: Pt[] = [];
  const push = (p: Pt) => {
    if (!out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-7)) out.push(p);
  };
  if (other.type === "bspline") {
    const a = ts.map((u) => evaluate(s, u));
    const b = sampleBSpline(other, pts, 32);
    for (let i = 0; i + 1 < a.length; i++)
      for (let j = 0; j + 1 < b.length; j++) {
        const p = segmentCrossing(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
        if (p) push(p);
      }
    return out;
  }
  let f: (q: Pt) => number;
  let inside: (q: Pt) => boolean;
  if (other.type === "line") {
    const a = pts.get(other.p1)!;
    const b = pts.get(other.p2)!;
    f = (q) => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
    inside = (q) => {
      const t = lineParam(a, b, q);
      return t >= -1e-9 && t <= 1 + 1e-9;
    };
  } else {
    const { c, r } = circleOf(other, pts);
    f = (q) => Math.hypot(q.x - c.x, q.y - c.y) - r;
    inside = (q) => onRound(other, q, pts);
  }
  const values = ts.map((u) => f(evaluate(s, u)));
  for (let i = 0; i + 1 < ts.length; i++) {
    const fa = values[i]!;
    const fb = values[i + 1]!;
    if (fa === 0) {
      const p = evaluate(s, ts[i]!);
      if (inside(p)) push(p);
      continue;
    }
    if (fa * fb > 0 || (fb === 0 && i + 2 < ts.length)) continue;
    let lo = ts[i]!;
    let hi = ts[i + 1]!;
    let flo = fa;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      const fm = f(evaluate(s, mid));
      if (fm * flo > 0) [lo, flo] = [mid, fm];
      else hi = mid;
    }
    const p = evaluate(s, (lo + hi) / 2);
    if (inside(p)) push(p);
  }
  return out;
}

/** Intersection points between two curves, extensions excluded (segments, arcs and splines as drawn). */
export function intersect(c1: SkGeometry, c2: SkGeometry, pts: Map<string, Pt>): Pt[] {
  if (c1.type === "point" || c2.type === "point") return [];
  if (c1.type === "bspline") return splineIntersections(c1, c2, pts);
  if (c2.type === "bspline") return splineIntersections(c2, c1, pts);
  if (c1.type === "line" && c2.type === "line") {
    const a = pts.get(c1.p1)!;
    const b = pts.get(c1.p2)!;
    const c = pts.get(c2.p1)!;
    const d = pts.get(c2.p2)!;
    const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    if (Math.abs(den) < EPS) return [];
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return [];
    return [{ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }];
  }
  if (c1.type !== "line" && c2.type === "line") return intersect(c2, c1, pts);
  const circ = (g: SkCircle | SkArc) => circleOf(g, pts);
  if (c1.type === "line") {
    const r2 = c2 as SkCircle | SkArc;
    const { c, r } = circ(r2);
    const a = pts.get(c1.p1)!;
    const b = pts.get(c1.p2)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const fx = a.x - c.x;
    const fy = a.y - c.y;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (disc < 0 || A < EPS) return [];
    const sq = Math.sqrt(disc);
    return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]
      .filter((t, i, arr) => t >= -EPS && t <= 1 + EPS && (i === 0 || Math.abs(t - arr[0]!) > 1e-12))
      .map((t) => ({ x: a.x + t * dx, y: a.y + t * dy }))
      .filter((p) => onRound(r2, p, pts));
  }
  // Circle / arc against circle / arc.
  const g1 = c1 as SkCircle | SkArc;
  const g2 = c2 as SkCircle | SkArc;
  const k1 = circ(g1);
  const k2 = circ(g2);
  const d = Math.hypot(k2.c.x - k1.c.x, k2.c.y - k1.c.y);
  if (d < EPS || d > k1.r + k2.r + EPS || d < Math.abs(k1.r - k2.r) - EPS) return [];
  const a = (k1.r * k1.r - k2.r * k2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(k1.r * k1.r - a * a, 0));
  const mx = k1.c.x + (a * (k2.c.x - k1.c.x)) / d;
  const my = k1.c.y + (a * (k2.c.y - k1.c.y)) / d;
  const ox = (h * (k2.c.y - k1.c.y)) / d;
  const oy = (h * (k2.c.x - k1.c.x)) / d;
  const res = h < 1e-12 ? [{ x: mx, y: my }] : [
    { x: mx + ox, y: my - oy },
    { x: mx - ox, y: my + oy },
  ];
  return res.filter((p) => onRound(g1, p, pts) && onRound(g2, p, pts));
}

function referenced(s: SketchData, id: string): boolean {
  return (
    s.geometry.some(
      (g) =>
        (g.type === "line" && (g.p1 === id || g.p2 === id)) ||
        ((g.type === "circle" || g.type === "arc") && g.c === id) ||
        (g.type === "arc" && (g.start === id || g.end === id)) ||
        (g.type === "bspline" && g.poles.includes(id)),
    ) ||
    s.constraints.some((c) => Object.values(c).includes(id)) ||
    s.dimensions.some((d) => d.a === id || d.b === id)
  );
}

/** Removes a curve, its constraints and dimensions, and the points left orphaned. */
function removeCurve(s: SketchData, id: string): void {
  const g = s.geometry.find((x) => x.id === id);
  s.geometry = s.geometry.filter((x) => x.id !== id);
  s.constraints = s.constraints.filter((c) => !Object.values(c).includes(id));
  s.dimensions = s.dimensions.filter((d) => d.a !== id && d.b !== id);
  const ends = g?.type === "line" ? [g.p1, g.p2] : g?.type === "arc" ? [g.start, g.end, g.c] : g?.type === "circle" ? [g.c] : g?.type === "bspline" ? g.poles : [];
  for (const p of ends) if (p !== SKETCH_ORIGIN && !referenced(s, p)) s.geometry = s.geometry.filter((x) => x.id !== p);
}

/**
 * Trim: removes the portion of the curve `curveId` around `at`, between the neighboring intersections.
 * Without an intersection, the whole curve is removed.
 */
export function trimSketch(sketch: SketchData, curveId: string, at: Pt, newId: NewId): SketchData | null {
  const s = trimRaw(sketch, curveId, at, newId);
  if (!s) return null;
  dropEndpointOnCurve(s);
  // Free endpoints that coincide (within computation precision) are welded.
  return closeGaps(s, coincidenceTol(pointMap(s.geometry))) ?? s;
}

function trimRaw(sketch: SketchData, curveId: string, at: Pt, newId: NewId): SketchData | null {
  const s = clone(sketch);
  const pts = pointMap(s.geometry);
  const curve = s.geometry.find((g) => g.id === curveId);
  if (!curve || curve.type === "point") return null;
  const others = s.geometry.filter((g) => g.id !== curveId && g.type !== "point" && !g.construction);
  const hits: { p: Pt; with: string }[] = others.flatMap((o) => intersect(curve, o, pts).map((p) => ({ p, with: o.id })));
  const tol = coincidenceTol(pts);
  const newPoint = (p: Pt, onCurve: string): string => {
    // An endpoint already exists here (the other curve was trimmed here): it is reused,
    // otherwise the two pieces would overlap without touching and the contour would stay open.
    const existing = endpointAt(s, p, tol, curveId);
    if (existing) return existing;
    const id = newId();
    s.geometry.push({ id, type: "point", x: p.x, y: p.y });
    s.constraints.push({ id: newId(), type: "pointOnCurve", point: id, curve: onCurve });
    return id;
  };

  if (curve.type === "line") {
    const a = pts.get(curve.p1)!;
    const b = pts.get(curve.p2)!;
    const tc = lineParam(a, b, at);
    // Intersections at the endpoints cut nothing.
    const ts = hits.map((h) => ({ ...h, t: lineParam(a, b, h.p) })).filter((h) => h.t > 1e-6 && h.t < 1 - 1e-6);
    const before = ts.filter((h) => h.t < tc).sort((x, y) => y.t - x.t)[0];
    const after = ts.filter((h) => h.t > tc).sort((x, y) => x.t - y.t)[0];
    if (!before && !after) {
      removeCurve(s, curveId);
      return s;
    }
    const line = s.geometry.find((g) => g.id === curveId) as SkLine;
    // The length changes: the length dimensions of the line no longer apply.
    s.dimensions = s.dimensions.filter((d) => !(d.a === curveId && !d.b));
    if (before && after) {
      const pa = newPoint(before.p, before.with);
      const pb = newPoint(after.p, after.with);
      const oldP2 = line.p2;
      line.p2 = pa;
      const nid = newId();
      s.geometry.push({ id: nid, type: "line", p1: pb, p2: oldP2, construction: line.construction });
      // Both pieces keep the orientation of the original line.
      for (const c of [...s.constraints]) {
        if ((c.type === "horizontal" || c.type === "vertical") && c.a === curveId) s.constraints.push({ id: newId(), type: c.type, a: nid });
      }
      if (!s.constraints.some((c) => (c.type === "horizontal" || c.type === "vertical") && c.a === curveId)) {
        s.constraints.push({ id: newId(), type: "parallel", a: curveId, b: nid } as SkConstraint);
      }
    } else if (after) {
      const old = line.p1;
      line.p1 = newPoint(after.p, after.with);
      if (old !== SKETCH_ORIGIN && !referenced(s, old)) s.geometry = s.geometry.filter((x) => x.id !== old);
    } else if (before) {
      const old = line.p2;
      line.p2 = newPoint(before.p, before.with);
      if (old !== SKETCH_ORIGIN && !referenced(s, old)) s.geometry = s.geometry.filter((x) => x.id !== old);
    }
    return s;
  }

  if (curve.type === "bspline") return trimSpline(s, curve, hits, at, newPoint);

  // Circle or arc: angular parameter.
  const c = pts.get(curve.c)!;
  const ang = (p: Pt) => Math.atan2(p.y - c.y, p.x - c.x);
  const start = curve.type === "arc" ? ang(pts.get(curve.start)!) : ang(at);
  const rel = (p: Pt) => norm(ang(p) - start);
  const span = curve.type === "arc" ? norm(ang(pts.get(curve.end)!) - start) || TAU : TAU;
  const tc = rel(at);
  const ts = hits.map((h) => ({ ...h, t: rel(h.p) })).filter((h) => h.t > 1e-6 && h.t < span - 1e-6);
  if (curve.type === "circle") {
    if (ts.length < 2) {
      removeCurve(s, curveId);
      return s;
    }
    // Keep the arc opposite the click: from the intersection following the click to the one preceding it.
    const sorted = [...ts].sort((x, y) => x.t - y.t);
    const after = sorted[0]!; // first point after the click (the click is at t = 0)
    const before = sorted[sorted.length - 1]!;
    const arcId = newId();
    const ps = newPoint(after.p, after.with);
    const pe = newPoint(before.p, before.with);
    s.geometry = s.geometry.map((g) => (g.id === curveId ? ({ id: arcId, type: "arc", c: curve.c, start: ps, end: pe, construction: curve.construction } as SkArc) : g));
    s.constraints = s.constraints.map((k) => JSON.parse(JSON.stringify(k).split(`"${curveId}"`).join(`"${arcId}"`)) as SkConstraint);
    s.dimensions = s.dimensions.map((d) => ({ ...d, a: d.a === curveId ? arcId : d.a, b: d.b === curveId ? arcId : d.b, type: d.a === curveId && d.type === "diameter" ? "radius" : d.type, value: d.a === curveId && d.type === "diameter" ? `(${d.value}) / 2` : d.value }));
    return s;
  }
  const arc = curve;
  const before = ts.filter((h) => h.t < tc).sort((x, y) => y.t - x.t)[0];
  const after = ts.filter((h) => h.t > tc).sort((x, y) => x.t - y.t)[0];
  if (!before && !after) {
    removeCurve(s, curveId);
    return s;
  }
  const a = s.geometry.find((g) => g.id === curveId) as SkArc;
  if (before && after) {
    const pa = newPoint(before.p, before.with);
    const pb = newPoint(after.p, after.with);
    const oldEnd = a.end;
    a.end = pa;
    s.geometry.push({ id: newId(), type: "arc", c: arc.c, start: pb, end: oldEnd, construction: arc.construction });
  } else if (after) {
    a.start = newPoint(after.p, after.with);
  } else if (before) {
    a.end = newPoint(before.p, before.with);
  }
  return s;
}

/** Identifier of the second piece of a split curve: "<id>.1", or the next free one. */
function pieceId(s: SketchData, id: string): string {
  for (let k = 1; ; k++) if (!s.geometry.some((g) => g.id === `${id}.${k}`)) return `${id}.${k}`;
}

/**
 * Trim of a spline: exact split at the intersections around `at` (knot insertion). The first piece keeps the identifier
 * of the spline, the second one is "<id>.1". A closed spline keeps the part opposite the click, as an open spline.
 */
function trimSpline(s: SketchData, curve: SkBSpline, hits: { p: Pt; with: string }[], at: Pt, newPoint: (p: Pt, onCurve: string) => string): SketchData {
  const pts = pointMap(s.geometry);
  const once = flatten(curve, pts);
  const [lo, hi] = domain(once);
  const period = hi - lo;
  const tol = 1e-9 * Math.max(period, 1);
  const tc = project(once, at).t;
  const ts = hits.map((h) => ({ ...h, t: project(once, h.p).t }));
  const oldPoles = curve.poles;
  const spline = s.geometry.find((g) => g.id === curve.id) as SkBSpline;
  // Places a piece: its end poles are given, its inner poles become new points.
  const place = (piece: FlatSpline, first: string, last: string) => {
    const u = unflatten(piece);
    const inner = u.poles.slice(1, -1).map((p, i) => {
      const id = `${curve.id}.p${i}`;
      let free = id;
      for (let k = 1; s.geometry.some((g) => g.id === free); k++) free = `${id}.${k}`;
      s.geometry.push({ id: free, type: "point", x: p.x, y: p.y, construction: true });
      return free;
    });
    return { poles: [first, ...inner, last], degree: piece.degree, knots: u.knots, mults: u.mults, ...(u.weights ? { weights: u.weights } : {}) };
  };
  const reset = (g: SkBSpline, data: ReturnType<typeof place>) => {
    delete g.weights;
    delete g.periodic;
    Object.assign(g, data);
  };

  if (!curve.periodic) {
    const inner = ts.filter((h) => h.t > lo + tol && h.t < hi - tol);
    const before = inner.filter((h) => h.t < tc).sort((x, y) => y.t - x.t)[0];
    const after = inner.filter((h) => h.t > tc).sort((x, y) => x.t - y.t)[0];
    if (!before && !after) {
      removeCurve(s, curve.id);
      return s;
    }
    const first = oldPoles[0]!;
    const last = oldPoles[oldPoles.length - 1]!;
    if (before && after) {
      const left = place(segment(once, lo, before.t), first, newPoint(before.p, before.with));
      const right = place(segment(once, after.t, hi), newPoint(after.p, after.with), last);
      reset(spline, left);
      s.geometry.push({ id: pieceId(s, curve.id), type: "bspline", ...right, ...(curve.construction ? { construction: true } : {}) });
    } else if (after) reset(spline, place(segment(once, after.t, hi), newPoint(after.p, after.with), last));
    else if (before) reset(spline, place(segment(once, lo, before.t), first, newPoint(before.p, before.with)));
  } else {
    if (ts.length < 2) {
      removeCurve(s, curve.id);
      return s;
    }
    // Kept part: from the first intersection after the click to the last one, going round once.
    const rel = (t: number) => (((t - tc) % period) + period) % period;
    const sorted = [...ts].sort((x, y) => rel(x.t) - rel(y.t));
    const after = sorted[0]!;
    const before = sorted[sorted.length - 1]!;
    const twice = flatten(curve, pts, 2);
    const piece = segment(twice, tc + rel(after.t), tc + rel(before.t));
    reset(spline, place(piece, newPoint(after.p, after.with), newPoint(before.p, before.with)));
  }
  for (const p of oldPoles) if (p !== SKETCH_ORIGIN && !referenced(s, p)) s.geometry = s.geometry.filter((x) => x.id !== p);
  return s;
}

/**
 * Sketch fillet: rounds the corner formed by two lines sharing the point `pointId`.
 * The fillet is an arc tangent to both lines, dimensioned by its radius.
 */
export function filletCorner(sketch: SketchData, pointId: string, radius: number, newId: NewId): SketchData | null {
  if (radius <= 0) return null;
  const s = clone(sketch);
  const pts = pointMap(s.geometry);
  const lines = s.geometry.filter((g): g is SkLine => g.type === "line" && !g.construction && (g.p1 === pointId || g.p2 === pointId));
  if (lines.length !== 2) return null;
  const P = pts.get(pointId)!;
  const other = (l: SkLine) => pts.get(l.p1 === pointId ? l.p2 : l.p1)!;
  const unit = (q: Pt) => {
    const l = Math.hypot(q.x - P.x, q.y - P.y);
    return { x: (q.x - P.x) / l, y: (q.y - P.y) / l, l };
  };
  const u1 = unit(other(lines[0]!));
  const u2 = unit(other(lines[1]!));
  const cos = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(cos);
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return null;
  const d = radius / Math.tan(theta / 2);
  if (d >= u1.l - 1e-9 || d >= u2.l - 1e-9) return null; // radius too large for the lines
  const T1 = { x: P.x + u1.x * d, y: P.y + u1.y * d };
  const T2 = { x: P.x + u2.x * d, y: P.y + u2.y * d };
  const bis = { x: u1.x + u2.x, y: u1.y + u2.y };
  const bl = Math.hypot(bis.x, bis.y);
  const dc = radius / Math.sin(theta / 2);
  const C = { x: P.x + (bis.x / bl) * dc, y: P.y + (bis.y / bl) * dc };
  const t1 = newId();
  const t2 = newId();
  const cId = newId();
  s.geometry.push({ id: t1, type: "point", x: T1.x, y: T1.y }, { id: t2, type: "point", x: T2.x, y: T2.y }, { id: cId, type: "point", x: C.x, y: C.y });
  for (const [l, t] of [
    [lines[0]!, t1],
    [lines[1]!, t2],
  ] as const) {
    const g = s.geometry.find((x) => x.id === l.id) as SkLine;
    if (g.p1 === pointId) g.p1 = t;
    else g.p2 = t;
  }
  // Counterclockwise from T1 to T2 around the center.
  const cross = (T1.x - C.x) * (T2.y - C.y) - (T1.y - C.y) * (T2.x - C.x);
  const arcId = newId();
  s.geometry.push({ id: arcId, type: "arc", c: cId, start: cross > 0 ? t1 : t2, end: cross > 0 ? t2 : t1 });
  s.constraints.push({ id: newId(), type: "tangent", a: lines[0]!.id, b: arcId }, { id: newId(), type: "tangent", a: lines[1]!.id, b: arcId });
  s.dimensions.push({ id: newId(), type: "radius", a: arcId, value: String(Math.round(radius * 1000) / 1000), driving: true });
  // The vertex is removed if it is no longer used (its constraints and dimensions with it).
  if (pointId !== SKETCH_ORIGIN) {
    s.constraints = s.constraints.filter((c) => !Object.values(c).includes(pointId));
    s.dimensions = s.dimensions.filter((dm) => dm.a !== pointId && dm.b !== pointId);
    if (!referenced(s, pointId)) s.geometry = s.geometry.filter((x) => x.id !== pointId);
  }
  return s;
}

/**
 * Offset: offset copy of curves. A closed loop of lines is offset with joins at the intersections;
 * circles and arcs are offset in radius. `distance` > 0: outward (left of the traversal direction).
 */
export function offsetCurves(sketch: SketchData, curveIds: string[], distance: number, newId: NewId): SketchData | null {
  if (distance === 0 || curveIds.length === 0) return null;
  const s = clone(sketch);
  const pts = pointMap(s.geometry);
  const curves = s.geometry.filter((g) => curveIds.includes(g.id) && g.type !== "point");
  const lines = curves.filter((g): g is SkLine => g.type === "line");
  // Splines are not offset.
  const round = curves.filter((g): g is SkCircle | SkArc => g.type === "circle" || g.type === "arc");
  const addPoint = (p: Pt) => {
    const id = newId();
    s.geometry.push({ id, type: "point", x: p.x, y: p.y });
    return id;
  };

  for (const g of round) {
    const c = pts.get(g.c)!;
    if (g.type === "circle") {
      if (g.r + distance <= 0) return null;
      s.geometry.push({ id: newId(), type: "circle", c: g.c, r: g.r + distance });
      continue;
    }
    const st = pts.get(g.start)!;
    const en = pts.get(g.end)!;
    const r = Math.hypot(st.x - c.x, st.y - c.y);
    const k = (r + distance) / r;
    if (k <= 0) return null;
    const ps = addPoint({ x: c.x + (st.x - c.x) * k, y: c.y + (st.y - c.y) * k });
    const pe = addPoint({ x: c.x + (en.x - c.x) * k, y: c.y + (en.y - c.y) * k });
    const id = newId();
    s.geometry.push({ id, type: "arc", c: g.c, start: ps, end: pe });
    s.constraints.push({ id: newId(), type: "concentric", a: g.id, b: id });
  }

  if (lines.length > 0) {
    // Chain the lines through their shared points.
    const ordered: { l: SkLine; a: string; b: string }[] = [];
    const remaining = [...lines];
    let cur = remaining.shift()!;
    ordered.push({ l: cur, a: cur.p1, b: cur.p2 });
    while (remaining.length) {
      const last = ordered[ordered.length - 1]!.b;
      const i = remaining.findIndex((l) => l.p1 === last || l.p2 === last);
      if (i < 0) break;
      cur = remaining.splice(i, 1)[0]!;
      ordered.push(cur.p1 === last ? { l: cur, a: cur.p1, b: cur.p2 } : { l: cur, a: cur.p2, b: cur.p1 });
    }
    const closed = ordered.length > 2 && ordered[ordered.length - 1]!.b === ordered[0]!.a;
    // Traversal direction: positive = counterclockwise; "outside" = to the right for a counterclockwise loop.
    let area = 0;
    for (const o of ordered) {
      const p = pts.get(o.a)!;
      const q = pts.get(o.b)!;
      area += p.x * q.y - q.x * p.y;
    }
    const side = closed && area > 0 ? -1 : 1;
    const shifted = ordered.map((o) => {
      const p = pts.get(o.a)!;
      const q = pts.get(o.b)!;
      const l = Math.hypot(q.x - p.x, q.y - p.y);
      const nx = (-(q.y - p.y) / l) * distance * side;
      const ny = ((q.x - p.x) / l) * distance * side;
      return { p: { x: p.x + nx, y: p.y + ny }, q: { x: q.x + nx, y: q.y + ny } };
    });
    const meet = (i: number, j: number): Pt => {
      const A = shifted[i]!;
      const B = shifted[j]!;
      const den = (A.q.x - A.p.x) * (B.q.y - B.p.y) - (A.q.y - A.p.y) * (B.q.x - B.p.x);
      if (Math.abs(den) < EPS) return A.q;
      const t = ((B.p.x - A.p.x) * (B.q.y - B.p.y) - (B.p.y - A.p.y) * (B.q.x - B.p.x)) / den;
      return { x: A.p.x + t * (A.q.x - A.p.x), y: A.p.y + t * (A.q.y - A.p.y) };
    };
    const n = shifted.length;
    const corners: string[] = [];
    for (let i = 0; i < n; i++) {
      if (closed) corners.push(addPoint(meet((i - 1 + n) % n, i)));
      else corners.push(addPoint(i === 0 ? shifted[0]!.p : meet(i - 1, i)));
    }
    if (!closed) corners.push(addPoint(shifted[n - 1]!.q));
    for (let i = 0; i < n; i++) {
      const id = newId();
      s.geometry.push({ id, type: "line", p1: corners[i]!, p2: corners[closed ? (i + 1) % n : i + 1]! });
      s.constraints.push({ id: newId(), type: "parallel", a: ordered[i]!.l.id, b: id });
    }
  }
  return s;
}

// --- Gaps between endpoints, closing contours --------------------------------------------------------

/** Coincidence tolerance (computation precision), relative to the extent of the sketch. */
function coincidenceTol(pts: Map<string, Pt>): number {
  let size = 1;
  for (const p of pts.values()) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  return size * 1e-7;
}

/** Endpoints (start/end points) of the non-construction lines, arcs and open splines, with the curves ending there. */
function endpointGraph(geometry: SkGeometry[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const g of geometry) {
    const ends = g.type === "point" || g.construction ? null : curveEnds(g);
    if (!ends) continue;
    for (const p of ends) m.set(p, [...(m.get(p) ?? []), g.id]);
  }
  return m;
}

/** Existing endpoint within `tol` of `p` (excluding the endpoints of the curve `exclude`). */
function endpointAt(s: SketchData, p: Pt, tol: number, exclude: string): string | null {
  const pts = pointMap(s.geometry);
  let best: string | null = null;
  let bestD = tol;
  for (const [id, curves] of endpointGraph(s.geometry)) {
    if (curves.length === 1 && curves[0] === exclude) continue;
    const q = pts.get(id)!;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) [best, bestD] = [id, d];
  }
  return best;
}

/** A "point on curve" constraint becomes useless when the point is an endpoint of the curve. */
function dropEndpointOnCurve(s: SketchData): void {
  const isEnd = (point: string, curve: string) => {
    const g = s.geometry.find((x) => x.id === curve);
    return !!g && g.type !== "point" && !!curveEnds(g)?.includes(point);
  };
  s.constraints = s.constraints.filter((c) => !(c.type === "pointOnCurve" && isEnd(c.point, c.curve)));
}

/** Gap between a free endpoint and another nearby endpoint that does not touch it. */
export interface Gap {
  a: string;
  b: string;
  distance: number;
  mid: Pt;
}

/**
 * Free endpoints (a single curve) within `tol` of another endpoint without touching it:
 * these are the points to weld to close a contour. Each point belongs to at most one gap.
 */
export function findGaps(geometry: SkGeometry[], tol: number): Gap[] {
  const pts = pointMap(geometry);
  const graph = endpointGraph(geometry);
  const ids = [...graph.keys()];
  const candidates: Gap[] = [];
  for (const [a, ca] of graph) {
    if (ca.length !== 1) continue;
    const pa = pts.get(a)!;
    for (const b of ids) {
      if (b === a) continue;
      const cb = graph.get(b)!;
      // Two free endpoints: each pair only once.
      if (cb.length === 1 && b < a) continue;
      // The two ends of the same curve are not welded (the curve would disappear).
      if (cb.length === 1 && cb[0] === ca[0]) continue;
      const pb = pts.get(b)!;
      const distance = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if (distance <= tol) candidates.push({ a, b, distance, mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } });
    }
  }
  candidates.sort((x, y) => x.distance - y.distance);
  const used = new Set<string>();
  const gaps: Gap[] = [];
  for (const g of candidates) {
    if (used.has(g.a) || used.has(g.b)) continue;
    used.add(g.a);
    used.add(g.b);
    gaps.push(g);
  }
  return gaps;
}

/**
 * Welds the point `drop` onto the point `keep`: all references are transferred, `keep` is placed at the midpoint
 * (except the origin, which does not move; `closeGaps` also leaves an existing junction in place), and the constraints or dimensions that became degenerate are removed.
 */
export function mergePoints(sketch: SketchData, keep: string, drop: string): SketchData {
  const s = clone(sketch);
  mergeInto(s, keep, drop, true);
  return s;
}

function mergeInto(s: SketchData, keep: string, drop: string, midpoint: boolean): void {
  if (drop === SKETCH_ORIGIN) [keep, drop] = [drop, keep];
  if (keep === drop) return;
  const pts = pointMap(s.geometry);
  const pk = pts.get(keep);
  const pd = pts.get(drop);
  const kp = s.geometry.find((g) => g.id === keep);
  if (midpoint && kp?.type === "point" && pk && pd) {
    kp.x = (pk.x + pd.x) / 2;
    kp.y = (pk.y + pd.y) / 2;
  }
  const sub = (id: string) => (id === drop ? keep : id);
  s.geometry = s.geometry
    .filter((g) => g.id !== drop)
    .map((g) => {
      if (g.type === "line") return { ...g, p1: sub(g.p1), p2: sub(g.p2) };
      if (g.type === "arc") return { ...g, c: sub(g.c), start: sub(g.start), end: sub(g.end) };
      if (g.type === "circle") return { ...g, c: sub(g.c) };
      if (g.type === "bspline") return { ...g, poles: g.poles.map(sub) };
      return g;
    });
  s.constraints = s.constraints.map((c) => JSON.parse(JSON.stringify(c).split(`"${drop}"`).join(`"${keep}"`)) as SkConstraint);
  // Duplicates (e.g. two "fix" on the same point) and constraints that became trivial.
  const seen = new Set<string>();
  s.constraints = s.constraints.filter((c) => {
    const { id: _, ...rest } = c;
    const key = JSON.stringify(rest);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  dropEndpointOnCurve(s);
  s.dimensions = s.dimensions.map((d) => ({ ...d, a: sub(d.a), b: d.b === undefined ? undefined : sub(d.b) })).filter((d) => d.a !== d.b);
  for (const d of s.dimensions) if (d.b === undefined) delete d.b;
}

/** Welds all the endpoints separated by less than `tol`. Returns null if there was nothing to close. */
export function closeGaps(sketch: SketchData, tol: number): SketchData | null {
  const gaps = findGaps(sketch.geometry, tol);
  if (gaps.length === 0) return null;
  const s = clone(sketch);
  const graph = endpointGraph(sketch.geometry);
  // `a` is always free; if `b` is a junction, it is the one that stays in place.
  for (const g of gaps) mergeInto(s, g.b, g.a, graph.get(g.b)!.length === 1);
  return s;
}

/** Free endpoints (a single line, arc or spline): ends of open contours. */
export function freeEndpoints(geometry: SkGeometry[]): string[] {
  return [...endpointGraph(geometry)].filter(([, c]) => c.length === 1).map(([p]) => p);
}
