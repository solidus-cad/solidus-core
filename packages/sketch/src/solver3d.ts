import { AXIS_DIR, evaluate, type Scope, type Sk3Constraint, type Sk3Dimension, type Sk3Geometry, type Sk3Line, type Sk3Point, type Sketch3DData, type V3 } from "@solidus-cad/sdk";
import { levenbergMarquardt, rank } from "./lm.ts";

/**
 * 3D sketch solver: least squares (Levenberg-Marquardt) on the coordinates of the free points.
 * Each constraint or driving dimension gives a block of residuals that depends on only a few points:
 * the Jacobian is computed by finite differences, block by block (sparse).
 */

export interface Solve3DOptions {
  scope?: Scope;
  /** Drag: target positions for some points (enforced if possible, otherwise approximated). */
  targets?: Record<string, V3>;
}

export interface Solve3DResult {
  ok: boolean;
  geometry: Sk3Geometry[];
  dof: number;
  /** Unsatisfied constraints and dimensions. */
  conflicting: string[];
  dimensionErrors: Record<string, string>;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** Weight of the soft hold on line lengths (first solve pass, see `settle`). */
const LENGTH_HOLD = 0.1;

interface Block {
  id: string;
  pts: string[];
  f: (P: (id: string) => V3) => number[];
  /** Soft block (drag): excluded from the diagnostic. */
  soft?: boolean;
}

function lineOf(geometry: Map<string, Sk3Geometry>, id: string): Sk3Line | undefined {
  const g = geometry.get(id);
  return g?.type === "line" ? g : undefined;
}

/**
 * Average length of the lines in the starting geometry (at least 1 mm), frozen during the solve:
 * it scales the angle residuals to a length (homogeneous conditioning with the residuals in mm)
 * without making them depend on the current lengths, otherwise shortening a line would be enough to cancel them.
 */
function refLength(geometry: Map<string, Sk3Geometry>, ...lines: Sk3Line[]): number {
  const P = (id: string): V3 => {
    const g = geometry.get(id);
    return g?.type === "point" ? [g.x, g.y, g.z] : [0, 0, 0];
  };
  const total = lines.reduce((s, l) => s + len(sub(P(l.p2), P(l.p1))), 0);
  return Math.max(total / lines.length, 1);
}

/** Measured value of a dimension (mm or °), on the current coordinates. */
export function measure3D(data: Sketch3DData, dim: Pick<Sk3Dimension, "type" | "a" | "b">): number | null {
  const geo = new Map(data.geometry.map((g) => [g.id, g]));
  const P = (id: string): V3 | null => {
    const g = geo.get(id);
    return g?.type === "point" ? [g.x, g.y, g.z] : null;
  };
  const dir = (id: string): V3 | null => {
    const l = lineOf(geo, id);
    const a = l && P(l.p1);
    const b = l && P(l.p2);
    return a && b ? sub(b, a) : null;
  };
  if (dim.type === "length") {
    const d = dir(dim.a);
    return d ? len(d) : null;
  }
  if (dim.type === "distance") {
    const a = P(dim.a);
    const b = dim.b ? P(dim.b) : null;
    return a && b ? len(sub(b, a)) : null;
  }
  const da = dir(dim.a);
  const db = dim.b ? dir(dim.b) : null;
  if (!da || !db) return null;
  return (Math.atan2(len(cross(da, db)), dot(da, db)) * 180) / Math.PI;
}

function constraintBlock(c: Sk3Constraint, geo: Map<string, Sk3Geometry>): Block | null {
  switch (c.type) {
    case "axis": {
      const l = lineOf(geo, c.line);
      if (!l) return null;
      const a = AXIS_DIR[c.axis];
      // Direction components perpendicular to the axis: zero.
      const keep = [0, 1, 2].filter((i) => a[i] === 0);
      return { id: c.id, pts: [l.p1, l.p2], f: (P) => { const d = sub(P(l.p2), P(l.p1)); return keep.map((i) => d[i]!); } };
    }
    case "inPlane": {
      const g = geo.get(c.target);
      if (!g) return null;
      const pts = g.type === "line" ? [g.p1, g.p2] : g.type === "spline" ? g.points : [g.id];
      const n = c.plane.n;
      return { id: c.id, pts, f: (P) => pts.map((p) => dot(sub(P(p), c.plane.p), n)) };
    }
    case "parallel":
    case "perpendicular":
    case "equal": {
      const la = lineOf(geo, c.a);
      const lb = lineOf(geo, c.b);
      if (!la || !lb) return null;
      const s = refLength(geo, la, lb);
      return {
        id: c.id,
        pts: [la.p1, la.p2, lb.p1, lb.p2],
        f: (P) => {
          const da = sub(P(la.p2), P(la.p1));
          const db = sub(P(lb.p2), P(lb.p1));
          if (c.type === "equal") return [len(da) - len(db)];
          // Sine (parallel) or cosine (perpendicular) of the angle: independent of the lengths.
          const k = s / (len(da) * len(db) || 1);
          if (c.type === "parallel") return cross(da, db).map((v) => v * k);
          return [dot(da, db) * k];
        },
      };
    }
    case "pointOnLine": {
      const l = lineOf(geo, c.line);
      if (!l || geo.get(c.point)?.type !== "point") return null;
      return {
        id: c.id,
        pts: [c.point, l.p1, l.p2],
        f: (P) => {
          const a = P(l.p1);
          const d = sub(P(l.p2), a);
          const nd = len(d) || 1;
          return cross(sub(P(c.point), a), d).map((v) => v / nd);
        },
      };
    }
    case "fix":
      return null; // handled by removing the point from the unknowns
  }
}

function dimensionBlock(d: Sk3Dimension, value: number, geo: Map<string, Sk3Geometry>): Block | null {
  if (d.type === "length") {
    const l = lineOf(geo, d.a);
    return l ? { id: d.id, pts: [l.p1, l.p2], f: (P) => [len(sub(P(l.p2), P(l.p1))) - value] } : null;
  }
  if (d.type === "distance") {
    if (!d.b || geo.get(d.a)?.type !== "point" || geo.get(d.b)?.type !== "point") return null;
    const b = d.b;
    return { id: d.id, pts: [d.a, b], f: (P) => [len(sub(P(b), P(d.a))) - value] };
  }
  const la = lineOf(geo, d.a);
  const lb = d.b ? lineOf(geo, d.b) : undefined;
  if (!la || !lb) return null;
  const target = (value * Math.PI) / 180;
  return {
    id: d.id,
    pts: [la.p1, la.p2, lb.p1, lb.p2],
    f: (P) => {
      const da = sub(P(la.p2), P(la.p1));
      const db = sub(P(lb.p2), P(lb.p1));
      // Angle deviation scaled to a length (homogeneous conditioning with the residuals in mm).
      return [(Math.atan2(len(cross(da, db)), dot(da, db)) - target) * Math.max(len(da), 1)];
    },
  };
}

export function solveSketch3D(data: Sketch3DData, opts: Solve3DOptions = {}): Solve3DResult {
  const geo = new Map(data.geometry.map((g) => [g.id, g]));
  const points = data.geometry.filter((g): g is Sk3Point => g.type === "point");
  const fixed = new Set(data.constraints.flatMap((c) => (c.type === "fix" ? [c.point] : [])));
  const free = points.filter((p) => !fixed.has(p.id));
  const index = new Map(free.map((p, i) => [p.id, i * 3]));
  const pos0 = new Map(points.map((p) => [p.id, [p.x, p.y, p.z] as V3]));

  const dimensionErrors: Record<string, string> = {};
  const blocks: Block[] = [];
  for (const c of data.constraints) {
    const b = constraintBlock(c, geo);
    if (b) blocks.push(b);
  }
  for (const d of data.dimensions) {
    if (!d.driving) continue;
    let v: number;
    try {
      v = evaluate(d.value, opts.scope ?? new Map());
    } catch (e) {
      dimensionErrors[d.id] = e instanceof Error ? e.message : String(e);
      continue;
    }
    const b = dimensionBlock(d, v, geo);
    if (b) blocks.push(b);
  }

  const getter = (x: number[]) => (id: string): V3 => {
    const k = index.get(id);
    return k === undefined ? (pos0.get(id) ?? [0, 0, 0]) : [x[k]!, x[k + 1]!, x[k + 2]!];
  };
  const run = (all: Block[], x0 = free.flatMap((p) => pos0.get(p.id)!)) => {
    const residuals = (x: number[]) => {
      const P = getter(x);
      return all.flatMap((b) => b.f(P));
    };
    return levenbergMarquardt(x0, residuals, (x) => blockJacobian(all, x, getter, index));
  };
  // Orientation constraints rotate the lines in straight steps (tangent to the arc): without a hold,
  // the free lengths drift (a line stretches or shrinks). First pass with a soft hold toward the
  // starting lengths, then exact projection onto the constraints alone, as for the drag.
  const lengthBlocks: Block[] = data.geometry.flatMap((l): Block[] => {
    if (l.type !== "line") return [];
    const l0 = len(sub(pos0.get(l.p2) ?? [0, 0, 0], pos0.get(l.p1) ?? [0, 0, 0]));
    return [{ id: `length:${l.id}`, pts: [l.p1, l.p2], soft: true, f: (P) => [(len(sub(P(l.p2), P(l.p1))) - l0) * LENGTH_HOLD] }];
  });
  const settle = (all: Block[], x0?: number[]) => (lengthBlocks.length ? run(all, run([...all, ...lengthBlocks], x0).x) : run(all, x0));

  const tol = 1e-6;
  const failingOf = (all: Block[], P: (id: string) => V3) => all.filter((b) => !b.soft && Math.hypot(...b.f(P)) > tol).map((b) => b.id);

  // Drag: first enforcing the target; if the sketch does not allow it, it is approximated as well as possible.
  const targets = Object.entries(opts.targets ?? {}).filter(([id]) => index.has(id));
  const targetBlocks = (soft: boolean): Block[] =>
    targets.map(([id, t]) => ({ id: `target:${id}`, pts: [id], soft, f: (P) => sub(P(id), t).map((v) => (soft ? v * 1e-3 : v)) }));
  let result = settle([...blocks, ...targetBlocks(false)]);
  if (targets.length && failingOf(blocks, getter(result.x)).length + failingOf(targetBlocks(false), getter(result.x)).length) {
    // Target approximated, then projection onto the constraints alone (the soft target slightly biases the others).
    result = run(blocks, run([...blocks, ...targetBlocks(true)]).x);
  }
  const P = getter(result.x);
  const conflicting = failingOf(blocks, P);
  // Degrees of freedom: rank of the Jacobian of the constraints alone (without the drag targets).
  const n = free.length * 3;
  const J = blockJacobian(blocks, result.x, getter, index);
  const dof = n - (J.length ? rank(J, n) : 0);

  const geometry = data.geometry.map((g): Sk3Geometry => {
    if (g.type !== "point" || !index.has(g.id)) return { ...g };
    const [x, y, z] = P(g.id);
    return { ...g, x, y, z };
  });
  return { ok: conflicting.length === 0 && Object.keys(dimensionErrors).length === 0, geometry, dof, conflicting, dimensionErrors };
}

/** Jacobian by finite differences, block by block: only the coordinates of the block's points are perturbed. */
function blockJacobian(blocks: Block[], x: number[], getter: (x: number[]) => (id: string) => V3, index: Map<string, number>): number[][] {
  const rows: number[][] = [];
  const h = 1e-7;
  for (const b of blocks) {
    const base = b.f(getter(x));
    const local = base.map(() => new Array<number>(x.length).fill(0));
    for (const p of new Set(b.pts)) {
      const k = index.get(p);
      if (k === undefined) continue;
      for (let j = k; j < k + 3; j++) {
        const xp = [...x];
        xp[j] = xp[j]! + h;
        b.f(getter(xp)).forEach((v, i) => (local[i]![j] = (v - base[i]!) / h));
      }
    }
    rows.push(...local);
  }
  return rows;
}
