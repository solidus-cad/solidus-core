import { beforeAll, describe, expect, it } from "vitest";
import { createImportedPart, createPartDocument, emptySketch, sectionArea, sectionFamily, SKETCH_AXIS_V, SKETCH_ORIGIN, type Feature, type PartDocument, type SketchData } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";

let engine: WasmKernelEngine;

beforeAll(async () => {
  engine = await WasmKernelEngine.create(await SketchSolver.create());
});

function doc(features: (Omit<Feature, "id" | "name"> & { id?: string })[], parameters: PartDocument["parameters"] = []): PartDocument {
  const d = createPartDocument("test");
  d.id = "test"; // same document from one call to the next: the cache is reused
  d.parameters = parameters;
  d.features = features.map((f, i) => ({ ...f, id: f.id ?? `f${i}`, name: `F${i}` }));
  d.rollback = d.features.length;
  return d;
}

const block = { type: "box", params: { width: "L", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } };
const hole = { type: "cylinder", params: { radius: "15", height: "40", x: "L / 2", y: "30", z: "0", axis: "z", op: "cut" } };

describe("CAM meshing", () => {
  it("camMesh: more triangles than the display, deflection respected on a cylinder", () => {
    const d = doc([block, hole], [{ name: "L", expr: "100" }]);
    const shown = engine.recompute(d).mesh!;
    const fine = engine.camMesh(d, 0.005)!;
    expect(fine.indices.length).toBeGreaterThan(shown.indices.length);
    expect(fine.faceGroups.length).toBe(shown.faceGroups.length);
    // Ø30 hole at (50, 30): all vertices of its wall lie on the circle, the chords deviate by less than the deflection
    const p = fine.positions;
    let worst = 0;
    for (let g = 0; g + 2 < fine.faceGroups.length; g += 3) {
      const verts = new Set<number>();
      for (let i = fine.faceGroups[g]!; i < fine.faceGroups[g]! + fine.faceGroups[g + 1]!; i++) verts.add(fine.indices[i]! * 3);
      const onHole = [...verts].every((v) => Math.abs(Math.hypot(p[v]! - 50, p[v + 1]! - 30) - 15) < 1e-3);
      if (!onHole || !verts.size) continue;
      for (let i = fine.faceGroups[g]!; i + 2 < fine.faceGroups[g]! + fine.faceGroups[g + 1]!; i += 3) {
        const [a, b] = [fine.indices[i]! * 3, fine.indices[i + 1]! * 3];
        const mx = (p[a]! + p[b]!) / 2 - 50;
        const my = (p[a + 1]! + p[b + 1]!) / 2 - 30;
        worst = Math.max(worst, 15 - Math.hypot(mx, my));
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.02);
    // The display keeps its coarse mesh on the next recompute
    expect(engine.recompute(d).mesh!.indices.length).toBe(shown.indices.length);
  });
});

describe("WasmKernelEngine (cad-core)", () => {
  it("computes a box with a hole driven by a parameter", () => {
    const r = engine.recompute(doc([block, hole], [{ name: "L", expr: "100" }]));
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40 - Math.PI * 15 ** 2 * 40, 0);
    expect(r.mesh!.indices.length).toBeGreaterThan(0);
    expect(r.mesh!.faceGroups.length % 3).toBe(0);
  });

  it("finds the feature that created a designated face", () => {
    const fillet = { type: "fillet", params: { radius: "3" } };
    engine.recompute(doc([block, hole, fillet], [{ name: "L", expr: "100" }]));
    const at = (name: string) => engine.featureAt("test", engine.resolveName("test", name));
    expect(at("f0/top")).toBe("f0"); // top of the box
    expect(at("f1/lateral")).toBe("f1"); // hole wall
    expect(at("f2/fillet(e(f0/front|f0/top))")).toBe("f2"); // fillet of the front-top edge
    expect(engine.featureAt("test", 9999)).toBeNull();
  });

  it("reports the feature that created each face", () => {
    const d = doc([block, hole], [{ name: "L", expr: "100" }]);
    const r = engine.recompute(d);
    const owners = r.faceFeatures!;
    expect(owners.length).toBe(r.mesh!.faceGroups.length / 3);
    const hits = owners.filter((f) => f === "f1").length;
    expect(hits).toBeGreaterThanOrEqual(1); // hole wall (one face, or two if the seam cuts it)
    expect(hits).toBeLessThanOrEqual(2);
    expect(owners.filter((f) => f === "f0").length).toBe(6); // the six faces of the box (top and bottom pierced)
    expect(owners.every((f) => f === "f0" || f === "f1")).toBe(true);
  });

  it("reuses the cache and only recomputes downstream", () => {
    const params = [{ name: "L", expr: "100" }];
    engine.recompute(doc([block, hole], params));
    expect(engine.recompute(doc([block, hole], params)).rebuilt).toBe(0);
    const bigger = { ...hole, params: { ...hole.params, radius: "20" } };
    expect(engine.recompute(doc([block, bigger], params)).rebuilt).toBe(1);
  });

  it("frees the least recent documents beyond the limit", async () => {
    // Kernel limit: 8 documents (maxCachedDocs, core/document/engine.hpp). New engine, for an empty cache.
    const params = [{ name: "L", expr: "100" }];
    const as = (id: string) => ({ ...doc([block, hole], params), id });
    const e = await WasmKernelEngine.create(await SketchSolver.create());
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    for (const id of ids) e.recompute(as(id));
    e.trim();
    expect(e.recompute(as("i")).rebuilt).toBe(0);
    expect(e.recompute(as("a")).rebuilt).toBe(2); // "a" was the least recent: freed, then rebuilt
    e.forget("i");
    expect(e.recompute(as("i")).rebuilt).toBe(2);
    e.dispose();
  });

  it("computes the inertia tensor at the center of gravity", () => {
    // Box 100 × 60 × 40: Ixx = V(b² + c²)/12, zero products.
    const box = engine.recompute(doc([block], [{ name: "L", expr: "100" }])).mass!;
    const V = 100 * 60 * 40;
    expect(box.inertia!.xx / (V * (60 ** 2 + 40 ** 2) / 12)).toBeCloseTo(1, 6);
    expect(box.inertia!.yy / (V * (100 ** 2 + 40 ** 2) / 12)).toBeCloseTo(1, 6);
    expect(box.inertia!.zz / (V * (100 ** 2 + 60 ** 2) / 12)).toBeCloseTo(1, 6);
    expect(Math.abs(box.inertia!.xy) / box.inertia!.xx).toBeLessThan(1e-9);

    // L: two adjacent boxes; product Pxy = Σ Vᵢ (xᵢ − Gx)(yᵢ − Gy) (own products zero).
    const a = { type: "box", params: { width: "20", depth: "20", height: "10", x: "0", y: "0", z: "0", op: "add" } };
    const b = { type: "box", params: { width: "20", depth: "10", height: "10", x: "20", y: "0", z: "0", op: "add" } };
    const l = engine.recompute({ ...doc([a, b]), id: "l-shape" }).mass!;
    const parts = [
      { v: 4000, c: [10, 10, 5] },
      { v: 2000, c: [30, 5, 5] },
    ];
    const g = [0, 1, 2].map((i) => parts.reduce((n, p) => n + p.v * p.c[i]!, 0) / 6000);
    const pxy = parts.reduce((n, p) => n + p.v * (p.c[0]! - g[0]!) * (p.c[1]! - g[1]!), 0);
    expect(l.center[0]).toBeCloseTo(g[0]!, 6);
    expect(pxy).toBeLessThan(0);
    expect(l.inertia!.xy).toBeCloseTo(pxy, 3);
    expect(l.inertia!.xz).toBeCloseTo(0, 3);
    expect(l.inertia!.yz).toBeCloseTo(0, 3);
  });

  it("isolates a feature in error without losing the body", () => {
    const r = engine.recompute(doc([block, { type: "fillet", params: { radius: "500" } }], [{ name: "L", expr: "100" }]));
    expect(r.statuses[0]!.ok).toBe(true);
    expect(r.statuses[1]!.ok).toBe(false);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40, 0);
  });

  it("reports invalid expressions", () => {
    const r = engine.recompute(doc([block], []));
    expect(r.statuses[0]).toMatchObject({ ok: false });
    expect(r.mesh).toBeNull();
  });

  it("applies fillets and chamfers", () => {
    const params = [{ name: "L", expr: "100" }];
    const filleted = engine.recompute(doc([block, hole, { type: "fillet", params: { radius: "3" } }], params));
    expect(filleted.statuses.every((s) => s.ok)).toBe(true);
    const chamfered = engine.recompute(doc([block, { type: "chamfer", params: { distance: "2" } }], params));
    expect(chamfered.statuses.every((s) => s.ok)).toBe(true);
    expect(chamfered.mass!.volume).toBeLessThan(100 * 60 * 40);
  });

  it("exports to STEP and STL", () => {
    engine.recompute(doc([block], [{ name: "L", expr: "100" }]));
    const step = new TextDecoder().decode(engine.exportShape("step"));
    expect(step.startsWith("ISO-10303-21")).toBe(true);
    expect(engine.exportShape("stl").length).toBeGreaterThan(100);
  });

  it("imports a STEP: same volume, and features can be added to the imported body", () => {
    engine.recompute(doc([block, hole], [{ name: "L", expr: "100" }]));
    const step = engine.exportShape("step");
    const imported = createImportedPart("palier.step", step);
    expect(imported.name).toBe("palier");
    imported.id = "imported";
    const r = engine.recompute(imported);
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40 - Math.PI * 15 ** 2 * 40, 0);
    // Hole added after the import.
    imported.features.push({ id: "c", name: "Trou", type: "cylinder", params: { radius: "5", height: "40", x: "10", y: "10", z: "0", axis: "z", op: "cut" } });
    imported.rollback = imported.features.length;
    const r2 = engine.recompute(imported);
    expect(r2.mass!.volume).toBeCloseTo(r.mass!.volume - Math.PI * 25 * 40, 0);
  });

  it("reports an unreadable STEP file", () => {
    const bad = createImportedPart("bad.step", new TextEncoder().encode("pas un STEP"));
    bad.id = "bad";
    const r = engine.recompute(bad);
    expect(r.statuses[0]).toMatchObject({ ok: false });
  });
});

/** Rectangle w × h with a corner at the origin, plus a centered hole of radius r (optional). */
function rectSketch(w: string, h: string, r?: string): SketchData {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "b", type: "point", x: 10, y: 0 },
    { id: "c", type: "point", x: 10, y: 10 },
    { id: "d", type: "point", x: 0, y: 10 },
    { id: "l1", type: "line", p1: SKETCH_ORIGIN, p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
    { id: "l3", type: "line", p1: "c", p2: "d" },
    { id: "l4", type: "line", p1: "d", p2: SKETCH_ORIGIN },
  ];
  s.constraints = [
    { id: "h1", type: "horizontal", a: "l1" },
    { id: "h2", type: "horizontal", a: "l3" },
    { id: "v1", type: "vertical", a: "l2" },
    { id: "v2", type: "vertical", a: "l4" },
  ];
  s.dimensions = [
    { id: "dw", type: "distance", a: "l1", value: w, driving: true },
    { id: "dh", type: "distance", a: "l2", value: h, driving: true },
  ];
  if (r) {
    s.geometry.push({ id: "hc", type: "point", x: 5, y: 5 }, { id: "hole", type: "circle", c: "hc", r: 1 });
    s.dimensions.push(
      { id: "dr", type: "radius", a: "hole", value: r, driving: true },
      { id: "dx", type: "horizontalDistance", a: SKETCH_ORIGIN, b: "hc", value: `(${w}) / 2`, driving: true },
      { id: "dy", type: "verticalDistance", a: SKETCH_ORIGIN, b: "hc", value: `(${h}) / 2`, driving: true },
    );
  }
  return s;
}

describe("Sketches", () => {
  it("extrudes a pierced rectangle driven by parameters", () => {
    const sk = { id: "sk", type: "sketch", params: {}, sketch: rectSketch("L", "40", "5") };
    const ex = { type: "extrude", params: { sketch: "sk", mode: "blind", depth: "10", reverse: "no", op: "add" } };
    const r = engine.recompute(doc([sk, ex], [{ name: "L", expr: "60" }]));
    expect(r.statuses.map((s) => s.ok)).toEqual([true, true]);
    expect(r.sketches.sk!.dof).toBe(0);
    expect(r.mass!.volume).toBeCloseTo((60 * 40 - Math.PI * 25) * 10, 3);
    expect(r.mass!.center[2]).toBeCloseTo(5, 6);
  });

  it("extrudes symmetrically, reversed, and cuts through all", () => {
    const base = { id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") };
    const sym = engine.recompute(doc([base, { type: "extrude", params: { sketch: "sk", mode: "symmetric", depth: "10", reverse: "no", op: "add" } }]));
    expect(sym.mass!.center[2]).toBeCloseTo(0, 6);
    const rev = engine.recompute(doc([base, { type: "extrude", params: { sketch: "sk", mode: "blind", depth: "10", reverse: "yes", op: "add" } }]));
    expect(rev.mass!.center[2]).toBeCloseTo(-5, 6);

    const cutSketch = rectSketch("20", "20");
    cutSketch.plane.offset = "100";
    const r = engine.recompute(
      doc([
        base,
        { type: "extrude", params: { sketch: "sk", mode: "blind", depth: "10", reverse: "no", op: "add" } },
        { id: "sk2", type: "sketch", params: {}, sketch: cutSketch },
        { type: "extrude", params: { sketch: "sk2", mode: "throughAll", depth: "1", reverse: "no", op: "cut" } },
      ]),
    );
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.mass!.volume).toBeCloseTo((60 * 40 - 20 * 20) * 10, 3);
  });

  it("revolves a profile about the V axis", () => {
    // 10 × 40 rectangle offset by 20 from the axis: tube with inner Ø 40, outer Ø 60, height 40.
    const s = rectSketch("10", "40");
    s.dimensions.push({ id: "off", type: "horizontalDistance", a: SKETCH_ORIGIN, b: "b", value: "30", driving: true });
    // The corner is no longer at the origin: it is replaced by a free point on the H axis.
    const at: Record<string, [number, number]> = { b: [30, 0], c: [30, 40], d: [20, 40] };
    s.geometry = s.geometry.map((g) => (g.type === "point" && at[g.id] ? { ...g, x: at[g.id]![0], y: at[g.id]![1] } : g));
    s.geometry.push({ id: "a", type: "point", x: 20, y: 0 });
    s.geometry = s.geometry.map((g) =>
      g.type === "line" ? { ...g, p1: g.p1 === SKETCH_ORIGIN ? "a" : g.p1, p2: g.p2 === SKETCH_ORIGIN ? "a" : g.p2 } : g,
    );
    s.constraints.push({ id: "onH", type: "pointOnCurve", point: "a", curve: "axis:H" });
    const r = engine.recompute(
      doc([
        { id: "sk", type: "sketch", params: {}, sketch: s },
        { type: "revolve", params: { sketch: "sk", axis: SKETCH_AXIS_V, angle: "360", op: "add" } },
      ]),
    );
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(Math.PI * (30 ** 2 - 20 ** 2) * 40, 1);
  });

  it("reports a sketch without a closed contour", () => {
    const s = rectSketch("60", "40");
    s.geometry = s.geometry.filter((g) => g.id !== "l4");
    s.constraints = s.constraints.filter((c) => c.id !== "v2");
    const r = engine.recompute(
      doc([
        { id: "sk", type: "sketch", params: {}, sketch: s },
        { type: "extrude", params: { sketch: "sk", mode: "blind", depth: "10", reverse: "no", op: "add" } },
      ]),
    );
    expect(r.statuses[0]!.ok).toBe(true);
    expect(r.statuses[1]).toMatchObject({ ok: false, error: expect.stringContaining("contour fermé") });
  });
});

/** L-shaped path: line from (0,0) to (50,0), then an arc of radius 20 turned 90°, then a vertical line. */
function pathSketch(): SketchData {
  const s = emptySketch("XZ");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 50, y: 0 },
    { id: "c", type: "point", x: 50, y: 20 },
    { id: "d", type: "point", x: 70, y: 20 },
    { id: "e", type: "point", x: 70, y: 60 },
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "arc", type: "arc", c: "c", start: "b", end: "d" },
    { id: "l2", type: "line", p1: "d", p2: "e" },
  ];
  return s;
}

/** Isolated points at the given positions (hole positions). */
function pointsSketch(pts: [number, number][], offset = "0"): SketchData {
  const s = emptySketch("XY");
  s.plane.offset = offset;
  s.geometry = pts.map(([x, y], i) => ({ id: `p${i}`, type: "point" as const, x, y }));
  return s;
}

const plate = { type: "box", params: { width: "100", depth: "60", height: "10", x: "0", y: "0", z: "0", op: "add" } };

describe("Advanced features", () => {
  it("sweeps a tube along a line + arc + line path", () => {
    const r = engine.recompute(
      doc([
        { id: "path", type: "sketch", params: {}, sketch: pathSketch() },
        { type: "sweep", params: { path: "path", profile: "circle", diameter: "10", inner: "6", profileSketch: "", op: "add" } },
      ]),
    );
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    const length = 50 + (Math.PI / 2) * 20 + 40;
    expect(r.mass!.volume).toBeCloseTo((Math.PI / 4) * (10 ** 2 - 6 ** 2) * length, 0);
  });

  it("drills through, counterbored and tapped ISO holes", () => {
    const through = engine.recompute(
      doc([
        plate,
        { id: "pts", type: "sketch", params: {}, sketch: pointsSketch([[20, 20], [80, 40]], "10") },
        { type: "hole", params: { sketch: "pts", type: "simple", size: "M6", mode: "throughAll", depth: "1", reverse: "no" } },
      ]),
    );
    expect(through.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok", "ok"]);
    expect(through.mass!.volume).toBeCloseTo(100 * 60 * 10 - 2 * Math.PI * 3.3 ** 2 * 10, 0);

    const cbore = engine.recompute(
      doc([
        plate,
        { id: "pts", type: "sketch", params: {}, sketch: pointsSketch([[50, 30]], "10") },
        { type: "hole", params: { sketch: "pts", type: "counterbore", size: "M6", mode: "throughAll", depth: "1", reverse: "no" } },
      ]),
    );
    const cb = Math.PI * 5.5 ** 2 * 6.5 + Math.PI * 3.3 ** 2 * (10 - 6.5);
    expect(cbore.mass!.volume).toBeCloseTo(100 * 60 * 10 - cb, 0);

    const blind = engine.recompute(
      doc([
        plate,
        { id: "pts", type: "sketch", params: {}, sketch: pointsSketch([[50, 30]], "10") },
        { type: "hole", params: { sketch: "pts", type: "tapped", size: "M8", mode: "blind", depth: "6", reverse: "no" } },
      ]),
    );
    const r = 6.8 / 2;
    const tip = (Math.PI / 3) * r ** 2 * (r / Math.tan((59 * Math.PI) / 180));
    expect(blind.mass!.volume).toBeCloseTo(100 * 60 * 10 - (Math.PI * r ** 2 * 6 + tip), 0);
  });

  it("machines slots defined by sketch lines", () => {
    const axes = (): SketchData => {
      const s = pointsSketch([[20, 20], [50, 20], [70, 15], [70, 45]], "10");
      s.geometry.push({ id: "l1", type: "line", p1: "p0", p2: "p1" }, { id: "l2", type: "line", p1: "p2", p2: "p3" });
      return s;
    };
    const stadium = (len: number, w: number) => len * w + Math.PI * (w / 2) ** 2;
    const through = engine.recompute(
      doc([plate, { id: "ax", type: "sketch", params: {}, sketch: axes() }, { type: "slot", params: { sketch: "ax", width: "8", mode: "throughAll", depth: "1", reverse: "no" } }]),
    );
    expect(through.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok", "ok"]);
    expect(through.mass!.volume).toBeCloseTo(100 * 60 * 10 - (stadium(30, 8) + stadium(30, 8)) * 10, 0);

    const blind = engine.recompute(
      doc([plate, { id: "ax", type: "sketch", params: {}, sketch: axes() }, { type: "slot", params: { sketch: "ax", width: "6", mode: "blind", depth: "4", reverse: "no" } }]),
    );
    expect(blind.mass!.volume).toBeCloseTo(100 * 60 * 10 - 2 * stadium(30, 6) * 4, 0);

    const m6 = engine.recompute(
      doc([plate, { id: "ax", type: "sketch", params: {}, sketch: axes() }, { type: "slot", params: { sketch: "ax", widthMode: "clearance", size: "M6", width: "1", mode: "throughAll", depth: "1", reverse: "no" } }]),
    );
    expect(m6.mass!.volume).toBeCloseTo(100 * 60 * 10 - 2 * stadium(30, 6.6) * 10, 0);

    // Counterbored M6: Ø11 for 6.5, then Ø6.6 clearance.
    const cbore = engine.recompute(
      doc([plate, { id: "ax", type: "sketch", params: {}, sketch: axes() }, { type: "slot", params: { sketch: "ax", widthMode: "clearance", size: "M6", type: "counterbore", mode: "throughAll", depth: "1", reverse: "no" } }]),
    );
    expect(cbore.statuses.every((x) => x.ok)).toBe(true);
    expect(cbore.mass!.volume).toBeCloseTo(100 * 60 * 10 - 2 * (stadium(30, 11) * 6.5 + stadium(30, 6.6) * 3.5), 0);

    // Countersunk M6: truncated cone at the ends, trapezoid in the middle.
    const csk = engine.recompute(
      doc([plate, { id: "ax", type: "sketch", params: {}, sketch: axes() }, { type: "slot", params: { sketch: "ax", widthMode: "clearance", size: "M6", type: "countersink", mode: "throughAll", depth: "1", reverse: "no" } }]),
    );
    expect(csk.statuses.every((x) => x.ok)).toBe(true);
    expect(csk.mass!.volume).toBeLessThan(m6.mass!.volume);
  });

  it("repeats a feature by mirror and patterns", () => {
    const pocket = { id: "pk", type: "box", params: { width: "10", depth: "10", height: "5", x: "5", y: "5", z: "5", op: "cut" } };
    const base = 100 * 60 * 10;
    const mir = engine.recompute(doc([plate, pocket, { type: "mirror", params: { feature: "pk", plane: "YZ", offset: "50" } }]));
    expect(mir.statuses.every((x) => x.ok)).toBe(true);
    expect(mir.mass!.volume).toBeCloseTo(base - 2 * 500, 3);

    const lin = engine.recompute(
      doc([
        plate,
        pocket,
        {
          type: "linearPattern",
          params: { feature: "pk", direction: "X", reverse: "no", count: "4", spacing: "20", direction2: "Y", count2: "2", spacing2: "30" },
        },
      ]),
    );
    expect(lin.mass!.volume).toBeCloseTo(base - 8 * 500, 3);

    const circ = engine.recompute(
      doc([
        { type: "cylinder", params: { radius: "50", height: "10", x: "0", y: "0", z: "0", axis: "z", op: "add" } },
        { id: "h", type: "cylinder", params: { radius: "4", height: "10", x: "35", y: "0", z: "0", axis: "z", op: "cut" } },
        { type: "circularPattern", params: { feature: "h", axis: "Z", count: "6", angle: "360" } },
      ]),
    );
    expect(circ.mass!.volume).toBeCloseTo(Math.PI * 10 * (50 ** 2 - 6 * 4 ** 2), 1);

    const body = engine.recompute(doc([plate, { type: "mirror", params: { feature: "", plane: "YZ", offset: "0" } }]));
    expect(body.mass!.volume).toBeCloseTo(2 * base, 3);
  });
});

describe("Edge and face references", () => {
  const box = { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } };

  it("fillets a single designated edge", () => {
    const r = engine.recompute(
      doc([box, { type: "fillet", params: { radius: "5" }, refs: [{ kind: "edge", p: [50, 0, 40], size: 100 }] }]),
    );
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40 - (1 - Math.PI / 4) * 25 * 100, 1);
  });

  it("reports an edge that no longer exists", () => {
    const r = engine.recompute(doc([box, { type: "chamfer", params: { distance: "2" }, refs: [{ kind: "edge", p: [500, 0, 40], size: 100 }] }]));
    expect(r.statuses[1]).toMatchObject({ ok: false, error: expect.stringContaining("Arête introuvable") });
  });

  it("shells the body by opening the top face", () => {
    const r = engine.recompute(
      doc([box, { type: "shell", params: { thickness: "2", direction: "inside" }, refs: [{ kind: "face", p: [50, 30, 40], size: 6000 }] }]),
    );
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40 - 96 * 56 * 38, 0);
  });

  const sides = [
    { kind: "face" as const, group: "faces", p: [50, 0, 20] as [number, number, number], size: 4000 },
    { kind: "face" as const, group: "faces", p: [50, 60, 20] as [number, number, number], size: 4000 },
    { kind: "face" as const, group: "faces", p: [0, 30, 20] as [number, number, number], size: 2400 },
    { kind: "face" as const, group: "faces", p: [100, 30, 20] as [number, number, number], size: 2400 },
  ];
  // Block whose four sides narrow by h·tan(a) per side over the height h.
  const drafted = (h: number, deg: number) => {
    const k = Math.tan((deg * Math.PI) / 180);
    return 100 * 60 * h - 160 * k * h * h + (4 / 3) * k * k * h ** 3;
  };

  it("drafts the sides from the bottom face", () => {
    const params = { angle: "5", mode: "neutral", neutralFrom: "face", plane: "XY", offset: "0", reverse: "no" };
    const r = engine.recompute(doc([box, { type: "draft", params, refs: [...sides, { kind: "face", group: "neutral", p: [50, 30, 0], size: 6000 }] }]));
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(drafted(40, 5), 1);
  });

  it("drafts the sides automatically from their base, pulled upward", () => {
    const params = { angle: "5", mode: "neutral", neutralFrom: "auto", plane: "XY", offset: "0", reverse: "no" };
    const r = engine.recompute(doc([box, { type: "draft", params, refs: sides }]));
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(drafted(40, 5), 1);
    expect(r.mass!.center[2]).toBeLessThan(20);
  });

  it("drafts both sides of a parting plane", () => {
    const params = { angle: "4", mode: "parting", neutralFrom: "plane", plane: "XY", offset: "20", reverse: "no" };
    const r = engine.recompute(doc([box, { type: "draft", params, refs: sides }]));
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(2 * drafted(20, 4), 1);
    expect(r.mass!.center[2]).toBeCloseTo(20, 4);
  });
});

describe("Sketch on a face", () => {
  it("extrudes a boss from the top face of a block", () => {
    const s = rectSketch("20", "10");
    s.plane.face = { p: [50, 30, 40], n: [0, 0, 1] };
    const r = engine.recompute(
      doc([
        { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
        { id: "sk", type: "sketch", params: {}, sketch: s },
        { type: "extrude", params: { sketch: "sk", mode: "blind", depth: "5", reverse: "no", op: "add" } },
      ]),
    );
    expect(r.statuses.every((x) => x.ok)).toBe(true);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 40 + 20 * 10 * 5, 3);
    // The boss is above the block: center of gravity slightly raised.
    expect(r.mass!.center[2]).toBeGreaterThan(20);
  });

  it("drills from a side face", () => {
    const pts = { ...emptySketch("XY"), geometry: [{ id: "p", type: "point" as const, x: 30, y: 20 }] };
    pts.plane.face = { p: [100, 30, 20], n: [1, 0, 0] };
    const r = engine.recompute(
      doc([
        { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
        { id: "sk", type: "sketch", params: {}, sketch: pts },
        { type: "hole", params: { sketch: "sk", type: "simple", size: "M8", mode: "blind", depth: "20", reverse: "no" } },
      ]),
    );
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok", "ok"]);
    expect(r.mass!.volume).toBeLessThan(100 * 60 * 40);
  });
});

describe("Profiles", () => {
  it("sweeps an IPE 200 and a square tube along a line", () => {
    const line = emptySketch("XY");
    line.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 1000, y: 0 },
      { id: "l", type: "line", p1: "a", p2: "b" },
    ];
    const ipe = engine.recompute(
      doc([
        { id: "sk", type: "sketch", params: {}, sketch: line },
        { type: "profile", params: { path: "sk", family: "IPE", size_IPE: "200", rotation: "0" } },
      ]),
    );
    expect(ipe.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    const area = sectionArea(sectionFamily("IPE")!.build("200"));
    expect(ipe.mass!.volume).toBeCloseTo(area * 1000, 0);
    // Vertical web: the section extends ±100 mm in Z around the path.
    expect(ipe.mass!.center[2]).toBeCloseTo(0, 6);

    const tube = engine.recompute(
      doc([
        { id: "sk", type: "sketch", params: {}, sketch: line },
        { type: "profile", params: { path: "sk", family: "squareTube", size_squareTube: "40x3", rotation: "0" } },
      ]),
    );
    expect(tube.mass!.volume).toBeCloseTo((40 * 40 - 34 * 34) * 1000, 0);
  });
});

describe("Multi-body", () => {
  const box = (x: string, op: string) => ({ type: "box", params: { width: "100", depth: "60", height: "40", x, y: "0", z: "0", op } });
  const step = (docId: string) => new TextDecoder().decode(engine.exportShape("step", docId)).match(/MANIFOLD_SOLID_BREP/g)?.length ?? 0;
  const xRange = (p: Float32Array) => {
    let [lo, hi] = [Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) [lo, hi] = [Math.min(lo, p[i]!), Math.max(hi, p[i]!)];
    return [lo, hi];
  };

  it("two disjoint bodies: mesh per body, masses, CAM, drawing, interferences and STEP over the whole part", () => {
    const d = doc([box("0", "add"), box("150", "new")]);
    d.id = "bodies";
    const r = engine.recompute(d);
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.activeBody).toBe("f1");
    expect(r.partBodies).toEqual(["f0", "f1"]);
    // Faces and edges numbered contiguously, body after body.
    expect(r.mesh!.bodies).toEqual([
      { id: "f0", faces: [0, 6], edges: [0, 12], kind: "solid" },
      { id: "f1", faces: [6, 6], edges: [12, 12], kind: "solid" },
    ]);
    expect(r.mass!.volume).toBeCloseTo(2 * 240_000, 0);
    expect(r.mass!.bodies!.map((b) => [b.id, Math.round(b.volume)])).toEqual([
      ["f0", 240_000],
      ["f1", 240_000],
    ]);
    expect(r.mass!.center[0]).toBeCloseTo(125, 6);

    // CAM: meshing of both bodies.
    const [lo, hi] = xRange(engine.camMesh(d, 0.01)!.positions);
    expect([lo, hi]).toEqual([0, 250]);
    // Drawing: both bodies are projected.
    const [front] = engine.project(d, ["front"]);
    expect(front!.bounds[0]).toBeCloseTo(0, 3);
    expect(front!.bounds[2]).toBeCloseTo(250, 3);
    // Assembly: a box placed on the second body interferes with it alone.
    const other = doc([box("150", "add")]);
    other.id = "other";
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const hits = engine.interferences([
      { key: "A", doc: d, matrix: I },
      { key: "B", doc: other, matrix: I },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.volume).toBeCloseTo(240_000, 0);
    // STEP: one solid per body.
    expect(step(d.id)).toBe(2);
  });

  it("combines two overlapping bodies: union, subtraction, intersection, tools kept", () => {
    const combined = (op: string, keep = "no") => {
      const d = doc([box("0", "add"), box("50", "new"), { type: "combineBodies", body: "f1", params: { op, tools: "f0", keep } }]);
      d.id = `combine-${op}-${keep}`;
      const r = engine.recompute(d);
      expect(r.statuses.every((s) => s.ok)).toBe(true);
      return { r, solids: step(d.id) };
    };
    // Overlap: 50 × 60 × 40 = 120 cm³.
    const union = combined("add");
    expect(union.r.mass!.volume).toBeCloseTo(360_000, 0);
    expect(union.r.partBodies).toEqual(["f1"]);
    expect(union.solids).toBe(1);
    expect(combined("cut").r.mass!.volume).toBeCloseTo(120_000, 0);
    expect(combined("intersect").r.mass!.volume).toBeCloseTo(120_000, 0);
    const kept = combined("add", "yes");
    expect(kept.r.partBodies).toEqual(["f0", "f1"]);
    expect(kept.r.mass!.volume).toBeCloseTo(240_000 + 360_000, 0);
    expect(kept.solids).toBe(2);
  });

  it("reads the bodies from before a feature edited in the middle of the tree", () => {
    const d = doc([box("0", "add"), box("50", "new"), { type: "combineBodies", body: "f1", params: { op: "add", tools: "f0", keep: "no" } }, box("200", "new")]);
    d.id = "bodies-before";
    // Feature that creates a body itself: it is not among the targets.
    expect(engine.recompute(d, { bodiesBefore: "f1" }).bodiesBefore).toEqual({ bodies: ["f0"], active: "f0" });
    // Before the combination, both bodies still exist; at the end of the tree, f0 has been absorbed.
    const r = engine.recompute(d, { bodiesBefore: "f2" });
    expect(r.bodiesBefore).toEqual({ bodies: ["f0", "f1"], active: "f1" });
    expect(r.partBodies).toEqual(["f1", "f3"]);
    expect(engine.recompute(d).bodiesBefore).toBeUndefined();
  });

  it("a legacy document without a target body keeps a single body", () => {
    const r = engine.recompute(doc([box("0", "add"), box("50", "add")]));
    expect(r.partBodies).toEqual(["f0"]);
    expect(r.mesh!.bodies).toHaveLength(1);
    expect(r.mass!.bodies).toBeUndefined();
    expect(r.mass!.volume).toBeCloseTo(360_000, 0);
  });
});

describe("Interferences", () => {
  it("measures the common volume of two overlapping occurrences", () => {
    const part = doc([{ type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } }]);
    const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const r = engine.interferences([
      { key: "A", doc: part, matrix: at(0) },
      { key: "B", doc: part, matrix: at(90) },
      { key: "C", doc: part, matrix: at(300) },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ a: "A", b: "B" });
    expect(r[0]!.volume).toBeCloseTo(10 * 60 * 40, 3);
  });
});

describe("Projections (drawing)", () => {
  it("projects a pierced block: visible outlines, hole hidden from the front, circle recognized from above", () => {
    const part = doc([
      { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
      { type: "cylinder", params: { radius: "10", height: "40", x: "50", y: "30", z: "0", axis: "z", op: "cut" } },
    ]);
    const [front, top] = engine.project(part, ["front", "top"]);
    // Front view: X horizontal, Z vertical; the vertical hole is hidden (two generators).
    expect(front!.bounds[0]).toBeCloseTo(0, 3);
    expect(front!.bounds[2]).toBeCloseTo(100, 3);
    expect(front!.bounds[3] - front!.bounds[1]).toBeCloseTo(40, 3);
    expect(front!.hidden.length).toBeGreaterThan(0);
    // Total length of the edges seen from the front: outline 2 × (100 + 40) mm.
    let len = 0;
    for (let i = 0; i < front!.visible.length; i += 4) len += Math.hypot(front!.visible[i + 2]! - front!.visible[i]!, front!.visible[i + 3]! - front!.visible[i + 1]!);
    expect(len).toBeCloseTo(280, 3);
    // Top view: the hole circle is visible and recognized (center 50, 30, radius 10).
    const c = Array.from(top!.circles);
    const found = [];
    for (let i = 0; i < c.length; i += 3) found.push(c.slice(i, i + 3));
    expect(found.some(([x, y, r]) => Math.abs(x! - 50) < 1e-6 && Math.abs(y! - 30) < 1e-6 && Math.abs(r! - 10) < 1e-6)).toBe(true);
  });
});

describe("Section views", () => {
  const plate = doc([
    { type: "box", params: { width: "100", depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
    { type: "cylinder", params: { radius: "10", height: "40", x: "50", y: "30", z: "0", axis: "z", op: "cut" } },
  ]);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it("sections a pierced block through its mid-plane: the hole becomes visible, the section is hatched", () => {
    // Front view (observer toward −Y): plane y = 30 ⇔ n · p = −30 with n = (0, −1, 0).
    const [cut] = engine.projectScene([{ key: "A", doc: plate, matrix: I }], [{ kind: "front", section: { depth: -30 } }]);
    expect(cut!.hatches).toHaveLength(1);
    // Section outline: two 40 × 40 rectangles on either side of the hole → total perimeter 2 × 160.
    const s = cut!.hatches![0]!.segments;
    let len = 0;
    for (let i = 0; i < s.length; i += 4) len += Math.hypot(s[i + 2]! - s[i]!, s[i + 3]! - s[i + 1]!);
    expect(len).toBeCloseTo(320, 3);
    // The hole's generators, hidden in the normal view, are now visible.
    const [plain] = engine.projectScene([{ key: "A", doc: plate, matrix: I }], [{ kind: "front" }]);
    expect(cut!.hidden.length).toBeLessThan(plain!.hidden.length);
  });

  it("does not cut a part excluded from the section", () => {
    const pin = doc([{ type: "cylinder", params: { radius: "9", height: "60", x: "50", y: "30", z: "-10", axis: "z", op: "add" } }]);
    pin.id = "pin";
    const [v] = engine.projectScene(
      [
        { key: "A", doc: plate, matrix: I },
        { key: "P", doc: pin, matrix: I, cut: false },
      ],
      [{ kind: "front", section: { depth: -30 } }],
    );
    expect(v!.hatches!.map((h) => h.key)).toEqual(["A"]);
  });
});

describe("Edge projection in a sketch", () => {
  it("follows the projected edge when the upstream model changes", () => {
    // Sketch on the top face: projection of the front-top edge (y = 0, z = 40) of the block.
    const sk = emptySketch("XY");
    sk.plane.face = { p: [50, 30, 40], n: [0, 0, 1] };
    sk.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 100, y: 0 },
      { id: "l", type: "line", p1: "a", p2: "b", projected: { kind: "edge", p: [50, 0, 40], size: 100 } },
    ];
    const run = (w: string) =>
      engine.recompute(
        doc([
          { type: "box", params: { width: w, depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
          { id: "sk", type: "sketch", params: {}, sketch: sk },
        ]),
      );
    const r = run("100");
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    const b = r.sketches.sk!.geometry.find((g) => g.id === "b") as { x: number };
    expect(b.x).toBeCloseTo(100, 6);
    // Block widened to 120: the edge still exists (it still passes through the stored point) and the sketch follows.
    const r2 = run("120");
    const b2 = r2.sketches.sk!.geometry.find((g) => g.id === "b") as { x: number };
    expect(b2.x).toBeCloseTo(120, 6);
  });

  it("a dimension to a model vertex (external reference) follows the model", () => {
    // Free sketch point dimensioned 10 mm horizontally from the vertex (100, 0, 40) of the front-top edge.
    const sk = emptySketch("XY");
    sk.plane.face = { p: [50, 30, 40], n: [0, 0, 1] };
    sk.geometry = [
      { id: "v", type: "point", x: 100, y: 0, anchor: "end", projected: { kind: "edge", p: [50, 0, 40], size: 100 }, construction: true, external: true },
      { id: "q", type: "point", x: 110, y: 0 },
    ];
    sk.constraints = [{ id: "f", type: "pointOnCurve", point: "q", curve: "axis:H" }];
    sk.dimensions = [{ id: "dx", type: "horizontalDistance", a: "v", b: "q", value: "10", driving: true }];
    const run = (w: string) =>
      engine.recompute(
        doc([
          { type: "box", params: { width: w, depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } },
          { id: "sk", type: "sketch", params: {}, sketch: sk },
        ]),
      );
    const q = (r: ReturnType<typeof run>) => r.sketches.sk!.geometry.find((g) => g.id === "q") as { x: number };
    expect(q(run("100")).x).toBeCloseTo(110, 6);
    expect(q(run("105")).x).toBeCloseTo(115, 6);
    // Large move: the dimension keeps its side (orientation taken from the stored geometry).
    expect(q(run("130")).x).toBeCloseTo(140, 6);
  });

  it("a circular edge seen by the slice projects to a segment covering the full diameter", () => {
    // Top circle of a cylinder (Z axis, radius R) projected onto the XZ plane: segment from x = 50 − R to 50 + R, at z = 40.
    const sk = emptySketch("XZ");
    sk.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 1, y: 0 },
      { id: "l", type: "line", p1: "a", p2: "b", projected: { kind: "edge", p: [60, 30, 40], size: 2 * Math.PI * 10 } },
    ];
    const run = (radius: string) =>
      engine.recompute(
        doc([
          { type: "cylinder", params: { radius, height: "40", x: "50", y: "30", z: "0", axis: "z", op: "add" } },
          { id: "sk", type: "sketch", params: {}, sketch: sk },
        ]),
      );
    const span = (r: ReturnType<typeof run>) => {
      const p = ["a", "b"].map((id) => r.sketches.sk!.geometry.find((g) => g.id === id) as { x: number; y: number });
      return { xs: p.map((q) => q.x).sort((u, v) => u - v), ys: p.map((q) => Math.abs(q.y)) };
    };
    const r = run("10");
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    const s = span(r);
    expect(s.xs[0]).toBeCloseTo(40, 6);
    expect(s.xs[1]).toBeCloseTo(60, 6);
    expect(s.ys[0]).toBeCloseTo(40, 6);
    expect(s.ys[1]).toBeCloseTo(40, 6);
  });
});

describe("Reference to another part (in-place edit)", () => {
  const ext = (points: [number, number, number][]) => ({ kind: "external" as const, asm: "A", path: "src", target: "dst", ref: { kind: "edge" as const, p: points[0]!, size: 1 }, points });

  it("projects the polyline kept up to date by the application, with no body in the part", () => {
    const sk = emptySketch("XY");
    sk.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 0, y: 0 },
      { id: "l", type: "line", p1: "a", p2: "b", projected: ext([[10, 5, 30], [60, 5, 30]]) },
    ];
    const run = (points: [number, number, number][]) => {
      const s = structuredClone(sk);
      (s.geometry[2] as { projected: ReturnType<typeof ext> }).projected = ext(points);
      return engine.recompute(doc([{ id: "sk", type: "sketch", params: {}, sketch: s }]));
    };
    const pt = (r: ReturnType<typeof run>, id: string) => r.sketches.sk!.geometry.find((g) => g.id === id) as { x: number; y: number };
    const r = run([[10, 5, 30], [60, 5, 30]]);
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok"]);
    expect(pt(r, "a").x).toBeCloseTo(10, 6);
    expect(pt(r, "b").x).toBeCloseTo(60, 6);
    expect(pt(r, "b").y).toBeCloseTo(5, 6);
    // The other part moved 15 mm in X: the linked line follows.
    const r2 = run([[25, 5, 30], [75, 5, 30]]);
    expect(pt(r2, "a").x).toBeCloseTo(25, 6);
    expect(pt(r2, "b").x).toBeCloseTo(75, 6);
  });

  it("projects a linked circular edge as a circle", () => {
    const sk = emptySketch("XY");
    const n = 24;
    const pts = Array.from({ length: n + 1 }, (_, i) => [40 + 8 * Math.cos((2 * Math.PI * i) / n), 20 + 8 * Math.sin((2 * Math.PI * i) / n), 0] as [number, number, number]);
    sk.geometry = [
      { id: "c", type: "point", x: 0, y: 0 },
      { id: "o", type: "circle", c: "c", r: 1, projected: ext(pts) },
    ];
    const r = engine.recompute(doc([{ id: "sk", type: "sketch", params: {}, sketch: sk }]));
    const c = r.sketches.sk!.geometry.find((g) => g.id === "c") as { x: number; y: number };
    const o = r.sketches.sk!.geometry.find((g) => g.id === "o") as { r: number };
    expect(c.x).toBeCloseTo(40, 6);
    expect(c.y).toBeCloseTo(20, 6);
    expect(o.r).toBeCloseTo(8, 6);
  });

  it("projects a linked circular edge seen by the slice as a segment", () => {
    // Circle in a vertical plane (normal Y): its projection on XY is the segment x ∈ [32, 48] at y = 20.
    const sk = emptySketch("XY");
    const n = 24;
    const pts = Array.from({ length: n + 1 }, (_, i) => [40 + 8 * Math.cos((2 * Math.PI * i) / n), 20, 30 + 8 * Math.sin((2 * Math.PI * i) / n)] as [number, number, number]);
    sk.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 1, y: 0 },
      { id: "l", type: "line", p1: "a", p2: "b", projected: ext(pts) },
    ];
    const r = engine.recompute(doc([{ id: "sk", type: "sketch", params: {}, sketch: sk }]));
    const pt = (id: string) => r.sketches.sk!.geometry.find((g) => g.id === id) as { x: number; y: number };
    expect([pt("a").x, pt("b").x].sort((u, v) => u - v)).toEqual([expect.closeTo(32, 6), expect.closeTo(48, 6)]);
    expect(pt("a").y).toBeCloseTo(20, 6);
  });
});

describe("Skeleton sketch (part)", () => {
  it("a sketch that references the skeleton follows its dimensions", () => {
    // Skeleton: a horizontal construction line of length L.
    const skel = emptySketch("XY");
    skel.geometry = [
      { id: "e", type: "point", x: 50, y: 0 },
      { id: "axe", type: "line", p1: SKETCH_ORIGIN, p2: "e", construction: true },
    ];
    skel.constraints = [{ id: "h", type: "horizontal", a: "axe" }];
    skel.dimensions = [{ id: "dl", type: "distance", a: "axe", value: "L", driving: true }];
    // Profile sketch: rectangle whose bottom side takes the skeleton line (reference).
    const prof = emptySketch("XY");
    prof.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 50, y: 0 },
      { id: "c", type: "point", x: 50, y: 10 },
      { id: "d", type: "point", x: 0, y: 10 },
      { id: "ref", type: "line", p1: "a", p2: "b", projected: { kind: "sketch", sketch: "skel", entity: "axe" } },
      { id: "l2", type: "line", p1: "b", p2: "c" },
      { id: "l3", type: "line", p1: "c", p2: "d" },
      { id: "l4", type: "line", p1: "d", p2: "a" },
    ];
    prof.constraints = [
      { id: "v1", type: "vertical", a: "l2" },
      { id: "v2", type: "vertical", a: "l4" },
      { id: "h3", type: "horizontal", a: "l3" },
    ];
    prof.dimensions = [{ id: "dh", type: "distance", a: "l2", value: "10", driving: true }];
    const run = (L: string) =>
      engine.recompute(
        doc(
          [
            { id: "skel", type: "sketch", params: {}, sketch: skel },
            { id: "prof", type: "sketch", params: {}, sketch: prof },
            { type: "extrude", params: { sketch: "prof", mode: "blind", depth: "5", reverse: "no", op: "add" } },
          ],
          [{ name: "L", expr: L }],
        ),
      );
    expect(run("50").mass!.volume).toBeCloseTo(50 * 10 * 5, 3);
    expect(run("80").mass!.volume).toBeCloseTo(80 * 10 * 5, 3);
  });
});

/** Open L-shaped polyline: (0,0) → (50,0) → (50,30). */
function lSketch(): SketchData {
  const s = emptySketch("XY");
  s.geometry = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 50, y: 0 },
    { id: "c", type: "point", x: 50, y: 30 },
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "l2", type: "line", p1: "b", p2: "c" },
  ];
  return s;
}

describe("Thin extrude", () => {
  const thin = (sketch: string, thinSide: string, extra: Record<string, string> = {}) => ({
    type: "thinExtrude",
    params: { sketch, mode: "blind", depth: "10", reverse: "no", op: "add", thickness: "2", thinSide, ...extra },
  });
  const lFeature = { id: "sk", type: "sketch", params: {}, sketch: lSketch() };

  it("thickens an open polyline on one side, the other, or centered", () => {
    const one = engine.recompute(doc([lFeature, thin("sk", "side1")]));
    const other = engine.recompute(doc([lFeature, thin("sk", "side2")]));
    const both = engine.recompute(doc([lFeature, thin("sk", "both")]));
    for (const r of [one, other, both]) expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    // Inside of the L: (50 + 30 − 2) × 2; outside: (50 + 30 + 2) × 2; centered: (50 + 30) × 2.
    expect([one.mass!.volume, other.mass!.volume].sort((x, y) => x - y)).toEqual([expect.closeTo(1560, 3), expect.closeTo(1640, 3)]);
    expect(both.mass!.volume).toBeCloseTo(1600, 3);
    expect(both.mass!.center[2]).toBeCloseTo(5, 6);
  });

  it("thickens a line + arc + line chain", () => {
    const r = engine.recompute(doc([{ id: "path", type: "sketch", params: {}, sketch: pathSketch() }, thin("path", "both", { mode: "symmetric" })]));
    expect(r.statuses.map((x) => (x.ok ? "ok" : x.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo((50 + 10 * Math.PI + 40) * 2 * 10, 2);
  });

  it("cuts a through-all groove from a single line", () => {
    const s = emptySketch("XY");
    s.geometry = [
      { id: "a", type: "point", x: -10, y: 30 },
      { id: "b", type: "point", x: 110, y: 30 },
      { id: "l", type: "line", p1: "a", p2: "b" },
    ];
    s.plane.offset = "5";
    const r = engine.recompute(
      doc([plate, { id: "sk", type: "sketch", params: {}, sketch: s }, thin("sk", "both", { mode: "throughAll", op: "cut", thickness: "4" })]),
    );
    expect(r.statuses.every((x) => x.ok)).toBe(true);
    expect(r.mass!.volume).toBeCloseTo(100 * 60 * 10 - 100 * 4 * 10, 2);
  });

  it("rejects a sketch without an open profile and a thickness that is too large", () => {
    const closed = engine.recompute(doc([{ id: "sk", type: "sketch", params: {}, sketch: rectSketch("60", "40") }, thin("sk", "side1")]));
    expect(closed.statuses[1]).toMatchObject({ ok: false, error: expect.stringContaining("aucun profil ouvert") });
    const tooThick = engine.recompute(doc([lFeature, thin("sk", "side1", { thickness: "40" })]));
    expect(tooThick.statuses[1]!.ok).toBe(false);
  });
});

describe("Welded frame", () => {
  type V3 = [number, number, number];
  const seg = (key: string, a: V3, b: V3) => ({ key, a, b });
  const step = (id: string, segs: ReturnType<typeof seg>[], params: Record<string, string> = {}) => ({
    id,
    type: "frameMembers",
    params: { family: "squareTube", size_squareTube: "40x3", rotation: "0", anchor: "c", corner: "miter", ...params },
    frame: { segments: segs.map((s) => s.key), paths: segs, joints: {} },
  });
  const rect = [
    seg("f1", [0, 0, 0], [1000, 0, 0]),
    seg("f2", [1000, 0, 0], [1000, 500, 0]),
    seg("f3", [1000, 500, 0], [0, 500, 0]),
    seg("f4", [0, 500, 0], [0, 0, 0]),
  ];
  const posts = [0, 1000].flatMap((x) => [0, 500].map((y) => seg(`p${x}-${y}`, [x, y, -800], [x, y, 0])));
  const area = 40 * 40 - 34 * 34;

  it("mitered frame then posts stopped under the frame: volumes and distinct bodies", () => {
    const r = engine.recompute(doc([step("s1", rect), step("s2", posts)]));
    expect(r.statuses.map((s) => s.ok)).toEqual([true, true]);
    // Miters at the axis: volume = area × length on the axis; posts of 800 − 20.
    expect(r.mass!.volume).toBeCloseTo(area * (2 * 1000 + 2 * 500) + area * 780 * 4, -2);
  });

  it("butt joint: the through member is flush, the butting member stops at its face", () => {
    const L = [seg("a", [0, 0, 0], [1000, 0, 0]), seg("b", [1000, 0, 0], [1000, 500, 0])];
    const r = engine.recompute(doc([step("s", L, { corner: "butt" })]));
    expect(r.statuses[0]!.ok).toBe(true);
    expect(r.mass!.volume).toBeCloseTo(area * (1020 + 480), -2);
  });

  it("reports a missing skeleton line", () => {
    const s = step("s1", rect);
    s.frame.segments.push("absente");
    const r = engine.recompute(doc([s]));
    expect(r.statuses[0]).toMatchObject({ ok: false, error: expect.stringContaining("introuvable") });
  });
  it("reference planes: sketch on an offset plane, mirror, plane in error", () => {
    const p1 = { id: "p1", type: "plane", params: {}, datum: { method: "offset" as const, refs: [{ kind: "base" as const, name: "XY" as const }], distance: "H" } };
    const sk = { id: "sk", type: "sketch", params: {}, sketch: { ...rectSketch("20", "10"), plane: { base: "XY" as const, offset: "0", datum: "p1" } } };
    const ex = { id: "ex", type: "extrude", params: { sketch: "sk", mode: "blind", depth: "4", reverse: "no", op: "add" } };
    const r = engine.recompute(doc([p1, sk, ex], [{ name: "H", expr: "30" }]));
    expect(r.statuses.map((x) => x.ok)).toEqual([true, true, true]);
    expect(r.mass!.center[2]).toBeCloseTo(32, 6);
    // Mirror the extrusion about YZ offset by -5.
    const mid = { id: "p2", type: "plane", params: {}, datum: { method: "offset" as const, refs: [{ kind: "base" as const, name: "YZ" as const }], distance: "-5" } };
    const m = engine.recompute(doc([p1, sk, ex, mid, { type: "mirror", params: { feature: "ex", plane: "p2", offset: "0" } }], [{ name: "H", expr: "30" }]));
    expect(m.statuses.every((x) => x.ok)).toBe(true);
    expect(m.mass!.volume).toBeCloseTo(2 * 20 * 10 * 4, 3);
    expect(m.mass!.center[0]).toBeCloseTo(-5, 6);
    // Plane without a point: error, and so is the sketch that relies on it.
    const bad = { id: "p1", type: "plane", params: {}, datum: { method: "parallel" as const, refs: [{ kind: "base" as const, name: "XY" as const }, null] } };
    const e = engine.recompute(doc([bad, sk, ex]));
    expect(e.statuses[0]!.ok).toBe(false);
    expect(e.statuses[1]).toMatchObject({ ok: false, error: expect.stringContaining("Plan") });
  });
});

describe("Twisted extrude", () => {
  const twisted = (twist: string, extra: Record<string, string> = {}) => ({
    type: "twistExtrude",
    params: { sketch: "sk", mode: "blind", depth: "10", twist, reverse: "no", op: "add", ...extra },
  });
  const sk = (r?: string) => ({ id: "sk", type: "sketch", params: {}, sketch: rectSketch("20", "10", r) });

  it("keeps the volume of the straight prism (90° twist)", () => {
    const r = engine.recompute(doc([sk(), twisted("90")]));
    expect(r.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok"]);
    expect(r.mass!.volume).toBeCloseTo(20 * 10 * 10, -1);
  });

  it("treats a hole and a zero twist as a prism", () => {
    const r = engine.recompute(doc([sk("2"), twisted("0")]));
    expect(r.statuses.every((s) => s.ok)).toBe(true);
    expect(r.mass!.volume).toBeCloseTo(20 * 10 * 10 - Math.PI * 4 * 10, 0);
    const t = engine.recompute(doc([sk("2"), twisted("45", { mode: "symmetric" })]));
    expect(t.statuses.every((s) => s.ok)).toBe(true);
    expect(t.mass!.volume).toBeCloseTo(20 * 10 * 10 - Math.PI * 4 * 10, 0);
  });

  it("rejects a zero length", () => {
    const r = engine.recompute(doc([sk(), twisted("30", { depth: "0" })]));
    expect(r.statuses[1]!.ok).toBe(false);
  });
});
