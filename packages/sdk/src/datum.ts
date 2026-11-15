import type { Expr, Feature } from "./document.ts";
import { evaluate, type Scope } from "./expr.ts";
import { planeFrame, type Vec3 } from "./sketch.ts";
import type { V3 } from "./sketch3d.ts";

/**
 * Datum planes (construction planes) of a part or an assembly.
 * The construction is purely geometric: it is done here, in TypeScript, and shared by
 * the UI (display, sketches), the kernel (sketches, symmetry) and the assembly.
 *
 * Elements picked on the model (faces, edges, vertices) are stored by their geometry at the time
 * of picking, like sketch planes on a face: they are made associative by the topological naming
 * of cad-core. Planes built on the base planes or on other datum planes follow the parameters.
 */

export type PlaneFrame = ReturnType<typeof planeFrame>;

/** Construction element of a plane. `component`: assembly occurrence (coordinates in its frame). */
export type DatumRef =
  | { kind: "base"; name: "XY" | "XZ" | "YZ" | "X" | "Y" | "Z" | "O" }
  /** Other datum plane (part "plane" feature, or assembly plane). */
  | { kind: "datum"; id: string }
  /** Planar face: point and normal. */
  | { kind: "plane"; p: V3; n: V3; component?: string }
  /** Straight edge, axis of a circle or a cylinder: point and direction. */
  | { kind: "axis"; p: V3; d: V3; component?: string }
  /** Vertex or circle center. */
  | { kind: "point"; p: V3; component?: string }
  /** Cylindrical face: axis, radius and point picked on the face. */
  | { kind: "cylinder"; p: V3; d: V3; r: number; at: V3; component?: string };

/** Role of an element in a construction method (what the user is expected to pick). */
export type DatumRole = "plane" | "axis" | "point" | "cylinder";

export type DatumMethod = "offset" | "parallel" | "midplane" | "angle" | "axisPoint" | "tangent" | "threePoints" | "normal";

export interface DatumPlaneDef {
  method: DatumMethod;
  /** Picked elements, in the order of the method's roles (null: not picked yet). */
  refs: (DatumRef | null)[];
  /** Distance (offset). */
  distance?: Expr;
  /** Angle in degrees (inclined plane, tangent plane). */
  angle?: Expr;
  /** Flips the side (offset, tangency), the bisector (midplane) or the normal (other methods). */
  flip?: boolean;
}

/** Roles of the elements of each method; `optional`: the last one may stay empty. */
export const DATUM_METHODS: Record<DatumMethod, { roles: DatumRole[]; optional?: boolean; distance?: boolean; angle?: boolean }> = {
  offset: { roles: ["plane"], distance: true },
  parallel: { roles: ["plane", "point"] },
  midplane: { roles: ["plane", "plane"] },
  angle: { roles: ["axis", "plane"], angle: true },
  axisPoint: { roles: ["axis", "point"] },
  tangent: { roles: ["cylinder", "plane"], optional: true, angle: true },
  threePoints: { roles: ["point", "point", "point"] },
  normal: { roles: ["axis", "point"], optional: true },
};

/** Elements accepted by a role. */
export function acceptsRef(role: DatumRole, ref: DatumRef): boolean {
  switch (role) {
    case "plane":
      return ref.kind === "plane" || ref.kind === "datum" || (ref.kind === "base" && ref.name.length === 2);
    case "axis":
      return ref.kind === "axis" || ref.kind === "cylinder" || (ref.kind === "base" && ["X", "Y", "Z"].includes(ref.name));
    case "point":
      return ref.kind === "point" || (ref.kind === "base" && ref.name === "O");
    case "cylinder":
      return ref.kind === "cylinder";
  }
}

export function defaultDatumPlane(method: DatumMethod = "offset", first: DatumRef | null = null): DatumPlaneDef {
  const spec = DATUM_METHODS[method];
  const refs: (DatumRef | null)[] = spec.roles.map(() => null);
  if (first && acceptsRef(spec.roles[0]!, first)) refs[0] = first;
  return { method, refs, distance: spec.distance ? "20" : undefined, angle: spec.angle ? (method === "angle" ? "45" : "0") : undefined };
}

export class DatumError extends Error {}

export interface DatumContext {
  num(expr: Expr | undefined, fallback: number): number;
  /** Frame of another datum plane already built. */
  datum(id: string): PlaneFrame | undefined;
  /** World matrix (4×4, column-major) of an assembly occurrence. */
  matrix?(component: string): number[] | undefined;
}

export interface DatumResult {
  frame: PlaneFrame;
  /** Point where the plane is drawn (near the elements that define it). */
  center: Vec3;
}

// --- Vectors -------------------------------------------------------------------

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const fromA = (a: V3): Vec3 => v(a[0], a[1], a[2]);
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, k: number): Vec3 => v(a.x * k, a.y * k, a.z * k);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const EPS = 1e-9;

function unit(a: Vec3, what: string): Vec3 {
  const l = len(a);
  if (l < EPS) throw new DatumError(what);
  return mul(a, 1 / l);
}

/** Component of `a` perpendicular to the unit direction `u`. */
const perp = (a: Vec3, u: Vec3): Vec3 => sub(a, mul(u, dot(a, u)));

/** Rotation of `a` (perpendicular to `u`) around `u`. */
const rotate = (a: Vec3, u: Vec3, deg: number): Vec3 => {
  const t = (deg * Math.PI) / 180;
  return add(mul(a, Math.cos(t)), mul(cross(u, a), Math.sin(t)));
};

function applyPoint(m: number[], p: Vec3): Vec3 {
  return v(m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!, m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!, m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!);
}
function applyDir(m: number[], d: Vec3): Vec3 {
  return v(m[0]! * d.x + m[4]! * d.y + m[8]! * d.z, m[1]! * d.x + m[5]! * d.y + m[9]! * d.z, m[2]! * d.x + m[6]! * d.y + m[10]! * d.z);
}

// --- Resolved elements (world frame) ------------------------------------------------

interface Pl {
  p: Vec3;
  n: Vec3;
  /** X axis to keep (base plane or offset datum plane: same sketch frame). */
  x?: Vec3;
}
interface Ax {
  p: Vec3;
  d: Vec3;
}

const BASE_AXES: Record<string, Vec3> = { X: v(1, 0, 0), Y: v(0, 1, 0), Z: v(0, 0, 1) };

function placement(ref: { component?: string }, ctx: DatumContext): (p: Vec3, isDir: boolean) => Vec3 {
  if (!ref.component) return (p) => p;
  const m = ctx.matrix?.(ref.component);
  if (!m) throw new DatumError("Occurrence de référence introuvable");
  return (p, isDir) => (isDir ? applyDir(m, p) : applyPoint(m, p));
}

function asPlane(ref: DatumRef | null, ctx: DatumContext): Pl {
  if (!ref) throw new DatumError("Plan de référence à désigner");
  if (ref.kind === "base" && ref.name.length === 2) {
    const f = planeFrame(ref.name as "XY", 0);
    return { p: f.origin, n: f.normal, x: f.xDir };
  }
  if (ref.kind === "datum") {
    const f = ctx.datum(ref.id);
    if (!f) throw new DatumError("Plan de référence introuvable ou en erreur");
    return { p: f.origin, n: f.normal, x: f.xDir };
  }
  if (ref.kind === "plane") {
    const tr = placement(ref, ctx);
    return { p: tr(fromA(ref.p), false), n: unit(tr(fromA(ref.n), true), "Normale nulle") };
  }
  throw new DatumError("Un plan ou une face plane est attendu");
}

function asAxis(ref: DatumRef | null, ctx: DatumContext): Ax {
  if (!ref) throw new DatumError("Axe à désigner");
  if (ref.kind === "base" && BASE_AXES[ref.name]) return { p: v(0, 0, 0), d: BASE_AXES[ref.name]! };
  if (ref.kind === "axis" || ref.kind === "cylinder") {
    const tr = placement(ref, ctx);
    return { p: tr(fromA(ref.p), false), d: unit(tr(fromA(ref.d), true), "Direction d'axe nulle") };
  }
  throw new DatumError("Une arête rectiligne ou un axe est attendu");
}

function asPoint(ref: DatumRef | null, ctx: DatumContext): Vec3 {
  if (!ref) throw new DatumError("Point à désigner");
  if (ref.kind === "base" && ref.name === "O") return v(0, 0, 0);
  if (ref.kind === "point") return placement(ref, ctx)(fromA(ref.p), false);
  throw new DatumError("Un sommet ou un point est attendu");
}

/** Frame of a plane (point, normal): fixed X axis, or the global axis most perpendicular to the normal. */
function frameOf(p: Vec3, n: Vec3, xHint?: Vec3): PlaneFrame {
  let x = xHint ? perp(xHint, n) : null;
  if (!x || len(x) < 1e-6) {
    const axes = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)];
    const ref = axes.reduce((a, b) => (Math.abs(dot(a, n)) <= Math.abs(dot(b, n)) ? a : b));
    x = perp(ref, n);
  }
  const xDir = mul(x, 1 / len(x));
  const yDir = cross(n, xDir);
  // Origin: projection of the global origin (readable sketch coordinates, as for a face).
  const origin = mul(n, dot(p, n));
  return { origin, xDir, yDir, normal: n };
}

const project = (q: Vec3, p: Vec3, n: Vec3): Vec3 => sub(q, mul(n, dot(sub(q, p), n)));

/** Builds a datum plane. Throws a DatumError if the construction is impossible. */
export function datumPlane(def: DatumPlaneDef, ctx: DatumContext): DatumResult {
  const spec = DATUM_METHODS[def.method];
  if (!spec) throw new DatumError(`Méthode inconnue « ${def.method} »`);
  const r = def.refs;
  const flip = def.flip ? -1 : 1;
  let p: Vec3;
  let n: Vec3;
  let x: Vec3 | undefined;
  /** Key points of the elements: the plane is drawn around their projection. */
  let near: Vec3[];

  switch (def.method) {
    case "offset": {
      const a = asPlane(r[0] ?? null, ctx);
      const d = ctx.num(def.distance, 0) * flip;
      p = add(a.p, mul(a.n, d));
      n = a.n;
      x = a.x;
      near = [p];
      break;
    }
    case "parallel": {
      const a = asPlane(r[0] ?? null, ctx);
      p = asPoint(r[1] ?? null, ctx);
      n = mul(a.n, flip);
      x = a.x;
      near = [p];
      break;
    }
    case "midplane": {
      const a = asPlane(r[0] ?? null, ctx);
      const b = asPlane(r[1] ?? null, ctx);
      const u = cross(a.n, b.n);
      if (len(u) < 1e-6) {
        // Parallel planes: midplane.
        p = add(a.p, mul(a.n, dot(sub(b.p, a.p), a.n) / 2));
        n = a.n;
        x = a.x;
      } else {
        // Intersecting planes: bisector plane, passing through the intersection line.
        const da = dot(a.n, a.p);
        const db = dot(b.n, b.p);
        p = mul(add(mul(cross(b.n, u), da), mul(cross(u, a.n), db)), 1 / dot(u, u));
        const nb = dot(a.n, b.n) < 0 ? mul(b.n, -1) : b.n;
        n = unit(def.flip ? sub(a.n, nb) : add(a.n, nb), "Plans confondus");
        x = unit(u, "Plans confondus");
      }
      near = [a.p, b.p];
      break;
    }
    case "angle": {
      const ax = asAxis(r[0] ?? null, ctx);
      const ref = asPlane(r[1] ?? null, ctx);
      const n0 = unit(perp(ref.n, ax.d), "L'axe est perpendiculaire au plan de référence : l'angle n'est pas défini");
      n = rotate(n0, ax.d, ctx.num(def.angle, 0) * flip);
      p = ax.p;
      x = ax.d;
      near = [ax.p];
      break;
    }
    case "axisPoint": {
      const ax = asAxis(r[0] ?? null, ctx);
      const q = asPoint(r[1] ?? null, ctx);
      n = mul(unit(cross(ax.d, sub(q, ax.p)), "Le point est sur l'axe : le plan n'est pas défini"), flip);
      p = ax.p;
      x = ax.d;
      near = [ax.p, q];
      break;
    }
    case "tangent": {
      const c = r[0];
      if (!c || c.kind !== "cylinder") throw new DatumError("Une face cylindrique est attendue");
      const tr = placement(c, ctx);
      const axis = { p: tr(fromA(c.p), false), d: unit(tr(fromA(c.d), true), "Direction d'axe nulle") };
      // Radial direction: normal of the datum plane (if any), otherwise the point picked on the face.
      const radial0 = r[1]
        ? unit(perp(asPlane(r[1], ctx).n, axis.d), "Le plan de référence est perpendiculaire à l'axe du cylindre")
        : unit(perp(sub(tr(fromA(c.at), false), axis.p), axis.d), "Point désigné sur l'axe du cylindre");
      n = mul(rotate(radial0, axis.d, ctx.num(def.angle, 0)), flip);
      // Contact point at the picked point, along the axis.
      const along = dot(sub(tr(fromA(c.at), false), axis.p), axis.d);
      p = add(add(axis.p, mul(axis.d, along)), mul(n, c.r));
      x = axis.d;
      near = [p];
      break;
    }
    case "threePoints": {
      const a = asPoint(r[0] ?? null, ctx);
      const b = asPoint(r[1] ?? null, ctx);
      const c = asPoint(r[2] ?? null, ctx);
      n = mul(unit(cross(sub(b, a), sub(c, a)), "Les trois points sont alignés"), flip);
      p = a;
      x = sub(b, a);
      near = [a, b, c];
      break;
    }
    case "normal": {
      const ax = asAxis(r[0] ?? null, ctx);
      p = r[1] ? asPoint(r[1], ctx) : ax.p;
      n = mul(ax.d, flip);
      near = [p];
      break;
    }
  }
  if (![p.x, p.y, p.z, n.x, n.y, n.z].every(Number.isFinite)) throw new DatumError("Plan non défini");
  const frame = frameOf(p, n, x);
  const c = mul(near.reduce(add, v(0, 0, 0)), 1 / near.length);
  return { frame, center: project(c, p, n) };
}

/** Built plane, or error message. */
export type DatumOutcome = (DatumResult & { error?: undefined }) | { error: string; frame?: undefined; center?: undefined };

/**
 * Datum planes of a part (computed "plane" features), in tree order:
 * a plane can only rely on the planes placed before it.
 */
export function partDatumPlanes(features: readonly Feature[], scope: Scope): Map<string, DatumOutcome> {
  const out = new Map<string, DatumOutcome>();
  const ctx: DatumContext = {
    num: (e, fb) => (e === undefined || e.trim() === "" ? fb : evaluate(e, scope)),
    datum: (id) => out.get(id)?.frame,
  };
  for (const f of features) {
    if (f.type !== "plane" || f.suppressed) continue;
    out.set(f.id, evalDatum(f.datum, ctx));
  }
  return out;
}

export function evalDatum(def: DatumPlaneDef | undefined, ctx: DatumContext): DatumOutcome {
  if (!def) return { error: "Plan sans définition" };
  try {
    return datumPlane(def, ctx);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Datum plane of an assembly. */
export interface AssemblyPlane {
  id: string;
  name: string;
  def: DatumPlaneDef;
  hidden?: boolean;
}

/** Planes of an assembly, in list order; `matrix`: world position of an occurrence (path). */
export function assemblyDatumPlanes(planes: readonly AssemblyPlane[], matrix: (component: string) => number[] | undefined, scope: Scope = new Map()): Map<string, DatumOutcome> {
  const out = new Map<string, DatumOutcome>();
  const ctx: DatumContext = {
    num: (e, fb) => (e === undefined || e.trim() === "" ? fb : evaluate(e, scope)),
    datum: (id) => out.get(id)?.frame,
    matrix,
  };
  for (const p of planes) out.set(p.id, evalDatum(p.def, ctx));
  return out;
}

/** Planes (base or datum) usable as a symmetry plane or sketch plane: frame from a name. */
export function namedPlaneFrame(name: string, datums: ReadonlyMap<string, DatumOutcome>, offset = 0): PlaneFrame | undefined {
  if (name === "XY" || name === "XZ" || name === "YZ") return planeFrame(name, offset);
  const f = datums.get(name)?.frame;
  return f ? shiftFrame(f, offset) : undefined;
}

/** Frame offset along its normal. */
export function shiftFrame(f: PlaneFrame, offset: number): PlaneFrame {
  return offset === 0 ? f : { ...f, origin: add(f.origin, mul(f.normal, offset)) };
}
