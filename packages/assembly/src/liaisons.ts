import type { AssemblyComponent, Mate, MateType, Matrix4, Scope } from "@solidus-cad/sdk";
import { COUPLING_MATES } from "@solidus-cad/sdk";
import { displace, mateResidual, mateValue, solveMates, symmetricEigen } from "./solver.ts";

/**
 * Kinematic liaison graph of an assembly (graphe des liaisons).
 *
 * The constraints are linearised at the current pose: the kernel of their Jacobian is the space of the small
 * motions they allow (twists of the bodies).
 * - Kinematic classes: bodies that never move relative to each other (whatever the allowed motion) form a
 *   single class; the fixed bodies form the ground class (bâti).
 * - Liaisons: between two classes, the constraints that join them alone allow a relative twist space, whose
 *   structure (number of rotations, of translations, and their geometry) identifies the normalised joint
 *   (pivot, glissière, rotule…).
 * - Couplings (gear, belt, rack and pinion) link two motions: shown apart, as they do not make a joint.
 * Mobility and degree of hyperstatism are given by the usual formula h = Ns − (Ec − m), with Ec the rank of the
 * kinematic equations.
 */

type V3 = [number, number, number];

export type LiaisonKind =
  | "rigid"
  | "pivot"
  | "slider"
  | "cylindrical"
  | "helical"
  | "spherical"
  | "fingerSpherical"
  | "planar"
  | "sphereCylinder"
  | "cylinderPlane"
  | "spherePlane"
  | "free"
  | "compound";

export interface LiaisonClass {
  /** Bodies (solver ids: occurrence, "occurrence/part" of a flexible sub-assembly). */
  bodies: string[];
  /** Ground class: holds the fixed bodies. */
  ground: boolean;
}

export interface Liaison {
  /** Indices of the two classes in `LiaisonGraph.classes`. */
  a: number;
  b: number;
  kind: LiaisonKind;
  /** Independent rotations and translations allowed. */
  rotations: number;
  translations: number;
  dof: number;
  /** Axis (pivot, glissière, pivot glissant, hélicoïdale, linéaire annulaire) or normal (appui plan, linéaire rectiligne, ponctuelle), unit, world frame. */
  axis?: V3;
  /** Point on the axis, or centre (rotule), world frame. */
  point?: V3;
  /** Helical: pitch (mm per turn). */
  pitch?: number;
  /** Constraints making up the joint. */
  mates: string[];
}

export interface Coupling {
  a: number;
  b: number;
  type: MateType;
  mates: string[];
}

export interface LiaisonGraph {
  classes: LiaisonClass[];
  liaisons: Liaison[];
  couplings: Coupling[];
  /** Mobility (independent motions relative to the ground). */
  mobility: number;
  /** Degree of hyperstatism (redundant constraints). */
  hyperstatic: number;
}

const COUPLING = new Set<string>(COUPLING_MATES);

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(...a);
const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
const centre = (m: Matrix4): V3 => [m[12]!, m[13]!, m[14]!];

/** Group of bodies moved as one rigid body, about the point `c`. */
interface Mover {
  bodies: string[];
  c: V3;
}

interface System {
  poses: Map<string, Matrix4>;
  values: Map<string, number>;
  /** Length scale: rotation unknowns are angle × L (same order of magnitude as translations). */
  L: number;
}

/** Jacobian (central differences) of the residuals of `mates` with respect to the displacements of the movers. */
function jacobian(sys: System, mates: Mate[], movers: Mover[]): number[][] {
  const n = movers.length * 6;
  const owner = new Map<string, number>();
  movers.forEach((g, k) => g.bodies.forEach((b) => owner.set(b, k)));
  const residualsAt = (x: number[]) => {
    const pose = (id: string) => {
      const m0 = sys.poses.get(id)!;
      const k = owner.get(id);
      if (k === undefined) return m0;
      const o = k * 6;
      return displace(m0, [x[o]!, x[o + 1]!, x[o + 2]!], [x[o + 3]! / sys.L, x[o + 4]! / sys.L, x[o + 5]! / sys.L], movers[k]!.c);
    };
    return mates.flatMap((m) => mateResidual(m, pose(m.a.component), pose(m.b.component), sys.poses.get(m.a.component)!, sys.poses.get(m.b.component)!, sys.values.get(m.id) ?? 0));
  };
  const h = 1e-5;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const xp = new Array<number>(n).fill(0);
    const xm = new Array<number>(n).fill(0);
    xp[j] = h;
    xm[j] = -h;
    const fp = residualsAt(xp);
    const fm = residualsAt(xm);
    cols.push(fp.map((v, i) => (v - fm[i]!) / (2 * h)));
  }
  return (cols[0] ?? []).map((_, i) => cols.map((c) => c[i]!));
}

/** Orthonormal basis of the kernel of J (n unknowns). */
function kernel(J: number[][], n: number): number[][] {
  if (n === 0) return [];
  const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a]! * row[b]!, 0)));
  const { values, vectors } = symmetricEigen(JtJ);
  const top = Math.max(0, ...values);
  return vectors.filter((_, k) => top < 1e-20 || values[k]! <= 1e-10 * top);
}

/** Twist of mover `k` in a kernel vector: angular velocity and velocity at the world origin. */
function twistOf(x: number[], k: number, c: V3, L: number): { w: V3; v0: V3 } {
  const o = k * 6;
  const w: V3 = [x[o + 3]! / L, x[o + 4]! / L, x[o + 5]! / L];
  const t: V3 = [x[o]!, x[o + 1]!, x[o + 2]!];
  // v(p) = t + w × (p − c)  ⇒  v(0) = t − w × c
  return { w, v0: sub(t, cross(w, c)) };
}

/** Solves the 3×3 system A·x = b (null if singular). */
function solve3(A: number[][], b: V3): V3 | null {
  const det = (m: number[][]) =>
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const d = det(A);
  const norm = Math.max(1e-30, ...A.flat().map(Math.abs)) ** 3;
  if (Math.abs(d) < 1e-9 * norm) return null;
  return [0, 1, 2].map((i) => det(A.map((row, r) => row.map((v, c) => (c === i ? b[r]! : v)))) / d) as V3;
}

/** Point that all the rotational twists leave fixed (least squares on w × p = −v0); null if undetermined. */
function fixedPoint(twists: { w: V3; v0: V3 }[]): V3 | null {
  const A = [0, 1, 2].map(() => [0, 0, 0]);
  const b: V3 = [0, 0, 0];
  for (const { w, v0 } of twists) {
    // Rows of [w]× (w × p = [w]× p).
    const M: V3[] = [
      [0, -w[2], w[1]],
      [w[2], 0, -w[0]],
      [-w[1], w[0], 0],
    ];
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i]![j]! += M[r]![i]! * M[r]![j]!;
        b[i]! += M[r]![i]! * -v0[r]!;
      }
    }
  }
  return solve3(A, b);
}

/**
 * Normalised joint of a relative twist space. `twists`: kernel basis of the relative motion (orthonormal in the
 * scaled unknowns); `L`: length scale of the rotations.
 */
export function classifyTwists(twists: { w: V3; v0: V3 }[], L: number): Omit<Liaison, "a" | "b" | "mates"> {
  const dof = twists.length;
  // Split into rotational and pure translation motions: eigen-decomposition of the Gram matrix of the w (scaled).
  const G = twists.map((a) => twists.map((b) => dot(a.w, b.w) * L * L));
  const { values, vectors } = symmetricEigen(G);
  const tol = 1e-6;
  const combine = (alpha: number[]) => ({
    w: twists.reduce<V3>((s, t, i) => add(s, scale(t.w, alpha[i]!)), [0, 0, 0]),
    v0: twists.reduce<V3>((s, t, i) => add(s, scale(t.v0, alpha[i]!)), [0, 0, 0]),
  });
  const rot = vectors.filter((_, k) => values[k]! > tol).map(combine);
  const trans = vectors.filter((_, k) => values[k]! <= tol).map((a) => unit(combine(a).v0));
  const r = rot.length;
  const t = trans.length;
  const base = { rotations: r, translations: t, dof };
  const par = (a: V3, b: V3) => len(cross(unit(a), unit(b))) < 1e-4;
  const perpTo = (a: V3, b: V3) => Math.abs(dot(unit(a), unit(b))) < 1e-4;
  if (dof === 0) return { ...base, kind: "rigid" };
  if (dof === 6) return { ...base, kind: "free" };
  if (r === 0 && t === 1) return { ...base, kind: "slider", axis: trans[0] };
  if (r === 1 && t <= 1) {
    const { w, v0 } = rot[0]!;
    const w2 = dot(w, w);
    const axis = unit(w);
    const point = scale(cross(w, v0), 1 / w2);
    if (t === 1) return par(trans[0]!, w) ? { ...base, kind: "cylindrical", axis, point } : { ...base, kind: "compound" };
    const pitch = dot(w, v0) / w2; // mm / rad
    if (Math.abs(pitch) < 1e-4) return { ...base, kind: "pivot", axis, point };
    return { ...base, kind: "helical", axis, point, pitch: pitch * 2 * Math.PI };
  }
  if (t === 0 && (r === 2 || r === 3)) {
    const point = fixedPoint(rot) ?? undefined;
    if (r === 3) return { ...base, kind: "spherical", point };
    // Rotule à doigt: the blocked rotation is about the normal to the two allowed axes.
    return { ...base, kind: "fingerSpherical", point, axis: unit(cross(rot[0]!.w, rot[1]!.w)) };
  }
  if (r === 1 && t === 2 && perpTo(rot[0]!.w, trans[0]!) && perpTo(rot[0]!.w, trans[1]!)) return { ...base, kind: "planar", axis: unit(rot[0]!.w) };
  if (r === 3 && t === 1) return { ...base, kind: "sphereCylinder", axis: trans[0] };
  if (r === 2 && t === 2) return { ...base, kind: "cylinderPlane", axis: unit(cross(trans[0]!, trans[1]!)) };
  if (r === 3 && t === 2) return { ...base, kind: "spherePlane", axis: unit(cross(trans[0]!, trans[1]!)) };
  return { ...base, kind: "compound" };
}

/**
 * Kernel of the constraints at a generic pose. At a singular pose (crank and connecting rod aligned at dead
 * centre, for example) the linearised constraints lose rank and a moving part looks momentarily fixed: the
 * mechanism is moved by a small step along its allowed motions, then brought back onto the constraints by the
 * solver, and analysed there. Falls back to the current pose if the step cannot be solved.
 */
function genericPose(sys: System, components: AssemblyComponent[], mates: Mate[], free: AssemblyComponent[]): { sys: System; movers: Mover[]; K: number[][] } {
  const moversAt = (s: System): Mover[] => free.map((c) => ({ bodies: [c.id], c: centre(s.poses.get(c.id)!) }));
  const movers = moversAt(sys);
  const K = kernel(jacobian(sys, mates, movers), movers.length * 6);
  if (K.length === 0 || mates.length === 0) return { sys, movers, K };
  // Deterministic combination of all the allowed motions (no preferred direction), step ≈ 2 % of the size.
  const x = new Array<number>(movers.length * 6).fill(0);
  K.forEach((v, k) => {
    const coef = Math.sin(12.9898 * (k + 1)) * 0.5 + 0.75;
    v.forEach((vi, i) => (x[i]! += coef * vi));
  });
  const norm = Math.hypot(...x) || 1;
  const step = (0.02 * sys.L) / norm;
  const moved = components.map((c) => {
    const k = free.indexOf(c);
    if (k < 0) return c;
    const o = k * 6;
    const t: V3 = [x[o]! * step, x[o + 1]! * step, x[o + 2]! * step];
    const r: V3 = [(x[o + 3]! * step) / sys.L, (x[o + 4]! * step) / sys.L, (x[o + 5]! * step) / sys.L];
    return { ...c, matrix: displace(c.matrix, t, r, movers[k]!.c) };
  });
  const solved = solveMates(moved, mates.map((m) => ({ ...m, drive: undefined })));
  if (!solved.ok) return { sys, movers, K };
  const poses = new Map(moved.map((c) => [c.id, solved.matrices[c.id] ?? c.matrix]));
  const gen: System = { ...sys, poses };
  const genMovers = moversAt(gen);
  const K2 = kernel(jacobian(gen, mates, genMovers), genMovers.length * 6);
  // The generic pose allows at most the motions of the singular one.
  return K2.length <= K.length ? { sys: gen, movers: genMovers, K: K2 } : { sys, movers, K };
}

/** Union-find. */
function classes(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  return { find, union: (a: number, b: number) => void (parent[find(a)] = find(b)) };
}

/**
 * Liaison graph of a set of bodies and constraints (current poses: those of the solved assembly).
 * Suppressed and unresolved constraints are ignored, as are motion drivers.
 */
export function liaisonGraph(components: AssemblyComponent[], mates: Mate[], scope: Scope = new Map()): LiaisonGraph {
  const byId = new Map(components.map((c) => [c.id, c]));
  const active = mates.filter((m) => !m.suppressed && !m.unresolved && byId.has(m.a.component) && byId.has(m.b.component) && m.a.component !== m.b.component);
  const poses = new Map(components.map((c) => [c.id, [...c.matrix]]));
  const values = new Map(active.map((m) => [m.id, mateValue(m, scope)]));
  // Length scale of the rotations: distance of the constrained elements from the body centres (as the solver).
  let L = 1;
  for (const m of active) for (const ref of [m.a, m.b]) {
    const pose = poses.get(ref.component)!;
    const p = ref.p;
    const w: V3 = [0, 1, 2].map((i) => pose[i]! * p[0] + pose[4 + i]! * p[1] + pose[8 + i]! * p[2] + pose[12 + i]!) as V3;
    L = Math.max(L, len(sub(w, centre(pose))));
  }
  const sys: System = { poses, values, L };

  // --- Global motion: kinematic classes and mobility ---
  const free = components.filter((c) => !c.fixed);
  const { sys: gen, movers, K } = genericPose(sys, components, active, free);
  const index = new Map(components.map((c, i) => [c.id, i]));
  const uf = classes(components.length);
  const fixed = components.filter((c) => c.fixed);
  for (const c of fixed.slice(1)) uf.union(index.get(c.id)!, index.get(fixed[0]!.id)!);
  const moverOf = new Map(free.map((c, k) => [c.id, k]));
  const twistAt = (id: string, x: number[]) => {
    const k = moverOf.get(id);
    return k === undefined ? { w: [0, 0, 0] as V3, v0: [0, 0, 0] as V3 } : twistOf(x, k, movers[k]!.c, L);
  };
  /** Do the two bodies have the same twist in every allowed motion? (Equality of twists is transitive.) */
  const rigidPair = (ida: string, idb: string) => {
    const p = scale(add(centre(gen.poses.get(ida)!), centre(gen.poses.get(idb)!)), 0.5);
    return K.every((x) => {
      const a = twistAt(ida, x);
      const b = twistAt(idb, x);
      return len(sub(a.w, b.w)) * L + len(sub(add(a.v0, cross(a.w, p)), add(b.v0, cross(b.w, p)))) < 1e-5;
    });
  };
  // Bodies joined by a constraint first, then the remaining classes pairwise (rigid through a loop).
  for (const m of active) {
    const [ia, ib] = [index.get(m.a.component)!, index.get(m.b.component)!];
    if (uf.find(ia) !== uf.find(ib) && rigidPair(m.a.component, m.b.component)) uf.union(ia, ib);
  }
  const roots = [...new Set(components.map((_, i) => uf.find(i)))];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    const [ra, rb] = [roots[i]!, roots[j]!];
    if (uf.find(ra) !== uf.find(rb) && rigidPair(components[ra]!.id, components[rb]!.id)) uf.union(ra, rb);
  }

  // Classes: ground first, then in the order of the components.
  const groups = new Map<number, string[]>();
  for (const c of components) {
    const r = uf.find(index.get(c.id)!);
    groups.set(r, [...(groups.get(r) ?? []), c.id]);
  }
  const list: LiaisonClass[] = [...groups.values()].map((bodies) => ({ bodies, ground: bodies.some((b) => byId.get(b)!.fixed) }));
  list.sort((a, b) => Number(b.ground) - Number(a.ground));
  const classOf = new Map(list.flatMap((g, i) => g.bodies.map((b) => [b, i] as const)));

  // Mobility: kernel dimension, less the 6 rigid motions of each connected set that holds no fixed body.
  const conn = classes(components.length);
  for (const m of active) conn.union(index.get(m.a.component)!, index.get(m.b.component)!);
  const floating = new Set(components.map((_, i) => conn.find(i))).size - new Set(fixed.map((c) => conn.find(index.get(c.id)!))).size;
  const mobility = Math.max(0, K.length - 6 * floating);

  // --- Liaisons between classes ---
  const liaisons: Liaison[] = [];
  const couplings: Coupling[] = [];
  const pairs = new Map<string, Mate[]>();
  for (const m of active) {
    const ca = classOf.get(m.a.component)!;
    const cb = classOf.get(m.b.component)!;
    if (ca === cb) continue;
    const key = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
    pairs.set(key, [...(pairs.get(key) ?? []), m]);
  }
  /** Relative twist space of the bodies `moving` (as one rigid body) under `ms`, the others being held. */
  const relative = (moving: string[], ms: Mate[]) => {
    const c = scale(moving.reduce<V3>((s, id) => add(s, centre(poses.get(id)!)), [0, 0, 0]), 1 / moving.length);
    const ker = kernel(jacobian(sys, ms, [{ bodies: moving, c }]), 6);
    return ker.map((x) => twistOf(x, 0, c, L));
  };
  for (const [key, ms] of pairs) {
    const [a, b] = key.split(":").map(Number) as [number, number];
    for (const type of new Set(ms.filter((m) => COUPLING.has(m.type)).map((m) => m.type))) {
      couplings.push({ a, b, type, mates: ms.filter((m) => m.type === type).map((m) => m.id) });
    }
    const joint = ms.filter((m) => !COUPLING.has(m.type));
    if (!joint.length) continue;
    // The class that moves: never the ground.
    const moving = list[b]!.ground ? list[a]! : list[b]!;
    liaisons.push({ a, b, ...classifyTwists(relative(moving.bodies, joint), L), mates: joint.map((m) => m.id) });
  }

  // --- Hyperstatism: h = Ns − rank(J), Ns: static unknowns of the joints between bodies (not between classes). ---
  let Ns = 0;
  const bodyPairs = new Map<string, Mate[]>();
  for (const m of active) {
    if (byId.get(m.a.component)!.fixed && byId.get(m.b.component)!.fixed) continue;
    if (COUPLING.has(m.type)) {
      Ns += 1;
      continue;
    }
    const key = [m.a.component, m.b.component].sort().join("\u0000");
    bodyPairs.set(key, [...(bodyPairs.get(key) ?? []), m]);
  }
  for (const [key, ms] of bodyPairs) {
    const [p, q] = key.split("\u0000") as [string, string];
    const moving = byId.get(q)!.fixed ? p : q;
    Ns += 6 - relative([moving], ms).length;
  }
  const rank = movers.length * 6 - K.length;
  return { classes: list, liaisons, couplings, mobility, hyperstatic: Math.max(0, Ns - rank) };
}
