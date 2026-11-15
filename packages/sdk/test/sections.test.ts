import { describe, expect, it } from "vitest";
import { sectionArea, sectionFamily, sectionProps, SECTION_FAMILIES } from "../src/sections.ts";

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("section properties", () => {
  it("solid rectangle: bh³/12, centered at the origin", () => {
    const p = sectionProps("flat", "40x8");
    expect(p.A).toBeCloseTo(320);
    expect(p.cu).toBeCloseTo(0);
    expect(p.cv).toBeCloseTo(0);
    expect(p.Iu).toBeCloseTo((40 * 8 ** 3) / 12);
    expect(p.Iv).toBeCloseTo((8 * 40 ** 3) / 12);
    expect(p.Wu).toBeCloseTo((40 * 8 ** 2) / 6);
    expect(p.Iuv).toBeCloseTo(0);
  });

  it("IPE 200: exact formula without fillets, catalog within ±6 % (fillets ignored)", () => {
    const [h, b, tw, tf] = [200, 100, 5.6, 8.5];
    const p = sectionProps("IPE", "200");
    expect(rel(p.Iu, (b * h ** 3 - (b - tw) * (h - 2 * tf) ** 3) / 12)).toBeLessThan(1e-9);
    expect(rel(p.Iv, (2 * tf * b ** 3 + (h - 2 * tf) * tw ** 3) / 12)).toBeLessThan(1e-9);
    // Catalog: A = 28.5 cm², Iy = 1943 cm⁴, Iz = 142.4 cm⁴, Wel,y = 194.3 cm³.
    expect(rel(p.A, 2850)).toBeLessThan(0.06);
    expect(rel(p.Iu, 1943e4)).toBeLessThan(0.06);
    expect(rel(p.Iv, 142.4e4)).toBeLessThan(0.06);
    expect(rel(p.Wu, 194.3e3)).toBeLessThan(0.06);
  });

  it("HEA 200: catalog within ±6 %", () => {
    const p = sectionProps("HEA", "200");
    // A = 53.8 cm², Iy = 3692 cm⁴, Iz = 1336 cm⁴.
    expect(rel(p.A, 5380)).toBeLessThan(0.06);
    expect(rel(p.Iu, 3692e4)).toBeLessThan(0.06);
    expect(rel(p.Iv, 1336e4)).toBeLessThan(0.06);
  });

  it("square tube 40×40×3 (sharp corners): inertia and Bredt torsion", () => {
    const p = sectionProps("squareTube", "40x3");
    expect(p.A).toBeCloseTo(40 * 40 - 34 * 34);
    expect(p.Iu).toBeCloseTo((40 ** 4 - 34 ** 4) / 12);
    expect(p.Iu).toBeCloseTo(p.Iv);
    expect(p.J).toBeCloseTo((4 * 37 ** 4 * 3) / (4 * 37));
  });

  it("round tube: exact inertia and polar torsion", () => {
    const p = sectionProps("roundTube", "48.3x2.9");
    const D = 48.3;
    const d = D - 5.8;
    expect(rel(p.Iu, (Math.PI * (D ** 4 - d ** 4)) / 64)).toBeLessThan(1e-9);
    expect(rel(p.J, (Math.PI * (D ** 4 - d ** 4)) / 32)).toBeLessThan(1e-9);
    expect(rel(p.Wu, (Math.PI * (D ** 4 - d ** 4)) / (32 * D))).toBeLessThan(1e-9);
  });

  it("UPN: centroid shifted toward the web", () => {
    const p = sectionProps("UPN", "100");
    expect(p.cu).toBeLessThan(0);
    expect(p.cv).toBeCloseTo(0);
  });

  it("angle 50×5: principal axes at 45°, I1 > Iu > I2", () => {
    const p = sectionProps("angle", "50x5");
    expect(Math.abs(p.Iuv)).toBeGreaterThan(1);
    expect(Math.abs(Math.abs(p.angle) - Math.PI / 4)).toBeLessThan(1e-6);
    expect(p.I1).toBeGreaterThan(p.Iu);
    expect(p.I2).toBeLessThan(p.Iu);
    expect(p.I1 + p.I2).toBeCloseTo(p.Iu + p.Iv);
    // Catalog L50×5: Iu = Iv = 11.0 cm⁴ (fillets ignored: ±8 %).
    expect(rel(p.Iu, 11.0e4)).toBeLessThan(0.08);
  });

  it("all sizes: area identical to sectionArea, positive moments of inertia", () => {
    for (const f of SECTION_FAMILIES)
      for (const s of f.sizes) {
        const p = sectionProps(f.id, s);
        expect(rel(p.A, sectionArea(sectionFamily(f.id)!.build(s)))).toBeLessThan(1e-9);
        expect(p.I2).toBeGreaterThan(0);
        expect(p.J).toBeGreaterThan(0);
      }
  });
});
