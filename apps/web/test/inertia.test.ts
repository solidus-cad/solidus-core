import { describe, expect, it } from "vitest";
import { combineInertia, rotateTensor, tensorOf } from "../src/inertia.ts";

/** Solid box a × b × c of mass m: tensor at its center. */
const box = (m: number, a: number, b: number, c: number) =>
  tensorOf({ xx: (m * (b * b + c * c)) / 12, yy: (m * (a * a + c * c)) / 12, zz: (m * (a * a + b * b)) / 12, xy: 0, xz: 0, yz: 0 }, 1);

describe("inertias of an assembly", () => {
  it("combines two boxes of different materials (Huygens)", () => {
    // Box 1: 2 kg centered at (0,0,0); box 2: 6 kg centered at (40,20,0). CoG at (30,15,0).
    const r = combineInertia(
      [
        { m: 2, c: [0, 0, 0], t: box(2, 10, 10, 10) },
        { m: 6, c: [40, 20, 0], t: box(6, 10, 10, 10) },
      ],
      [30, 15, 0],
      8,
    )!;
    const own = (m: number) => (m * 200) / 12;
    // d₁ = (−30,−15,0), d₂ = (10,5,0)
    expect(r.cog.zz).toBeCloseTo(own(2) + own(6) + 2 * (900 + 225) + 6 * (100 + 25), 6);
    expect(r.cog.xx).toBeCloseTo(own(2) + own(6) + 2 * 225 + 6 * 25, 6);
    // Produit Ixy = Σ m dx dy
    expect(r.cog.xy).toBeCloseTo(2 * 450 + 6 * 50, 6);
    expect(r.cog.xz).toBeCloseTo(0, 9);
    // At the origin: + M (|G|² E − G Gᵀ)
    expect(r.origin.zz).toBeCloseTo(r.cog.zz + 8 * (900 + 225), 6);
    expect(r.origin.xy).toBeCloseTo(r.cog.xy + 8 * 30 * 15, 6);
  });

  it("rotates the tensor with the occurrence", () => {
    // Box elongated in X rotated 90° around Z: it becomes elongated in Y.
    const t = box(1, 100, 10, 10);
    const rotZ = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const r = rotateTensor(rotZ, t);
    expect(r[0]).toBeCloseTo(t[4]!, 9);
    expect(r[4]).toBeCloseTo(t[0]!, 9);
    expect(r[8]).toBeCloseTo(t[8]!, 9);
    // 45° rotation: non-zero product of inertia, of known sign (mass along x = y).
    const c = Math.SQRT1_2;
    const r45 = rotateTensor([c, c, 0, 0, -c, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], t);
    expect(-r45[1]!).toBeGreaterThan(0); // Ixy = ∫xy dm > 0
  });
});
