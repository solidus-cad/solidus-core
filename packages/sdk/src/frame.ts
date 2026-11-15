import type { Feature } from "./document.ts";
import { evaluate, type Scope } from "./expr.ts";
import { sectionArea, sectionFamily, type Section } from "./sections.ts";
import type { V3 } from "./sketch3d.ts";

/**
 * Welded frame: profiles placed on the lines of a skeleton, step by step.
 * Pure functions (shared by the kernel, the UI and the tests):
 *  - placement of each profile (frame, section, alignment);
 *  - end cuts: miter, butt joint (through, flush, overhang, gap),
 *    stop on the profiles already placed (previous steps, or T start);
 *  - cut list.
 * Each end is a plane: the profile keeps the half-space on the side of the normal.
 */

/** Skeleton line copied into the frame (skeleton coordinate system = frame coordinate system). */
export interface FrameSegment {
  key: string;
  a: V3;
  b: V3;
}

export type JointType = "miter" | "butt";
export type JointTrim = "outer" | "axis" | "inner";

/** Setting of a node (coincident ends of several profiles of a step). */
export interface JointSetting {
  type: JointType;
  /** Through profile (segment key); by default, the first of the step. */
  through?: string;
  /** Stop of the through profile: outer face of the butting profile, its axis, or its inner face. */
  trim: JointTrim;
  /** Overhang of the through profile beyond its stop (mm, negative: set back). */
  overhang: number;
  /** Gap between the butting profile and the face of the through profile (mm). */
  gap: number;
}

export interface FrameStepData {
  /** Lines dressed by the step (skeleton keys "sketch:element"). */
  segments: string[];
  /** Line geometry, copied from the skeleton at each change. */
  paths: FrameSegment[];
  /** Settings per node (key: `nodeKey`). */
  joints: Record<string, JointSetting>;
}

export type FrameAnchor = "c" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface FrameStep {
  id: string;
  family: string;
  size: string;
  /** Rotation of the section around the axis (°). */
  rotation: number;
  anchor: FrameAnchor;
  corner: JointType;
  data: FrameStepData;
}

export interface FramePlane {
  p: V3;
  /** Normal pointing toward the retained material. */
  n: V3;
}

export interface MemberLayout {
  key: string;
  step: string;
  family: string;
  size: string;
  section: Section;
  /** Support line and frame: t is the axis, u and v the section axes (already rotated). */
  a: V3;
  b: V3;
  t: V3;
  u: V3;
  v: V3;
  /** Offset of the section in (u, v): alignment. */
  offset: [number, number];
  start: FramePlane;
  end: FramePlane;
  /** Abscissas (along t, from a) of the extreme fibers: the raw bar goes from sMin to sMax. */
  sMin: number;
  sMax: number;
  /** Overall length (mm) and cut angles at both ends (° ; 0 = square cut). */
  length: number;
  angleStart: number;
  angleEnd: number;
}

export const DEFAULT_JOINT: Omit<JointSetting, "type"> = { trim: "outer", overhang: 0, gap: 0 };

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const TOL = 1e-3;
const same = (a: V3, b: V3) => len(sub(a, b)) < TOL;

/** Stable key of a node: profiles meeting there. */
export function nodeKey(members: string[]): string {
  return [...members].sort().join("|");
}

/** Frame step described by a `frameMembers` feature (null if incomplete). */
export function frameStepOf(f: Feature, scope: Scope): FrameStep | null {
  if (f.type !== "frameMembers" || !f.frame) return null;
  const family = f.params.family ?? "";
  let rotation = 0;
  try {
    rotation = evaluate(f.params.rotation ?? "0", scope);
  } catch {
    /* invalid rotation: 0 */
  }
  return {
    id: f.id,
    family,
    size: f.params[`size_${family}`] ?? "",
    rotation,
    anchor: (f.params.anchor as FrameAnchor) || "c",
    corner: f.params.corner === "butt" ? "butt" : "miter",
    data: f.frame,
  };
}

/** Points of the outer contour of the section (discretized circles), section coordinates. */
function outline(s: Section): [number, number][] {
  if (s.outer.kind === "polygon") return s.outer.pts;
  const { c, r } = s.outer;
  return Array.from({ length: 32 }, (_, i) => [c[0] + r * Math.cos((i / 32) * 2 * Math.PI), c[1] + r * Math.sin((i / 32) * 2 * Math.PI)] as [number, number]);
}

function anchorOffset(pts: [number, number][], anchor: FrameAnchor): [number, number] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // The alignment point of the section is brought onto the line.
  const ax = anchor.includes("w") ? x0 : anchor.includes("e") ? x1 : (x0 + x1) / 2;
  const ay = anchor.includes("s") ? y0 : anchor.includes("n") ? y1 : (y0 + y1) / 2;
  return [-ax, -ay];
}

interface Member {
  key: string;
  step: FrameStep;
  section: Section;
  a: V3;
  b: V3;
  t: V3;
  u: V3;
  v: V3;
  offset: [number, number];
  /** Extreme fibers of the section, as vectors (world frame) from the axis. */
  fibers: V3[];
}

/** Support function: maximum advance of the section in direction w (from the axis). */
const support = (m: Member, w: V3) => Math.max(...m.fibers.map((f) => dot(f, w)));

function makeMember(step: FrameStep, seg: FrameSegment): Member | null {
  const fam = sectionFamily(step.family);
  if (!fam) return null;
  let section: Section;
  try {
    section = fam.build(step.size);
  } catch {
    return null;
  }
  const d = sub(seg.b, seg.a);
  if (len(d) < TOL) return null;
  const t = unit(d);
  // Web vertical: Z reference (Y for a vertical profile), as in the "profile" feature.
  const up: V3 = Math.abs(t[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  let u = unit(cross(up, t));
  let v = unit(cross(t, u));
  const ang = (step.rotation * Math.PI) / 180;
  if (ang !== 0) {
    const [c, s] = [Math.cos(ang), Math.sin(ang)];
    [u, v] = [add(mul(u, c), mul(v, s)), add(mul(v, c), mul(u, -s))];
  }
  const pts = outline(section);
  const offset = anchorOffset(pts, step.anchor);
  const fibers = pts.map(([x, y]) => add(mul(u, x + offset[0]), mul(v, y + offset[1])));
  return { key: seg.key, step, section, a: seg.a, b: seg.b, t, u, v, offset, fibers };
}

/** Plane of the face of profile `m` turned toward `dir` (perpendicular to its axis), at the point `at`. */
function facePlane(m: Member, at: V3, dir: V3, gap: number): FramePlane | null {
  const w = sub(dir, mul(m.t, dot(dir, m.t)));
  if (len(w) < 1e-6) return null; // profile in line with the axis
  const n = unit(w);
  const foot = add(m.a, mul(m.t, dot(sub(at, m.a), m.t)));
  return { p: add(foot, mul(n, support(m, n) + gap)), n };
}

/** Distance from a point to the axis (segment) of a profile, and abscissa on the axis. */
function axisDistance(m: Member, p: V3): { d: number; s: number; L: number } {
  const L = len(sub(m.b, m.a));
  const s = dot(sub(p, m.a), m.t);
  const c = Math.max(0, Math.min(L, s));
  return { d: len(sub(p, add(m.a, mul(m.t, c)))), s, L };
}

/** Abscissa (from the end, toward the inside `d`) where the plane cuts the axis; null if parallel. */
function cutDepth(V: V3, d: V3, pl: FramePlane): number | null {
  const k = dot(d, pl.n);
  if (Math.abs(k) < 1e-9) return null;
  return dot(sub(pl.p, V), pl.n) / k;
}

/**
 * Placement of all the profiles of the steps, in order: each step stops on the profiles
 * of the previous steps, which are never modified.
 */
export function layoutFrame(steps: FrameStep[]): MemberLayout[] {
  const placed: Member[] = [];
  const out: MemberLayout[] = [];
  for (const step of steps) {
    const paths = new Map(step.data.paths.map((p) => [p.key, p]));
    const members = step.data.segments.flatMap((k) => {
      const seg = paths.get(k);
      const m = seg ? makeMember(step, seg) : null;
      return m ? [m] : [];
    });
    // Nodes of the step: coincident ends.
    const ends = members.flatMap((m) => [
      { m, V: m.a, d: m.t, isStart: true },
      { m, V: m.b, d: mul(m.t, -1), isStart: false },
    ]);
    const planesFor = new Map<string, FramePlane[]>(); // `${key}:${start|end}`
    const push = (m: Member, isStart: boolean, pl: FramePlane) => {
      const k = `${m.key}:${isStart ? "s" : "e"}`;
      planesFor.set(k, [...(planesFor.get(k) ?? []), pl]);
    };

    const visited = new Set<number>();
    ends.forEach((e, i) => {
      if (visited.has(i)) return;
      const group = ends.map((x, j) => ({ x, j })).filter(({ x }) => same(x.V, e.V));
      group.forEach(({ j }) => visited.add(j));
      if (group.length < 2) return;
      const node = group.map((g) => g.x);
      const override = step.data.joints[nodeKey(node.map((n) => n.m.key))];
      const setting: JointSetting = { ...DEFAULT_JOINT, ...override, type: override?.type ?? step.corner };
      const V = e.V;
      if (node.length === 2 && setting.type === "miter") {
        const [A, B] = node as [(typeof node)[0], (typeof node)[0]];
        const diff = sub(A.d, B.d);
        if (len(diff) < 1e-9) return; // overlapping profiles
        const n = unit(diff);
        push(A.m, A.isStart, { p: V, n });
        push(B.m, B.isStart, { p: V, n: mul(n, -1) });
        return;
      }
      // Butt joint: one through profile, the others butt against it.
      const P = node.find((n) => n.m.key === setting.through) ?? node[0]!;
      let e0 = -Infinity;
      for (const Q of node) {
        if (Q === P) continue;
        const face = facePlane(P.m, V, Q.d, setting.gap);
        push(Q.m, Q.isStart, face ?? { p: V, n: Q.d });
        // Stop of the through profile, measured on the section of the butting profile in the direction opposite to the through profile.
        const w = sub(mul(P.d, -1), mul(Q.m.t, dot(mul(P.d, -1), Q.m.t)));
        const wl = len(w);
        const outer = wl > 1e-6 ? support(Q.m, unit(w)) : 0;
        const inner = wl > 1e-6 ? -support(Q.m, mul(unit(w), -1)) : 0;
        e0 = Math.max(e0, setting.trim === "outer" ? outer : setting.trim === "inner" ? inner : 0);
      }
      const stop = (Number.isFinite(e0) ? e0 : 0) + setting.overhang;
      push(P.m, P.isStart, { p: sub(V, mul(P.d, stop)), n: P.d });
    });

    // T starts on a profile of the step, and stops on the profiles already placed.
    for (const e of ends) {
      const others = [
        ...members.filter((o) => o !== e.m && !same(o.a, e.V) && !same(o.b, e.V)),
        ...placed,
      ];
      for (const o of others) {
        const { d, s, L } = axisDistance(o, e.V);
        const reach = Math.max(...o.fibers.map(len));
        if (s < -reach - TOL || s > L + reach + TOL || d > reach + TOL) continue;
        const pl = facePlane(o, e.V, e.d, 0);
        if (pl) push(e.m, e.isStart, pl);
      }
    }

    for (const m of members) {
      const L = len(sub(m.b, m.a));
      const choose = (isStart: boolean): FramePlane => {
        const V = isStart ? m.a : m.b;
        const d = isStart ? m.t : mul(m.t, -1);
        let best: { pl: FramePlane; s: number } = { pl: { p: V, n: d }, s: 0 };
        let first = true;
        for (const pl of planesFor.get(`${m.key}:${isStart ? "s" : "e"}`) ?? []) {
          const s = cutDepth(V, d, pl);
          if (s === null || s >= L) continue;
          // The most restrictive plane (the furthest inward) wins.
          if (first || s > best.s) best = { pl, s };
          first = false;
        }
        return best.pl;
      };
      const start = choose(true);
      const end = choose(false);
      // Extreme fibers: abscissas where each fiber crosses the end planes.
      const at = (pl: FramePlane, f: V3) => {
        const k = dot(m.t, pl.n);
        return Math.abs(k) < 1e-9 ? 0 : dot(sub(pl.p, add(m.a, f)), pl.n) / k;
      };
      const sMin = Math.min(...m.fibers.map((f) => at(start, f)));
      const sMax = Math.max(...m.fibers.map((f) => at(end, f)));
      const angle = (pl: FramePlane) => Math.round(((Math.acos(Math.min(1, Math.abs(dot(pl.n, m.t)))) * 180) / Math.PI) * 10) / 10;
      out.push({
        key: m.key,
        step: step.id,
        family: step.family,
        size: step.size,
        section: m.section,
        a: m.a,
        b: m.b,
        t: m.t,
        u: m.u,
        v: m.v,
        offset: m.offset,
        start,
        end,
        sMin,
        sMax,
        length: sMax - sMin,
        angleStart: angle(start),
        angleEnd: angle(end),
      });
    }
    placed.push(...members);
  }
  return out;
}

export interface CutRow {
  /** Mark (1, 2, 3...). */
  mark: number;
  family: string;
  size: string;
  length: number;
  angleA: number;
  angleB: number;
  quantity: number;
  /** Unit mass (kg). */
  mass: number;
  members: string[];
}

/** Cut list: identical profiles (section, length rounded to 0.5 mm, angles) grouped together. */
export function cutList(layouts: MemberLayout[], density = 7.85): CutRow[] {
  const rows = new Map<string, CutRow>();
  for (const m of layouts) {
    const length = Math.round(m.length * 2) / 2;
    const [angleA, angleB] = [m.angleStart, m.angleEnd].sort((x, y) => y - x) as [number, number];
    const key = `${m.family}|${m.size}|${length}|${angleA}|${angleB}`;
    const row = rows.get(key);
    if (row) {
      row.quantity++;
      row.members.push(m.key);
      continue;
    }
    // mm² × mm = mm³; ÷ 1000 → cm³; × g/cm³ → g; ÷ 1000 → kg.
    const mass = (sectionArea(m.section) * m.length * density) / 1e6;
    rows.set(key, { mark: 0, family: m.family, size: m.size, length, angleA, angleB, quantity: 1, mass, members: [m.key] });
  }
  const list = [...rows.values()].sort((a, b) => a.family.localeCompare(b.family) || a.size.localeCompare(b.size) || b.length - a.length);
  list.forEach((r, i) => (r.mark = i + 1));
  return list;
}

/** Active steps of a part document (before the rollback bar), up to and including `until`. */
export function frameStepsOf(features: Feature[], rollback: number, scope: Scope, until?: string): FrameStep[] {
  const out: FrameStep[] = [];
  for (const [i, f] of features.entries()) {
    if (i >= rollback) break;
    if (!f.suppressed) {
      const s = frameStepOf(f, scope);
      if (s) out.push(s);
    }
    if (f.id === until) break;
  }
  return out;
}
