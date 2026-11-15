import { describe, expect, it } from "vitest";
import { evaluate, hasUnitSuffix, isConstantExpr, isPlainNumber, resolveParameters, splitUnitNumber } from "../src/expr.ts";
import { effectiveParameters } from "../src/document.ts";

const empty = new Map<string, number>();

describe("evaluate", () => {
  it("respects operator precedence", () => {
    expect(evaluate("2 + 3 * 4", empty)).toBe(14);
    expect(evaluate("(2 + 3) * 4", empty)).toBe(20);
    expect(evaluate("-2 ^ 2", empty)).toBe(-4);
    expect(evaluate("2 ^ 3 ^ 2", empty)).toBe(512);
  });

  it("handles functions, constants and parameters", () => {
    expect(evaluate("min(4, 2) + max(1, 3)", empty)).toBe(5);
    expect(evaluate("cos(60)", empty)).toBeCloseTo(0.5);
    expect(evaluate("2 * pi", empty)).toBeCloseTo(2 * Math.PI);
    expect(evaluate("L / 2", new Map([["L", 50]]))).toBe(25);
  });

  it("converts unit suffixes to mm", () => {
    expect(evaluate("1in", empty)).toBeCloseTo(25.4);
    expect(evaluate("2 in", empty)).toBeCloseTo(50.8);
    expect(evaluate('2"', empty)).toBeCloseTo(50.8);
    expect(evaluate("10 mm + 1 in", empty)).toBeCloseTo(35.4);
    expect(evaluate("3ft", empty)).toBeCloseTo(914.4);
    expect(evaluate("2 cm + 0.5 m", empty)).toBeCloseTo(520);
    expect(evaluate("(1/2) in", empty)).toBeCloseTo(12.7);
    expect(evaluate('1/4"', empty)).toBeCloseTo(6.35);
    expect(evaluate('1 1/4"', empty)).toBeCloseTo(31.75);
    expect(evaluate("3 + 1/4 in", empty)).toBeCloseTo(9.35);
    expect(evaluate("2 m", new Map([["m", 7]]))).toBe(2000);
    expect(evaluate("2 * m", new Map([["m", 7]]))).toBe(14);
    expect(evaluate("L + 1 in", new Map([["L", 10]]))).toBeCloseTo(35.4);
    expect(() => evaluate("1 inch", empty)).toThrow();
    expect(() => evaluate("in", empty)).toThrow("inconnu");
    expect(() => evaluate("1 1/4", empty)).toThrow();
  });

  it("classifies expressions", () => {
    expect(isPlainNumber(" 12,5 ")).toBe(true);
    expect(isPlainNumber("-3")).toBe(true);
    expect(isPlainNumber("1 in")).toBe(false);
    expect(splitUnitNumber("2.5 in")).toEqual({ value: 2.5, unit: "in" });
    expect(splitUnitNumber('3"')).toEqual({ value: 3, unit: "in" });
    expect(splitUnitNumber("L in")).toBeNull();
    expect(hasUnitSuffix("L + 2in")).toBe(true);
    expect(hasUnitSuffix("L + 2")).toBe(false);
    expect(isConstantExpr("1/2 + sqrt(2)")).toBe(true);
    expect(isConstantExpr("L/2")).toBe(false);
  });

  it("reports errors", () => {
    expect(() => evaluate("", empty)).toThrow("vide");
    expect(() => evaluate("2 +", empty)).toThrow();
    expect(() => evaluate("X", empty)).toThrow("inconnu");
    expect(() => evaluate("1 / 0", empty)).toThrow("zéro");
    expect(() => evaluate("2 $ 3", empty)).toThrow();
  });
});

describe("resolveParameters", () => {
  it("resolves in any order", () => {
    const r = resolveParameters([
      { name: "L", expr: "2 * H + 10" },
      { name: "H", expr: "20" },
    ]);
    expect(r.scope.get("L")).toBe(50);
    expect(r.errors.size).toBe(0);
  });

  it("reports a result that is not a finite number", () => {
    const r = resolveParameters([
      { name: "A", expr: "sqrt(0 - 1)" },
      { name: "B", expr: "10 ^ 400" },
      { name: "C", expr: "A + 1" },
    ]);
    expect([...r.scope.keys()]).toEqual([]);
    expect(r.errors.get("A")).toBe("Résultat non fini");
    expect(r.errors.get("B")).toBe("Résultat non fini");
    expect(r.errors.has("C")).toBe(true);
  });

  it("detects cycles", () => {
    const r = resolveParameters([
      { name: "A", expr: "B + 1" },
      { name: "B", expr: "A + 1" },
      { name: "C", expr: "5" },
    ]);
    expect(r.errors.has("A")).toBe(true);
    expect(r.errors.has("B")).toBe(true);
    expect(r.scope.get("C")).toBe(5);
  });
});

describe("effectiveParameters", () => {
  it("applies the active configuration of the family", () => {
    const doc = {
      parameters: [
        { name: "L", expr: "100" },
        { name: "H", expr: "20" },
      ],
      family: {
        columns: ["L", "D"],
        rows: [
          { name: "Court", values: ["50", "8"] },
          { name: "Long", values: ["200", ""] },
        ],
        active: 0,
      },
    };
    expect(effectiveParameters(doc)).toEqual([
      { name: "L", expr: "50" },
      { name: "H", expr: "20" },
      { name: "D", expr: "8" },
    ]);
    expect(effectiveParameters({ ...doc, family: { ...doc.family, active: 1 } })).toEqual([
      { name: "L", expr: "200" },
      { name: "H", expr: "20" },
    ]);
    expect(effectiveParameters({ parameters: doc.parameters })).toBe(doc.parameters);
  });
});
