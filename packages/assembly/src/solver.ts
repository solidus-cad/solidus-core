import type { AssemblyComponent, Mate, MateDrive, MateRef, Matrix4, Scope } from "@solidus-cad/sdk";
import { COUPLING_MATES, evaluate } from "@solidus-cad/sdk";

const COUPLING = new Set<string>(COUPLING_MATES);

/**
 * Assembly constraint solver (rigid bodies).
 * Unknowns: for each free occurrence involved, a translation (3) and a small rotation (3, rotation vector).
 * Method: Levenberg-Marquardt, Jacobian by finite differences. Sufficient for assemblies of a few dozen parts.
 */

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1));

/** 3×3 rotation matrix (row-major) of a rotation vector (Rodrigues' formula). */
function rotation(r: V3): number[] {
  const th = Math.hypot(...r);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(r, 1 / th);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

const rot = (R: number[], v: V3): V3 => [R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2], R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2], R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2]];

/** Applies a 4×4 column-major matrix (three.js convention). */
function applyPoint(m: Matrix4, p: V3): V3 {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
}
function applyDir(m: Matrix4, d: V3): V3 {
  return [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]];
}

/** Inverse of a rigid 4×4 column-major matrix. */
function invertRigid(m: Matrix4): Matrix4 {
  const t: V3 = [m[12]!, m[13]!, m[14]!];
  const out = [m[0]!, m[4]!, m[8]!, 0, m[1]!, m[5]!, m[9]!, 0, m[2]!, m[6]!, m[10]!, 0, 0, 0, 0, 1];
  out[12] = -(out[0]! * t[0] + out[4]! * t[1] + out[8]! * t[2]);
  out[13] = -(out[1]! * t[0] + out[5]! * t[1] + out[9]! * t[2]);
  out[14] = -(out[2]! * t[0] + out[6]! * t[1] + out[10]! * t[2]);
  return out;
}

/** Composes: rotation `R` about point `c`, then translation `t`, applied to matrix `m0`. */
function compose(m0: Matrix4, R: number[], c: V3, t: V3): Matrix4 {
  const out = [...m0];
  for (let col = 0; col < 3; col++) {
    const v = rot(R, [m0[col * 4]!, m0[col * 4 + 1]!, m0[col * 4 + 2]!]);
    out[col * 4] = v[0];
    out[col * 4 + 1] = v[1];
    out[col * 4 + 2] = v[2];
  }
  const p = add(add(rot(R, sub([m0[12]!, m0[13]!, m0[14]!], c)), c), t);
  out[12] = p[0];
  out[13] = p[1];
  out[14] = p[2];
  return out;
}

export interface SolveResult {
  ok: boolean;
  /** Updated matrices, per occurrence. */
  matrices: Record<string, Matrix4>;
  /** Remaining degrees of freedom of the constrained occurrences. */
  dof: number;
  /** Unsatisfied constraints (mutually incompatible). */
  failing: string[];
  residual: number;
}

function world(ref: MateRef, m: Matrix4): { p: V3; d: V3; u?: V3 } {
  return { p: applyPoint(m, ref.p), d: normalize(applyDir(m, ref.d)), u: ref.u ? normalize(applyDir(m, ref.u)) : undefined };
}

/** Component of `v` perpendicular to the unit direction `d`. */
const perp = (v: V3, d: V3): V3 => sub(v, scale(d, dot(v, d)));

/**
 * Residuals of a motion driver, in addition to those of the constraint (axes already coincident):
 * rotary: direction `ub` of B = direction `ua` of A rotated by the requested angle about the axis of A;
 * linear: position of B's point along the axis of A (normal of A's plane for a parallel mate).
 */
function driveResiduals(drive: MateDrive, a: { p: V3; d: V3 }, b: { p: V3; d: V3 }, ua: V3 | undefined, ub: V3 | undefined): number[] {
  if (drive.kind === "linear") return [dot(sub(b.p, a.p), a.d) - drive.value];
  if (!ua || !ub) return [];
  const target = rot(rotation(scale(a.d, (drive.value * Math.PI) / 180)), ua);
  return perp(sub(ub, target), a.d);
}

/**
 * Signed rotation (rad) of a body about the axis `ref.d` from pose `m0`: angle of ΔR = R·R0ᵀ projected onto the
 * starting axis. An increment (not an absolute angle): the coupling keeps the initial phase of both bodies, and stays
 * continuous as long as the step between two resolutions is less than a half turn (successive Motion frames).
 */
function turned(ref: MateRef, m: Matrix4, m0: Matrix4): number {
  const n = normalize(applyDir(m0, ref.d));
  const M = (i: number, k: number) => [0, 1, 2].reduce((s, j) => s + m[j * 4 + i]! * m0[j * 4 + k]!, 0);
  const vee: V3 = [(M(2, 1) - M(1, 2)) / 2, (M(0, 2) - M(2, 0)) / 2, (M(1, 0) - M(0, 1)) / 2];
  const c = (M(0, 0) + M(1, 1) + M(2, 2) - 1) / 2;
  return Math.atan2(dot(n, vee), c);
}

/**
 * Residual of a coupling constraint (gear, belt, rack and pinion), in radians or mm:
 * gear θB + k·θA; belt θB − k·θA; rack and pinion ΔsB − r·θA (ΔsB: displacement of B's point along its axis).
 */
function couplingResidual(mate: Mate, ma: Matrix4, mb: Matrix4, ma0: Matrix4, mb0: Matrix4, value: number): number[] {
  const k = (mate.flip ? -1 : 1) * value;
  const thA = turned(mate.a, ma, ma0);
  if (mate.type === "rackpinion") {
    const axis = normalize(applyDir(mb0, mate.b.d));
    const ds = dot(sub(applyPoint(mb, mate.b.p), applyPoint(mb0, mate.b.p)), axis);
    return [ds - k * thA];
  }
  const thB = turned(mate.b, mb, mb0);
  return [mate.type === "gear" ? thB + k * thA : thB - k * thA];
}

/** Residuals of a constraint (zero when satisfied). */
function residuals(mate: Mate, a: { p: V3; d: V3; u?: V3 }, b: { p: V3; d: V3; u?: V3 }, value: number): number[] {
  const sign = mate.flip ? -1 : 1;
  const ka = mate.a.kind;
  const kb = mate.b.kind;
  // Mixed pairs: `x` is the element of the first kind, `y` the one of the second (plane < axis < point).
  const order = { plane: 0, axis: 1, point: 2 } as const;
  const [x, y] = order[ka] <= order[kb] ? [a, b] : [b, a];
  const pair = order[ka] <= order[kb] ? `${ka}/${kb}` : `${kb}/${ka}`;
  const v = mate.type === "distance" ? value : 0;
  switch (mate.type) {
    case "coincident":
    case "distance":
      switch (pair) {
        case "axis/axis": {
          // Axes coincident, or parallel at the requested distance.
          const c = cross(a.d, b.d);
          const off = perp(sub(b.p, a.p), a.d);
          return v === 0 ? [...c, ...off] : [...c, Math.hypot(...off) - v];
        }
        case "plane/axis":
          // Axis in the plane (or parallel to the plane, at the requested distance).
          return [dot(y.d, x.d), dot(sub(y.p, x.p), x.d) - sign * v];
        case "plane/point":
          return [dot(sub(y.p, x.p), x.d) - sign * v];
        case "axis/point": {
          const off = perp(sub(y.p, x.p), x.d);
          return v === 0 ? off : [Math.hypot(...off) - v];
        }
        case "point/point": {
          const off = sub(b.p, a.p);
          return v === 0 ? off : [Math.hypot(...off) - v];
        }
        default: {
          // Planes: opposite normals (faces facing each other), or aligned if `flip`; offset = value.
          const o = add(a.d, scale(b.d, sign));
          return [...o, dot(sub(b.p, a.p), a.d) - v];
        }
      }
    case "concentric": {
      if (pair === "axis/point") return perp(sub(y.p, x.p), x.d);
      const r = [...cross(a.d, b.d), ...perp(sub(b.p, a.p), a.d)];
      // Rotation locked: frame directions of both parts coincide around the common axis.
      return mate.lockRotation && a.u && b.u ? [...r, ...perp(sub(b.u, a.u), a.d)] : r;
    }
    case "parallel":
      if (pair === "plane/plane") return [...add(a.d, scale(b.d, sign))];
      // Axis parallel to a plane: direction perpendicular to the normal.
      return pair === "plane/axis" ? [dot(a.d, b.d)] : [...cross(a.d, b.d)];
    case "perpendicular":
      // Axis perpendicular to a plane: direction aligned with the normal.
      return pair === "plane/axis" ? [...cross(a.d, b.d)] : [dot(a.d, b.d)];
    case "gear":
    case "belt":
    case "rackpinion":
      return []; // motion coupling: see `couplingResidual`
    case "angle": {
      const rad = (value * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      // At 0° and 180° (90° for an axis and a plane) the scalar forms below have a zero derivative at the solution:
      // the constraint would remove no degree of freedom (DOF count, liaison graph) and converge slowly.
      // These angles take the vector form of the equivalent parallel / perpendicular constraint.
      const extreme = 1 - 1e-12;
      if (pair === "plane/axis") {
        if (Math.abs(cos) >= extreme) return [dot(a.d, b.d)]; // axis parallel to the plane
        if (Math.abs(sin) >= extreme) return [...cross(a.d, b.d)]; // axis along the normal (either sense)
        // Angle of an axis with a plane: complement of the angle with the normal (squared: no preferred sign).
        return [dot(a.d, b.d) ** 2 - sin ** 2];
      }
      if (cos >= extreme) return [...sub(b.d, a.d)]; // same directions
      if (cos <= -extreme) return [...add(b.d, a.d)]; // opposite directions
      return [dot(a.d, b.d) - cos];
    }
  }
}

/**
 * Residuals of a constraint for the poses `ma`, `mb` of its two bodies (`ma0`, `mb0`: reference poses, used by the
 * motion couplings). Motion drivers are ignored: the residuals describe the joint, not its actuation.
 */
export function mateResidual(mate: Mate, ma: Matrix4, mb: Matrix4, ma0: Matrix4, mb0: Matrix4, value: number): number[] {
  if (COUPLING.has(mate.type)) return couplingResidual(mate, ma, mb, ma0, mb0, value);
  return residuals(mate, world(mate.a, ma), world(mate.b, mb), value);
}

/** Pose `m0` displaced by the rotation vector `r` (rad) about point `c`, then by the translation `t`. */
export function displace(m0: Matrix4, t: V3, r: V3, c: V3): Matrix4 {
  return compose(m0, rotation(r), c, t);
}

/** Numeric value of a constraint (expression evaluated in `scope`; 0 if it cannot be evaluated). */
export function mateValue(m: Mate, scope: Scope = new Map()): number {
  try {
    return m.value ? evaluate(m.value, scope) : 0;
  } catch {
    return 0;
  }
}

export interface SolveOptions {
  /**
   * Interactive move: poses towards which these occurrences are pulled (manipulator), the constraints keeping
   * priority. The other occurrences stay as close as possible to their pose; only the group linked to the pulled
   * occurrences (through constraints, without crossing fixed occurrences) is solved.
   */
  pull?: Map<string, Matrix4>;
}

/** Solves the constraints; fixed occurrences and unconstrained ones do not move. */
export function solveMates(components: AssemblyComponent[], mates: Mate[], scope: Scope = new Map(), opts: SolveOptions = {}): SolveResult {
  const pull = opts.pull && opts.pull.size > 0 ? opts.pull : null;
  const active = mates.filter((m) => !m.suppressed && !m.unresolved);
  const byId = new Map(components.map((c) => [c.id, c]));
  const involved = [...new Set(active.flatMap((m) => [m.a.component, m.b.component]))].filter((id) => byId.has(id));
  let free = involved.filter((id) => !byId.get(id)!.fixed);
  if (pull) {
    // Group reachable from the pulled occurrences; the rest of the assembly is not affected by the move.
    const reach = new Set([...pull.keys()].filter((id) => byId.has(id) && !byId.get(id)!.fixed));
    const queue = [...reach];
    while (queue.length) {
      const id = queue.pop()!;
      for (const m of active) {
        const other = m.a.component === id ? m.b.component : m.b.component === id ? m.a.component : null;
        if (!other || reach.has(other) || !byId.has(other) || byId.get(other)!.fixed) continue;
        reach.add(other);
        queue.push(other);
      }
    }
    free = [...reach];
  }
  const m0 = new Map(components.map((c) => [c.id, [...c.matrix]]));
  const values = new Map(active.map((m) => {
    let v = 0;
    // Driven distance or angle: the image value replaces that of the constraint.
    if (m.drive && (m.type === "distance" || m.type === "angle")) return [m.id, [m.drive].flat()[0]!.value];
    try {
      v = m.value ? evaluate(m.value, scope) : 0;
    } catch {
      v = 0;
    }
    return [m.id, v];
  }));
  // Rotation about the current center of each occurrence (better conditioning).
  const centers = new Map(free.map((id) => [id, [m0.get(id)![12]!, m0.get(id)![13]!, m0.get(id)![14]!] as V3]));
  const n = free.length * 6;
  // Rotation unknowns expressed as lengths (angle × L, L: distance of the constrained elements from the rotation center):
  // translations and rotations then have effects of the same order, which keeps the solver from stalling.
  let L = 1;
  for (const m of active) {
    for (const ref of [m.a, m.b]) {
      const c = centers.get(ref.component);
      if (c) L = Math.max(L, Math.hypot(...sub(applyPoint(m0.get(ref.component)!, ref.p), c)));
    }
  }

  const matricesFor = (x: number[]): Map<string, Matrix4> => {
    const out = new Map(m0);
    free.forEach((id, k) => {
      const t: V3 = [x[k * 6]!, x[k * 6 + 1]!, x[k * 6 + 2]!];
      const r: V3 = [x[k * 6 + 3]! / L, x[k * 6 + 4]! / L, x[k * 6 + 5]! / L];
      out.set(id, compose(m0.get(id)!, rotation(r), centers.get(id)!, t));
    });
    return out;
  };

  const evalAll = (x: number[]): { f: number[]; per: { id: string; r: number[] }[] } => {
    const ms = matricesFor(x);
    const per = active
      .filter((m) => byId.has(m.a.component) && byId.has(m.b.component))
      .map((m) => {
        const ma = ms.get(m.a.component)!;
        const mb = ms.get(m.b.component)!;
        const a = world(m.a, ma);
        const b = world(m.b, mb);
        // Rotary motor on a rotation-locked concentric mate: the motor replaces the lock.
        const rotaryDriven = !!m.drive && [m.drive].flat().some((d) => d.kind === "rotary");
        const shape = m.lockRotation && rotaryDriven ? { ...m, lockRotation: false } : m;
        const r = COUPLING.has(m.type)
          ? couplingResidual(m, ma, mb, m0.get(m.a.component)!, m0.get(m.b.component)!, values.get(m.id) ?? 0)
          : residuals(shape, a, b, values.get(m.id) ?? 0);
        if (m.drive && (m.type === "concentric" || m.type === "coincident" || m.type === "parallel")) {
          for (const d of [m.drive].flat()) {
            const ua = d.ua ? normalize(applyDir(ma, d.ua)) : undefined;
            const ub = d.ub ? normalize(applyDir(mb, d.ub)) : undefined;
            r.push(...driveResiduals(d, a, b, ua, ub));
          }
        }
        return { id: m.id, r };
      });
    return { f: per.flatMap((p) => p.r), per };
  };

  /**
   * Pull residuals (interactive move): three points of each free occurrence (center, center + L·x, center + L·y)
   * towards their target pose; weight 1 for the pulled occurrences, weak for the others (they stay in place
   * unless the constraints carry them along).
   */
  const anchors = new Map(free.map((id) => {
    const c = centers.get(id)!;
    const inv = invertRigid(m0.get(id)!);
    return [id, [c, add(c, [L, 0, 0]), add(c, [0, L, 0])].map((p) => applyPoint(inv, p))] as const;
  }));
  const pullResiduals = (x: number[]): number[] => {
    const ms = matricesFor(x);
    const out: number[] = [];
    for (const id of free) {
      const target = pull?.get(id);
      const w = target ? 1 : 1e-3;
      const goal = target ?? m0.get(id)!;
      for (const q of anchors.get(id)!) out.push(...scale(sub(applyPoint(ms.get(id)!, q), applyPoint(goal, q)), w));
    }
    return out;
  };

  const norm2 = (v: number[]) => v.reduce((s, e) => s + e * e, 0);
  let J: number[][] = [];

  /**
   * Jacobian by central differences: forward differences, too imprecise on curved residuals
   * (normals, directions), reduced Levenberg-Marquardt to a slow convergence that stopped before the solution.
   */
  const centralJacobian = (x0: number[], fx: (x: number[]) => number[] = (x) => evalAll(x).f) => {
    const h = 1e-5;
    const cols: number[][] = [];
    for (let j = 0; j < n; j++) {
      const xp = [...x0];
      const xm = [...x0];
      xp[j] = xp[j]! + h;
      xm[j] = xm[j]! - h;
      const fp = fx(xp);
      const fm = fx(xm);
      cols.push(fp.map((v, i) => (v - fm[i]!) / (2 * h)));
    }
    return (cols[0] ?? []).map((_, i) => cols.map((c) => c[i]!));
  };

  /**
   * Levenberg-Marquardt from `x0`, minimum-norm step: JᵀJ is decomposed into eigenpairs and the free directions
   * (near-zero eigenvalues: remaining degrees of freedom, slides and rotations with no effect) are excluded from
   * the step. Solved as is, the system took excessive steps there, distorted by the curvature of the constraints:
   * the step was rejected, the damping then slowed all directions and the descent stalled before the solution
   * (constraint wrongly rejected, for example a connecting rod to place on an already mounted crankshaft).
   */
  const descend = (x0: number[]) => {
    let x = x0;
    let f = evalAll(x).f;
    let cost = norm2(f);
    let lambda = 1e-3;
    for (let iter = 0; iter < 100 && n > 0 && cost > 1e-20; iter++) {
      const Jx = centralJacobian(x);
      const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => Jx.reduce((s, row) => s + row[a]! * row[b]!, 0)));
      const Jtf = Array.from({ length: n }, (_, a) => Jx.reduce((s, row, i) => s + row[a]! * f[i]!, 0));
      const { values, vectors } = symmetricEigen(JtJ);
      const top = Math.max(1e-30, ...values);
      // Retained directions and the gradient component along each.
      const kept = values.map((s2, k) => ({ s2, v: vectors[k]!, g: vectors[k]!.reduce((acc, vi, i) => acc + vi * Jtf[i]!, 0) })).filter((e) => e.s2 > 1e-12 * top);
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        // (JᵀJ + λ JᵀJ) δ = −Jᵀ f, restricted to the retained directions.
        const delta = new Array<number>(n).fill(0);
        for (const e of kept) {
          const c = -e.g / (e.s2 * (1 + lambda));
          for (let i = 0; i < n; i++) delta[i]! += c * e.v[i]!;
        }
        const xn = x.map((v, i) => v + delta[i]!);
        const fn = evalAll(xn).f;
        const cn = norm2(fn);
        if (cn < cost) {
          x = xn;
          f = fn;
          cost = cn;
          lambda = Math.max(lambda / 10, 1e-12);
          improved = true;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { x, cost };
  };

  // Start from the current position; if the solver stops at a saddle point (faces with the same orientation to be
  // placed facing each other: half turn needed), new starts from shifted orientations.
  /**
   * Interactive move: descent of the pull residuals restricted to the motions allowed by the constraints (null
   * space of their Jacobian), each step followed by a return onto the constraints. The constraints thus keep
   * priority: a part on a face slides on it, a part on an axis turns about it, whatever the manipulator pose.
   */
  const pullDescend = (x0: number[]) => {
    let x = descend(x0).x;
    const sq = (v: number[][], a: number, b: number) => v.reduce((s, row) => s + row[a]! * row[b]!, 0);
    let pc = norm2(pullResiduals(x));
    for (let iter = 0; iter < 30 && n > 0 && pc > 1e-20; iter++) {
      const Jc = centralJacobian(x);
      const C = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => sq(Jc, a, b)));
      const ec = symmetricEigen(C);
      const topC = Math.max(0, ...ec.values);
      const N = ec.vectors.filter((_, k) => ec.values[k]! <= 1e-9 * topC);
      if (!N.length) break;
      // Pull step in the null space: least squares on the coordinates z (x += Nᵀ z).
      const p = pullResiduals(x);
      const Jp = centralJacobian(x, pullResiduals);
      const A = Jp.map((row) => N.map((v) => v.reduce((s, vi, i) => s + vi * row[i]!, 0)));
      const k = N.length;
      const AtA = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => sq(A, a, b)));
      const Atp = Array.from({ length: k }, (_, a) => A.reduce((s, row, i) => s + row[a]! * p[i]!, 0));
      const ea = symmetricEigen(AtA);
      const topA = Math.max(1e-30, ...ea.values);
      const z = new Array<number>(k).fill(0);
      ea.values.forEach((s2, j) => {
        if (s2 <= 1e-12 * topA) return;
        const v = ea.vectors[j]!;
        const c = -v.reduce((acc, vi, i) => acc + vi * Atp[i]!, 0) / s2;
        for (let i = 0; i < k; i++) z[i]! += c * v[i]!;
      });
      const step = new Array<number>(n).fill(0);
      N.forEach((v, j) => {
        for (let i = 0; i < n; i++) step[i]! += z[j]! * v[i]!;
      });
      let accepted = false;
      for (let f = 1; f > 1 / 64; f /= 2) {
        const r = descend(x.map((v, i) => v + f * step[i]!));
        const pn = norm2(pullResiduals(r.x));
        if (r.cost < 1e-12 && pn < pc) {
          const gain = pc - pn;
          x = r.x;
          pc = pn;
          accepted = gain > 1e-10 * (pc + gain);
          break;
        }
      }
      if (!accepted) break;
    }
    return { x, cost: norm2(evalAll(x).f) };
  };

  let { x, cost } = pull ? pullDescend(new Array<number>(n).fill(0)) : descend(new Array<number>(n).fill(0));
  const kicks: V3[] = [
    [0.7, 0.4, 0.2],
    [-0.4, 0.7, -0.3],
    [0.2, -0.3, 0.8],
    [1.6, 0.5, -0.4],
  ];
  for (const k of kicks) {
    // Interactive move: no jump to another configuration (the previous pose stays if the move is impossible).
    if (cost <= 1e-14 || n === 0 || pull) break;
    const x0 = new Array<number>(n).fill(0).map((_, i) => (i % 6 >= 3 ? k[(i % 6) - 3]! * L : 0));
    const r = descend(x0);
    if (r.cost < cost) ({ x, cost } = r);
  }

  const final = evalAll(x);
  const tol = 1e-6;
  const failing = final.per.filter((p) => Math.hypot(...p.r) > tol).map((p) => p.id);
  // Rank: central differences (error in h², below the rank threshold; forward differences counted
  // spurious degrees of freedom on curved residuals, such as plane normals).
  if (n > 0) J = centralJacobian(x);
  const dof = n - rank(J, n);
  const ms = matricesFor(x);
  return {
    ok: failing.length === 0,
    matrices: Object.fromEntries(free.map((id) => [id, ms.get(id)!])),
    dof,
    failing,
    residual: Math.sqrt(cost),
  };
}

/**
 * Eigenvalues and eigenvectors of a symmetric matrix: Householder tridiagonalization then implicit QL
 * (tred2 / tql2, after JAMA). `vectors[k]` is the eigenvector of `values[k]`.
 */
export function symmetricEigen(S: number[][]): { values: number[]; vectors: number[][] } {
  const n = S.length;
  const V = S.map((r) => [...r]);
  const d = new Array<number>(n).fill(0);
  const e = new Array<number>(n).fill(0);
  if (n === 0) return { values: [], vectors: [] };
  for (let j = 0; j < n; j++) d[j] = V[n - 1]![j]!;
  // tred2: reduction to a tridiagonal matrix.
  for (let i = n - 1; i > 0; i--) {
    let scale = 0;
    let h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]!);
    if (scale === 0) {
      e[i] = d[i - 1]!;
      for (let j = 0; j < i; j++) {
        d[j] = V[i - 1]![j]!;
        V[i]![j] = 0;
        V[j]![i] = 0;
      }
    } else {
      for (let k = 0; k < i; k++) {
        d[k] = d[k]! / scale;
        h += d[k]! * d[k]!;
      }
      let f = d[i - 1]!;
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      for (let j = 0; j < i; j++) {
        f = d[j]!;
        V[j]![i] = f;
        g = e[j]! + V[j]![j]! * f;
        for (let k = j + 1; k <= i - 1; k++) {
          g += V[k]![j]! * d[k]!;
          e[k] = e[k]! + V[k]![j]! * f;
        }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) {
        e[j] = e[j]! / h;
        f += e[j]! * d[j]!;
      }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j] = e[j]! - hh * d[j]!;
      for (let j = 0; j < i; j++) {
        f = d[j]!;
        g = e[j]!;
        for (let k = j; k <= i - 1; k++) V[k]![j] = V[k]![j]! - (f * e[k]! + g * d[k]!);
        d[j] = V[i - 1]![j]!;
        V[i]![j] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1; i++) {
    V[n - 1]![i] = V[i]![i]!;
    V[i]![i] = 1;
    const h = d[i + 1]!;
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = V[k]![i + 1]! / h;
      for (let j = 0; j <= i; j++) {
        let g = 0;
        for (let k = 0; k <= i; k++) g += V[k]![i + 1]! * V[k]![j]!;
        for (let k = 0; k <= i; k++) V[k]![j] = V[k]![j]! - g * d[k]!;
      }
    }
    for (let k = 0; k <= i; k++) V[k]![i + 1] = 0;
  }
  for (let j = 0; j < n; j++) {
    d[j] = V[n - 1]![j]!;
    V[n - 1]![j] = 0;
  }
  V[n - 1]![n - 1] = 1;
  e[0] = 0;
  // tql2: eigenvalues of the tridiagonal matrix by implicit QL, vectors accumulated in V.
  for (let i = 1; i < n; i++) e[i - 1] = e[i]!;
  e[n - 1] = 0;
  let f = 0;
  let tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l++) {
    tst1 = Math.max(tst1, Math.abs(d[l]!) + Math.abs(e[l]!));
    let m = l;
    while (m < n && Math.abs(e[m]!) > eps * tst1) m++;
    if (m > l) {
      for (let iter = 0; iter < 60; iter++) {
        let g = d[l]!;
        let p = (d[l + 1]! - g) / (2 * e[l]!);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l]! / (p + r);
        d[l + 1] = e[l]! * (p + r);
        const dl1 = d[l + 1]!;
        let h = g - d[l]!;
        for (let i = l + 2; i < n; i++) d[i] = d[i]! - h;
        f += h;
        p = d[m]!;
        let c = 1;
        let c2 = c;
        let c3 = c;
        const el1 = e[l + 1]!;
        let s = 0;
        let s2 = 0;
        for (let i = m - 1; i >= l; i--) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i]!;
          h = c * p;
          r = Math.hypot(p, e[i]!);
          e[i + 1] = s * r;
          s = e[i]! / r;
          c = p / r;
          p = c * d[i]! - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]!);
          for (let k = 0; k < n; k++) {
            h = V[k]![i + 1]!;
            V[k]![i + 1] = s * V[k]![i]! + c * h;
            V[k]![i] = c * V[k]![i]! - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]!) / dl1;
        e[l] = s * p;
        d[l] = c * p;
        if (Math.abs(e[l]!) <= eps * tst1) break;
      }
    }
    d[l] = d[l]! + f;
    e[l] = 0;
  }
  return { values: d, vectors: d.map((_, k) => V.map((row) => row[k]!)) };
}

/** Numerical rank of a matrix (Gaussian elimination with a relative threshold). */
function rank(J: number[][], n: number): number {
  const M = J.map((r) => [...r]);
  let rk = 0;
  const maxAbs = Math.max(1e-12, ...M.flat().map(Math.abs));
  for (let c = 0; c < n && rk < M.length; c++) {
    let p = rk;
    for (let r = rk + 1; r < M.length; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-7 * maxAbs) continue;
    [M[rk], M[p]] = [M[p]!, M[rk]!];
    for (let r = rk + 1; r < M.length; r++) {
      const k = M[r]![c]! / M[rk]![c]!;
      for (let k2 = c; k2 < n; k2++) M[r]![k2] = M[r]![k2]! - k * M[rk]![k2]!;
    }
    rk++;
  }
  return rk;
}
