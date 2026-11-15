import { describe, expect, it } from "vitest";
import type { FeatureDefinition, PartDocument, SketchData } from "@solidus-cad/sdk";
import { nonParameterizedDims } from "../src/components/partDims.ts";

/** Dimensions not driven by a parameter: numeric parameters of features and driving sketch dimensions. */

const boxDef = (keys: string[]): FeatureDefinition => ({
  type: "box",
  label: { fr: "Boîte", en: "Box" },
  icon: "",
  params: keys.map((key) => ({ key, kind: "length" as const, label: { fr: `Cote ${key}`, en: `Dim ${key}` }, default: "10" })),
});

const doc = (features: PartDocument["features"]): PartDocument => ({
  format: "cad.part",
  formatVersion: 1,
  name: "Piece",
  units: "mm",
  parameters: [{ name: "P1", expr: "100" }],
  features,
  rollback: features.length,
  appearance: { color: "#ffffff" },
});

const sketch = (dimensions: SketchData["dimensions"]) => ({
  id: "sk1",
  type: "sketch",
  name: "Esquisse 1",
  params: {},
  sketch: { plane: { base: "XY" as const, offset: "0" }, geometry: [], constraints: [], dimensions },
});

describe("nonParameterizedDims", () => {
  it("lists the driving sketch dimensions and the undriven numeric parameters, with a unique name", () => {
    const d = doc([
      sketch([
        { id: "d1", type: "radius", a: "c1", value: "5", driving: true },
        { id: "d2", type: "distance", a: "p1", b: "p2", value: "P1", driving: true },
        { id: "d3", type: "angle", a: "l1", b: "l2", value: "30", driving: false },
      ]),
      { id: "f1", type: "box", name: "Boîte", params: { w: "P1", d: "40", h: "2 * 50" } },
    ]);
    expect(nonParameterizedDims(d, (t) => (t === "box" ? boxDef(["w", "d", "h"]) : undefined), (x) => x.fr, (k) => k)).toEqual([
      { name: "Esquisse 1 — radius", value: "5" },
      { name: "Boîte — Cote d", value: "40" },
      { name: "Boîte — Cote h", value: "2 * 50" },
    ]);
  });

  it("two dimensions with the same name get a suffix; deleted features and those beyond the rollback bar are ignored", () => {
    const d = doc([
      { id: "f1", type: "box", name: "Boîte", params: { h: "10" } },
      { id: "f2", type: "box", name: "Boîte", params: { h: "20" }, suppressed: true },
      { id: "f3", type: "box", name: "Boîte", params: { h: "30" } },
    ]);
    d.rollback = 3;
    expect(nonParameterizedDims(d, (t) => (t === "box" ? boxDef(["h"]) : undefined), (x) => x.fr, (k) => k)).toEqual([
      { name: "Boîte — Cote h", value: "10" },
      { name: "Boîte — Cote h (2)", value: "30" },
    ]);
  });
});
