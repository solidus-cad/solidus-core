import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "@solidus-cad/sdk";
import { decodeLen, encodeLen, fmtArea, fmtLen, fmtVol, inchFraction, lenExpr, setInchFractions, setLengthUnit } from "../src/units.ts";

const empty = new Map<string, number>();

afterEach(() => {
  setLengthUnit("mm");
  setInchFractions(false);
});

describe("units: mm (default)", () => {
  it("keeps values and expressions as typed", () => {
    expect(encodeLen("12,5")).toBe("12.5");
    expect(encodeLen("L/2")).toBe("L/2");
    expect(encodeLen("1 in")).toBe("1 in");
    expect(decodeLen("25.4")).toBe("25.4");
    expect(decodeLen("1 in")).toBe("1 in");
    expect(fmtLen(12.3456)).toBe("12.35");
    expect(fmtLen(10, { unit: true })).toBe("10 mm");
    expect(lenExpr(25.43219)).toBe("25.432");
  });
});

describe("units: inches", () => {
  it("stores typed lengths with the suffix", () => {
    setLengthUnit("in");
    expect(encodeLen("2")).toBe("2 in");
    expect(encodeLen("0,5")).toBe("0.5 in");
    expect(encodeLen("1/4")).toBe("1/4 in");
    expect(encodeLen("1 1/4")).toBe("1 1/4 in");
    expect(encodeLen("1/2 + 1")).toBe("(1/2 + 1) in");
    expect(encodeLen("L/2")).toBe("L/2");
    expect(encodeLen("10 mm")).toBe("10 mm");
    expect(encodeLen('3"')).toBe('3"');
    for (const [typed, mm] of [["2", 50.8], ["1 1/4", 31.75], ["1/2 + 1", 38.1], ["1/4", 6.35]] as const)
      expect(evaluate(encodeLen(typed), empty)).toBeCloseTo(mm);
  });

  it("shows stored values in inches", () => {
    setLengthUnit("in");
    expect(decodeLen("2 in")).toBe("2");
    expect(decodeLen("25.4")).toBe("1");
    expect(decodeLen("L/2")).toBe("L/2");
    expect(decodeLen(encodeLen("1.375"))).toBe("1.375");
    expect(lenExpr(25.43)).toBe("1.001 in");
  });

  it("formats lengths, areas and volumes", () => {
    setLengthUnit("in");
    expect(fmtLen(31.75)).toBe("1.25");
    expect(fmtLen(31.75, { unit: true })).toBe("1.25 in");
    expect(fmtLen(31.75, { digits: 3, fixed: true })).toBe("1.250");
    expect(fmtArea(645.16)).toMatch(/^1 in²$/);
    expect(fmtVol(16387.064)).toMatch(/^1 in³$/);
    setInchFractions(true);
    expect(fmtLen(31.75, { unit: true })).toBe('1 1/4"');
    expect(fmtLen(7.62)).toBe("0.3");
    expect(inchFraction(0.015625)).toBe("1/64");
    expect(inchFraction(-0.5)).toBe("-1/2");
    expect(inchFraction(3)).toBe("3");
  });
});
