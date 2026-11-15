import { describe, expect, it } from "vitest";
import { familyFinish, FINISHES, MATERIAL_FAMILIES, materialSheet, MATERIALS } from "../src/index.ts";

describe("materialSheet", () => {
  it("completes a legacy document (name and density) with the database sheet", () => {
    const m = materialSheet({ name: "Aluminium 6061 T6", density: 2.7 })!;
    expect(m.young).toBe(69);
    expect(m.yieldStrength).toBe(276);
  });

  it("legacy names of the database", () => {
    const m = materialSheet({ name: "Aluminium 6061", density: 2.7 })!;
    expect(m.name).toBe("Aluminium 6061");
    expect(m.family).toBe("aluminium");
    expect(m.young).toBe(69);
  });

  it("custom database", () => {
    const base = [{ name: "Maison", density: 3, young: 42 }];
    expect(materialSheet({ name: "Maison", density: 3 }, base)!.young).toBe(42);
  });

  it("every database sheet has a known family", () => {
    const ids = new Set(MATERIAL_FAMILIES.map((f) => f.id));
    for (const m of MATERIALS) expect(ids.has(m.family!)).toBe(true);
  });

  it("document values take precedence over the database", () => {
    expect(materialSheet({ name: "Acier S235", density: 7.8 })!.density).toBe(7.8);
  });

  it("material not in the database, or absent", () => {
    expect(materialSheet({ name: "Inconnu", density: 1 })).toEqual({ name: "Inconnu", density: 1 });
    expect(materialSheet(undefined)).toBeUndefined();
  });

  it("names are unique in the database", () => {
    expect(new Set(MATERIALS.map((m) => m.name)).size).toBe(MATERIALS.length);
  });
});

describe("familyFinish", () => {
  it("every family has a known finish, except minerals", () => {
    const ids = new Set(FINISHES.map((f) => f.id));
    for (const f of MATERIAL_FAMILIES) {
      const finish = familyFinish(f.id);
      if (f.id === "mineral") expect(finish).toBeUndefined();
      else expect(ids.has(finish!)).toBe(true);
    }
    expect(familyFinish(undefined)).toBeUndefined();
  });

  it("finishes named in the 15 UI languages", () => {
    for (const f of FINISHES) expect(Object.keys(f.label)).toHaveLength(15);
  });
});
