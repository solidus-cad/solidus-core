import { curveEnds, SKETCH_ORIGIN, type SkCurve, type SkGeometry } from "@solidus-cad/sdk";
import { sampleBSpline } from "./bspline.ts";

/**
 * Detection of the profiles of a sketch: closed loops, regions (outer contour + holes) and open chains.
 * Used by the kernel (face construction) and by the editor (profile display, diagnostics).
 */

export interface Pt {
  x: number;
  y: number;
}

/** Curve traversed in a given direction. */
export interface OrientedCurve {
  curve: SkCurve;
  reversed: boolean;
}

export interface Loop {
  curves: OrientedCurve[];
  /** Approximating polygon (traversal direction of the loop). */
  polygon: Pt[];
  /** Signed area: positive if counterclockwise. */
  area: number;
}

export interface Region {
  outer: Loop;
  holes: Loop[];
}

export interface ProfileAnalysis {
  loops: Loop[];
  regions: Region[];
  /** Open chains (possible sweep paths), in traversal order. */
  chains: OrientedCurve[][];
  /** Points where more than two curves meet: ambiguous profile. */
  branchPoints: string[];
  /** True if curves of different loops cross. */
  selfIntersecting: boolean;
}

export function pointMap(geometry: SkGeometry[]): Map<string, Pt> {
  const m = new Map<string, Pt>([
    [SKETCH_ORIGIN, { x: 0, y: 0 }],
    [`${SKETCH_ORIGIN}:H`, { x: 1, y: 0 }],
    [`${SKETCH_ORIGIN}:V`, { x: 0, y: 1 }],
  ]);
  for (const g of geometry) if (g.type === "point") m.set(g.id, { x: g.x, y: g.y });
  return m;
}

const ends = curveEnds;

/** Samples a curve in its natural direction (line: p1→p2; arc: counterclockwise; spline: from its first pole). */
export function sampleCurve(c: SkCurve, pts: Map<string, Pt>, segmentsPerTurn = 64): Pt[] {
  if (c.type === "line") return [pts.get(c.p1)!, pts.get(c.p2)!];
  if (c.type === "bspline") return sampleBSpline(c, pts, Math.max(4, Math.round(segmentsPerTurn / 4)));
  const center = pts.get(c.c)!;
  if (c.type === "circle") {
    return Array.from({ length: segmentsPerTurn + 1 }, (_, i) => {
      const a = (i / segmentsPerTurn) * 2 * Math.PI;
      return { x: center.x + c.r * Math.cos(a), y: center.y + c.r * Math.sin(a) };
    });
  }
  const s = pts.get(c.start)!;
  const e = pts.get(c.end)!;
  const r = Math.hypot(s.x - center.x, s.y - center.y);
  const a0 = Math.atan2(s.y - center.y, s.x - center.x);
  let a1 = Math.atan2(e.y - center.y, e.x - center.x);
  if (a1 <= a0) a1 += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(((a1 - a0) / (2 * Math.PI)) * segmentsPerTurn));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
  });
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function buildPolygon(curves: OrientedCurve[], pts: Map<string, Pt>): Pt[] {
  const poly: Pt[] = [];
  for (const oc of curves) {
    const s = sampleCurve(oc.curve, pts);
    if (oc.reversed) s.reverse();
    poly.push(...s.slice(0, -1));
  }
  return poly;
}

export function analyzeProfiles(geometry: SkGeometry[]): ProfileAnalysis {
  const pts = pointMap(geometry);
  const curves = geometry.filter((g): g is SkCurve => g.type !== "point" && !g.construction);
  const loops: Loop[] = [];
  const chains: OrientedCurve[][] = [];

  // Circles and periodic splines are loops on their own.
  for (const c of curves) {
    if (ends(c)) continue;
    const polygon = sampleCurve(c, pts).slice(0, -1);
    loops.push({ curves: [{ curve: c, reversed: false }], polygon, area: signedArea(polygon) });
  }

  // Endpoint graph (lines and arcs).
  const incident = new Map<string, SkCurve[]>();
  const edges = curves.filter((c) => ends(c));
  for (const c of edges) {
    for (const p of ends(c)!) incident.set(p, [...(incident.get(p) ?? []), c]);
  }
  const branchPoints = [...incident].filter(([, l]) => l.length > 2).map(([p]) => p);

  const used = new Set<string>();
  const walk = (start: SkCurve, from: string): { seq: OrientedCurve[]; closed: boolean; last: string } => {
    const seq: OrientedCurve[] = [];
    let cur: SkCurve | undefined = start;
    let at = from;
    while (cur && !used.has(cur.id)) {
      used.add(cur.id);
      const [a, b] = ends(cur)!;
      const reversed = at !== a;
      seq.push({ curve: cur, reversed });
      at = reversed ? a : b;
      const next: SkCurve[] = (incident.get(at) ?? []).filter((c) => !used.has(c.id));
      cur = next.length === 1 && (incident.get(at)?.length ?? 0) === 2 ? next[0] : undefined;
    }
    return { seq, closed: at === from && seq.length > 0, last: at };
  };

  // Open chains first: they start from a free endpoint (degree 1).
  for (const [p, list] of incident) {
    if (list.length !== 1 || used.has(list[0]!.id)) continue;
    chains.push(walk(list[0]!, p).seq);
  }
  // Then the closed loops.
  for (const c of edges) {
    if (used.has(c.id)) continue;
    const [a] = ends(c)!;
    const { seq, closed } = walk(c, a);
    if (!closed) {
      chains.push(seq);
      continue;
    }
    const polygon = buildPolygon(seq, pts);
    loops.push({ curves: seq, polygon, area: signedArea(polygon) });
  }

  // Intersections between loops (diagnostic).
  let selfIntersecting = false;
  outer: for (let i = 0; i < loops.length; i++) {
    for (let j = i; j < loops.length; j++) {
      const A = loops[i]!.polygon;
      const B = loops[j]!.polygon;
      for (let k = 0; k < A.length; k++) {
        for (let m = 0; m < B.length; m++) {
          if (i === j && Math.abs(k - m) <= 1) continue;
          if (i === j && ((k === 0 && m === B.length - 1) || (m === 0 && k === A.length - 1))) continue;
          if (segmentsIntersect(A[k]!, A[(k + 1) % A.length]!, B[m]!, B[(m + 1) % B.length]!)) {
            selfIntersecting = true;
            break outer;
          }
        }
      }
    }
  }

  // Regions: even nesting depth = outer contour, odd = hole.
  const contains = (outerLoop: Loop, inner: Loop) => outerLoop !== inner && pointInPolygon(inner.polygon[0]!, outerLoop.polygon);
  const depth = loops.map((l) => loops.filter((o) => contains(o, l)).length);
  const regions: Region[] = [];
  loops.forEach((l, i) => {
    if (depth[i]! % 2 !== 0) return;
    const holes = loops.filter((h, j) => depth[j] === depth[i]! + 1 && contains(l, h));
    regions.push({ outer: l, holes });
  });

  return { loops, regions, chains, branchPoints, selfIntersecting };
}
