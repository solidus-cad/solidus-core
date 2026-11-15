import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { MeshPayload } from "@solidus-cad/sdk";
import { circleAt, fitCircle, polylineMidpoint, snapAt } from "../src/snap.ts";

/** Edges: a segment (0,0,0)-(50,0,0) and a circle of radius 10 centered at (30,30,0), discretized into 24 segments. */
function payload(): MeshPayload {
  const pts: number[] = [0, 0, 0, 50, 0, 0];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = ((i + 1) / n) * Math.PI * 2;
    pts.push(30 + 10 * Math.cos(a), 30 + 10 * Math.sin(a), 0, 30 + 10 * Math.cos(b), 30 + 10 * Math.sin(b), 0);
  }
  return {
    positions: new Float32Array(),
    normals: new Float32Array(),
    indices: new Uint32Array(),
    faceGroups: new Int32Array(),
    edges: new Float32Array(pts),
    edgeGroups: new Int32Array([0, 2, 1, 2, n * 2, 2]),
  };
}

// Top view, 1 px = 1 mm, coordinate origin at the center of a 200 × 200 window.
const W = 200;
const camera = new THREE.OrthographicCamera(-W / 2, W / 2, W / 2, -W / 2, -1000, 1000);
camera.position.set(0, 0, 100);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const screen = (x: number, y: number) => [W / 2 + x, W / 2 - y] as const;
const ray = new THREE.Ray(new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, -1));

function snap(x: number, y: number) {
  const [sx, sy] = screen(x, y);
  return snapAt([{ key: null, payload: payload(), matrix: new THREE.Matrix4() }], camera, W, W, sx, sy, ray, null, 1);
}

describe("snapping of measurement points", () => {
  it("snaps to the closest vertex", () => {
    const s = snap(47, 3)!;
    expect(s.kind).toBe("vertex");
    expect(s.point).toEqual([50, 0, 0]);
  });

  it("snaps to the center of a circle", () => {
    const s = snap(32, 28)!;
    expect(s.kind).toBe("center");
    expect(s.point[0]).toBeCloseTo(30, 4);
    expect(s.point[1]).toBeCloseTo(30, 4);
  });

  it("snaps to a point on an edge, otherwise nothing in empty space", () => {
    const s = snap(12, 4)!;
    expect(s.kind).toBe("edge");
    expect(s.point[0]).toBeCloseTo(12, 4);
    expect(s.point[1]).toBeCloseTo(0, 4);
    expect(snap(-60, -60)).toBeNull();
  });

  it("snaps to the midpoint of an edge", () => {
    const s = snap(23, 4)!;
    expect(s.kind).toBe("midpoint");
    expect(s.point[0]).toBeCloseTo(25, 4);
    expect(s.point[1]).toBeCloseTo(0, 4);
  });

  it("takes the midpoint of an arc along its length, none for a full circle", () => {
    const arc = Array.from({ length: 7 }, (_, i) => new THREE.Vector3(10 * Math.cos((i / 6) * Math.PI), 10 * Math.sin((i / 6) * Math.PI), 0));
    const m = polylineMidpoint(arc)!;
    expect(m.x).toBeCloseTo(0, 6);
    expect(m.y).toBeCloseTo(10, 6);
    const circle = Array.from({ length: 13 }, (_, i) => new THREE.Vector3(10 * Math.cos((i / 12) * Math.PI * 2), 10 * Math.sin((i / 12) * Math.PI * 2), 0));
    expect(polylineMidpoint(circle)).toBeNull();
  });

  it("applies the occurrence matrix", () => {
    const m = new THREE.Matrix4().makeTranslation(10, 0, 0);
    const [sx, sy] = screen(59, 1);
    const s = snapAt([{ key: "a", payload: payload(), matrix: m }], camera, W, W, sx, sy, ray, null, 1)!;
    expect(s).toMatchObject({ kind: "vertex", key: "a" });
    expect(s.point).toEqual([60, 0, 0]);
  });
});

describe("diameter and radius measurement", () => {
  it("fits an arc: radius, covered angle, center", () => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      pts.push(new THREE.Vector3(5 + 5 * Math.cos(a), 5 * Math.sin(a), 2));
    }
    const c = fitCircle(pts)!;
    expect(c.closed).toBe(false);
    expect(c.radius).toBeCloseTo(5, 6);
    expect(c.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(c.center.toArray().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([5, 0, 2]);
    expect(fitCircle([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(3, 0, 0)])).toBeNull();
  });

  it("picks the circular edge under the pointer", () => {
    const [sx, sy] = screen(40, 30); // on the circle of radius 10 centered at (30, 30)
    const c = circleAt([{ key: null, payload: payload(), matrix: new THREE.Matrix4() }], camera, W, W, sx, sy, ray, null, 1)!;
    expect(c).toMatchObject({ kind: "edge", closed: true });
    expect(c.radius).toBeCloseTo(10, 4);
    expect(c.center[0]).toBeCloseTo(30, 4);
    expect(Math.abs(c.normal[2])).toBeCloseTo(1, 6);
  });

  it("picks nothing on a straight edge", () => {
    const [sx, sy] = screen(25, 1);
    expect(circleAt([{ key: null, payload: payload(), matrix: new THREE.Matrix4() }], camera, W, W, sx, sy, ray, null, 1)).toBeNull();
  });
});
