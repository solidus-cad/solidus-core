import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { analyzeProfiles } from "@solidus-cad/sketch";
import type { SkGeometry } from "@solidus-cad/sdk";
import { textContours } from "../src/sketch/text.ts";

vi.stubGlobal("fetch", async (url: string) => {
  const file = new URL(`../src/assets/fonts/LiberationSans-${/Bold/.test(String(url)) ? "Bold" : "Regular"}.ttf`, import.meta.url);
  const b = readFileSync(file);
  return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
});

function geometryOf(contours: { x: number; y: number }[][]): SkGeometry[] {
  const g: SkGeometry[] = [];
  let n = 0;
  for (const poly of contours) {
    const ids = poly.map((p) => {
      const id = `p${n++}`;
      g.push({ id, type: "point", x: p.x, y: p.y });
      return id;
    });
    ids.forEach((p1, i) => g.push({ id: `l${n++}`, type: "line", p1, p2: ids[(i + 1) % ids.length]! }));
  }
  return g;
}

test("'O': one region with a hole; 'OK': two regions", async () => {
  const o = analyzeProfiles(geometryOf(await textContours("O", { height: 10, bold: false })));
  expect(o.regions).toHaveLength(1);
  expect(o.regions[0]!.holes).toHaveLength(1);
  const ok = analyzeProfiles(geometryOf(await textContours("OK", { height: 10, bold: true })));
  expect(ok.regions).toHaveLength(2);
  expect(ok.selfIntersecting).toBe(false);
});

test("the cap height equals the requested height, two lines do not overlap", async () => {
  const ys = (await textContours("H", { height: 10, bold: false })).flat().map((p) => p.y);
  expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 0);
  const two = (await textContours("H\nH", { height: 10, bold: false })).flat().map((p) => p.y);
  expect(Math.min(...two)).toBeLessThan(-10);
});
