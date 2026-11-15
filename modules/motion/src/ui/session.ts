import { createEffect, createRoot, on } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { createMotionStudy, newId, type AssemblyDocument, type CameraKey, type Mate, type MotionKey, type MotionStudy, type MotionTrack } from "@solidus-cad/sdk";
import {
  asmLeaves,
  assemblyDoc,
  commitAsm,
  interferencesOf,
  isPosed,
  occurrenceLabel,
  onLeaveAssembly,
  openOrCreateAssembly,
  redrawAssembly,
  setDisplayPose,
  setWs,
  solvableAsm,
  ws,
} from "@app/workspace.ts";
import { getViewer, setMessage } from "@app/store.ts";
import { t, type TKey } from "../texts.ts";
import { requireFeature } from "@app/license.ts";
import { bake, bakeKey, cameraAt, frameAt, frameCount, frameTime, isRelative, posed, restValue, sortedKeys, trackKindsFor, trackSpeed, valueAt, type MotionFrame } from "./engine.ts";

/**
 * Motion workbench: displayed study, playback (loop), background frame baking, collisions,
 * and study changes (all undoable: they go through the assembly history).
 */

/** State of a frame on the timeline: to compute, valid, mate not satisfied, limit reached, collision. */
export type FrameStatus = "pending" | "ok" | "fail" | "limit" | "collision";

interface MotionUi {
  /** Displayed time (s). */
  time: number;
  playing: boolean;
  speed: number;
  /** Baking in progress, and number of frames computed. */
  baking: boolean;
  baked: number;
  status: FrameStatus[];
  /** Collisions per checked frame (pairs of parts). */
  collisions: Record<number, { a: string; b: string }[]>;
  checking: boolean;
  /** Mate chosen in the list (track addition). */
  mate: string | null;
  /** Selected track and key (rank in the sorted keys); `camera`: camera track. */
  track: string | null;
  key: number | null;
  /** Video export: dialog open, progress (0…1) during encoding. */
  videoOpen: boolean;
  exporting: number | null;
}

export const [ms, setMs] = createStore<MotionUi>({
  time: 0,
  playing: false,
  speed: 1,
  baking: false,
  baked: 0,
  status: [],
  collisions: {},
  checking: false,
  mate: null,
  track: null,
  key: null,
  videoOpen: false,
  exporting: null,
});

/** Computed frames (outside the store: large, never observed field by field). */
let frames: MotionFrame[] = [];

/** Displayed study. */
export function study(): MotionStudy | undefined {
  const id = ws.motion?.studyId;
  return id ? ws.asm?.motion?.find((s) => s.id === id) : undefined;
}

export const studies = (): MotionStudy[] => ws.asm?.motion ?? [];

// --- Lifecycle ------------------------------------------------------------------------------------

/** Opens the workbench on the active assembly (or the most recent); creates a first study if needed. */
export function startMotion(): void {
  requireFeature("motion", () => {
    openOrCreateAssembly();
    if (!ws.asm || ws.motion || ws.sketch3d || ws.frame) return;
    let s = ws.asm.motion?.[0];
    if (!s) {
      const created = createMotionStudy(`${t("mot.study")} 1`);
      commitAsm((a) => void (a.motion = [...(a.motion ?? []), created]));
      s = created;
    }
    setWs({ motion: { studyId: s.id }, gizmo: "none", mateDraft: null });
    onLeaveAssembly(finishMotion);
    setMs({ time: 0, playing: false, track: null, key: null, mate: null });
    setDisplayPose((a) => {
      const f = frames[frameAt(study() ?? s!, ms.time)];
      return f ? posed(a, f.pose) : a;
    });
  });
}

/** Closes the workbench: the assembly returns to its modeling position. */
export function finishMotion(): void {
  if (!ws.motion) return;
  pause();
  abortBake();
  onLeaveAssembly(null);
  setWs("motion", null);
  setDisplayPose(null);
}

// --- Study ----------------------------------------------------------------------------------------

/** Modifies the displayed study (one history entry). */
function mutateStudy(fn: (s: MotionStudy) => void): void {
  const id = ws.motion?.studyId;
  if (!id) return;
  commitAsm((a) => {
    const s = a.motion?.find((x) => x.id === id);
    if (s) fn(s);
  });
}

export function setStudy(patch: Partial<Pick<MotionStudy, "name" | "duration" | "fps" | "loop" | "collisions">>): void {
  if (patch.duration !== undefined && !(patch.duration > 0)) return;
  if (patch.fps !== undefined && !(patch.fps >= 1 && patch.fps <= 120)) return;
  mutateStudy((s) => Object.assign(s, patch));
  if (ms.time > (study()?.duration ?? 0)) seek(study()!.duration);
}

export function newStudy(): void {
  if (!ws.asm) return;
  const n = studies().length + 1;
  const s = createMotionStudy(`${t("mot.study")} ${n}`);
  commitAsm((a) => void (a.motion = [...(a.motion ?? []), s]));
  selectStudy(s.id);
}

export function selectStudy(id: string): void {
  pause();
  setWs("motion", { studyId: id });
  setMs({ time: 0, track: null, key: null });
}

export function deleteStudy(): void {
  const id = ws.motion?.studyId;
  if (!id || studies().length <= 1) return setMessage(t("mot.lastStudy"));
  const rest = studies().filter((s) => s.id !== id);
  commitAsm((a) => void (a.motion = a.motion?.filter((s) => s.id !== id)));
  selectStudy(rest[0]!.id);
}

// --- Tracks ---------------------------------------------------------------------------------------

/** Displayable name of a mate (type and parts). */
export function mateLabel(m: Mate): string {
  const side = (r: Mate["a"]) => (r.datum ? (ws.asm?.planes?.find((p) => p.id === r.datum)?.name ?? "?") : occurrenceLabel(r.component));
  return `${t(`mate.${m.type}` as TKey)} · ${side(m.a)} ↔ ${side(m.b)}`;
}

/** Drivable mates of the active assembly. */
export function drivableMates(): Mate[] {
  return (ws.asm?.mates ?? []).filter((m) => !m.suppressed && !m.unresolved && trackKindsFor(m).length > 0);
}

/** Unit of a track. */
export const unitOf = (tr: Pick<MotionTrack, "kind">): string => (tr.kind === "rotary" ? "°" : "mm");

/** Adds a track on a mate: from its start value to one turn (rotary) or 50 mm (linear) further. */
export function addTrack(kind: "linear" | "rotary", mateId: string | null = ms.mate): void {
  const s = study();
  const m = ws.asm?.mates.find((x) => x.id === mateId);
  if (!s || !m) return setMessage(t("mot.pickMate"));
  if (!trackKindsFor(m).includes(kind)) return setMessage(t(kind === "rotary" ? "mot.notRotary" : "mot.notLinear"));
  if (s.tracks.some((x) => x.mate === m.id && x.kind === kind)) return setMessage(t("mot.alreadyDriven"));
  const v0 = restValue(m);
  const v1 = kind === "linear" ? v0 + 50 : isRelative(m) ? 360 : Math.min(180, v0 + 90);
  const tr: MotionTrack = { id: newId(), mate: m.id, kind, keys: [{ t: 0, value: v0 }, { t: s.duration, value: v1 }] };
  if (m.type === "angle") setMessage(t("mot.angleHint"));
  mutateStudy((x) => void x.tracks.push(tr));
  setMs({ track: tr.id, key: null });
}

export function deleteTrack(id: string): void {
  mutateStudy((s) => void (s.tracks = s.tracks.filter((x) => x.id !== id)));
  if (ms.track === id) setMs({ track: null, key: null });
}

export function setTrack(id: string, patch: Partial<Pick<MotionTrack, "min" | "max" | "muted" | "reverse">>): void {
  mutateStudy((s) => {
    const tr = s.tracks.find((x) => x.id === id);
    if (!tr) return;
    for (const [k, v] of Object.entries(patch) as [keyof typeof patch, number | boolean | undefined][]) {
      if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) delete tr[k];
      else (tr as unknown as Record<string, unknown>)[k] = v;
    }
  });
}

/** Keys of a track sorted in time (selection ranks refer to them). */
export function keysOf(trackId: string): (MotionKey | CameraKey)[] {
  const s = study();
  if (!s) return [];
  return trackId === "camera" ? sortedKeys(s.camera ?? []) : sortedKeys(s.tracks.find((x) => x.id === trackId)?.keys ?? []);
}

/** Editable key list of a track (within a study change), sorted in place. */
function keyList(s: MotionStudy, trackId: string): (MotionKey | CameraKey)[] | null {
  const keys = trackId === "camera" ? (s.camera ??= []) : s.tracks.find((x) => x.id === trackId)?.keys;
  return keys ? keys.sort((a, b) => a.t - b.t) : null;
}

/** Rank (sorted keys) of the key at time `t`. */
const keyIndexAt = (trackId: string, t: number): number => keysOf(trackId).findIndex((k) => Math.abs(k.t - t) < SAME_TIME);

const SAME_TIME = 1e-6;

/** Adds (or replaces) a track key at time `t`; default value: the track's value at that time. */
export function addKey(trackId: string, t: number = ms.time, value?: number): void {
  const s = study();
  const tr = s?.tracks.find((x) => x.id === trackId);
  if (!s || !tr) return;
  const v = value ?? valueAt({ keys: tr.keys }, t).value;
  mutateStudy((x) => {
    const keys = keyList(x, trackId) as MotionKey[];
    const same = keys.find((k) => Math.abs(k.t - t) < SAME_TIME);
    if (same) same.value = v;
    else keys.push({ t, value: v });
    keyList(x, trackId);
  });
  setMs({ track: trackId, key: keyIndexAt(trackId, t) });
}

/** Camera key: current viewpoint of the view, at the displayed time. */
export function addCameraKey(): void {
  const v = getViewer();
  if (!v || !study()) return;
  const c = v.cameraState();
  const t0 = ms.time;
  const key: CameraKey = { t: t0, position: c.position, target: c.target, up: c.up, zoom: c.zoom };
  mutateStudy((x) => {
    const keys = keyList(x, "camera") as CameraKey[];
    const i = keys.findIndex((k) => Math.abs(k.t - t0) < SAME_TIME);
    if (i >= 0) keys[i] = key;
    else keys.push(key);
    keyList(x, "camera");
  });
  setMs({ track: "camera", key: keyIndexAt("camera", t0) });
}

/** Deletes all camera keys: the camera becomes free again. */
export function clearCamera(): void {
  mutateStudy((s) => void delete s.camera);
  if (ms.track === "camera") setMs({ track: null, key: null });
}

/** Sets the constant speed of a track (units per second): moves the value of its last key. */
export function setTrackSpeed(trackId: string, speed: number): void {
  if (!Number.isFinite(speed)) return;
  mutateStudy((s) => {
    const tr = s.tracks.find((x) => x.id === trackId);
    if (!tr || trackSpeed(tr) === null) return;
    const [a, b] = keyList(s, trackId) as [MotionKey, MotionKey];
    b.value = a.value + speed * (b.t - a.t);
  });
}

/** Modifies key `index` (rank in the sorted keys) of a track. */
export function setKey(trackId: string, index: number, patch: Partial<Pick<MotionKey, "t" | "value" | "ease">>): void {
  const dur = study()?.duration ?? 0;
  if (patch.t !== undefined) patch.t = Math.max(0, Math.min(dur, patch.t));
  if (patch.value !== undefined && !Number.isFinite(patch.value)) return;
  const at = patch.t ?? keysOf(trackId)[index]?.t;
  if (at === undefined) return;
  mutateStudy((s) => {
    const keys = keyList(s, trackId);
    const k = keys?.[index];
    if (!keys || !k) return;
    // Only one key per time: moved onto another, it replaces it.
    if (patch.t !== undefined) {
      const other = keys.findIndex((x) => x !== k && Math.abs(x.t - patch.t!) < SAME_TIME);
      if (other >= 0) keys.splice(other, 1);
    }
    Object.assign(k, patch);
    keyList(s, trackId);
  });
  if (ms.track === trackId) setMs("key", keyIndexAt(trackId, at));
}

export function deleteKey(trackId: string, index: number): void {
  mutateStudy((s) => void keyList(s, trackId)?.splice(index, 1));
  setMs({ key: null });
}

/** Deletes the selected key. */
export function deleteSelectedKey(): void {
  if (ms.track && ms.key !== null) deleteKey(ms.track, ms.key);
}

// --- Baking ---------------------------------------------------------------------------------------

let bakeCtl: AbortController | null = null;
let collideCtl: AbortController | null = null;
let lastKey = "";
let bakeTimer: ReturnType<typeof setTimeout> | undefined;

function abortBake(): void {
  bakeCtl?.abort();
  collideCtl?.abort();
  bakeCtl = collideCtl = null;
  clearTimeout(bakeTimer);
  lastKey = "";
  setMs({ baking: false, checking: false });
}

/** Computed frame displayed at time `t` (null: not yet computed). */
export function frameOf(t: number): MotionFrame | null {
  const s = study();
  return s ? (frames[frameAt(s, t)] ?? null) : null;
}

const statusOf = (f: MotionFrame, collided: boolean): FrameStatus => (f.failing.length ? "fail" : f.overLimit.length ? "limit" : collided ? "collision" : "ok");

async function runBake(): Promise<void> {
  const s = study();
  const a = solvableAsm();
  if (!s || !a) return;
  bakeCtl?.abort();
  collideCtl?.abort();
  const ctl = (bakeCtl = new AbortController());
  const studyCopy = JSON.parse(JSON.stringify(unwrap(s))) as MotionStudy;
  frames = [];
  setMs({ baking: true, baked: 0, status: new Array<FrameStatus>(frameCount(studyCopy)).fill("pending"), collisions: {}, checking: false });
  const shownAt = frameAt(studyCopy, ms.time);
  const out = await bake(a, studyCopy, {
    getAsm: assemblyDoc,
    signal: ctl.signal,
    onFrame: (i, f) => {
      frames[i] = f;
      setMs("status", i, statusOf(f, false));
      setMs("baked", i + 1);
      if (i === shownAt) showFrame();
    },
  });
  if (!out || ctl.signal.aborted) return;
  setMs("baking", false);
  showFrame();
  if (studyCopy.collisions?.enabled) void runCollisions(a, studyCopy);
}

/** Collision check on one frame every `step` (kernel, cancellable task). */
async function runCollisions(a: AssemblyDocument, s: MotionStudy): Promise<void> {
  const ctl = (collideCtl = new AbortController());
  const step = Math.max(1, Math.round(s.collisions?.step ?? 5));
  setMs("checking", true);
  try {
    for (let i = 0; i < frames.length; i += step) {
      const f = frames[i];
      if (!f) continue;
      const r = await interferencesOf(posed(a, f.pose));
      if (ctl.signal.aborted) return;
      setMs("collisions", i, r.map((x) => ({ a: x.a, b: x.b })));
      if (r.length > 0) {
        // The frame and those it represents (up to the next check) are flagged.
        for (let j = i; j < Math.min(frames.length, i + step); j++) if (ms.status[j] === "ok") setMs("status", j, "collision");
      }
    }
  } catch (e) {
    setMessage((e as Error).message);
  } finally {
    if (collideCtl === ctl) setMs("checking", false);
  }
}

/** Collisions of the nearest checked frame before time `t`. */
export function collisionsAt(t: number): { a: string; b: string }[] {
  const s = study();
  if (!s) return [];
  const i = frameAt(s, t);
  const step = Math.max(1, Math.round(s.collisions?.step ?? 5));
  return ms.collisions[i - (i % step)] ?? [];
}

// Any change to what baking depends on (constraints, positions, tracks) restarts it, after a short delay.
createRoot(() =>
  createEffect(
    on(
      () => {
        const s = study();
        const a = ws.asm;
        return s && a && ws.motion ? bakeKey(a, s) + JSON.stringify(s.collisions ?? null) : "";
      },
      (key) => {
        if (!key || key === lastKey) return;
        lastKey = key;
        clearTimeout(bakeTimer);
        bakeTimer = setTimeout(() => void runBake(), 120);
      },
    ),
  ),
);

// --- Display and playback -------------------------------------------------------------------------

/** Displays the frame at the current time (positions only), and the camera if the study animates one. */
export function showFrame(): void {
  const s = study();
  const a = ws.asm;
  const v = getViewer();
  if (!s || !a || !v || !ws.motion) return;
  const f = frames[frameAt(s, ms.time)];
  if (f) {
    // Machine posed: the demo pose is composed frame by frame, and the full display takes care of it.
    if (isPosed()) redrawAssembly();
    else v.setAssemblyMatrices(Object.fromEntries(asmLeaves(posed(a, f.pose)).map((l) => [l.key, l.matrix])));
  }
  const cam = cameraAt(s, ms.time);
  if (cam) v.setCameraState(cam);
}

export function seek(time: number): void {
  const s = study();
  if (!s) return;
  setMs("time", Math.max(0, Math.min(s.duration, time)));
  showFrame();
}

/** Previous / next frame. */
export function stepFrame(delta: number): void {
  const s = study();
  if (!s) return;
  pause();
  seek(frameTime(s, frameAt(s, ms.time) + delta));
}

let raf = 0;
let last = 0;

function tick(now: number): void {
  const s = study();
  if (!s || !ms.playing) return;
  const dt = ((now - last) / 1000) * ms.speed;
  last = now;
  let time = ms.time + dt;
  if (time >= s.duration) {
    if (s.loop && s.duration > 0) time %= s.duration;
    else {
      seek(s.duration);
      return pause();
    }
  }
  seek(time);
  raf = requestAnimationFrame(tick);
}

export function play(): void {
  const s = study();
  if (!s || ms.playing) return;
  // At the end of a study without loop: restart from the beginning.
  if (!s.loop && ms.time >= s.duration) seek(0);
  setMs("playing", true);
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

export function pause(): void {
  cancelAnimationFrame(raf);
  setMs("playing", false);
}

export const togglePlay = (): void => (ms.playing ? pause() : play());

export function rewind(): void {
  seek(0);
}

export function toggleLoop(): void {
  const s = study();
  if (s) setStudy({ loop: !s.loop });
}

export function setSpeed(speed: number): void {
  if (speed > 0) setMs("speed", speed);
}

/** Computed frames (video export). */
export const bakedFrames = (): readonly MotionFrame[] => frames;
