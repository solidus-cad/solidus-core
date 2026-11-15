import type { SkDimension, SkGeometry } from "@solidus-cad/sdk";
import { dimensionAnchors, measureDimension, type Pt } from "@solidus-cad/sketch";
import { isPlainNumber, splitUnitNumber } from "@solidus-cad/sdk";
import { fmtLen } from "../units.ts";

/** Drawing of a dimension, in sketch coordinates: extension and dimension lines, position and text of the label. */
export interface DimGraphic {
  d: SkDimension;
  /** Midpoint of the dimensioned elements (origin of the label offset). */
  mid: Pt;
  /** Position of the label. */
  L: Pt;
  segs: [Pt, Pt][];
  /** Angular dimension arc (polyline, arrows at both ends). */
  arc?: Pt[];
  /** Arrows at both ends of the last segment (linear dimensions; the angular arc always has its own). */
  arrows: boolean;
  text: string;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);
/** A bare number, or a number with a unit (`2 in`): the label only shows the value. */
const isNumber = (s: string) => isPlainNumber(s) || splitUnitNumber(s) !== null;

/** `px`: size of a screen pixel in mm, for the default label offset. */
export function dimensionGraphic(d: SkDimension, g: SkGeometry[], px: number): DimGraphic | null {
  const an = dimensionAnchors(d, g);
  if (!an) return null;
  const measured = measureDimension(d, g) ?? 0;
  if (d.type === "angle") return angleGraphic(d, an as [Pt, Pt, Pt, Pt], measured, px);
  const [p, q] = an as [Pt, Pt];
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  let off = d.offset;
  if (!off) {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    off = d.type === "horizontalDistance" ? { x: 0, y: 24 * px } : d.type === "verticalDistance" ? { x: 24 * px, y: 0 } : { x: (-dy / len) * 24 * px, y: (dx / len) * 24 * px };
  }
  const L = { x: mid.x + off.x, y: mid.y + off.y };
  const segs: [Pt, Pt][] = [];
  if (d.type === "distance") {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / len, y: dx / len };
    const k = (L.x - p.x) * n.x + (L.y - p.y) * n.y;
    const p2 = { x: p.x + n.x * k, y: p.y + n.y * k };
    const q2 = { x: q.x + n.x * k, y: q.y + n.y * k };
    segs.push([p, p2], [q, q2], [p2, q2]);
  } else if (d.type === "horizontalDistance") {
    segs.push([p, { x: p.x, y: L.y }], [q, { x: q.x, y: L.y }], [{ x: p.x, y: L.y }, { x: q.x, y: L.y }]);
  } else if (d.type === "verticalDistance") {
    segs.push([p, { x: L.x, y: p.y }], [q, { x: L.x, y: q.y }], [{ x: L.x, y: p.y }, { x: L.x, y: q.y }]);
  } else if (d.type === "radius" || d.type === "diameter") {
    const r = Math.hypot(q.x - p.x, q.y - p.y);
    const dl = Math.hypot(L.x - p.x, L.y - p.y) || 1;
    const u = { x: (L.x - p.x) / dl, y: (L.y - p.y) / dl };
    const edge = { x: p.x + u.x * r, y: p.y + u.y * r };
    segs.push([d.type === "diameter" ? { x: p.x - u.x * r, y: p.y - u.y * r } : p, edge], [edge, L]);
  }
  const prefix = d.type === "radius" ? "R" : d.type === "diameter" ? "Ø" : "";
  const text = label(d, `${prefix}${fmtLen(measured)}`);
  return { d, mid, L, segs, arrows: d.type !== "radius" && d.type !== "diameter", text };
}

function label(d: SkDimension, value: string): string {
  return !d.driving ? `(${value})` : isNumber(d.value) ? value : `${d.value} = ${value}`;
}

/**
 * Angular dimension: arc centred on the intersection of the two lines, from the direction of `a` to that of `b`
 * (the direction that gives the measured value), with extension lines when the arc goes beyond the segments.
 */
function angleGraphic(d: SkDimension, [a1, a2, b1, b2]: [Pt, Pt, Pt, Pt], measured: number, px: number): DimGraphic {
  const text = label(d, `${fmt(measured)}°`);
  let u = { x: a2.x - a1.x, y: a2.y - a1.y };
  let w = { x: b2.x - b1.x, y: b2.y - b1.y };
  const cross = u.x * w.y - u.y * w.x;
  const mids = { x: (a1.x + a2.x + b1.x + b2.x) / 4, y: (a1.y + a2.y + b1.y + b2.y) / 4 };
  if (Math.abs(cross) < 1e-9 * Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y)) {
    // Parallel lines: no arc, only the label.
    const L = d.offset ? { x: mids.x + d.offset.x, y: mids.y + d.offset.y } : mids;
    return { d, mid: mids, L, segs: [], arrows: false, text };
  }
  // Intersection of the two lines.
  const t = ((b1.x - a1.x) * w.y - (b1.y - a1.y) * w.x) / cross;
  const O = { x: a1.x + t * u.x, y: a1.y + t * u.y };
  // Orientation toward the segments (reversing both directions does not change the angle).
  const ma = { x: (a1.x + a2.x) / 2 - O.x, y: (a1.y + a2.y) / 2 - O.y };
  if (ma.x * u.x + ma.y * u.y < 0) {
    u = { x: -u.x, y: -u.y };
    w = { x: -w.x, y: -w.y };
  }
  const a0 = Math.atan2(u.y, u.x);
  let sweep = Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y);
  const reach = (p: Pt, q: Pt) => Math.max(Math.hypot(p.x - O.x, p.y - O.y), Math.hypot(q.x - O.x, q.y - O.y));
  const rDefault = Math.max(Math.min(reach(a1, a2), reach(b1, b2)) * 0.6, 30 * px);
  const off = d.offset ?? { x: Math.cos(a0 + sweep / 2) * rDefault, y: Math.sin(a0 + sweep / 2) * rDefault };
  const L = { x: O.x + off.x, y: O.y + off.y };
  const r = Math.hypot(off.x, off.y) || rDefault;
  // The label moved out of the sector: the arc extends up to it.
  const aL = Math.atan2(off.y, off.x);
  let rel = Math.atan2(Math.sin(aL - a0), Math.cos(aL - a0));
  let start = a0;
  if (sweep < 0) {
    start = a0 + sweep;
    sweep = -sweep;
    rel = Math.atan2(Math.sin(aL - start), Math.cos(aL - start));
  }
  let from = start;
  let to = start + sweep;
  if (rel < 0) from = start + rel;
  else if (rel > sweep) to = start + rel;
  const n = Math.max(8, Math.ceil(((to - from) * 180) / Math.PI / 4));
  const arc = Array.from({ length: n + 1 }, (_, i) => {
    const k = from + ((to - from) * i) / n;
    return { x: O.x + r * Math.cos(k), y: O.y + r * Math.sin(k) };
  });
  // Extension lines: from the nearest segment end to the arc, if it is further than the segment.
  const segs: [Pt, Pt][] = [];
  for (const [ang, p, q] of [
    [start, ...(Math.abs(a0 - start) < 1e-9 ? [a1, a2] : [b1, b2])],
    [start + sweep, ...(Math.abs(a0 - start) < 1e-9 ? [b1, b2] : [a1, a2])],
  ] as [number, Pt, Pt][]) {
    const e = { x: O.x + r * Math.cos(ang), y: O.y + r * Math.sin(ang) };
    const far = reach(p, q);
    if (far < r) {
      const end = Math.hypot(p.x - O.x, p.y - O.y) > Math.hypot(q.x - O.x, q.y - O.y) ? p : q;
      segs.push([end, e]);
    }
  }
  return { d, mid: O, L, segs, arc, arrows: false, text };
}
