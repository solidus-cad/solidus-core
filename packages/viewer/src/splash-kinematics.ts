/**
 * Kinematics of the splash screen mechanisms (Geneva drive, excavator, anchor escapement, Jansen walker), without three.js:
 * profiles, laws of motion and contact simulation, checked for interferences by the tests (test/splash-kinematics.test.ts).
 */

export type P = [number, number];
const TAU = Math.PI * 2;
export const polar = (r: number, a: number): P => [r * Math.cos(a), r * Math.sin(a)];
const rotP = (p: P, a: number): P => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
export const transform = (pts: readonly P[], a: number, dx = 0, dy = 0): P[] => pts.map((p) => { const q = rotP(p, a); return [q[0] + dx, q[1] + dy]; });
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

// ---------------------------------------------------------------------------------------------------------------------
// 2D geometry helpers (interference checks)

/** Point in polygon (even-odd). */
export function inside(p: P, poly: readonly P[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
/** Distance from a point to the outline of a polygon. */
export function edgeDistance(p: P, poly: readonly P[]): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!, b = poly[i]!;
    const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2)) : 0;
    d = Math.min(d, Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey));
  }
  return d;
}
/** Smallest gap between two polygons (negative when they overlap: a vertex of one inside the other). */
export function gap(a: readonly P[], b: readonly P[]): number {
  let d = Infinity;
  for (const p of a) { if (inside(p, b)) return -edgeDistance(p, b); d = Math.min(d, edgeDistance(p, b)); }
  for (const p of b) { if (inside(p, a)) return -edgeDistance(p, a); d = Math.min(d, edgeDistance(p, a)); }
  return d;
}
/** Separating axis test for two convex polygons (true = they overlap by more than `tol`). */
export function convexOverlap(a: readonly P[], b: readonly P[], tol = 0): boolean {
  for (const poly of [a, b]) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const nx = poly[j]![1] - poly[i]![1], ny = poly[i]![0] - poly[j]![0], L = Math.hypot(nx, ny) || 1;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of a) { const s = (p[0] * nx + p[1] * ny) / L; a0 = Math.min(a0, s); a1 = Math.max(a1, s); }
      for (const p of b) { const s = (p[0] * nx + p[1] * ny) / L; b0 = Math.min(b0, s); b1 = Math.max(b1, s); }
      if (a1 - b0 <= tol || b1 - a0 <= tol) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Geneva drive, 4 slots. Wheel centre G = (0, 0), driver centre D = (a, 0). Pin radius r = a·sin 45°.

export const GENEVA = { a: 2, r: 2 * Math.SQRT1_2, R: 2 * Math.SQRT1_2 - 0.03, w: 0.25, pinR: 0.1, rl: 1.0, lockGap: 0.03, cut: 0.025, T: 1.2 };

/** Outline of the wheel (4 slots, 4 locking arcs), wheel frame, slots along 0°, 90°, 180°, 270°. */
export function genevaWheel(): P[] {
  const { a, r, R, w, rl, lockGap } = GENEVA;
  const c = a - r; // closest approach of the pin centre: centre of the round slot end
  const xo = Math.sqrt(R * R - (w / 2) ** 2), delta = Math.asin(w / 2 / R);
  const rc = rl + lockGap, beta = Math.acos((R * R + a * a - rc * rc) / (2 * R * a));
  const pts: P[] = [];
  for (let k = 0; k < 4; k++) {
    const s = (k * Math.PI) / 2;
    pts.push(rotP([xo, -w / 2], s), rotP([c, -w / 2], s));
    for (let i = 1; i < 12; i++) { const g = -Math.PI / 2 - (Math.PI * i) / 12; pts.push(rotP([c + (w / 2) * Math.cos(g), (w / 2) * Math.sin(g)], s)); }
    pts.push(rotP([c, w / 2], s), rotP([xo, w / 2], s));
    const m = s + Math.PI / 4;
    for (let i = 0; i <= 5; i++) pts.push(polar(R, s + delta + ((m - beta - s - delta) * i) / 5));
    const C = polar(a, m), p1 = polar(R, m - beta), p2 = polar(R, m + beta);
    const g1 = Math.atan2(p1[1] - C[1], p1[0] - C[0]);
    let dg = Math.atan2(p2[1] - C[1], p2[0] - C[0]) - g1;
    while (dg > Math.PI) dg -= TAU;
    while (dg < -Math.PI) dg += TAU;
    for (let i = 1; i < 18; i++) { const g = g1 + (dg * i) / 18; pts.push([C[0] + rc * Math.cos(g), C[1] + rc * Math.sin(g)]); }
    for (let i = 0; i <= 5; i++) pts.push(polar(R, m + beta + ((s + Math.PI / 2 - delta - m - beta) * i) / 5));
  }
  return pts;
}

/**
 * Locking disc of the driver (driver frame, pin along +X): radius rl, with the clearance cut facing the pin that lets the
 * wheel turn. The cut is the envelope of the wheel tips seen from the driver during the indexing (plus a margin).
 */
export function genevaLock(): P[] {
  const { a, rl, cut } = GENEVA;
  const n = 360, rho = new Array<number>(n).fill(rl);
  const wheel = genevaWheel();
  for (let s = 0; s <= 600; s++) {
    const f = -Math.PI / 4 - 0.2 + ((Math.PI / 2 + 0.4) * s) / 600;
    const { wheel: wa, drive } = genevaAt(f);
    for (const p of wheel) {
      const g = rotP(p, wa), q = rotP([g[0] - a, g[1]], -drive), dist = Math.hypot(q[0], q[1]);
      if (dist >= rl + cut) continue;
      const i = Math.round(((Math.atan2(q[1], q[0]) + Math.PI) / TAU) * n) % n;
      for (let di = -3; di <= 3; di++) { const j = (i + di + n) % n; rho[j] = Math.min(rho[j]!, Math.max(0.22, dist - cut)); }
    }
  }
  return rho.map((v, i) => polar(v, (i / n) * TAU - Math.PI));
}

/**
 * Angles at crank angle `f` (radians, f = 0: pin on the line of centres, inside). Returns the driver rotation (pin along its +X)
 * and the wheel rotation (slots along its 0°, 90°…).
 */
export function genevaAt(f: number): { wheel: number; drive: number; engaged: boolean } {
  const { a, r } = GENEVA;
  const k = Math.floor((f + Math.PI) / TAU), u = f - k * TAU;
  let loc: number, engaged = false;
  if (u < -Math.PI / 4) loc = Math.PI / 4;
  else if (u > Math.PI / 4) loc = -Math.PI / 4;
  else { loc = Math.atan2(-r * Math.sin(u), a - r * Math.cos(u)); engaged = true; }
  return { wheel: (-k * Math.PI) / 2 + loc, drive: Math.PI + f, engaged };
}

// ---------------------------------------------------------------------------------------------------------------------
// Excavator: boom, stick, bucket in the arm plane (X forward, Y up), bucket driven through a side link and an H-link.

export const DIG = {
  T: 4.8,
  P0: [0.8, 0.75] as P, // boom foot, arm frame
  boomTip: [3.0, 0] as P,
  stickEnd: [2.0, 0] as P,
  // bucket linkage, stick frame: side link pivot Q, bucket cylinder base Bc; bucket frame: link pin K
  Q: [1.55, 0.18] as P,
  Bc: [0.3, 0.46] as P,
  K: [-0.1, 0.3] as P,
  l1: 0.46, // Q → J
  l2: 0.48, // J → K
  // boom cylinders (arm frame → boom frame), stick cylinder (boom → stick)
  boomBase: [1.2, 0.28] as P,
  boomEnd: [1.25, 0.05] as P,
  stickBase: [1.5, 0.74] as P,
  stickEnd2: [-0.5, 0.12] as P,
  /** stick bar (stick frame) from the rear clevis to the bucket pivot, width */
  stickBar: [[-0.3, 0.05], [2.0, 0]] as [P, P],
  stickW: 0.26,
  /** boom bars (boom frame), widths */
  boomBars: [[[0, 0], [1.6, 0.4], 0.4], [[1.6, 0.4], [3.0, 0], 0.34]] as [P, P, number][],
  /** bucket shell (bucket frame): the ears at the pivot and the link pin are separate plates */
  shell: [[0.16, 0.34], [0.45, 0.4], [0.85, 0.25], [1.05, -0.05], [1.12, -0.34], [0.95, -0.27], [0.8, 0.0], [0.5, 0.1], [0.24, 0.05], [0.14, 0.14]] as P[],
  /** cylinder radii (barrel), base clearance */
  rb: { boom: 0.085, stick: 0.09, bucket: 0.075 },
  keys: [
    [0.0, { sw: 0, a1: 22, a2: -100, a3: -40 }],
    [0.16, { sw: 0, a1: 8, a2: -62, a3: -22 }],
    [0.36, { sw: 0, a1: 14, a2: -112, a3: -112 }],
    [0.5, { sw: 0, a1: 34, a2: -100, a3: -122 }],
    [0.66, { sw: 1.42, a1: 30, a2: -88, a3: -118 }],
    [0.78, { sw: 1.42, a1: 28, a2: -70, a3: -8 }],
    [0.86, { sw: 1.42, a1: 28, a2: -70, a3: -8 }],
    [1.0, { sw: 0, a1: 22, a2: -100, a3: -40 }],
  ] as [number, Pose][],
};
export interface Pose { sw: number; a1: number; a2: number; a3: number }

export function digPose(ph: number): Pose {
  const K = DIG.keys;
  for (let i = 0; i < K.length - 1; i++) {
    const [t0, a] = K[i]!, [t1, b] = K[i + 1]!;
    if (ph >= t0 && ph <= t1) {
      const u = smooth((ph - t0) / (t1 - t0));
      return { sw: a.sw + (b.sw - a.sw) * u, a1: a.a1 + (b.a1 - a.a1) * u, a2: a.a2 + (b.a2 - a.a2) * u, a3: a.a3 + (b.a3 - a.a3) * u };
    }
  }
  return K[0]![1];
}

/** Circle–circle intersection; `left` picks the solution on the left of P → Q. */
export function circles(P: P, r1: number, Q: P, r2: number, left: boolean): P | null {
  const dx = Q[0] - P[0], dy = Q[1] - P[1], d = Math.hypot(dx, dy);
  if (d > r1 + r2 || d < Math.abs(r1 - r2) || d === 0) return null;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const bx = P[0] + (a * dx) / d, by = P[1] + (a * dy) / d, s = left ? 1 : -1;
  return [bx - (s * h * dy) / d, by + (s * h * dx) / d];
}

/** Bucket linkage in the stick frame at bucket angle a3 (degrees): link pin K, joint J (cylinder rod end). */
export function bucketLink(a3: number): { K: P; J: P } | null {
  const k = rotP(DIG.K, (a3 * Math.PI) / 180);
  const K: P = [DIG.stickEnd[0] + k[0], DIG.stickEnd[1] + k[1]];
  const J = circles(DIG.Q, DIG.l1, K, DIG.l2, true);
  return J ? { K, J } : null;
}

/** Rectangle of a bar of width w between two points. */
export function barRect(a: P, b: P, w: number): P[] {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = (-dy / L) * (w / 2), ny = (dx / L) * (w / 2);
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
}

/**
 * In-plane clearances of the parts that share the arm mid-plane (z = 0): stick and bucket cylinders against the boom, the
 * stick and the side link lug; bucket shell against the stick. Smallest gap over the cycle (negative = interference).
 */
export function digClearances(samples = 240): Record<string, number> {
  const D = Math.PI / 180, out: Record<string, number> = {};
  const note = (k: string, g: number) => (out[k] = Math.min(out[k] ?? Infinity, g));
  const [sa, sb] = DIG.stickBar;
  for (let s = 0; s <= samples; s++) {
    const p = digPose(s / samples);
    const boomA = p.a1 * D, a2 = p.a2 * D, a3 = p.a3 * D;
    // stick frame → boom frame
    const sToB = (q: P): P => { const v = rotP(q, a2); return [DIG.boomTip[0] + v[0], DIG.boomTip[1] + v[1]]; };
    const stick = barRect(sa, sb, DIG.stickW);
    // stick cylinder (boom frame): base on the boom top, rod end at the stick rear
    const c1: [P, P] = [DIG.stickBase, sToB(DIG.stickEnd2)];
    const cylRect = (a: P, b: P, r: number, from: number) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), u: P = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      return barRect([a[0] + u[0] * from, a[1] + u[1] * from], [b[0] - u[0] * 0.12, b[1] - u[1] * 0.12], 2 * r);
    };
    for (const [a, b, w] of DIG.boomBars) note("stickCyl/boom", gap(cylRect(...c1, DIG.rb.stick * 1.18, 0.13), barRect(a, b, w)));
    note("stickCyl/stick", gap(cylRect(...c1, DIG.rb.stick * 1.18, 0.13), stick.map(sToB)));
    const link = bucketLink(p.a3);
    if (!link) { note("link", -1); continue; }
    const c2 = cylRect(DIG.Bc, link.J, DIG.rb.bucket * 1.18, 0.13);
    note("bucketCyl/stick", gap(c2, stick));
    // bucket shell in the stick frame
    const shell = DIG.shell.map((q): P => { const v = rotP(q, a3); return [DIG.stickEnd[0] + v[0], DIG.stickEnd[1] + v[1]]; });
    note("shell/stick", gap(shell, stick));
    note("shell/bucketCyl", gap(shell, c2));
    note("shell/Hlink", gap(shell, barRect(link.J, link.K, 0.1)));
    note("shell/sideLink", gap(shell, barRect(DIG.Q, link.J, 0.09)));
    void boomA;
  }
  return out;
}

/** Arm points in the arm frame for a pose: used for the cylinder lengths. */
export function digPoints(p: Pose) {
  const D = Math.PI / 180;
  const boomA = p.a1 * D, stickA = (p.a1 + p.a2) * D;
  const toArm = (q: P, a: number, o: P): P => { const v = rotP(q, a); return [o[0] + v[0], o[1] + v[1]]; };
  const tip = toArm(DIG.boomTip, boomA, DIG.P0);
  const link = bucketLink(p.a3);
  return {
    boom: [DIG.boomBase, toArm(DIG.boomEnd, boomA, DIG.P0)] as [P, P],
    stick: [toArm(DIG.stickBase, boomA, DIG.P0), toArm(DIG.stickEnd2, stickA, tip)] as [P, P],
    bucket: link ? ([toArm(DIG.Bc, stickA, tip), toArm(link.J, stickA, tip)] as [P, P]) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Anchor escapement: escape wheel (30 teeth, clockwise) and anchor whose pallets move almost radially (pivot on the tangents).

const deg = Math.PI / 180;
export const ESC = { n: 30, rR: 0.8, rT: 1.0, Rc: 1.075, half: 0.1, wid: 0.04, slant: 0.05, theta: 39 * deg, A: 5 * deg, T: 1.2 };
export const escPivot = (): P => [0, ESC.Rc / Math.cos(ESC.theta)];

/** Tooth triangles (wheel frame), tooth i at -i·pitch: trailing root, tip leaning forward (clockwise), leading root. */
export function escTeeth(): P[][] {
  const { n, rR, rT } = ESC, p = TAU / n;
  return Array.from({ length: n }, (_, i) => { const b = -i * p; return [polar(rR, b + 0.02 * p), polar(rT, b - 0.5 * p), polar(rR, b - 0.58 * p)]; });
}
/** Wheel outline (wheel frame) from the tooth triangles and the root circle. */
export function escWheel(): P[] {
  const { n, rR } = ESC, p = TAU / n, pts: P[] = [];
  for (let i = 0; i < n; i++) {
    const b = -i * p;
    pts.push(polar(rR, b), polar(ESC.rT, b - 0.5 * p), polar(rR, b - 0.58 * p), polar(rR, b - 0.79 * p));
  }
  return pts;
}
/** Pallets in the anchor frame (pivot at the origin): [left, right], quadrilaterals with the slanted impulse face. */
export function escPallets(): P[][] {
  const { Rc, half, wid, slant, theta } = ESC, pv = escPivot();
  return [-1, 1].map((sx) => {
    const c: P = [sx * Rc * Math.sin(theta), Rc * Math.cos(theta)];
    const u: P = [c[0] / Rc, c[1] / Rc], v: P = [-u[1], u[0]]; // radial outward, tangent towards larger polar angles (entry side)
    const at = (l: number, s: number): P => [c[0] + u[0] * l + v[0] * s - pv[0], c[1] + u[1] * l + v[1] * s - pv[1]];
    return [at(-half + slant, wid), at(half, wid), at(half, -wid), at(-half, -wid)];
  });
}

/**
 * Contact simulation: anchor angle A·sin(2πt/T); the wheel is driven clockwise (bounded speed) and advances as far as the
 * pallets allow, or recoils when a pallet pushes a tooth back. Steady state, sampled over two periods (2·T).
 */
export function escSimulate(samples = 480): { wheel: Float64Array; anchor: (t: number) => number; advance: number; minGap: number } {
  const { T, A } = ESC, pitch = TAU / ESC.n, pv = escPivot();
  const teeth = escTeeth(), pallets = escPallets();
  const anchor = (t: number) => A * Math.sin((TAU * t) / T);
  const blocked = (w: number, an: number) => {
    for (const pal of pallets) {
      const P = transform(pal, an, pv[0], pv[1]);
      const pa = Math.atan2(P[0]![1], P[0]![0]);
      for (let i = 0; i < teeth.length; i++) {
        let da = -i * pitch + w - pa;
        da = ((da % TAU) + TAU + Math.PI) % TAU - Math.PI;
        if (Math.abs(da) > 0.5) continue;
        if (convexOverlap(transform(teeth[i]!, w), P, 1e-4)) return true;
      }
    }
    return false;
  };
  const dt = 1 / 480, vmax = 420 * deg * dt;
  let w = 0;
  // free start position
  while (blocked(w, anchor(0))) w += 0.2 * deg;
  const step = (t: number) => {
    const an = anchor(t);
    let back = 0;
    while (blocked(w, an) && back < 60) { w += 0.05 * deg; back++; } // recoil
    if (!blocked(w - vmax, an)) { w -= vmax; return; }
    let lo = 0, hi = vmax;
    for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; if (blocked(w - m, an)) hi = m; else lo = m; }
    w -= lo;
  };
  let t = 0;
  for (; t < 3 * T; t += dt) step(t);
  const out = new Float64Array(samples + 1);
  const t0 = t, w0 = w;
  let k = 0;
  for (; k <= samples; ) {
    const target = t0 + (2 * T * k) / samples;
    while (t < target) { step(t); t += dt; }
    out[k++] = w;
  }
  // exact loop: the residual drift of the warm-up (a few thousandths of a pitch) spread over the period
  const drift = w0 - out[samples]! - 2 * pitch;
  for (let i = 0; i <= samples; i++) out[i] += (drift * i) / samples;
  // minimal distance tooth–pallet over the recorded period (should stay ≥ 0)
  let minGap = Infinity;
  for (let i = 0; i < samples; i += 4) {
    const an = anchor(t0 + (2 * T * i) / samples);
    for (const pal of pallets) {
      const P = transform(pal, an, pv[0], pv[1]);
      for (const tooth of teeth) { const g = gap(transform(tooth, out[i]!), P); if (g < 0.3) minGap = Math.min(minGap, g); }
    }
  }
  return { wheel: out, anchor: (tt) => anchor(tt + t0), advance: (w0 - out[samples]! + drift) / pitch, minGap };
}

/** Trapezoid teeth of a spur gear (gear frame), tooth i around angle i·pitch. */
export function gearTeeth(n: number, rr: number, ra: number): P[][] {
  const p = TAU / n;
  return Array.from({ length: n }, (_, i) => { const b = i * p - 0.325 * p; return [polar(rr, b), polar(ra, b + 0.2 * p), polar(ra, b + 0.45 * p), polar(rr, b + 0.65 * p)]; });
}
/** Phase of the driven gear (radians) for which the teeth of a pair mesh without overlap over a pitch of the pinion. */
export function meshPhase(n1: number, r1: [number, number], n2: number, r2: [number, number], dist: number, dir: number): number {
  const t1 = gearTeeth(n1, ...r1), t2 = gearTeeth(n2, ...r2);
  let best = 0, bestScore = Infinity;
  for (let s = 0; s < 60; s++) {
    const ph = ((TAU / n2) * s) / 60;
    let score = 0;
    for (let k = 0; k < 16; k++) {
      const a1 = ((TAU / n1) * k) / 16, a2 = ph - (a1 * n1) / n2;
      const A = t1.map((t) => transform(t, a1));
      const B = t2.map((t) => transform(t, a2, dist * Math.cos(dir), dist * Math.sin(dir)));
      for (const a of A) for (const b of B) if (convexOverlap(a, b, 1e-4)) score++;
    }
    if (score < bestScore) { bestScore = score; best = ph; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// Jansen linkage ("holy numbers"), crank at the origin, fixed pivot B = (-a, -l).

export const JANSEN = { a: 38, b: 41.5, c: 39.3, d: 40.1, e: 55.8, f: 39.4, g: 36.7, h: 65.7, i: 49, j: 50, k: 61.9, l: 7.8, m: 15 };
export type Leg = Record<"O" | "M" | "B" | "C" | "D" | "E" | "F" | "G", P>;
export function jansenLeg(th: number): Leg {
  const L = JANSEN;
  const M = polar(L.m, th), B: P = [-L.a, -L.l], O: P = [0, 0];
  const pick = (s1: P | null, s2: P | null, better: (x: P, y: P) => boolean): P => (s1 && s2 ? (better(s1, s2) ? s1 : s2) : (s1 ?? s2 ?? [0, 0]));
  const both = (P1: P, r1: number, P2: P, r2: number, better: (x: P, y: P) => boolean) => pick(circles(P1, r1, P2, r2, true), circles(P1, r1, P2, r2, false), better);
  const up = (x: P, y: P) => x[1] > y[1], lo = (x: P, y: P) => x[1] < y[1], le = (x: P, y: P) => x[0] < y[0];
  const C = both(M, L.j, B, L.b, up), D = both(M, L.k, B, L.c, lo), E = both(B, L.d, C, L.e, le), F = both(E, L.f, D, L.g, le), G = both(F, L.h, D, L.i, lo);
  return { O, M, B, C, D, E, F, G };
}
export const JANSEN_EDGES: [keyof Leg, keyof Leg][] = [["O", "M"], ["M", "C"], ["M", "D"], ["B", "C"], ["B", "D"], ["B", "E"], ["C", "E"], ["E", "F"], ["D", "F"], ["D", "G"], ["F", "G"]];
