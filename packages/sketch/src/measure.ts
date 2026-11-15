import type { SkDimension, SkGeometry } from "@solidus-cad/sdk";
import { pointMap, type Pt } from "./profiles.ts";
import { AXIS_LINES } from "./solver.ts";

/** Anchor points of a dimension: two points for distances, center + point for radius/diameter. */
export function dimensionAnchors(d: SkDimension, geometry: SkGeometry[]): Pt[] | null {
  const pts = pointMap(geometry);
  const byId = new Map([...AXIS_LINES, ...geometry].map((g) => [g.id, g]));
  const a = byId.get(d.a);
  const b = d.b ? byId.get(d.b) : undefined;
  const pt = (id: string) => pts.get(id);
  if (d.type === "radius" || d.type === "diameter") {
    if (a?.type === "circle") {
      const c = pt(a.c)!;
      return [c, { x: c.x + a.r, y: c.y }];
    }
    if (a?.type === "arc") return [pt(a.c)!, pt(a.start)!];
    return null;
  }
  if (d.type === "angle") {
    if (a?.type !== "line" || b?.type !== "line") return null;
    return [pt(a.p1)!, pt(a.p2)!, pt(b.p1)!, pt(b.p2)!];
  }
  if (a?.type === "line" && !d.b) return [pt(a.p1)!, pt(a.p2)!];
  const pa = pt(d.a);
  const pb = d.b ? pt(d.b) : undefined;
  if (pa && pb) return [pa, pb];
  // Point–line: projection of the point onto the line.
  const [p, l] = a?.type === "line" ? [pb, a] : b?.type === "line" ? [pa, b] : [undefined, undefined];
  if (p && l) {
    const l1 = pt(l.p1)!;
    const l2 = pt(l.p2)!;
    const dx = l2.x - l1.x;
    const dy = l2.y - l1.y;
    const t = ((p.x - l1.x) * dx + (p.y - l1.y) * dy) / (dx * dx + dy * dy || 1);
    return [p, { x: l1.x + t * dx, y: l1.y + t * dy }];
  }
  return null;
}

/** Measured value of a dimension on the current geometry (mm or degrees). */
export function measureDimension(d: SkDimension, geometry: SkGeometry[]): number | null {
  const an = dimensionAnchors(d, geometry);
  if (!an) return null;
  const [p, q] = an as [Pt, Pt];
  switch (d.type) {
    case "distance":
      return Math.hypot(q.x - p.x, q.y - p.y);
    case "horizontalDistance":
      return Math.abs(q.x - p.x);
    case "verticalDistance":
      return Math.abs(q.y - p.y);
    case "radius":
      return Math.hypot(q.x - p.x, q.y - p.y);
    case "diameter":
      return 2 * Math.hypot(q.x - p.x, q.y - p.y);
    case "angle": {
      const [a1, a2, b1, b2] = an as [Pt, Pt, Pt, Pt];
      const ax = a2.x - a1.x;
      const ay = a2.y - a1.y;
      const bx = b2.x - b1.x;
      const by = b2.y - b1.y;
      return Math.abs((Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI);
    }
  }
}
