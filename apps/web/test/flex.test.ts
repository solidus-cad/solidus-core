import { describe, expect, it } from "vitest";
import { IDENTITY, type AssemblyDocument } from "@solidus-cad/sdk";
import { solveAssembly } from "../src/assembly/flex.ts";

const at = (x: number, y = 0, z = 0) => {
  const m = [...IDENTITY];
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

/** Cylinder: fixed body and rod concentric on the X axis; the rod measures 100 mm (end face at x = 100). */
const cylinder: AssemblyDocument = {
  format: "cad.assembly",
  formatVersion: 1,
  id: "verin",
  name: "Vérin",
  groups: [],
  components: [
    { id: "body", name: "Corps", partId: "pBody", matrix: at(0), fixed: true },
    { id: "rod", name: "Tige", partId: "pRod", matrix: at(0) },
  ],
  mates: [
    {
      id: "axe",
      type: "concentric",
      a: { component: "body", kind: "axis", p: [0, 0, 0], d: [1, 0, 0] },
      b: { component: "rod", kind: "axis", p: [0, 0, 0], d: [1, 0, 0] },
    },
  ],
};

function machine(flexible: boolean): AssemblyDocument {
  return {
    format: "cad.assembly",
    formatVersion: 1,
    id: "machine",
    name: "Machine",
    groups: [],
    components: [
      { id: "V", name: "Vérin <1>", partId: "", assemblyId: "verin", matrix: at(0, 50, 0), fixed: true, flexible },
      { id: "W", name: "Mur", partId: "pWall", matrix: at(200, 50, 0), fixed: true },
    ],
    // End of the rod (rod frame: plane x = 100, normal +X) against the wall (wall plane x = 0, normal −X).
    mates: [
      {
        id: "butee",
        type: "coincident",
        a: { component: "W", kind: "plane", p: [0, 0, 0], d: [-1, 0, 0] },
        b: { component: "V/rod", kind: "plane", p: [100, 0, 0], d: [1, 0, 0] },
      },
    ],
  };
}

const getAsm = (id: string) => (id === "verin" ? cylinder : undefined);

describe("subassemblies", () => {
  it("flexible: the rod slides up to the wall, the body does not move", () => {
    const r = solveAssembly(machine(true), getAsm);
    expect(r.ok).toBe(true);
    const v = r.updates.find((u) => u.id === "V")!;
    // The occurrence (carried by the body, fixed) does not move.
    expect(v.matrix[12]).toBeCloseTo(0, 6);
    expect(v.matrix[13]).toBeCloseTo(50, 6);
    // The rod slid 100 mm in the occurrence frame.
    expect(v.flex!.rod![12]).toBeCloseTo(100, 5);
    expect(v.flex!.body![12]).toBeCloseTo(0, 6);
    // The original subassembly is not modified.
    expect(cylinder.components[1]!.matrix[12]).toBe(0);
  });

  it("rigid: the rod cannot slide, the constraint is flagged", () => {
    const r = solveAssembly(machine(false), getAsm);
    expect(r.ok).toBe(false);
    expect(r.failing).toEqual(["butee"]);
  });
});
