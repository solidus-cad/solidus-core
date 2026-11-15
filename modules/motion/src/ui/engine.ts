import type { AssemblyDocument, CameraKey, Mate, MateDrive, Matrix4, MotionEase, MotionKey, MotionStudy, MotionTrack, V3 } from "@solidus-cad/sdk";
import { invRigid, pathMatrix, solveAssembly, type Mat } from "@app/assembly/flex.ts";

/**
 * Motion workbench engine (no interface): track values over time, mate drivers,
 * frame baking (constraints solved frame by frame, each frame starting from the previous one:
 * the mechanism stays on the same branch) and animated camera.
 */

type GetAsm = (id: string) => AssemblyDocument | undefined;

/** Position of the first-level occurrences at one frame (matrix, and flexible positions of subassemblies). */
export type Pose = Record<string, { matrix: Matrix4; flex?: Record<string, Matrix4> }>;

export interface MotionFrame {
  t: number;
  pose: Pose;
  /** Constraints not satisfied at this frame. */
  failing: string[];
  /** Tracks blocked at a limit. */
  overLimit: string[];
}

// --- Interpolation --------------------------------------------------------------------------------

const easeOf = (e: MotionEase | undefined, u: number): number => (e === "step" ? 0 : e === "ease" ? u * u * (3 - 2 * u) : u);

/** Keys sorted in time. */
export const sortedKeys = <K extends { t: number }>(keys: K[]): K[] => [...keys].sort((a, b) => a.t - b.t);

/** Previous and next key of an instant, and progress (0…1, easing of the previous key applied). */
function bracket<K extends { t: number; ease?: MotionEase }>(keys: K[], t: number): { a: K; b: K; u: number } | null {
  const ks = sortedKeys(keys);
  if (ks.length === 0) return null;
  if (t <= ks[0]!.t) return { a: ks[0]!, b: ks[0]!, u: 0 };
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    if (t < b.t) return { a, b, u: easeOf(a.ease, b.t > a.t ? (t - a.t) / (b.t - a.t) : 1) };
  }
  const last = ks[ks.length - 1]!;
  return { a: last, b: last, u: 0 };
}

/** Value of a track at time `t`, bounded by its limits (`limited`: a limit was reached). */
export function valueAt(track: Pick<MotionTrack, "keys" | "min" | "max">, t: number): { value: number; limited: boolean } {
  const br = bracket<MotionKey>(track.keys, t);
  const raw = br ? br.a.value + (br.b.value - br.a.value) * br.u : 0;
  let value = raw;
  if (track.min !== undefined && value < track.min) value = track.min;
  if (track.max !== undefined && value > track.max) value = track.max;
  return { value, limited: value !== raw };
}

/** Constant speed of a track (units per second), if it has one: two keys, linear between them. */
export function trackSpeed(track: Pick<MotionTrack, "keys">): number | null {
  const ks = sortedKeys(track.keys);
  if (ks.length !== 2) return null;
  const [a, b] = ks as [MotionKey, MotionKey];
  if (b.t <= a.t || (a.ease ?? "linear") !== "linear") return null;
  return (b.value - a.value) / (b.t - a.t);
}

const lerp3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Viewpoint at time `t` (null without camera key: free camera). */
export function cameraAt(study: Pick<MotionStudy, "camera">, t: number): Omit<CameraKey, "t" | "ease"> | null {
  const br = bracket<CameraKey>(study.camera ?? [], t);
  if (!br) return null;
  const za = br.a.zoom;
  const zb = br.b.zoom ?? za;
  // Zoom interpolated geometrically: a regular magnification.
  const zoom = za !== undefined && zb !== undefined ? za * (zb / za) ** br.u : za;
  return { position: lerp3(br.a.position, br.b.position, br.u), target: lerp3(br.a.target, br.b.target, br.u), up: norm3(lerp3(br.a.up, br.b.up, br.u)), zoom };
}

// --- Pilotes --------------------------------------------------------------------------------------

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const applyPoint = (m: Mat, p: V): V => [0, 1, 2].map((i) => m[i]! * p[0] + m[4 + i]! * p[1] + m[8 + i]! * p[2] + m[12 + i]!) as V;
const applyDir = (m: Mat, d: V): V => [0, 1, 2].map((i) => m[i]! * d[0] + m[4 + i]! * d[1] + m[8 + i]! * d[2]) as V;

/** Track kinds a mate accepts (empty: mate not drivable). */
export function trackKindsFor(m: Mate): ("linear" | "rotary")[] {
  if (m.type === "distance") return ["linear"];
  if (m.type === "angle") return ["rotary"];
  const axes = m.a.kind === "axis" && m.b.kind === "axis";
  // Concentric: a rotary motor also applies to a rotation-locked mate (the motor replaces the lock).
  if ((m.type === "concentric" || m.type === "coincident") && axes) return ["rotary", "linear"];
  // Parallel: linear motor along the direction of the first element (plane normal or axis).
  if (m.type === "parallel") return ["linear"];
  return [];
}

/** True if the track is relative to the start pose (concentric, coaxial axes, parallel); otherwise the value of the mate. */
export const isRelative = (m: Mate): boolean => m.type === "concentric" || m.type === "coincident" || m.type === "parallel";

/** Start value of a track: value of the driven mate (distance, angle), otherwise 0. */
export function restValue(m: Mate): number {
  const v = Number(m.value);
  return !isRelative(m) && Number.isFinite(v) ? v : 0;
}

const IDENT: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Matrix (assembly frame) of the part carrying a reference; identity for a reference plane. */
function refMatrix(asm: AssemblyDocument, component: string, getAsm: GetAsm): Mat | null {
  return component ? pathMatrix(asm, component.split("/"), getAsm) : IDENT;
}

/** A direction perpendicular to `d` (unit). */
function perpendicular(d: V): V {
  const ref: V = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c = cross(d, ref);
  const l = Math.hypot(...c);
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** Prepared driver: everything except the value, measured on the start pose. */
export interface PreparedDrive {
  track: MotionTrack;
  mate: string;
  base: Omit<MateDrive, "value">;
  /** Offset added to the track value (start position along the axis, relative linear tracks). */
  offset: number;
}

/**
 * Measures on the start pose what relative tracks need: reference directions perpendicular
 * to the axis (rotary: angle 0 at the start pose) and start position along the axis (linear).
 */
export function prepareDrives(asm: AssemblyDocument, study: MotionStudy, getAsm: GetAsm): PreparedDrive[] {
  const out: PreparedDrive[] = [];
  for (const track of study.tracks) {
    if (track.muted) continue;
    const m = asm.mates.find((x) => x.id === track.mate);
    if (!m || m.suppressed || m.unresolved || !trackKindsFor(m).includes(track.kind)) continue;
    if (!isRelative(m)) {
      out.push({ track, mate: m.id, base: { kind: track.kind }, offset: 0 });
      continue;
    }
    const ma = refMatrix(asm, m.a.component, getAsm);
    const mb = refMatrix(asm, m.b.component, getAsm);
    if (!ma || !mb) continue;
    const pa = applyPoint(ma, m.a.p);
    const pb = applyPoint(mb, m.b.p);
    const da = applyDir(ma, m.a.d);
    const l = Math.hypot(...da) || 1;
    const d: V = [da[0] / l, da[1] / l, da[2] / l];
    if (track.kind === "linear") {
      out.push({ track, mate: m.id, base: { kind: "linear" }, offset: dot(sub(pb, pa), d) });
      continue;
    }
    const u = perpendicular(d);
    out.push({ track, mate: m.id, base: { kind: "rotary", ua: applyDir(invRigid(ma), u), ub: applyDir(invRigid(mb), u) }, offset: 0 });
  }
  return out;
}

/** Assembly constraints with the drivers set at time `t`. */
function drivenMates(asm: AssemblyDocument, drives: PreparedDrive[], t: number): { mates: Mate[]; overLimit: string[] } {
  const overLimit: string[] = [];
  const byMate = new Map<string, MateDrive[]>();
  for (const d of drives) {
    const v = valueAt(d.track, t);
    if (v.limited) overLimit.push(d.track.id);
    const value = (d.track.reverse ? -v.value : v.value) + d.offset;
    byMate.set(d.mate, [...(byMate.get(d.mate) ?? []), { ...d.base, value }]);
  }
  return { mates: asm.mates.map((m) => (byMate.has(m.id) ? { ...m, drive: byMate.get(m.id) } : m)), overLimit };
}

/** Assembly placed in a pose (occurrences replaced; the original document is not modified). */
export function posed(asm: AssemblyDocument, pose: Pose): AssemblyDocument {
  return {
    ...asm,
    components: asm.components.map((c) => {
      const p = pose[c.id];
      return p ? { ...c, matrix: p.matrix, flex: p.flex ?? c.flex } : c;
    }),
  };
}

function poseOf(asm: AssemblyDocument): Pose {
  return Object.fromEntries(asm.components.map((c) => [c.id, { matrix: [...c.matrix], flex: c.flex }]));
}

/** One solve at time `t` from pose `from`. */
function solveAt(asm: AssemblyDocument, drives: PreparedDrive[], from: Pose, t: number, getAsm: GetAsm): MotionFrame {
  const { mates, overLimit } = drivenMates(asm, drives, t);
  const r = solveAssembly({ ...posed(asm, from), mates }, getAsm);
  const pose: Pose = { ...from };
  for (const u of r.updates) pose[u.id] = { matrix: u.matrix, flex: u.flex ?? from[u.id]?.flex };
  return { t, pose, failing: r.failing, overLimit };
}

/** Number of frames of a study (first and last included). */
export const frameCount = (s: Pick<MotionStudy, "duration" | "fps">): number => Math.max(1, Math.round(s.duration * s.fps) + 1);

/** Time of a frame. */
export const frameTime = (s: Pick<MotionStudy, "duration" | "fps">, i: number): number => Math.min(s.duration, i / s.fps);

/** Frame closest to a time. */
export const frameAt = (s: Pick<MotionStudy, "duration" | "fps">, t: number): number => Math.max(0, Math.min(frameCount(s) - 1, Math.round(t * s.fps)));

/**
 * Next frame from `prev`; if the solve fails (large step on a mechanism), the step is subdivided
 * (continuation): each substep starts from the previous one.
 */
export function nextFrame(asm: AssemblyDocument, drives: PreparedDrive[], prev: MotionFrame, t: number, getAsm: GetAsm, depth = 3): MotionFrame {
  const direct = solveAt(asm, drives, prev.pose, t, getAsm);
  if (direct.failing.length === 0 || depth === 0 || prev.failing.length > 0) return direct;
  const mid = nextFrame(asm, drives, prev, (prev.t + t) / 2, getAsm, depth - 1);
  if (mid.failing.length > 0) return direct;
  return nextFrame(asm, drives, mid, t, getAsm, depth - 1);
}

export interface BakeOptions {
  getAsm: GetAsm;
  /** Called after each computed frame. */
  onFrame?: (i: number, f: MotionFrame) => void;
  signal?: AbortSignal;
  /** Yields to the interface between two batches (ms of computation per batch). */
  budget?: number;
}

/** Computes all frames of the study (yields to the interface regularly; cancellable). */
export async function bake(asm: AssemblyDocument, study: MotionStudy, opts: BakeOptions): Promise<MotionFrame[] | null> {
  const drives = prepareDrives(asm, study, opts.getAsm);
  const n = frameCount(study);
  const frames: MotionFrame[] = [];
  const budget = opts.budget ?? 30;
  let start = performance.now();
  let prev: MotionFrame = { t: 0, pose: poseOf(asm), failing: [], overLimit: [] };
  for (let i = 0; i < n; i++) {
    if (opts.signal?.aborted) return null;
    const f = i === 0 ? solveAt(asm, drives, prev.pose, 0, opts.getAsm) : nextFrame(asm, drives, prev, frameTime(study, i), opts.getAsm);
    frames.push(f);
    opts.onFrame?.(i, f);
    // A frame that failed is not used as the start of the next one: restart from the last valid frame.
    if (f.failing.length === 0 || prev.failing.length > 0) prev = f;
    if (performance.now() - start > budget) {
      await new Promise((r) => setTimeout(r, 0));
      start = performance.now();
    }
  }
  return frames;
}

/** Fingerprint of what baking depends on (constraints, start positions, tracks, rate). */
export function bakeKey(asm: AssemblyDocument, study: MotionStudy): string {
  return JSON.stringify([asm.components.map((c) => [c.id, c.matrix, c.flex, c.fixed]), asm.mates, study.tracks, study.duration, study.fps]);
}
