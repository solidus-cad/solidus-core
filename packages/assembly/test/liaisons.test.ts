import { describe, expect, it } from "vitest";
import { IDENTITY, type AssemblyComponent, type Mate } from "@solidus-cad/sdk";
import { liaisonGraph } from "../src/index.ts";

type V3 = [number, number, number];

const at = (x: number, y: number, z: number) => {
  const m = [...IDENTITY];
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

const ground: AssemblyComponent = { id: "A", name: "A", partId: "p", matrix: at(0, 0, 0), fixed: true };
// B already in place: its local frame coincides with A's frame shifted by 40 mm in z.
const B: AssemblyComponent = { id: "B", name: "B", partId: "p", matrix: at(0, 0, 40) };

const plane = (component: string, p: V3, d: V3) => ({ component, kind: "plane" as const, p, d });
const axis = (component: string, p: V3, d: V3) => ({ component, kind: "axis" as const, p, d });
const point = (component: string, p: V3) => ({ component, kind: "point" as const, p, d: [0, 0, 1] as V3 });

// Top face of A (z = 40) against the bottom face of B (local z = 0), axis z through (50, 30).
const onTop: Mate = { id: "plan", type: "coincident", a: plane("A", [50, 30, 40], [0, 0, 1]), b: plane("B", [50, 30, 0], [0, 0, -1]) };
const coaxial: Mate = { id: "axe", type: "concentric", a: axis("A", [50, 30, 0], [0, 0, 1]), b: axis("B", [50, 30, 0], [0, 0, 1]) };

const near = (a: number[] | undefined, b: number[]) => {
  expect(a).toBeDefined();
  a!.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 4));
};
const parallel = (a: number[] | undefined, b: number[]) => {
  expect(a).toBeDefined();
  expect(Math.abs(a![0]! * b[0]! + a![1]! * b[1]! + a![2]! * b[2]!)).toBeCloseTo(1, 5);
};

describe("liaisonGraph", () => {
  it("plane on plane: appui plan of normal z", () => {
    const g = liaisonGraph([ground, B], [onTop]);
    expect(g.classes).toHaveLength(2);
    expect(g.classes[0]!.ground).toBe(true);
    expect(g.liaisons).toHaveLength(1);
    const l = g.liaisons[0]!;
    expect(l.kind).toBe("planar");
    expect([l.rotations, l.translations]).toEqual([1, 2]);
    parallel(l.axis, [0, 0, 1]);
    expect(g.mobility).toBe(3);
    expect(g.hyperstatic).toBe(0);
  });

  it("concentric: pivot glissant; with an axial stop: pivot on the axis", () => {
    const cyl = liaisonGraph([ground, B], [coaxial]).liaisons[0]!;
    expect(cyl.kind).toBe("cylindrical");
    parallel(cyl.axis, [0, 0, 1]);
    near(cyl.point!.slice(0, 2), [50, 30]);

    const g = liaisonGraph([ground, B], [coaxial, onTop]);
    const piv = g.liaisons[0]!;
    expect(piv.kind).toBe("pivot");
    expect(piv.dof).toBe(1);
    parallel(piv.axis, [0, 0, 1]);
    near(piv.point!.slice(0, 2), [50, 30]);
    expect(piv.mates.sort()).toEqual(["axe", "plan"]);
    expect(g.mobility).toBe(1);
  });

  it("concentric with locked rotation: glissière along the axis", () => {
    const lock: Mate = { ...coaxial, lockRotation: true, a: { ...coaxial.a, u: [1, 0, 0] }, b: { ...coaxial.b, u: [1, 0, 0] } };
    const l = liaisonGraph([ground, B], [lock]).liaisons[0]!;
    expect(l.kind).toBe("slider");
    parallel(l.axis, [0, 0, 1]);
  });

  it("coincident points: rotule at the point", () => {
    const ball: Mate = { id: "rot", type: "coincident", a: point("A", [10, 20, 40]), b: point("B", [10, 20, 0]) };
    const l = liaisonGraph([ground, B], [ball]).liaisons[0]!;
    expect(l.kind).toBe("spherical");
    near(l.point, [10, 20, 40]);
  });

  it("fully constrained parts form a single kinematic class", () => {
    const lock: Mate = { ...coaxial, lockRotation: true, a: { ...coaxial.a, u: [1, 0, 0] }, b: { ...coaxial.b, u: [1, 0, 0] } };
    const g = liaisonGraph([ground, B], [lock, onTop]);
    expect(g.classes).toHaveLength(1);
    expect(g.classes[0]!.bodies.sort()).toEqual(["A", "B"]);
    expect(g.liaisons).toHaveLength(0);
    expect(g.mobility).toBe(0);
  });

  it("groups bodies rigid to each other, and links the moving classes", () => {
    // B turns about z on the ground; C is rigidly fixed to B; D turns on C about x.
    const C: AssemblyComponent = { id: "C", name: "C", partId: "p", matrix: at(0, 0, 80) };
    const D: AssemblyComponent = { id: "D", name: "D", partId: "p", matrix: at(0, 0, 80) };
    const stackBC: Mate[] = [
      { id: "bc1", type: "coincident", a: plane("B", [50, 30, 40], [0, 0, 1]), b: plane("C", [50, 30, 0], [0, 0, -1]) },
      { id: "bc2", type: "concentric", lockRotation: true, a: { ...axis("B", [50, 30, 0], [0, 0, 1]), u: [1, 0, 0] }, b: { ...axis("C", [50, 30, 0], [0, 0, 1]), u: [1, 0, 0] } },
    ];
    const pinCD: Mate[] = [
      { id: "cd1", type: "concentric", a: axis("C", [0, 10, 20], [1, 0, 0]), b: axis("D", [0, 10, 20], [1, 0, 0]) },
      { id: "cd2", type: "coincident", a: plane("C", [5, 10, 20], [1, 0, 0]), b: plane("D", [5, 10, 20], [-1, 0, 0]) },
    ];
    const g = liaisonGraph([ground, B, C, D], [coaxial, onTop, ...stackBC, ...pinCD]);
    expect(g.classes).toHaveLength(3);
    const bc = g.classes.findIndex((c) => c.bodies.includes("B"));
    expect(g.classes[bc]!.bodies.sort()).toEqual(["B", "C"]);
    expect(g.liaisons).toHaveLength(2);
    expect(g.liaisons.every((l) => l.kind === "pivot")).toBe(true);
    const cd = g.liaisons.find((l) => l.mates.includes("cd1"))!;
    parallel(cd.axis, [1, 0, 0]);
    expect(g.mobility).toBe(2);
    expect(g.hyperstatic).toBe(0);
  });

  it("two pivots on the same axis in parallel: hyperstatic", () => {
    // Shaft B held by two coaxial bearings carried by two fixed housings.
    const H: AssemblyComponent = { id: "H", name: "H", partId: "p", matrix: at(0, 0, 0), fixed: true };
    const bearing = (id: string, housing: string, z: number): Mate[] => [
      { id: `${id}a`, type: "concentric", a: axis(housing, [50, 30, z], [0, 0, 1]), b: axis("B", [50, 30, z - 40], [0, 0, 1]) },
      { id: `${id}p`, type: "coincident", a: plane(housing, [50, 30, z], [0, 0, 1]), b: plane("B", [50, 30, z - 40], [0, 0, -1]) },
    ];
    const g = liaisonGraph([ground, H, B], [...bearing("1", "A", 40), ...bearing("2", "H", 40)]);
    expect(g.classes).toHaveLength(2); // A and H: ground
    expect(g.liaisons[0]!.kind).toBe("pivot");
    expect(g.mobility).toBe(1);
    expect(g.hyperstatic).toBe(5);
  });

  it("gear coupling between two pivots", () => {
    const C: AssemblyComponent = { id: "C", name: "C", partId: "p", matrix: at(100, 0, 40) };
    const pivotC: Mate[] = [
      { id: "c1", type: "concentric", a: axis("A", [150, 30, 0], [0, 0, 1]), b: axis("C", [50, 30, 0], [0, 0, 1]) },
      { id: "c2", type: "coincident", a: plane("A", [150, 30, 40], [0, 0, 1]), b: plane("C", [50, 30, 0], [0, 0, -1]) },
    ];
    const gear: Mate = { id: "g", type: "gear", value: "2", a: axis("B", [50, 30, 0], [0, 0, 1]), b: axis("C", [50, 30, 0], [0, 0, 1]) };
    const g = liaisonGraph([ground, B, C], [coaxial, onTop, ...pivotC, gear]);
    expect(g.classes).toHaveLength(3);
    expect(g.liaisons).toHaveLength(2);
    expect(g.couplings).toHaveLength(1);
    expect(g.couplings[0]!.type).toBe("gear");
    expect(g.mobility).toBe(1);
  });

  it("an unconstrained part stays a class of its own, without liaison", () => {
    const E: AssemblyComponent = { id: "E", name: "E", partId: "p", matrix: at(300, 0, 0) };
    const g = liaisonGraph([ground, B, E], [onTop]);
    expect(g.classes).toHaveLength(3);
    expect(g.liaisons).toHaveLength(1);
  });
});

describe("liaisonGraph, mechanisms", () => {
  it("crank and connecting rod: the motion driver is ignored, one class per moving part", () => {
    const R = 50;
    const Lr = 150;
    const z: V3 = [0, 0, 1];
    const x: V3 = [1, 0, 0];
    const ax = (p: V3, d: V3 = z) => ({ kind: "axis" as const, p, d });
    const comps: AssemblyComponent[] = [
      ground,
      { id: "C", name: "C", partId: "p", matrix: at(0, 0, 0) },
      { id: "R", name: "R", partId: "p", matrix: at(R, 0, 0) },
      { id: "P", name: "P", partId: "p", matrix: at(R + Lr, 0, 0) },
    ];
    const mates: Mate[] = [
      { id: "crank", type: "concentric", a: { component: "A", ...ax([0, 0, 0]) }, b: { component: "C", ...ax([0, 0, 0]) }, drive: { kind: "rotary", value: 0, ua: x, ub: x } },
      { id: "floor", type: "coincident", a: plane("A", [0, 0, 0], z), b: plane("C", [0, 0, 0], [0, 0, -1]) },
      { id: "pinA", type: "concentric", a: { component: "C", ...ax([R, 0, 0]) }, b: { component: "R", ...ax([0, 0, 0]) } },
      { id: "pinB", type: "concentric", a: { component: "R", ...ax([Lr, 0, 0]) }, b: { component: "P", ...ax([0, 0, 0]) } },
      { id: "slide", type: "concentric", a: { component: "A", ...ax([0, 0, 0], x) }, b: { component: "P", ...ax([0, 0, 0], x) } },
    ];
    const g = liaisonGraph(comps, mates);
    expect(g.classes).toHaveLength(4);
    const kind = (id: string) => g.liaisons.find((l) => l.mates.includes(id))!.kind;
    expect(kind("crank")).toBe("pivot");
    expect(kind("pinA")).toBe("cylindrical");
    expect(kind("pinB")).toBe("cylindrical");
    expect(kind("slide")).toBe("cylindrical");
    // Modelled at dead centre (crank and rod aligned): the piston must not be taken as fixed.
    expect(g.classes.find((c) => c.bodies.includes("P"))!.ground).toBe(false);
    // Crank rotation and rod sliding along its pins (the piston cannot turn: its pin axis is held by the rod).
    expect(g.mobility).toBe(2);
  });
});
