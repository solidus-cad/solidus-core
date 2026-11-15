import { beforeAll, describe, expect, it } from "vitest";
import { createPartDocument, emptySketch, sketchFrame, SKETCH_ORIGIN, type Feature, type PartDocument, type SketchData } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";

let engine: WasmKernelEngine;

beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

function doc(features: (Omit<Feature, "id" | "name"> & { id?: string })[]): PartDocument {
  const d = createPartDocument("tole");
  d.id = "tole";
  d.features = features.map((f, i) => ({ ...f, id: f.id ?? `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return d;
}

/** 100 × 60 rectangle at the origin of the XY plane. */
function rect(): SketchData {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "b", type: "point", x: 100, y: 0 },
    { id: "c", type: "point", x: 100, y: 60 },
    { id: "d", type: "point", x: 0, y: 60 },
    { id: "l1", type: "line", p1: SKETCH_ORIGIN, p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
    { id: "l3", type: "line", p1: "c", p2: "d" },
    { id: "l4", type: "line", p1: "d", p2: SKETCH_ORIGIN },
  ];
  return s;
}

function circle(base: "XY" | "XZ", x: number, y: number, r: number): SketchData {
  const s = emptySketch(base);
  s.geometry = [
    { id: "c", type: "point", x, y },
    { id: "k", type: "circle", c: "c", r },
  ];
  return s;
}

/** Open L-shaped profile in the XZ plane: (0, 0) → (50, 0) → (50, 30). */
function lProfile(): SketchData {
  const s = emptySketch("XZ");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 50, y: 0 },
    { id: "c", type: "point", x: 50, y: 30 },
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
  ];
  return s;
}

const sheet = { thickness: "2", radius: "2", kFactor: "0.5", depth: "40", reverse: "no" };
const base = [
  { id: "sk", type: "sketch", params: {}, sketch: rect() },
  { id: "base", type: "sheetBase", params: { ...sheet, sketch: "sk" } },
];
/** Edge flange at 90° of 20 mm on the top edge y = 60. */
const flange = { id: "fl", type: "edgeFlange", params: { length: "20", angle: "90", direction: "same" }, refs: [{ kind: "edge" as const, p: [50, 60, 2] as [number, number, number], size: 100 }] };

const BA = (Math.PI / 2) * (2 + 0.5 * 2); // bend allowance of a 90° bend (R = 2, T = 2, K = 0.5)

function yMax(r: { mesh: { positions: Float32Array } | null }): number {
  let m = -Infinity;
  const p = r.mesh!.positions;
  for (let i = 1; i < p.length; i += 3) m = Math.max(m, p[i]!);
  return m;
}

function zMax(r: { mesh: { positions: Float32Array } | null }): number {
  let m = -Infinity;
  const p = r.mesh!.positions;
  for (let i = 2; i < p.length; i += 3) m = Math.max(m, p[i]!);
  return m;
}

describe("Sheet metal", () => {
  it("creates a flat sheet from a closed contour", () => {
    const r = engine.recompute(doc(base));
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 2, 3);
  });

  it("adds an edge flange with a real bend and an exact flat pattern", () => {
    const r = engine.recompute(doc([...base, flange]));
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok", "ok"]);
    const bend = (Math.PI / 4) * (4 ** 2 - 2 ** 2) * 100;
    expect(r.mass!.volume).toBeCloseTo(12000 + bend + 20 * 2 * 100, 1);
    // Vertical plate: from the top of the bend (z = R + T = 4) up to 4 + 20.
    expect(zMax(r)).toBeCloseTo(24, 1);

    const flat = engine.flatPattern(doc([...base, flange]));
    expect(flat.bounds[0]).toBeCloseTo(0, 3);
    expect(flat.bounds[2]).toBeCloseTo(100, 3);
    expect(flat.bounds[3] - flat.bounds[1]).toBeCloseTo(60 + BA + 20, 2);
    expect(flat.bends).toHaveLength(1);
    expect(flat.bends[0]!.angle).toBeCloseTo(90, 6);
    expect(flat.bends[0]!.y1).toBeCloseTo(60 + BA / 2, 3);

    // Flattening: same volume (K = 0.5: neutral fiber at mid-thickness), flat sheet.
    const f = engine.recompute(doc([...base, flange, { type: "sheetFlat", params: {} }]));
    expect(f.statuses.every((s) => s.ok)).toBe(true);
    expect(f.mass!.volume).toBeCloseTo(r.mass!.volume, 1);
    expect(zMax(f)).toBeCloseTo(2, 3);
  });

  it("edge flange on a lower edge: the bend goes outside the sheet, flat pattern is a single contour", () => {
    const below = { ...flange, refs: [{ kind: "edge" as const, p: [50, 60, 0] as [number, number, number], size: 100 }] };
    for (const direction of ["same", "opposite"]) {
      const f = { ...below, params: { ...below.params, direction } };
      const r = engine.recompute(doc([...base, f]));
      expect(r.statuses.every((s) => s.ok)).toBe(true);
      // No overlap with the base sheet: full volume.
      expect(r.mass!.volume).toBeCloseTo(12000 + (Math.PI / 4) * 12 * 100 + 4000, 1);
      const flat = engine.flatPattern(doc([...base, f]));
      expect(flat.bounds[3]).toBeCloseTo(60 + BA + 20, 2);
      expect(flat.outline.length).toBe(16); // a rectangle: 4 segments
      expect(flat.bends[0]!.y1).toBeCloseTo(60 + BA / 2, 3);
    }
  });

  it("carries a cut of the edge flange into the flat pattern", () => {
    const features = [
      ...base,
      flange,
      { id: "hole", type: "sketch", params: {}, sketch: circle("XZ", 50, 15, 4) },
      { type: "sheetCut", params: { sketch: "hole" } },
    ];
    const r = engine.recompute(doc(features));
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    const flat = engine.flatPattern(doc(features));
    const c = Array.from(flat.circles);
    const found = [];
    for (let i = 0; i < c.length; i += 3) if (Math.abs(c[i + 2]! - 4) < 1e-6) found.push([c[i]!, c[i + 1]!]);
    expect(found.length).toBeGreaterThan(0);
    // The hole is 15 − 4 = 11 mm from the start of the bent plate, beyond the bend.
    expect(found[0]![0]).toBeCloseTo(50, 3);
    expect(found[0]![1]).toBeCloseTo(60 + BA + 11, 2);
  });

  it("carries a Part cut placed on the edge flange into the flat pattern", () => {
    const features = [
      ...base,
      flange,
      { id: "hole", type: "sketch", params: {}, sketch: circle("XZ", 50, 15, 4) },
      { type: "extrude", params: { sketch: "hole", mode: "throughAll", depth: "1", reverse: "no", op: "cut" } },
    ];
    const flat = engine.flatPattern(doc(features));
    const c = Array.from(flat.circles);
    const found = [];
    for (let i = 0; i < c.length; i += 3) if (Math.abs(c[i + 2]! - 4) < 1e-6) found.push([c[i]!, c[i + 1]!]);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]![0]).toBeCloseTo(50, 3);
    expect(found[0]![1]).toBeCloseTo(60 + BA + 11, 2);
    // The flattened body is drilled as well: same volume as the folded one.
    const folded = engine.recompute(doc(features));
    const flatBody = engine.recompute(doc([...features, { type: "sheetFlat", params: {} }]));
    expect(flatBody.mass!.volume).toBeCloseTo(folded.mass!.volume, 3);
  });

  it("carries a hole and a slot placed on the edge flange into the flat pattern", () => {
    // XZ plane offset in front of the edge flange (y = 60 to 62); drilling toward the edge.
    const point = emptySketch("XZ");
    point.plane.offset = "-70";
    point.geometry = [{ id: "p", type: "point", x: 30, y: 15 }];
    const axis = emptySketch("XZ");
    axis.plane.offset = "-70";
    axis.geometry = [
      { id: "a", type: "point", x: 50, y: 15 },
      { id: "b", type: "point", x: 70, y: 15 },
      { id: "l", type: "line", p1: "a", p2: "b" },
    ];
    const cases: { sketch: SketchData; feature: { type: string; params: Record<string, string> }; centres: number[][] }[] = [
      { sketch: point, feature: { type: "hole", params: { sketch: "h", type: "simple", size: "M6", mode: "throughAll", depth: "1", reverse: "yes" } }, centres: [[30, 3.3]] },
      { sketch: axis, feature: { type: "slot", params: { sketch: "h", width: "8", mode: "throughAll", depth: "1", reverse: "yes" } }, centres: [[50, 4], [70, 4]] },
    ];
    const plain = engine.recompute(doc([...base, flange]));
    for (const { sketch, feature, centres } of cases) {
      const features = [...base, flange, { id: "h", type: "sketch", params: {}, sketch }, feature];
      const folded = engine.recompute(doc(features));
      expect(folded.statuses.every((s) => s.ok)).toBe(true);
      expect(folded.mass!.volume).toBeLessThan(plain.mass!.volume - 1);
      const c = Array.from(engine.flatPattern(doc(features)).circles);
      const found: number[][] = [];
      for (let i = 0; i < c.length; i += 3) found.push([c[i]!, c[i + 1]!, c[i + 2]!]);
      found.sort((a, b) => a[0]! - b[0]!);
      expect(found).toHaveLength(centres.length);
      centres.forEach(([x, r], i) => {
        expect(found[i]![0]).toBeCloseTo(x!, 3);
        expect(found[i]![1]).toBeCloseTo(60 + BA + 11, 2);
        expect(found[i]![2]).toBeCloseTo(r!, 3);
      });
      const flatBody = engine.recompute(doc([...features, { type: "sheetFlat", params: {} }]));
      expect(flatBody.mass!.volume).toBeCloseTo(folded.mass!.volume, 3);
    }
  });

  it("after flattening: the cut applies to the flat pattern, bends are rejected", () => {
    const flatFirst = [...base, flange, { type: "sheetFlat", params: {} }];
    const features = [
      ...flatFirst,
      { id: "hole", type: "sketch", params: {}, sketch: circle("XY", 50, 30, 4) },
      { type: "extrude", params: { sketch: "hole", mode: "throughAll", depth: "1", reverse: "no", op: "cut" } },
    ];
    const r = engine.recompute(doc(features));
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    const c = Array.from(engine.flatPattern(doc(features)).circles);
    const found = [];
    for (let i = 0; i < c.length; i += 3) if (Math.abs(c[i + 2]! - 4) < 1e-6) found.push([c[i]!, c[i + 1]!]);
    expect(found).toHaveLength(1);
    expect(found[0]![0]).toBeCloseTo(50, 3);
    expect(found[0]![1]).toBeCloseTo(30, 3);
    const again = engine.recompute(doc([...flatFirst, { ...flange, id: "fl2" }]));
    expect(again.statuses.at(-1)!.ok).toBe(false);
  });

  it("bends a sheet along an open profile", () => {
    const a = engine.recompute(doc([{ id: "p", type: "sketch", params: {}, sketch: lProfile() }, { type: "sheetBase", params: { ...sheet, sketch: "p" } }]));
    const b = engine.recompute(doc([{ id: "p", type: "sketch", params: {}, sketch: lProfile() }, { type: "sheetBase", params: { ...sheet, sketch: "p", reverse: "yes" } }]));
    expect(a.statuses.every((s) => s.ok)).toBe(true);
    expect(b.statuses.every((s) => s.ok)).toBe(true);
    const bend = (Math.PI / 4) * (4 ** 2 - 2 ** 2) * 40;
    // Inner bend (setback R) or outer bend (setback R + T), depending on the side of the material.
    const inner = (48 + 28) * 2 * 40 + bend;
    const outer = (46 + 26) * 2 * 40 + bend;
    const vols = [a.mass!.volume, b.mass!.volume].sort((x, y) => x - y);
    expect(vols[0]).toBeCloseTo(outer, 1);
    expect(vols[1]).toBeCloseTo(inner, 1);
  });

  it("extrudes an open profile symmetrically about the sketch plane", () => {
    const sheetOf = (depthMode: string) =>
      engine.recompute(doc([{ id: "p", type: "sketch", params: {}, sketch: lProfile() }, { type: "sheetBase", params: { ...sheet, sketch: "p", depthMode } }]));
    const one = sheetOf("oneSide");
    const mid = sheetOf("symmetric");
    expect(mid.statuses.every((s) => s.ok)).toBe(true);
    expect(mid.mass!.volume).toBeCloseTo(one.mass!.volume, 3);
    // Same sheet, moved back by half the depth along the normal of the XZ sketch (Y axis): centred on the plane.
    expect(Math.abs(one.mass!.center[1])).toBeCloseTo(20, 3);
    expect(mid.mass!.center[1]).toBeCloseTo(0, 3);
    expect(mid.mass!.center[0]).toBeCloseTo(one.mass!.center[0], 3);
    expect(mid.mass!.center[2]).toBeCloseTo(one.mass!.center[2], 3);
  });

  it("flange position: material inside or outside shortens the sheet", () => {
    const bend = (Math.PI / 4) * 12 * 100;
    for (const [position, setback] of [["materialInside", 4], ["materialOutside", 2]] as const) {
      const f = { ...flange, params: { ...flange.params, position } };
      const r = engine.recompute(doc([...base, f]));
      expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok", "ok"]);
      expect(r.mass!.volume).toBeCloseTo(12000 - setback * 2 * 100 + bend + 4000, 1);
      // Outer face (inside) or inner face (outside) of the flange, at the edge y = 60.
      expect(yMax(r)).toBeCloseTo(60 - setback + 4, 1);
      const flat = engine.flatPattern(doc([...base, f]));
      expect(flat.bounds[3]).toBeCloseTo(60 - setback + BA + 20, 2);
    }
  });

  it("flange shorter than the edge: square or round bend reliefs and setbacks", () => {
    const bend = (Math.PI / 4) * 12 * 80;
    const expected = { rect: 2 * (2 * 4 * 2), round: 2 * (3 * 2 * 2 + Math.PI), none: 0 };
    for (const relief of ["rect", "round", "none"] as const) {
      const f = { ...flange, params: { ...flange.params, offsetStart: "10", offsetEnd: "10", relief } };
      const r = engine.recompute(doc([...base, f]));
      expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok", "ok"]);
      expect(r.mass!.volume).toBeCloseTo(12000 - expected[relief] + bend + 20 * 2 * 80, 1);
      const flat = engine.flatPattern(doc([...base, f]));
      expect(flat.bounds[3]).toBeCloseTo(60 + BA + 20, 2);
      expect(flat.bends[0]!.x1 === 10 || flat.bends[0]!.x1 === 90).toBe(true);
    }
  });

  it("bend on a sketch line: the moving side rises, the flat pattern does not change", () => {
    const line = emptySketch("XY");
    line.geometry = [
      { id: "a", type: "point", x: 50, y: -10 },
      { id: "b", type: "point", x: 50, y: 70 },
      { id: "l", type: "line", p1: "a", p2: "b" },
    ];
    const features = [...base, { id: "ln", type: "sketch", params: {}, sketch: line }, { type: "sketchedBend", params: { sketch: "ln", angle: "90", direction: "same", flip: "no" } }];
    const r = engine.recompute(doc(features));
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok", "ok", "ok"]);
    // K = 0.5: the bent zone keeps the volume of the developed strip.
    expect(r.mass!.volume).toBeCloseTo(12000, 1);
    expect(zMax(r)).toBeCloseTo(4 + 50 - BA / 2, 1);
    const flat = engine.flatPattern(doc(features));
    expect(flat.bounds).toEqual([expect.closeTo(0, 3), expect.closeTo(0, 3), expect.closeTo(100, 3), expect.closeTo(60, 3)]);
    expect(flat.bends).toHaveLength(1);
    expect(flat.bends[0]!.x1).toBeCloseTo(50, 3);

    // An edge flange on the moving side follows the bend.
    const side = { ...flange, id: "f2", refs: [{ kind: "edge" as const, p: [100, 30, 2] as [number, number, number], size: 60 }] };
    const withFlange = [...base, side, ...features.slice(2)];
    const r2 = engine.recompute(doc(withFlange));
    expect(r2.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(r2.mass!.volume).toBeCloseTo(12000 + (Math.PI / 4) * 12 * 60 + 20 * 2 * 60, 1);
    expect(engine.flatPattern(doc(withFlange)).bends).toHaveLength(2);
  });

  it("closes the corner between two edges designated together (overlap or butt)", () => {
    const two = (corner: string) => ({
      ...flange,
      params: { ...flange.params, corner },
      refs: [flange.refs[0]!, { kind: "edge" as const, p: [100, 30, 2] as [number, number, number], size: 60 }],
    });
    const plate = (len: number) => 20 * 2 * len;
    const bends = (Math.PI / 4) * 12 * (100 + 60);
    const open = engine.recompute(doc([...base, two("open")]));
    expect(open.statuses.every((x) => x.ok)).toBe(true);
    expect(open.mass!.volume).toBeCloseTo(12000 + bends + plate(100) + plate(60), 1);
    // Overlap: the first plate lengthens by R + T, the second by R; neither overlaps.
    const overlap = engine.recompute(doc([...base, two("overlap")]));
    expect(overlap.statuses.every((x) => x.ok)).toBe(true);
    expect(overlap.mass!.volume).toBeCloseTo(open.mass!.volume + plate(4) + plate(2), 1);
    // Butt: each lengthens by R + T/2; they overlap over T/2 × T/2.
    const butt = engine.recompute(doc([...base, two("butt")]));
    expect(butt.statuses.every((x) => x.ok)).toBe(true);
    expect(butt.mass!.volume).toBeCloseTo(open.mass!.volume + 2 * plate(3) - 1 * 1 * 20, 1);
    // Flat pattern: the extensions lie flat, without overlap.
    const flat = engine.flatPattern(doc([...base, two("overlap")]));
    expect(flat.bounds[2]).toBeCloseTo(100 + BA + 20, 2);
    expect(flat.bounds[3]).toBeCloseTo(60 + BA + 20, 2);
  });

  it("cut across a bend: the bent strip is also removed from the flat pattern", () => {
    const cut = emptySketch("XY");
    cut.geometry = [
      { id: "p1", type: "point", x: 40, y: 55 },
      { id: "p2", type: "point", x: 60, y: 55 },
      { id: "p3", type: "point", x: 60, y: 90 },
      { id: "p4", type: "point", x: 40, y: 90 },
      { id: "a", type: "line", p1: "p1", p2: "p2" },
      { id: "b", type: "line", p1: "p2", p2: "p3" },
      { id: "c", type: "line", p1: "p3", p2: "p4" },
      { id: "d", type: "line", p1: "p4", p2: "p1" },
    ];
    const features = [...base, flange, { id: "cut", type: "sketch", params: {}, sketch: cut }, { type: "sheetCut", params: { sketch: "cut" } }];
    const folded = engine.recompute(doc(features));
    expect(folded.statuses.every((x) => x.ok)).toBe(true);
    const flat = engine.recompute(doc([...features, { type: "sheetFlat", params: {} }]));
    expect(flat.statuses.every((x) => x.ok)).toBe(true);
    // 20 mm wide notch, from y = 55 to the end of the flange: sheet, bend and flange.
    const full = 100 * (60 + BA + 20) * 2;
    expect(flat.mass!.volume).toBeCloseTo(full - 20 * (60 + BA + 20 - 55) * 2, 1);
    // K = 0.5: the folded and flat bodies keep the same volume.
    expect(flat.mass!.volume).toBeCloseTo(folded.mass!.volume, 1);
  });

  it("hole drilled in the bend, normal to the neutral fiber: unrolled in the bent strip", () => {
    // Point on the neutral fiber (radius R + K·T = 3) at the middle of the bend, bend axis at (y = 60, z = 4).
    const c = Math.SQRT1_2;
    const P: [number, number, number] = [50, 60 + 3 * c, 4 - 3 * c];
    const hole = emptySketch("XY");
    hole.plane.face = { p: P, n: [0, c, -c] };
    const f = sketchFrame(hole.plane, 0);
    const d = [P[0] - f.origin.x, P[1] - f.origin.y, P[2] - f.origin.z];
    const x = d[0]! * f.xDir.x + d[1]! * f.xDir.y + d[2]! * f.xDir.z;
    const y = d[0]! * f.yDir.x + d[1]! * f.yDir.y + d[2]! * f.yDir.z;
    hole.geometry = [
      { id: "c", type: "point", x, y },
      { id: "k", type: "circle", c: "c", r: 1.2 },
    ];
    const features = [...base, flange, { id: "h", type: "sketch", params: {}, sketch: hole }, { type: "sheetCut", params: { sketch: "h" } }];
    const r = engine.recompute(doc(features));
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    const plain = engine.recompute(doc([...base, flange, { type: "sheetFlat", params: {} }]));
    const flat = engine.recompute(doc([...features, { type: "sheetFlat", params: {} }]));
    // Unrolled hole: about π·1.2² on the neutral fiber, through the full thickness. (Radius < 2·cos 45°:
    // the hole touches neither the sheet nor the edge, only the bend.)
    expect(plain.mass!.volume - flat.mass!.volume).toBeCloseTo(Math.PI * 1.2 ** 2 * 2, 0);
    const outline = engine.flatPattern(doc(features));
    // The hole outline lies in the bend strip (60 ≤ y ≤ 60 + BA).
    const ys: number[] = [];
    for (let i = 0; i < outline.outline.length; i += 2) {
      const xx = outline.outline[i]!;
      const yy = outline.outline[i + 1]!;
      if (xx > 45 && xx < 55) ys.push(yy);
    }
    const inner = ys.filter((v) => v > 59 && v < 61 + BA);
    expect(inner.length).toBeGreaterThan(8);
    expect(Math.min(...inner)).toBeGreaterThan(60);
    expect(Math.max(...inner)).toBeLessThan(60 + BA);
  });

  it("rejects an edge flange without a base sheet", () => {
    const r = engine.recompute(doc([{ type: "box", params: { width: "10", depth: "10", height: "10", x: "0", y: "0", z: "0", op: "add" } }, flange]));
    expect(r.statuses[1]).toMatchObject({ ok: false });
  });
});
