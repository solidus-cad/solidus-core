import type { V2 } from "./types.ts";

const rad = (d: number) => (d * Math.PI) / 180;
/** Involute function: inv(a) = tan(a) − a. */
export const inv = (a: number) => Math.tan(a) - a;

/** Pitch, base, tip and root radii of a cylindrical gear (transverse plane, in mm). */
export interface SpurGeometry {
  rp: number;
  rb: number;
  ra: number;
  rf: number;
}

/** Radii of a gear of module `m`, `z` teeth, pressure angle `alpha` (°) and profile shift coefficient `x`. */
export function spurGeometry(m: number, z: number, alpha: number, x = 0): SpurGeometry {
  const rp = (m * z) / 2;
  return { rp, rb: rp * Math.cos(rad(alpha)), ra: rp + (1 + x) * m, rf: rp - (1.25 - x) * m };
}

/**
 * Contour of an involute gear, vertices counterclockwise.
 * Each tooth: rising flank (radial up to the base circle if the root is lower), tip arc, falling flank, root arc.
 */
export function spurOutline(m: number, z: number, alpha: number, x = 0, flankSteps = 10): V2[] {
  const { rp, rb, ra, rf } = spurGeometry(m, z, alpha, x);
  // Half angular thickness of the tooth at the pitch circle, then at the base circle.
  const half = (m * (Math.PI / 2 + 2 * x * Math.tan(rad(alpha)))) / (2 * rp);
  const halfBase = half + inv(rad(alpha));
  const halfAt = (r: number) => halfBase - inv(Math.acos(Math.min(1, rb / r)));
  const rStart = Math.max(rb, rf);
  const at = (r: number, a: number): V2 => [r * Math.cos(a), r * Math.sin(a)];

  const flank: [number, number][] = []; // (radius, half-angle) from the root to the tip
  if (rf < rb) flank.push([rf, halfBase]);
  for (let i = 0; i <= flankSteps; i++) {
    const r = rStart + ((ra - rStart) * i) / flankSteps;
    flank.push([r, halfAt(r)]);
  }
  const pitch = (2 * Math.PI) / z;
  const pts: V2[] = [];
  for (let k = 0; k < z; k++) {
    const c = k * pitch;
    for (const [r, a] of flank) pts.push(at(r, c - a));
    pts.push(at(ra, c)); // middle of the tip arc
    for (let i = flank.length - 1; i >= 0; i--) pts.push(at(flank[i]![0], c + flank[i]![1]));
    // Root arc up to the next tooth (one intermediate point).
    const gapStart = c + flank[0]![1];
    const gapEnd = c + pitch - flank[0]![1];
    if (gapEnd > gapStart) pts.push(at(rf, (gapStart + gapEnd) / 2));
  }
  return pts;
}

/** Minimum tooth count without cutting interference (no shift: 17 to 20° pressure angle). */
export const undercutLimit = (alpha: number, x = 0) => Math.ceil((2 * (1 - x)) / Math.sin(rad(alpha)) ** 2);
