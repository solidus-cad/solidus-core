import type { Expr } from "./document.ts";

/**
 * 3D sketch (skeleton part): points and lines in space, in the part frame.
 * As in 2D, the endpoints are shared points and the stored coordinates are the last solution of the solver.
 * The lines serve as supports for assembly constraints; lines and splines are sweep paths and loft sections or
 * guides (the kernel builds one wire per chain, see `prepared.curves3d`).
 */

export type Axis3 = "X" | "Y" | "Z";
export type V3 = [number, number, number];

export interface Sk3Point {
  id: string;
  type: "point";
  x: number;
  y: number;
  z: number;
  construction?: boolean;
}

export interface Sk3Line {
  id: string;
  type: "line";
  p1: string;
  p2: string;
  construction?: boolean;
}

/**
 * Spline through points (identifiers of `point` geometries, in order), passive for the solver: its points carry the
 * constraints. Interpolated by `interpolate3` of @solidus-cad/sketch (cubic at most, as many poles as points).
 */
export interface Sk3Spline {
  id: string;
  type: "spline";
  points: string[];
  construction?: boolean;
}

export type Sk3Geometry = Sk3Point | Sk3Line | Sk3Spline;

/** Plane frozen at creation (point and unit normal, part frame). */
export interface Sk3Plane {
  p: V3;
  n: V3;
}

export type Sk3Constraint =
  /** Line parallel to an axis of the part frame. */
  | { id: string; type: "axis"; line: string; axis: Axis3 }
  /** Point, line (both its endpoints) or spline (all its points) in a plane. */
  | { id: string; type: "inPlane"; target: string; plane: Sk3Plane }
  | { id: string; type: "parallel" | "perpendicular" | "equal"; a: string; b: string }
  | { id: string; type: "pointOnLine"; point: string; line: string }
  /** Point locked at its position (attached to a vertex of another part, or fixed by the user). */
  | { id: string; type: "fix"; point: string };

/** Dimension: length of a line (`a`), distance between two points (`a`, `b`), angle between two lines (°). */
export interface Sk3Dimension {
  id: string;
  type: "length" | "distance" | "angle";
  a: string;
  b?: string;
  value: Expr;
  driving: boolean;
}

export interface Sketch3DData {
  geometry: Sk3Geometry[];
  constraints: Sk3Constraint[];
  dimensions: Sk3Dimension[];
}

export function emptySketch3D(): Sketch3DData {
  return { geometry: [], constraints: [], dimensions: [] };
}

export const AXIS_DIR: Record<Axis3, V3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** Points of a spline sampled along it (`sampleSpline3` of @solidus-cad/sketch). */
export type Spline3Sampler = (through: V3[]) => V3[];

/**
 * 3D segments (pairs of points, part frame) of the lines and splines of a 3D sketch. Without `sample`, a spline is
 * drawn as the polyline through its points.
 */
export function sketch3DSegments(data: Sketch3DData, out: number[], withConstruction = true, sample?: Spline3Sampler): void {
  const pts = new Map(data.geometry.filter((g): g is Sk3Point => g.type === "point").map((p) => [p.id, p]));
  for (const g of data.geometry) {
    if (g.type === "point" || (g.construction && !withConstruction)) continue;
    if (g.type === "line") {
      const a = pts.get(g.p1);
      const b = pts.get(g.p2);
      if (a && b) out.push(a.x, a.y, a.z, b.x, b.y, b.z);
      continue;
    }
    const through = g.points.flatMap((id): V3[] => {
      const p = pts.get(id);
      return p ? [[p.x, p.y, p.z]] : [];
    });
    if (through.length < 2) continue;
    const line = sample ? sample(through) : through;
    for (let i = 1; i < line.length; i++) out.push(...line[i - 1]!, ...line[i]!);
  }
}
