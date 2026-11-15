import { describe, expect, it } from "vitest";
import type { V3 } from "@solidus-cad/sdk";
import { autoBase, cross, dot, infer, meshSnapPoints, parseTyped, planeFrom3, scale, add, unit, type InferContext } from "../src/sketch3d/infer.ts";

/** Orthographic camera (1 px = 1 mm) looking along `dir`. */
function camera(dir: V3, up: V3 = [0, 0, 1]) {
  const d = unit(dir);
  const right = unit(cross(d, up));
  const top = cross(right, d);
  const toScreen = (p: V3) => ({ x: dot(p, right), y: -dot(p, top) });
  const rayAt = (s: { x: number; y: number }) => ({ o: add(add(scale(right, s.x), scale(top, -s.y)), scale(d, -1000)), d });
  return { toScreen, rayAt, d };
}

function ctx(cam: ReturnType<typeof camera>, cursor: { x: number; y: number }, extra: Partial<InferContext> = {}): InferContext {
  return { toScreen: cam.toScreen, cursor, ray: cam.rayAt(cursor), points: [], vertices: [], plane: { p: [0, 0, 0], n: [0, 0, 1] }, ...extra };
}

const iso = camera([-1, 1, -1]);

describe("infer", () => {
  it("snaps to an existing point", () => {
    const P: V3 = [10, 20, 30];
    const r = infer(ctx(iso, add2(iso.toScreen(P), 4, -3), { points: [{ id: "p", p: P }] }));
    expect(r?.kind).toBe("point");
    expect(r?.id).toBe("p");
  });

  it("snaps to a vertex of another part", () => {
    const V: V3 = [50, 0, 0];
    const r = infer(ctx(iso, iso.toScreen(V), { vertices: [V] }));
    expect(r?.kind).toBe("vertex");
    expect(r?.p).toEqual(V);
  });

  it("infers the Z direction from the previous point, in isometric view", () => {
    const from: V3 = [0, 0, 0];
    const target: V3 = [0, 0, 80];
    const s = add2(iso.toScreen(target), 6, 0); // 6 px from the Z axis
    const r = infer(ctx(iso, s, { from }));
    expect(r?.kind).toBe("axis");
    expect(r?.axis).toBe("Z");
    expect(r!.p[0]).toBeCloseTo(0, 6);
    expect(r!.p[1]).toBeCloseTo(0, 6);
    expect(r!.p[2]).toBeGreaterThan(70);
  });

  it("does not infer an axis far from the principal directions", () => {
    const r = infer(ctx(iso, iso.toScreen([40, 30, 0]), { from: [0, 0, 0] }));
    expect(r?.kind).toBe("plane");
    expect(r?.p[2]).toBeCloseTo(0, 6);
  });

  it("locks an axis and takes the coordinate of a targeted point", () => {
    const r = infer(ctx(iso, iso.toScreen([100, 40, 0]), { from: [0, 0, 0], lock: "X", points: [{ id: "q", p: [100, 40, 0] }] }));
    expect(r?.kind).toBe("lock");
    expect(r?.p).toEqual([100, 0, 0]);
  });

  it("aligns to the coordinate of an existing point in the work plane", () => {
    const top = camera([0, 0, -1], [0, 1, 0]);
    const r = infer(ctx(top, top.toScreen([52, 33, 0]), { points: [{ id: "q", p: [50, -40, 0] }] }));
    expect(r?.kind).toBe("plane");
    expect(r!.p[0]).toBeCloseTo(50, 6);
    expect(r!.align.length).toBe(1);
  });

  it("constrains to the chosen work plane", () => {
    const top = camera([0, 0, -1], [0, 1, 0]);
    const r = infer(ctx(top, { x: 10, y: -10 }, { plane: { p: [0, 0, 25], n: [0, 0, 1], fixed: true } }));
    expect(r?.plane).toEqual({ p: [0, 0, 25], n: [0, 0, 1] });
    expect(r!.p[2]).toBeCloseTo(25, 6);
  });
});

function add2(s: { x: number; y: number }, dx: number, dy: number) {
  return { x: s.x + dx, y: s.y + dy };
}

describe("automatic work plane", () => {
  it("chooses the plane facing the camera the most", () => {
    expect(autoBase([0.1, -0.2, -0.9])).toBe("XY");
    expect(autoBase([0.1, 0.9, -0.3])).toBe("XZ");
    expect(autoBase([-0.8, 0.3, -0.3])).toBe("YZ");
  });

  it("plane through three points", () => {
    const p = planeFrom3([0, 0, 5], [10, 0, 5], [0, 10, 5]);
    expect(p?.n).toEqual([0, 0, 1]);
    expect(planeFrom3([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull();
  });
});

describe("keyboard input", () => {
  it("length, absolute point, relative displacement", () => {
    expect(parseTyped("120")).toEqual({ kind: "length", value: 120 });
    expect(parseTyped("12,5")).toEqual({ kind: "length", value: 12.5 });
    expect(parseTyped("10;0;5")).toEqual({ kind: "absolute", p: [10, 0, 5] });
    expect(parseTyped("@10;0;5")).toEqual({ kind: "relative", d: [10, 0, 5] });
    expect(parseTyped("@10 -2 5")).toEqual({ kind: "relative", d: [10, -2, 5] });
    expect(parseTyped("10;2")).toBeNull();
    expect(parseTyped("abc")).toBeNull();
  });
});

describe("notable points of a mesh", () => {
  it("endpoints, midpoint, circle center", () => {
    const seg: number[] = [0, 0, 0, 10, 0, 0, 10, 0, 0, 20, 0, 0];
    const circle: number[] = [];
    const n = 24;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 2 * Math.PI;
      const a1 = ((i + 1) / n) * 2 * Math.PI;
      circle.push(5 + 3 * Math.cos(a0), 7 + 3 * Math.sin(a0), 1, 5 + 3 * Math.cos(a1), 7 + 3 * Math.sin(a1), 1);
    }
    const edges = new Float32Array([...seg, ...circle]);
    const groups = new Int32Array([0, 4, 1, 4, n * 2, 2]);
    const pts = meshSnapPoints(edges, groups).map((p) => p.map((v) => Math.round(v * 1000) / 1000));
    expect(pts).toContainEqual([0, 0, 0]);
    expect(pts).toContainEqual([20, 0, 0]);
    expect(pts).toContainEqual([10, 0, 0]);
    expect(pts).toContainEqual([5, 7, 1]);
  });
});
