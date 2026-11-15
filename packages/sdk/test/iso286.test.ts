import { describe, expect, it } from "vitest";
import { equivalentGrade, itTolerance, matchClasses } from "../src/iso286.ts";

describe("ISO 286: IT and equivalent grade", () => {
  it("itTolerance", () => {
    expect(itTolerance(20, 7)).toBe(0.021);
    expect(itTolerance(20, 8)).toBe(0.033);
    expect(itTolerance(600, 7)).toBeNull();
  });
  it("equivalentGrade: largest grade whose IT fits within the interval", () => {
    expect(equivalentGrade(20, 0.021)).toBe(7);
    expect(equivalentGrade(20, 0.03)).toBe(7);
    expect(equivalentGrade(20, 0.1)).toBe(10);
    expect(equivalentGrade(20, 0.0001)).toBe(1);
    expect(equivalentGrade(20, 5)).toBe(16);
    expect(equivalentGrade(700, 0.1)).toBeNull();
  });
  it("matchClasses: finds the code from the deviations", () => {
    expect(matchClasses(20, 0.021, 0)).toEqual(["H7"]);
    expect(matchClasses(8, -0.005, -0.014)).toEqual(["g6"]);
    expect(matchClasses(40, 0.1, -0.05)).toEqual([]);
  });
});
