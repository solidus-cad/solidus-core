import type { Expr, GeomRef } from "./document.ts";

/**
 * 2D sketch model, independent of the solver.
 * The endpoints of lines and arcs are shared points: two connected segments reference the same point.
 * The stored coordinates are the last solution of the solver.
 */

export type BasePlane = "XY" | "XZ" | "YZ";

export interface SketchPlane {
  base: BasePlane;
  offset: Expr;
  /**
   * Planar face picked in the view (point on the face, outward normal). Takes precedence over `base`.
   * The plane is frozen at creation (not yet associative: the topological naming of cad-core will make it associative).
   */
  face?: { p: [number, number, number]; n: [number, number, number] };
  /** Datum plane of the part (identifier of the "plane" feature): takes precedence over `face` and `base`. */
  datum?: string;
  /**
   * Face of another part of the assembly (in-place editing): `face` is realigned on it when the parts
   * move or change in this assembly. `ref`: face (frame of the source part).
   */
  external?: ExternalLink;
}

/** Link to an element of another part of an assembly (in-place editing). */
export interface ExternalLink {
  /** Context assembly. */
  asm: string;
  /** Occurrence carrying the element (path in the assembly). */
  path: string;
  /** Occurrence of the edited part (path in the assembly): frame in which the element is brought back. */
  target: string;
  /** Targeted element, in the frame of the source part. */
  ref: GeomRef;
  /** Link broken by the user: the geometry stays frozen. */
  frozen?: boolean;
  /** Element not found at the last update (the geometry keeps its last position). */
  broken?: boolean;
}

/**
 * Edge or vertex of another part of the assembly, projected into the sketch. `points`: last known polyline
 * of the edge in the frame of the edited part (updated by the application); the kernel projects it onto the plane.
 */
export interface ExternalRef extends ExternalLink {
  kind: "external";
  points: [number, number, number][];
}

interface GeoBase {
  id: string;
  construction?: boolean;
  /**
   * Curve projected from an edge of the model: fixed for the solver, realigned by the kernel
   * on the actual position of the edge at each recompute (associative geometry).
   */
  projected?: GeomRef | SketchEntityRef | ExternalRef;
  /**
   * External reference: element of another feature (edge, vertex, sketch element) picked for a dimension
   * or a constraint, without being imported into the sketch. Always projected and in construction; hidden outside
   * of editing and removed as soon as no dimension or constraint uses it anymore.
   */
  external?: boolean;
}

/** Reference to a curve of a skeleton sketch (same document), projected and realigned at each recompute. */
export interface SketchEntityRef {
  kind: "sketch";
  sketch: string;
  entity: string;
}

export interface SkPoint extends GeoBase {
  type: "point";
  x: number;
  y: number;
  /** Point projected from an edge of the model (`projected`): picked endpoint or center. */
  anchor?: "start" | "end" | "center";
}

export interface SkLine extends GeoBase {
  type: "line";
  p1: string;
  p2: string;
}

export interface SkCircle extends GeoBase {
  type: "circle";
  c: string;
  r: number;
}

/** Arc traversed counterclockwise, from `start` to `end`. */
export interface SkArc extends GeoBase {
  type: "arc";
  c: string;
  start: string;
  end: string;
}

/**
 * B-spline defined by its poles (control points, identifiers of `point` geometries). Open: it goes through its first
 * and last poles (clamped knots), which are its endpoints. Periodic: closed on itself, without endpoints.
 * Without `knots`, the knots are uniform (see `bsplineKnots`); explicit knots come from a split.
 */
export interface SkBSpline extends GeoBase {
  type: "bspline";
  poles: string[];
  degree: number;
  periodic?: boolean;
  /** Weights of the poles (rational spline); absent: all 1. */
  weights?: number[];
  /** Distinct knots and their multiplicities (OCCT convention); absent: uniform. */
  knots?: number[];
  mults?: number[];
}

export type SkGeometry = SkPoint | SkLine | SkCircle | SkArc | SkBSpline;
export type SkCurve = SkLine | SkCircle | SkArc | SkBSpline;

/**
 * Knots of a B-spline (OCCT and PlaneGCS convention): explicit ones, otherwise uniform. Open spline of n poles and
 * degree p: n - p + 1 knots, multiplicity p + 1 at both ends. Periodic: n + 1 knots of multiplicity 1.
 */
export function bsplineKnots(g: SkBSpline): { knots: number[]; mults: number[] } {
  if (g.knots && g.mults) return { knots: g.knots, mults: g.mults };
  const n = g.poles.length;
  const p = g.degree;
  if (g.periodic) return { knots: Array.from({ length: n + 1 }, (_, i) => i), mults: Array(n + 1).fill(1) };
  const count = n - p + 1;
  return { knots: Array.from({ length: count }, (_, i) => i), mults: Array.from({ length: count }, (_, i) => (i === 0 || i === count - 1 ? p + 1 : 1)) };
}

/** Endpoints of a curve (start, end), or null for a closed curve (circle, periodic spline). */
export function curveEnds(c: SkCurve): [string, string] | null {
  if (c.type === "line") return [c.p1, c.p2];
  if (c.type === "arc") return [c.start, c.end];
  if (c.type === "bspline" && !c.periodic) return [c.poles[0]!, c.poles[c.poles.length - 1]!];
  return null;
}

/** Geometric constraints. `a`, `b`: geometry identifiers. */
export type SkConstraint =
  | { id: string; type: "horizontal" | "vertical"; a: string }
  | { id: string; type: "parallel" | "perpendicular" | "equal" | "tangent" | "concentric"; a: string; b: string }
  | { id: string; type: "pointOnCurve" | "midpoint"; point: string; curve: string }
  | { id: string; type: "symmetric"; a: string; b: string; axis: string }
  | { id: string; type: "fix"; point: string };

export type DimensionKind = "distance" | "horizontalDistance" | "verticalDistance" | "radius" | "diameter" | "angle";

/**
 * Dimension. `driving`: driving (sets the value) or driven (measurement only).
 * distance*: between two points (`a`, `b`) or point–line; radius/diameter: `a` circle or arc; angle: two lines.
 */
export interface SkDimension {
  id: string;
  type: DimensionKind;
  a: string;
  b?: string;
  value: Expr;
  driving: boolean;
  /** Text position, relative to the middle of the dimensioned elements. */
  offset?: { x: number; y: number };
}

export interface SketchData {
  plane: SketchPlane;
  geometry: SkGeometry[];
  constraints: SkConstraint[];
  dimensions: SkDimension[];
}

export function emptySketch(base: BasePlane = "XY"): SketchData {
  return { plane: { base, offset: "0" }, geometry: [], constraints: [], dimensions: [] };
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Frame of a base plane: origin, X and Y axes of the sketch, normal (X × Y). */
export function planeFrame(base: BasePlane, offset: number): { origin: Vec3; xDir: Vec3; yDir: Vec3; normal: Vec3 } {
  switch (base) {
    case "XY":
      return { origin: { x: 0, y: 0, z: offset }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
    case "XZ":
      return { origin: { x: 0, y: -offset, z: 0 }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: -1, z: 0 } };
    case "YZ":
      return { origin: { x: offset, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 }, yDir: { x: 0, y: 0, z: 1 }, normal: { x: 1, y: 0, z: 0 } };
  }
}

/**
 * Frame of any sketch plane (base plane or face), offset by `offset` along the normal.
 * For a face: origin = projection of the global origin onto the plane; X axis = the global axis most
 * perpendicular to the normal, projected into the plane (stable and readable frame).
 */
export function sketchFrame(
  plane: SketchPlane,
  offset: number,
  datum?: (id: string) => ReturnType<typeof planeFrame> | undefined,
): ReturnType<typeof planeFrame> {
  // Datum plane: its frame, offset along its normal (falls back to `base` if not found).
  const d0 = plane.datum ? datum?.(plane.datum) : undefined;
  if (d0) {
    const o = d0.origin;
    const n = d0.normal;
    return { ...d0, origin: { x: o.x + n.x * offset, y: o.y + n.y * offset, z: o.z + n.z * offset } };
  }
  if (!plane.face) return planeFrame(plane.base, offset);
  const [nx, ny, nz] = plane.face.n;
  const len = Math.hypot(nx, ny, nz) || 1;
  const n = { x: nx / len, y: ny / len, z: nz / len };
  const [px, py, pz] = plane.face.p;
  const d = px * n.x + py * n.y + pz * n.z + offset;
  const origin = { x: n.x * d, y: n.y * d, z: n.z * d };
  const axes = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
  ];
  const ref = axes.reduce((a, b) => (Math.abs(a.x * n.x + a.y * n.y + a.z * n.z) <= Math.abs(b.x * n.x + b.y * n.y + b.z * n.z) ? a : b));
  const k = ref.x * n.x + ref.y * n.y + ref.z * n.z;
  const xr = { x: ref.x - k * n.x, y: ref.y - k * n.y, z: ref.z - k * n.z };
  const xl = Math.hypot(xr.x, xr.y, xr.z);
  const xDir = { x: xr.x / xl, y: xr.y / xl, z: xr.z / xl };
  const yDir = { x: n.y * xDir.z - n.z * xDir.y, y: n.z * xDir.x - n.x * xDir.z, z: n.x * xDir.y - n.y * xDir.x };
  return { origin, xDir, yDir, normal: n };
}

export function sketchToWorld(frame: ReturnType<typeof planeFrame>, u: number, v: number): Vec3 {
  const { origin: o, xDir: x, yDir: y } = frame;
  return { x: o.x + u * x.x + v * y.x, y: o.y + u * x.y + v * y.y, z: o.z + u * x.z + v * y.z };
}

/** Reference axes of a sketch, usable as a revolution or symmetry axis. */
export const SKETCH_AXIS_H = "axis:H";
export const SKETCH_AXIS_V = "axis:V";
/** Origin of the sketch: implicit fixed point, usable as a line endpoint or center. */
export const SKETCH_ORIGIN = "O";
