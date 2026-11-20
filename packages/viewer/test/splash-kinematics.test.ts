import { describe, expect, it } from "vitest";
import {
  GENEVA,
  JANSEN_EDGES,
  bucketLink,
  digClearances,
  digPose,
  edgeDistance,
  escSimulate,
  gap,
  genevaAt,
  genevaLock,
  genevaWheel,
  inside,
  jansenLeg,
  transform,
  type P,
} from "../src/splash-kinematics.ts";

describe("splash mechanisms", () => {
  it("Geneva drive: no interference between the wheel, the locking disc and the pin over a turn", () => {
    const { a, r, pinR } = GENEVA;
    const wheel = genevaWheel(), lock = genevaLock();
    let minLock = Infinity, minPin = Infinity;
    for (let s = 0; s < 720; s++) {
      const g = genevaAt(-Math.PI + (2 * Math.PI * s) / 720);
      const W = transform(wheel, g.wheel);
      minLock = Math.min(minLock, gap(W, transform(lock, g.drive, a, 0)));
      const pin: P = [a + r * Math.cos(g.drive), r * Math.sin(g.drive)];
      expect(inside(pin, W)).toBe(false);
      minPin = Math.min(minPin, edgeDistance(pin, W) - pinR);
    }
    expect(minLock).toBeGreaterThan(0.02);
    expect(minPin).toBeGreaterThan(0.02);
  }, 60_000);

  it("Geneva drive: a quarter turn per crank turn, wheel locked outside the engagement", () => {
    const g0 = genevaAt(-Math.PI), g1 = genevaAt(Math.PI - 1e-9);
    expect(g0.wheel - g1.wheel).toBeCloseTo(Math.PI / 2, 6);
    expect(genevaAt(-2).wheel).toBe(genevaAt(-1).wheel);
  });

  it("escapement: two teeth per two beats, pallets never inside the teeth", () => {
    const e = escSimulate();
    expect(e.advance).toBeCloseTo(2, 1); // steady state reached (drift spread over the period)
    expect(e.minGap).toBeGreaterThan(-0.002);
  }, 60_000);

  it("excavator: bucket linkage solvable, mid-plane parts clear of each other", () => {
    for (let s = 0; s <= 100; s++) expect(bucketLink(digPose(s / 100).a3)).not.toBeNull();
    for (const [k, g] of Object.entries(digClearances())) expect(g, k).toBeGreaterThan(0.03);
  });

  it("Jansen walker: bars of a leg never cross in their plane (no shared joint)", () => {
    const seg = (a: P, b: P, c: P, d: P) => {
      let m = Infinity;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        m = Math.min(m, edgeDistance([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], [c, d]), edgeDistance([c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t], [a, b]));
      }
      return m;
    };
    for (let s = 0; s < 90; s++) {
      const q = jansenLeg((s / 90) * 2 * Math.PI);
      for (let i = 0; i < JANSEN_EDGES.length; i++) for (let j = i + 1; j < JANSEN_EDGES.length; j++) {
        const [a, b] = JANSEN_EDGES[i]!, [c, d] = JANSEN_EDGES[j]!;
        if (a === c || a === d || b === c || b === d) continue;
        expect(seg(q[a], q[b], q[c], q[d])).toBeGreaterThan(4);
      }
      expect(q.G[1]).toBeGreaterThan(-93);
    }
  }, 60_000);
});
