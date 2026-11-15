// Topological naming in cad-core (core/NAMING.md): names come from the tree (features, sketch curves and points,
// designated edges), never from dimensions. For each feature, two sets of dimensions give the same names,
// and no face receives a rank-based fallback name.
import { beforeAll, describe, expect, it } from "vitest";
import { emptySketch, SKETCH_ORIGIN, type SketchData } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine, type WasmRecomputeResult } from "../src/engine.ts";
import { doc, pathSketch, pointsSketch } from "./scenarios.ts";

let core: WasmKernelEngine;

beforeAll(async () => {
  core = await WasmKernelEngine.create(await SketchSolver.create());
});

type Make = Parameters<typeof doc>[0];

/** Face names for two values of parameter P (same document). */
function namesFor(make: Make, a: string, b: string): [Set<string>, Set<string>, WasmRecomputeResult] {
  const d = doc(make, [{ name: "P", expr: a }]);
  const ra = core.recompute(d);
  expect(ra.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(ra.statuses.map(() => "ok"));
  const rb = core.recompute({ ...d, parameters: [{ name: "P", expr: b }] });
  expect(rb.statuses.every((s) => s.ok)).toBe(true);
  return [new Set(ra.topology.faces), new Set(rb.topology.faces), ra];
}

/** Rank-based fallback names (faces that no origin named). */
const fallback = (names: Set<string>) => [...names].filter((n) => /\/(sheet|side|slot\([^)]*\.sx|hole\([^)]*\.x)\(?\d+\)?$/.test(n) || n.endsWith("gen(?)"));

function stable(make: Make, a: string, b: string): Set<string> {
  const [x, y] = namesFor(make, a, b);
  expect(y).toEqual(x);
  expect(fallback(x)).toEqual([]);
  return x;
}

const plate = (h = "10") => ({ type: "box", params: { width: "100", depth: "60", height: h, x: "0", y: "0", z: "0", op: "add" } });

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

describe("Topological naming: stability when dimensions change", () => {
  it("holes: named by the sketch point and the hole profile segment", () => {
    const names = stable(
      [
        plate("P"),
        { id: "pts", type: "sketch", params: {}, sketch: pointsSketch([[20, 20], [80, 40]], "P") },
        { id: "h", type: "hole", params: { sketch: "pts", type: "counterbore", size: "M6", mode: "throughAll", depth: "1", reverse: "no" } },
      ],
      "10",
      "14",
    );
    expect([...names].some((n) => n.startsWith("h/hole(p0."))).toBe(true);
    expect([...names].some((n) => n.startsWith("h/hole(p1."))).toBe(true);
  });

  it("slots: named by the sketch line", () => {
    const axes = pointsSketch([[20, 20], [50, 20]], "10");
    axes.geometry.push({ id: "ax", type: "line", p1: "p0", p2: "p1" });
    const names = stable(
      [plate(), { id: "sk", type: "sketch", params: {}, sketch: axes }, { id: "sl", type: "slot", params: { sketch: "sk", width: "P", mode: "throughAll", depth: "1", reverse: "no" } }],
      "8",
      "6",
    );
    expect([...names].some((n) => n.startsWith("sl/slot(ax."))).toBe(true);
  });

  it("sweep: named by the path curve and the section edge", () => {
    const names = stable(
      [
        { id: "path", type: "sketch", params: {}, sketch: pathSketch() },
        { id: "sw", type: "sweep", params: { path: "path", profile: "circle", diameter: "P", inner: "6", profileSketch: "", op: "add" } },
      ],
      "10",
      "12",
    );
    for (const n of ["sw/side(l1|outer)", "sw/side(arc|outer)", "sw/side(l2|inner)", "sw/start", "sw/end"]) expect(names.has(n), n).toBe(true);
  });

  it("profile: named by the path curve and the section edge", () => {
    const line = emptySketch("XY");
    line.geometry = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 1000, y: 0 },
      { id: "l", type: "line", p1: "a", p2: "b" },
    ];
    const names = stable(
      [{ id: "sk", type: "sketch", params: {}, sketch: line }, { id: "pr", type: "profile", params: { path: "sk", family: "IPE", size_IPE: "200", rotation: "P" } }],
      "0",
      "15",
    );
    expect([...names].some((n) => n.startsWith("pr/side(l|e"))).toBe(true);
  });

  it("base sheet and edge flange: named by the sketch and the designated edge", () => {
    const sheet = { thickness: "2", radius: "2", kFactor: "0.5", depth: "40", reverse: "no" };
    const names = stable(
      [
        { id: "sk", type: "sketch", params: {}, sketch: rect() },
        { id: "base", type: "sheetBase", params: { ...sheet, sketch: "sk" } },
        { id: "fl", type: "edgeFlange", params: { length: "P", angle: "90", direction: "same" }, refs: [{ kind: "edge", p: [50, 60, 2], size: 100 }] },
      ],
      "20",
      "25",
    );
    // The edge at y = 60 (side(l3)) disappears: the bend of the edge flange joins it.
    for (const n of ["base/top(l1)", "base/bottom(l1)", "base/side(l1)"]) expect(names.has(n), `${n} parmi ${[...names].sort().join(", ")}`).toBe(true);
    const all = [...names].sort().join(", ");
    expect([...names].some((n) => n.startsWith("fl/bend(e(")), all).toBe(true);
    expect([...names].some((n) => n.startsWith("fl/flange(e(")), all).toBe(true);
  });

  it("an edge flange designated by name follows the sheet when it widens", () => {
    const d = doc([
      { id: "sk", type: "sketch", params: {}, sketch: rect() },
      { id: "base", type: "sheetBase", params: { thickness: "2", radius: "2", kFactor: "0.5", depth: "40", reverse: "no", sketch: "sk" } },
    ]);
    const r = core.recompute(d);
    const m = r.mesh!;
    // Top edge at y = 60: designated by its name, as the viewer does.
    const name = r.topology.edges.find((n) => n.includes("base/top(l1)") && n.includes("base/side(l3)"))!;
    expect(name).toBeTruthy();
    expect(m.names?.edges).toContain(name);
    const flange = { id: "fl", type: "edgeFlange", params: { length: "20", angle: "90", direction: "same" }, refs: [{ kind: "edge" as const, p: [999, 999, 999] as [number, number, number], size: 1, name }] };
    const ok = core.recompute({ ...d, features: [...d.features, { ...flange, name: "Bord" }], rollback: 3 });
    // The stored point is wrong: only the name can locate the edge.
    expect(ok.statuses.map((s) => (s.ok ? "ok" : s.error))).toEqual(["ok", "ok", "ok"]);
  });
});
