import { describe, expect, it } from "vitest";
import { stepValue } from "../src/components/step.ts";

const evalExpr = (expr: string) => (expr === "L/2" ? { value: 50 } : { error: "inconnu" });

describe("stepValue", () => {
  it("increments a number by 1", () => {
    expect(stepValue("10", 1, evalExpr)).toBe("11");
    expect(stepValue("10", -1, evalExpr)).toBe("9");
  });

  it("accepts the decimal comma and rounds the result", () => {
    expect(stepValue("2,5", 1, evalExpr)).toBe("3.5");
    expect(stepValue("0.1", 0.2, evalExpr)).toBe("0.3");
  });

  it("replaces an expression with its incremented value", () => {
    expect(stepValue("L/2", 1, evalExpr)).toBe("51");
  });

  it("does nothing on an empty or invalid value", () => {
    expect(stepValue("", 1, evalExpr)).toBeNull();
    expect(stepValue("abc", 1, evalExpr)).toBeNull();
  });
});
