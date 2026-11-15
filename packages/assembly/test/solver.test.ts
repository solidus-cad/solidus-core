import { describe, expect, it } from "vitest";
import { IDENTITY, type AssemblyComponent, type Mate, type MateRef } from "@solidus-cad/sdk";
import { solveMates } from "../src/index.ts";
import { symmetricEigen } from "../src/solver.ts";

const at = (x: number, y: number, z: number) => {
  const m = [...IDENTITY];
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

const base: AssemblyComponent = { id: "A", name: "A", partId: "p", matrix: at(0, 0, 0), fixed: true };
const block: AssemblyComponent = { id: "B", name: "B", partId: "p", matrix: at(30, 20, 100) };

// Faces in the local frame of a 100 × 60 × 40 block with one corner at the origin.
const top = { kind: "plane" as const, p: [50, 30, 40] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
const bottom = { kind: "plane" as const, p: [50, 30, 0] as [number, number, number], d: [0, 0, -1] as [number, number, number] };

describe("solveMates", () => {
  it("places one face on another (coincident) by moving only what is necessary", () => {
    const mates: Mate[] = [{ id: "m1", type: "coincident", a: { component: "A", ...top }, b: { component: "B", ...bottom } }];
    const r = solveMates([base, block], mates);
    expect(r.ok).toBe(true);
    const m = r.matrices.B!;
    expect(m[14]).toBeCloseTo(40, 6);
    // A plane/plane coincidence leaves 3 degrees of freedom (sliding x, y and rotation about z).
    expect(r.dof).toBe(3);
  });

  it("applies a distance and a concentric constraint", () => {
    const axisA = { kind: "axis" as const, p: [50, 30, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    const axisB = { kind: "axis" as const, p: [50, 30, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    const mates: Mate[] = [
      { id: "m1", type: "distance", a: { component: "A", ...top }, b: { component: "B", ...bottom }, value: "5" },
      { id: "m2", type: "concentric", a: { component: "A", ...axisA }, b: { component: "B", ...axisB } },
    ];
    const r = solveMates([base, block], mates);
    expect(r.ok).toBe(true);
    const m = r.matrices.B!;
    // The point on B's axis (local 50, 30, 0) lies on A's axis, 5 mm above the top face.
    const p = [0, 1, 2].map((i) => m[i]! * 50 + m[4 + i]! * 30 + m[12 + i]!);
    expect(p[0]).toBeCloseTo(50, 5);
    expect(p[1]).toBeCloseTo(30, 5);
    expect(p[2]).toBeCloseTo(45, 5);
    expect(r.dof).toBe(1); // the rotation about the common axis remains
  });

  it("pull: a constrained occurrence only follows the manipulator along its degrees of freedom", () => {
    // B on A's top face (z = 40): slides in x/y, but cannot be lifted.
    const placed = { ...block, matrix: at(30, 20, 40) };
    const mates: Mate[] = [{ id: "m1", type: "coincident", a: { component: "A", ...top }, b: { component: "B", ...bottom } }];
    const r = solveMates([base, placed], mates, undefined, { pull: new Map([["B", at(80, -10, 90)]]) });
    expect(r.ok).toBe(true);
    const m = r.matrices.B!;
    expect(m[12]).toBeCloseTo(80, 3);
    expect(m[13]).toBeCloseTo(-10, 3);
    expect(m[14]).toBeCloseTo(40, 6);
  });

  it("pull: a free group linked by constraints follows the pulled occurrence", () => {
    const c: AssemblyComponent = { id: "C", name: "C", partId: "p", matrix: at(30, 20, 140) };
    const placed = { ...block, matrix: at(30, 20, 100) };
    // C stacked on B, B not fixed: moving B carries C.
    const mates: Mate[] = [
      { id: "m1", type: "coincident", a: { component: "B", ...top }, b: { component: "C", ...bottom } },
      { id: "m2", type: "concentric", a: { component: "B", kind: "axis", p: [50, 30, 0], d: [0, 0, 1] }, b: { component: "C", kind: "axis", p: [50, 30, 0], d: [0, 0, 1] } },
    ];
    const r = solveMates([base, placed, c], mates, undefined, { pull: new Map([["B", at(30, 20, 200)]]) });
    expect(r.ok).toBe(true);
    expect(r.matrices.B![14]).toBeCloseTo(200, 2);
    expect(r.matrices.C![14]).toBeCloseTo(240, 2);
    expect(r.matrices.C![12]).toBeCloseTo(30, 4);
  });

  it("reports incompatible constraints", () => {
    const mates: Mate[] = [
      { id: "m1", type: "distance", a: { component: "A", ...top }, b: { component: "B", ...bottom }, value: "5" },
      { id: "m2", type: "distance", a: { component: "A", ...top }, b: { component: "B", ...bottom }, value: "10" },
    ];
    const r = solveMates([base, block], mates);
    expect(r.ok).toBe(false);
    expect(r.failing.length).toBeGreaterThan(0);
  });

  it("moves neither fixed parts nor unconstrained parts", () => {
    const r = solveMates([base, block], []);
    expect(r.matrices).toEqual({});
    expect(r.ok).toBe(true);
  });

  it("places a vertex on a face and a point on an axis", () => {
    const corner = { kind: "point" as const, p: [0, 0, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    const r1 = solveMates([base, block], [{ id: "m1", type: "coincident", a: { component: "A", ...top }, b: { component: "B", ...corner } }]);
    expect(r1.ok).toBe(true);
    expect(r1.matrices.B![14]).toBeCloseTo(40, 6);
    // Point on plane: 5 remaining degrees of freedom.
    expect(r1.dof).toBe(5);
    const axisZ = { kind: "axis" as const, p: [10, 10, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    const r2 = solveMates([base, block], [{ id: "m1", type: "coincident", a: { component: "A", ...axisZ }, b: { component: "B", ...corner } }]);
    expect(r2.ok).toBe(true);
    expect(r2.matrices.B![12]).toBeCloseTo(10, 6);
    expect(r2.matrices.B![13]).toBeCloseTo(10, 6);
    expect(r2.dof).toBe(4);
  });

  it("merges two vertices and puts an axis in a plane", () => {
    const p0 = { kind: "point" as const, p: [100, 60, 40] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    const p1 = { kind: "point" as const, p: [0, 0, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    const r = solveMates([base, block], [{ id: "m1", type: "coincident", a: { component: "A", ...p0 }, b: { component: "B", ...p1 } }]);
    expect(r.ok).toBe(true);
    expect([r.matrices.B![12], r.matrices.B![13], r.matrices.B![14]].map((v) => Math.round(v! * 1e6) / 1e6)).toEqual([100, 60, 40]);
    const edge = { kind: "axis" as const, p: [50, 0, 0] as [number, number, number], d: [1, 0, 0] as [number, number, number] };
    const r2 = solveMates([base, block], [{ id: "m1", type: "coincident", a: { component: "A", ...top }, b: { component: "B", ...edge } }]);
    expect(r2.ok).toBe(true);
    expect(r2.matrices.B![14]).toBeCloseTo(40, 6);
  });

  it("places two faces with the same orientation facing each other (half turn)", () => {
    const r = solveMates([base, block], [{ id: "m1", type: "coincident", a: { component: "A", ...top }, b: { component: "B", ...top } }]);
    expect(r.ok).toBe(true);
    // B's normal is reversed: B's "top" face points downward.
    expect(r.matrices.B![10]).toBeCloseTo(-1, 6);
  });
  it("locks the rotation of a concentric constraint", () => {
    // B rotated by 30° about z: the lock brings it back onto A's frame direction.
    const c = Math.cos(Math.PI / 6);
    const sn = Math.sin(Math.PI / 6);
    const turned: AssemblyComponent = { ...block, matrix: [c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1, 0, 30, 20, 100, 1] };
    const axis = { kind: "axis" as const, p: [50, 30, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    const u: [number, number, number] = [1, 0, 0];
    const mates: Mate[] = [
      { id: "m1", type: "coincident", a: { component: "A", ...top }, b: { component: "B", ...bottom } },
      { id: "m2", type: "concentric", a: { component: "A", ...axis, u }, b: { component: "B", ...axis, u }, lockRotation: true },
    ];
    const r = solveMates([base, turned], mates);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    // B's local x axis coincides with A's.
    expect(r.matrices.B![0]).toBeCloseTo(1, 5);
    expect(r.matrices.B![1]).toBeCloseTo(0, 5);
    // Without the lock, rotation about the axis stays free.
    const free = solveMates([base, turned], [mates[0]!, { ...mates[1]!, lockRotation: false }]);
    expect(free.dof).toBe(1);
  });
  it("counts 4 degrees of freedom for two parallel planes", () => {
    const r = solveMates([base, block], [{ id: "m1", type: "parallel", a: { component: "A", ...top }, b: { component: "B", ...top }, flip: true }]);
    expect(r.ok).toBe(true);
    // Normals already point the same way: the part does not move.
    expect(r.matrices.B).toEqual(block.matrix);
    expect(r.dof).toBe(4);
  });
  describe("motion drivers", () => {
    const z: [number, number, number] = [0, 0, 1];
    const x: [number, number, number] = [1, 0, 0];
    const ax = (p: [number, number, number], d: [number, number, number] = z) => ({ kind: "axis" as const, p, d });

    it("rotates a concentric part through a full turn, including direction", () => {
      const wheel: AssemblyComponent = { id: "B", name: "B", partId: "p", matrix: at(0, 0, 0) };
      let comps = [base, wheel];
      for (let deg = 0; deg <= 360; deg += 45) {
        const mates: Mate[] = [
          { id: "m1", type: "concentric", a: { component: "A", ...ax([0, 0, 0]) }, b: { component: "B", ...ax([0, 0, 0]) }, drive: { kind: "rotary", value: deg, ua: x, ub: x } },
          { id: "m2", type: "coincident", a: { component: "A", kind: "plane", p: [0, 0, 0], d: z }, b: { component: "B", kind: "plane", p: [0, 0, 0], d: [0, 0, -1] } },
        ];
        const r = solveMates(comps, mates);
        expect(r.ok).toBe(true);
        const m = r.matrices.B!;
        // B's local x axis rotated by `deg` about z (signed: 90° towards +y).
        expect(m[0]).toBeCloseTo(Math.cos((deg * Math.PI) / 180), 5);
        expect(m[1]).toBeCloseTo(Math.sin((deg * Math.PI) / 180), 5);
        comps = [base, { ...wheel, matrix: m }];
      }
    });

    it("slides a part along an axis", () => {
      const slider: AssemblyComponent = { id: "B", name: "B", partId: "p", matrix: at(5, 0, 0) };
      const mates: Mate[] = [{ id: "m1", type: "concentric", a: { component: "A", ...ax([0, 0, 0], x) }, b: { component: "B", ...ax([0, 0, 0], x) }, drive: { kind: "linear", value: -25 } }];
      const r = solveMates([base, slider], mates);
      expect(r.ok).toBe(true);
      expect(r.matrices.B![12]).toBeCloseTo(-25, 5);
    });

    it("drives a crank and connecting rod without branch jumping", () => {
      const R = 50;
      const Lr = 150;
      let comps: AssemblyComponent[] = [
        base,
        { id: "C", name: "C", partId: "p", matrix: at(0, 0, 0) },
        { id: "R", name: "R", partId: "p", matrix: at(R, 0, 0) },
        { id: "P", name: "P", partId: "p", matrix: at(R + Lr, 0, 0) },
      ];
      for (let deg = 0; deg <= 360; deg += 15) {
        const mates: Mate[] = [
          { id: "crank", type: "concentric", a: { component: "A", ...ax([0, 0, 0]) }, b: { component: "C", ...ax([0, 0, 0]) }, drive: { kind: "rotary", value: deg, ua: x, ub: x } },
          { id: "floor", type: "coincident", a: { component: "A", kind: "plane", p: [0, 0, 0], d: z }, b: { component: "C", kind: "plane", p: [0, 0, 0], d: [0, 0, -1] } },
          { id: "pinA", type: "concentric", a: { component: "C", ...ax([R, 0, 0]) }, b: { component: "R", ...ax([0, 0, 0]) } },
          { id: "pinB", type: "concentric", a: { component: "R", ...ax([Lr, 0, 0]) }, b: { component: "P", ...ax([0, 0, 0]) } },
          { id: "slide", type: "concentric", a: { component: "A", ...ax([0, 0, 0], x) }, b: { component: "P", ...ax([0, 0, 0], x) } },
        ];
        const r = solveMates(comps, mates);
        expect(r.ok).toBe(true);
        const th = (deg * Math.PI) / 180;
        // Piston position: r cos θ + √(l² − r² sin² θ) (branch on the +x side, the starting one).
        expect(r.matrices.P![12]).toBeCloseTo(R * Math.cos(th) + Math.sqrt(Lr * Lr - R * R * Math.sin(th) ** 2), 3);
        comps = comps.map((c) => (r.matrices[c.id] ? { ...c, matrix: r.matrices[c.id]! } : c));
      }
    });
  });
});

describe("solveMates, mechanisms", () => {
  type V = [number, number, number];
  const X: V = [1, 0, 0];
  const Y: V = [0, 1, 0];
  const Z: V = [0, 0, 1];
  // Connecting rod lying flat (bores along X, length along Z), piston upright (axis along Z, piston pin along X).
  const rodPose = (x: number, y: number, z: number) => [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, x, y, z, 1];
  const pistonPose = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, y, z, 1];
  const axis = (component: string, p: V, d: V): MateRef => ({ component, kind: "axis", p, d });
  const plane = (component: string, d: V): MateRef => ({ component, kind: "plane", p: [0, 0, 0], d });

  it("assembles a 4-cylinder engine constraint by constraint from an exploded view", () => {
    // Fixed block, offset crankshaft, connecting rods and pistons well ahead: each constraint must be accepted
    // (regression: the descent stalled at the second connecting rod and the constraint was rejected).
    const comps: AssemblyComponent[] = [
      { id: "B", name: "B", partId: "b", matrix: [...IDENTITY], fixed: true },
      { id: "C", name: "C", partId: "c", matrix: at(120, 0, 0) },
    ];
    for (let i = 0; i < 4; i++) {
      comps.push({ id: `R${i}`, name: "R", partId: "r", matrix: rodPose(i * 100, -260, 60) });
      comps.push({ id: `P${i}`, name: "P", partId: "p", matrix: pistonPose(i * 100, -260, 300) });
    }
    const mates: Mate[] = [];
    let r = solveMates(comps, mates);
    const add = (m: Omit<Mate, "id">) => {
      mates.push({ ...m, id: `m${mates.length}` } as Mate);
      r = solveMates(comps, mates);
      expect(r.failing, `contrainte ${mates.length}`).toEqual([]);
      for (const c of comps) if (r.matrices[c.id]) c.matrix = r.matrices[c.id]!;
    };
    add({ type: "concentric", a: axis("B", [350, 0, 0], X), b: axis("C", [388, 0, 0], X) });
    add({ type: "coincident", flip: true, a: plane("B", X), b: plane("C", X) });
    for (let i = 0; i < 4; i++) {
      const up = i === 0 || i === 3 ? 1 : -1;
      add({ type: "concentric", a: axis(`R${i}`, [0, 0, 0], Z), b: axis("C", [i * 100, 0, up * 40], X) });
      add({ type: "concentric", a: axis(`P${i}`, [0, 0, 0], Y), b: axis("B", [i * 100, 0, 0], Z) });
      add({ type: "concentric", a: axis(`P${i}`, [0, 0, 0], X), b: axis(`R${i}`, [0, 140, 0], Z) });
      add({ type: "coincident", flip: true, a: plane(`R${i}`, Z), b: plane(`P${i}`, X) });
    }
    // The crankshaft rotation remains (free: it may have turned very slightly). Piston 1 is on the axis of its bore,
    // at top dead center (piston pin axis at 40 + 140 mm).
    expect(r.dof).toBe(1);
    const p0 = comps.find((c) => c.id === "P0")!.matrix;
    expect(p0[12]).toBeCloseTo(0, 6);
    expect(p0[13]).toBeCloseTo(0, 6);
    expect(p0[14]).toBeCloseTo(180, 2);
  });
});

describe("symmetricEigen", () => {
  it("decomposes a symmetric positive semi-definite matrix", () => {
    for (const n of [1, 2, 12, 40]) {
      const B = Array.from({ length: n }, (_, i) => Array.from({ length: n - 1 || 1 }, (_, j) => Math.sin(i * 3 + j * 7 + 1)));
      const S = B.map((ri) => B.map((rj) => ri.reduce((s, v, k) => s + v * rj[k]!, 0)));
      const { values, vectors } = symmetricEigen(S);
      for (let k = 0; k < n; k++) {
        const v = vectors[k]!;
        expect(Math.hypot(...v)).toBeCloseTo(1, 10);
        S.forEach((row, i) => expect(row.reduce((s, x, j) => s + x * v[j]!, 0)).toBeCloseTo(values[k]! * v[i]!, 6));
      }
    }
  });
});

describe("solveMates, couplings (gear, belt, rack and pinion)", () => {
  type V = [number, number, number];
  const X: V = [1, 0, 0];
  const Z: V = [0, 0, 1];
  const axis = (component: string, p: V, d: V = Z): MateRef => ({ component, kind: "axis", p, d });
  const angleOf = (m: number[]) => (Math.atan2(m[1]!, m[0]!) * 180) / Math.PI;
  const norm = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

  /** Turns the input shaft from 0 to `to` degrees, frame by frame (each resolution starts from the previous one). */
  function turn(comps: AssemblyComponent[], mates: (deg: number) => Mate[], to: number, step = 15) {
    let cur = comps;
    let last = solveMates(cur, mates(0));
    for (let deg = step; deg <= to; deg += step) {
      last = solveMates(cur, mates(deg));
      expect(last.ok).toBe(true);
      cur = cur.map((c) => (last.matrices[c.id] ? { ...c, matrix: last.matrices[c.id]! } : c));
    }
    return last;
  }

  const shafts = (deg: number): Mate[] => [
    { id: "in", type: "concentric", a: axis("A", [0, 0, 0]), b: axis("G1", [0, 0, 0]), drive: { kind: "rotary", value: deg, ua: X, ub: X } },
    { id: "out", type: "concentric", a: axis("A", [60, 0, 0]), b: axis("G2", [0, 0, 0]) },
  ];
  const wheels: AssemblyComponent[] = [base, { id: "G1", name: "G1", partId: "p", matrix: at(0, 0, 0) }, { id: "G2", name: "G2", partId: "p", matrix: at(60, 0, 0) }];

  it("meshes two gears in opposite directions according to the ratio ZA / ZB", () => {
    const gear = (deg: number): Mate[] => [...shafts(deg), { id: "g", type: "gear", a: axis("G1", [0, 0, 0]), b: axis("G2", [0, 0, 0]), value: "40 / 20" }];
    const r = turn(wheels, gear, 120);
    expect(norm(angleOf(r.matrices.G2!))).toBeCloseTo(norm(-240), 3);
    expect(norm(angleOf(r.matrices.G1!))).toBeCloseTo(120, 3);
  });

  it("drives two wheels in the same direction with a belt, and reverses them with flip", () => {
    const belt = (deg: number, flip = false): Mate[] => [...shafts(deg), { id: "b", type: "belt", a: axis("G1", [0, 0, 0]), b: axis("G2", [0, 0, 0]), value: "0.5", flip }];
    expect(norm(angleOf(turn(wheels, belt, 90).matrices.G2!))).toBeCloseTo(45, 3);
    expect(norm(angleOf(turn(wheels, (d) => belt(d, true), 90).matrices.G2!))).toBeCloseTo(-45, 3);
  });

  it("composes a train of two pairs and an intermediate shaft with two wheels", () => {
    const comps: AssemblyComponent[] = [...wheels, { id: "G3", name: "G3", partId: "p", matrix: at(60, 0, 0) }, { id: "G4", name: "G4", partId: "p", matrix: at(120, 0, 0) }];
    const train = (deg: number): Mate[] => [
      ...shafts(deg),
      { id: "g12", type: "gear", a: axis("G1", [0, 0, 0]), b: axis("G2", [0, 0, 0]), value: "2" },
      // G3 is fixed to G2 (same shaft, wheel of the following stage): rotation linked by a ratio-1 coupling.
      { id: "key", type: "belt", a: axis("G2", [0, 0, 0]), b: axis("G3", [0, 0, 0]), value: "1" },
      { id: "shaft3", type: "concentric", a: axis("A", [60, 0, 0]), b: axis("G3", [0, 0, 0]) },
      { id: "out4", type: "concentric", a: axis("A", [120, 0, 0]), b: axis("G4", [0, 0, 0]) },
      { id: "g34", type: "gear", a: axis("G3", [0, 0, 0]), b: axis("G4", [0, 0, 0]), value: "3" },
    ];
    const r = turn(comps, train, 60);
    expect(norm(angleOf(r.matrices.G2!))).toBeCloseTo(norm(-120), 3);
    expect(norm(angleOf(r.matrices.G4!))).toBeCloseTo(norm(360), 3); // 60° × 2 × 3, two reversals
  });

  it("moves a rack by r·θ", () => {
    const rack: AssemblyComponent = { id: "R", name: "R", partId: "p", matrix: at(0, -20, 0) };
    const mates = (deg: number): Mate[] => [
      shafts(deg)[0]!,
      { id: "guide", type: "concentric", a: axis("A", [0, -20, 0], X), b: axis("R", [0, 0, 0], X) },
      { id: "rp", type: "rackpinion", a: axis("G1", [0, 0, 0]), b: axis("R", [0, 0, 0], X), value: "20" },
    ];
    const r = turn([base, wheels[1]!, rack], mates, 90);
    expect(r.matrices.R![12]).toBeCloseTo((20 * Math.PI) / 2, 3);
  });
});

describe("angle constraints at 0°, 90° and 180°", () => {
  // B in place on top of A; the angle constraints below are already satisfied: only the DOF count is checked.
  const free: AssemblyComponent = { id: "B", name: "B", partId: "p", matrix: at(0, 0, 40) };
  const ref = (component: string, kind: "plane" | "axis", d: [number, number, number]): MateRef => ({ component, kind, p: [0, 0, 0], d });
  const dofOf = (m: Omit<Mate, "id">) => solveMates([base, free], [{ id: "m", ...m }]).dof;

  it("plane/plane at 0° or 180° blocks two rotations, like parallel", () => {
    const parallel = dofOf({ type: "parallel", flip: true, a: ref("A", "plane", [0, 0, 1]), b: ref("B", "plane", [0, 0, 1]) });
    expect(parallel).toBe(4);
    expect(dofOf({ type: "angle", value: "0", a: ref("A", "plane", [0, 0, 1]), b: ref("B", "plane", [0, 0, 1]) })).toBe(4);
    expect(dofOf({ type: "angle", value: "180", a: ref("A", "plane", [0, 0, 1]), b: ref("B", "plane", [0, 0, -1]) })).toBe(4);
    // Any other angle blocks one rotation.
    expect(dofOf({ type: "angle", value: "30", a: ref("A", "plane", [0, 0, 1]), b: ref("B", "plane", [0, -0.5, Math.sqrt(3) / 2]) })).toBe(5);
  });

  it("axis/axis at 0° blocks two rotations", () => {
    expect(dofOf({ type: "angle", value: "0", a: ref("A", "axis", [1, 0, 0]), b: ref("B", "axis", [1, 0, 0]) })).toBe(4);
  });

  it("axis/plane at 0° (parallel) and 90° (along the normal)", () => {
    expect(dofOf({ type: "angle", value: "0", a: ref("A", "plane", [0, 0, 1]), b: ref("B", "axis", [1, 0, 0]) })).toBe(5);
    expect(dofOf({ type: "angle", value: "90", a: ref("A", "plane", [0, 0, 1]), b: ref("B", "axis", [0, 0, 1]) })).toBe(4);
    expect(dofOf({ type: "angle", value: "90", a: ref("A", "plane", [0, 0, 1]), b: ref("B", "axis", [0, 0, -1]) })).toBe(4);
  });

  it("still brings a tilted part to 0°", () => {
    const tilted: AssemblyComponent = { ...free, matrix: [1, 0, 0, 0, 0, Math.cos(0.3), Math.sin(0.3), 0, 0, -Math.sin(0.3), Math.cos(0.3), 0, 0, 0, 40, 1] };
    const r = solveMates([base, tilted], [{ id: "m", type: "angle", value: "0", a: ref("A", "plane", [0, 0, 1]), b: ref("B", "plane", [0, 0, 1]) }]);
    expect(r.ok).toBe(true);
    expect(r.matrices.B![10]).toBeCloseTo(1, 6);
  });
});
