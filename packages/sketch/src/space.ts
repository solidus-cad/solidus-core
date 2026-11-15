import type { Scope, Sketch3DData, V3 } from "@solidus-cad/sdk";
import { interpolate3 } from "./bspline.ts";
import { solveSketch3D } from "./solver3d.ts";

/**
 * Curves of a 3D sketch for the kernel (`prepared.curves3d`, core/part/sketch.cpp): points re-solved with the
 * current parameters, lines, splines converted to poles, and chains. A chain stops at a point shared by more or
 * fewer than two curves (branches of a skeleton); the remaining curves form closed loops.
 */

export type SpaceCurve =
  | { type: "line"; p1: string; p2: string }
  /** Open B-spline (OCCT convention); `a`, `b`: identifiers of its end points. */
  | { type: "bspline"; poles: V3[]; degree: number; knots: number[]; mults: number[]; a: string; b: string };

export interface SpaceCurves {
  points: Record<string, V3>;
  curves: Record<string, SpaceCurve>;
  chains: { id: string; reversed: boolean }[][];
}

const ends = (c: SpaceCurve): [string, string] => (c.type === "line" ? [c.p1, c.p2] : [c.a, c.b]);

export function sketch3DCurves(data: Sketch3DData, scope?: Scope): SpaceCurves {
  const geometry = solveSketch3D(data, { scope }).geometry;
  const points: Record<string, V3> = {};
  for (const g of geometry) if (g.type === "point") points[g.id] = [g.x, g.y, g.z];
  const curves: Record<string, SpaceCurve> = {};
  const order: string[] = [];
  for (const g of geometry) {
    if (g.type === "point" || g.construction) continue;
    if (g.type === "line") {
      if (!points[g.p1] || !points[g.p2] || g.p1 === g.p2) continue;
      curves[g.id] = { type: "line", p1: g.p1, p2: g.p2 };
    } else {
      const ids = g.points.filter((id) => points[id]);
      const sp = ids.length >= 2 ? interpolate3(ids.map((id) => points[id]!)) : null;
      if (!sp || ids[0] === ids[ids.length - 1]) continue;
      curves[g.id] = { type: "bspline", ...sp, a: ids[0]!, b: ids[ids.length - 1]! };
    }
    order.push(g.id);
  }

  // Curves at each point.
  const at = new Map<string, string[]>();
  for (const id of order) for (const p of ends(curves[id]!)) at.set(p, [...(at.get(p) ?? []), id]);
  const passes = (p: string) => at.get(p)?.length === 2;
  const visited = new Set<string>();
  const chains: SpaceCurves["chains"] = [];
  for (const start of order) {
    if (visited.has(start)) continue;
    visited.add(start);
    const chain = [{ id: start, reversed: false }];
    // Forward from the end of the first curve, then backward from its start, through the points of degree 2.
    const walk = (from: string, forward: boolean) => {
      let p = from;
      while (passes(p)) {
        const next = at.get(p)!.find((c) => !visited.has(c));
        if (!next) break;
        visited.add(next);
        const [a, b] = ends(curves[next]!);
        const reversed = forward ? a !== p : b !== p;
        if (forward) chain.push({ id: next, reversed });
        else chain.unshift({ id: next, reversed });
        p = forward ? (reversed ? a : b) : reversed ? b : a;
      }
    };
    const [a, b] = ends(curves[start]!);
    walk(b, true);
    walk(a, false);
    chains.push(chain);
  }
  return { points, curves, chains };
}
