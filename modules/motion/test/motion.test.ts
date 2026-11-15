import { describe, expect, test } from "vitest";
import { createAssemblyDocument, createMotionStudy, IDENTITY, type AssemblyDocument, type Mate, type MotionStudy } from "@solidus-cad/sdk";
import { bake, cameraAt, frameCount, isRelative, trackKindsFor, trackSpeed, valueAt } from "../src/ui/engine.ts";

const at = (x: number, y: number, z: number) => {
  const m = [...IDENTITY];
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};
type V = [number, number, number];
const Z: V = [0, 0, 1];
const X: V = [1, 0, 0];
const ax = (component: string, p: V, d: V = Z) => ({ component, kind: "axis" as const, p, d });
const none = () => undefined;

describe("valueAt", () => {
  const track = { keys: [{ t: 0, value: 0 }, { t: 2, value: 100, ease: "ease" as const }, { t: 1, value: 50 }] };
  test("interpolates between sorted keys, holds before and after", () => {
    expect(valueAt(track, -1).value).toBe(0);
    expect(valueAt(track, 0.5).value).toBeCloseTo(25);
    expect(valueAt(track, 1).value).toBe(50);
    // Key at t = 1 without a specified interpolation: linear up to the next one.
    expect(valueAt(track, 1.5).value).toBeCloseTo(75);
    expect(valueAt(track, 5).value).toBe(100);
  });
  test("easing and step", () => {
    const eased = { keys: [{ t: 0, value: 0, ease: "ease" as const }, { t: 1, value: 10 }] };
    expect(valueAt(eased, 0.25).value).toBeCloseTo(10 * 0.15625);
    const step = { keys: [{ t: 0, value: 0, ease: "step" as const }, { t: 1, value: 10 }] };
    expect(valueAt(step, 0.99).value).toBe(0);
    expect(valueAt(step, 1).value).toBe(10);
  });
  test("limits", () => {
    const r = valueAt({ ...track, min: 10, max: 60 }, 1.5);
    expect(r.value).toBe(60);
    expect(r.limited).toBe(true);
    expect(valueAt({ ...track, min: 10 }, 0).limited).toBe(true);
    expect(valueAt({ ...track, max: 60 }, 0.5).limited).toBe(false);
  });
});

describe("tracks", () => {
  const m = (type: Mate["type"], kind: "axis" | "plane", extra: Partial<Mate> = {}): Mate => ({
    id: "m",
    type,
    a: { component: "A", kind, p: [0, 0, 0], d: Z },
    b: { component: "B", kind, p: [0, 0, 0], d: Z },
    ...extra,
  });
  test("track kinds per mate type", () => {
    expect(trackKindsFor(m("distance", "plane"))).toEqual(["linear"]);
    expect(trackKindsFor(m("angle", "plane"))).toEqual(["rotary"]);
    expect(trackKindsFor(m("concentric", "axis"))).toEqual(["rotary", "linear"]);
    expect(trackKindsFor(m("concentric", "axis", { lockRotation: true }))).toEqual(["rotary", "linear"]);
    expect(trackKindsFor(m("coincident", "plane"))).toEqual([]);
    expect(trackKindsFor(m("parallel", "plane"))).toEqual(["linear"]);
    expect(trackKindsFor(m("parallel", "axis"))).toEqual(["linear"]);
    expect(isRelative(m("concentric", "axis"))).toBe(true);
    expect(isRelative(m("parallel", "plane"))).toBe(true);
    expect(isRelative(m("distance", "plane"))).toBe(false);
  });
});

describe("cameraAt", () => {
  test("without keys: free camera; with keys: interpolated", () => {
    expect(cameraAt({}, 1)).toBeNull();
    const c = cameraAt({ camera: [{ t: 0, position: [0, 0, 0], target: [0, 0, 0], up: Z, zoom: 1 }, { t: 2, position: [100, 0, 0], target: [0, 10, 0], up: Z, zoom: 4 }] }, 1)!;
    expect(c.position[0]).toBeCloseTo(50);
    expect(c.target[1]).toBeCloseTo(5);
    expect(c.up).toEqual(Z);
    expect(c.zoom).toBeCloseTo(2);
  });
});

/** Crank-slider: fixed frame A, crank C (radius 50), connecting rod R (150), piston P on the x axis. */
function crankSlider(): AssemblyDocument {
  const a = createAssemblyDocument("bielle");
  a.components = [
    { id: "A", name: "A", partId: "p", matrix: at(0, 0, 0), fixed: true },
    { id: "C", name: "C", partId: "p", matrix: at(0, 0, 0) },
    { id: "R", name: "R", partId: "p", matrix: at(50, 0, 0) },
    { id: "P", name: "P", partId: "p", matrix: at(200, 0, 0) },
  ];
  a.mates = [
    { id: "crank", type: "concentric", a: ax("A", [0, 0, 0]), b: ax("C", [0, 0, 0]) },
    { id: "floor", type: "coincident", a: { component: "A", kind: "plane", p: [0, 0, 0], d: Z }, b: { component: "C", kind: "plane", p: [0, 0, 0], d: [0, 0, -1] } },
    { id: "pinA", type: "concentric", a: ax("C", [50, 0, 0]), b: ax("R", [0, 0, 0]) },
    { id: "pinB", type: "concentric", a: ax("R", [150, 0, 0]), b: ax("P", [0, 0, 0]) },
    { id: "slide", type: "concentric", a: ax("A", [0, 0, 0], X), b: ax("P", [0, 0, 0], X) },
  ];
  return a;
}

describe("bake", () => {
  test("one crank turn: the piston follows, without branch jump, and returns to the start", async () => {
    const asm = crankSlider();
    const study: MotionStudy = { ...createMotionStudy("tour"), duration: 1, fps: 12, tracks: [{ id: "t1", mate: "crank", kind: "rotary", keys: [{ t: 0, value: 0 }, { t: 1, value: 360 }] }] };
    const frames = (await bake(asm, study, { getAsm: none }))!;
    expect(frames).toHaveLength(frameCount(study));
    for (const f of frames) {
      expect(f.failing).toEqual([]);
      const th = (f.t * 360 * Math.PI) / 180;
      expect(f.pose.P!.matrix[12]).toBeCloseTo(50 * Math.cos(th) + Math.sqrt(150 ** 2 - 50 ** 2 * Math.sin(th) ** 2), 3);
    }
    // Start pose and document unchanged.
    expect(frames[frames.length - 1]!.pose.C!.matrix[0]).toBeCloseTo(1, 5);
    expect(asm.components[3]!.matrix[12]).toBe(200);
  });

  test("relative linear track and reported limit", async () => {
    const asm = crankSlider();
    // The piston alone, guided on the x axis: the connecting rod is removed.
    asm.mates = asm.mates.filter((m) => m.id === "slide");
    const study: MotionStudy = {
      ...createMotionStudy("course"),
      duration: 1,
      fps: 4,
      tracks: [{ id: "t1", mate: "slide", kind: "linear", keys: [{ t: 0, value: 0 }, { t: 1, value: -40 }], min: -30 }],
    };
    const frames = (await bake(asm, study, { getAsm: none }))!;
    expect(frames[2]!.pose.P!.matrix[12]).toBeCloseTo(180, 4);
    expect(frames[4]!.pose.P!.matrix[12]).toBeCloseTo(170, 4);
    expect(frames[4]!.overLimit).toEqual(["t1"]);
    expect(frames[2]!.overLimit).toEqual([]);
  });

  test("rotary motor on a rotation-locked concentric mate: the motor replaces the lock", async () => {
    const asm = crankSlider();
    asm.mates = asm.mates.filter((m) => m.id === "crank" || m.id === "floor").map((m) => (m.id === "crank" ? { ...m, a: { ...m.a, u: X }, b: { ...m.b, u: X }, lockRotation: true } : m));
    asm.components = asm.components.filter((c) => c.id === "A" || c.id === "C");
    const study: MotionStudy = { ...createMotionStudy("r"), duration: 1, fps: 2, tracks: [{ id: "t", mate: "crank", kind: "rotary", keys: [{ t: 0, value: 0 }, { t: 1, value: 90 }] }] };
    const frames = (await bake(asm, study, { getAsm: none }))!;
    const angle = (f: (typeof frames)[number]) => Math.round((Math.atan2(f.pose.C!.matrix[1]!, f.pose.C!.matrix[0]!) * 180) / Math.PI);
    expect(frames.map((f) => f.failing)).toEqual([[], [], []]);
    expect(frames.map(angle)).toEqual([0, 45, 90]);
  });

  test("linear motor on a parallel mate: displacement along the normal of A's plane", async () => {
    const asm = createAssemblyDocument("p");
    asm.components = [
      { id: "A", name: "A", partId: "p", matrix: at(0, 0, 0), fixed: true },
      { id: "B", name: "B", partId: "p", matrix: at(5, 7, 20) },
    ];
    asm.mates = [{ id: "par", type: "parallel", a: { component: "A", kind: "plane", p: [0, 0, 0], d: Z }, b: { component: "B", kind: "plane", p: [0, 0, 0], d: Z } }];
    const study: MotionStudy = { ...createMotionStudy("p"), duration: 1, fps: 2, tracks: [{ id: "t", mate: "par", kind: "linear", keys: [{ t: 0, value: 0 }, { t: 1, value: 40 }] }] };
    const frames = (await bake(asm, study, { getAsm: none }))!;
    expect(frames.map((f) => f.failing)).toEqual([[], [], []]);
    expect(frames.map((f) => Math.round(f.pose.B!.matrix[14]!))).toEqual([20, 40, 60]);
    // Only the driven direction moves.
    expect(frames[2]!.pose.B!.matrix[12]).toBeCloseTo(5, 4);
    expect(frames[2]!.pose.B!.matrix[13]).toBeCloseTo(7, 4);
  });

  test("distance mate driven by absolute value; cancellation", async () => {
    const asm = createAssemblyDocument("d");
    asm.components = [
      { id: "A", name: "A", partId: "p", matrix: at(0, 0, 0), fixed: true },
      { id: "B", name: "B", partId: "p", matrix: at(0, 0, 20) },
    ];
    asm.mates = [{ id: "d", type: "distance", value: "20", a: { component: "A", kind: "plane", p: [0, 0, 0], d: Z }, b: { component: "B", kind: "plane", p: [0, 0, 0], d: [0, 0, -1] } }];
    const study: MotionStudy = { ...createMotionStudy("d"), duration: 1, fps: 2, tracks: [{ id: "t", mate: "d", kind: "linear", keys: [{ t: 0, value: 20 }, { t: 1, value: 60 }] }] };
    const frames = (await bake(asm, study, { getAsm: none }))!;
    expect(frames.map((f) => Math.round(f.pose.B!.matrix[14]!))).toEqual([20, 40, 60]);
    const ctl = new AbortController();
    ctl.abort();
    expect(await bake(asm, study, { getAsm: none, signal: ctl.signal })).toBeNull();
  });
});

describe("track speed", () => {
  test("two linear keys: constant speed, whatever their order", () => {
    expect(trackSpeed({ keys: [{ t: 0, value: 10 }, { t: 2, value: 30 }] })).toBe(10);
    expect(trackSpeed({ keys: [{ t: 2, value: 0 }, { t: 0, value: 10 }] })).toBe(-5);
  });
  test("no single speed: other key counts, easing or step", () => {
    expect(trackSpeed({ keys: [{ t: 0, value: 0 }] })).toBeNull();
    expect(trackSpeed({ keys: [{ t: 0, value: 0 }, { t: 1, value: 1 }, { t: 2, value: 5 }] })).toBeNull();
    expect(trackSpeed({ keys: [{ t: 0, value: 0, ease: "ease" }, { t: 1, value: 1 }] })).toBeNull();
    expect(trackSpeed({ keys: [{ t: 0, value: 0, ease: "step" }, { t: 1, value: 1 }] })).toBeNull();
  });
});
