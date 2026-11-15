import { describe, expect, it } from "vitest";
import { offsetChain, thinOutline, type ThinPrim } from "../src/index.ts";

const line = (ax: number, ay: number, bx: number, by: number): ThinPrim => ({ type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

/** Signed area of an outline (arcs are approximated by their chord plus a circular segment). */
function area(outline: ThinPrim[]): number {
  let s = 0;
  for (const p of outline) {
    s += p.a.x * p.b.y - p.b.x * p.a.y;
    if (p.type === "arc") {
      let sweep = Math.atan2(p.b.y - p.c.y, p.b.x - p.c.x) - Math.atan2(p.a.y - p.c.y, p.a.x - p.c.x);
      if (p.ccw && sweep <= 0) sweep += 2 * Math.PI;
      if (!p.ccw && sweep >= 0) sweep -= 2 * Math.PI;
      s += p.r * p.r * (sweep - Math.sin(sweep));
    }
  }
  return s / 2;
}

describe("offsetChain", () => {
  it("extends sharp corners up to the intersection", () => {
    const o = offsetChain([line(0, 0, 50, 0), line(50, 0, 50, 30)], 2)!;
    expect(o).toHaveLength(2);
    expect(o[0]!.b).toEqual({ x: 48, y: 2 });
    expect(o[1]!.a).toEqual({ x: 48, y: 2 });
  });

  it("rejects a segment shorter than the thickness on the inner side", () => {
    expect(offsetChain([line(0, 0, 50, 0), line(50, 0, 50, 1), line(50, 1, 0, 1)], 5)).toBeNull();
  });

  it("rejects an arc whose radius becomes zero", () => {
    const arc: ThinPrim = { type: "arc", c: { x: 0, y: 0 }, r: 1, a: { x: 1, y: 0 }, b: { x: 0, y: 1 }, ccw: true };
    expect(offsetChain([arc], 2)).toBeNull();
  });
});

describe("thinOutline", () => {
  it("closes the wall of an L: area = length × thickness", () => {
    const chain = [line(0, 0, 50, 0), line(50, 0, 50, 30)];
    expect(Math.abs(area(thinOutline(chain, 0, 2)!))).toBeCloseTo(78 * 2, 9);
    expect(Math.abs(area(thinOutline(chain, 0, -2)!))).toBeCloseTo(82 * 2, 9);
    expect(Math.abs(area(thinOutline(chain, 1, -1)!))).toBeCloseTo(80 * 2, 9);
  });

  it("thickens an arc tangent to its neighboring lines", () => {
    const arc: ThinPrim = { type: "arc", c: { x: 50, y: 20 }, r: 20, a: { x: 50, y: 0 }, b: { x: 70, y: 20 }, ccw: true };
    const outline = thinOutline([line(0, 0, 50, 0), arc, line(70, 20, 70, 60)], 1, -1)!;
    expect(Math.abs(area(outline))).toBeCloseTo((50 + 10 * Math.PI + 40) * 2, 9);
  });
});
