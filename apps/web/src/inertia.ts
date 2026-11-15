import type { Inertia } from "@solidus-cad/sdk";

type V3 = [number, number, number];

// 3×3 inertia tensor (row-major): moments on the diagonal, −products off the diagonal.
export type M3 = number[];

export function tensorOf(i: Inertia, scale: number): M3 {
  return [i.xx, -i.xy, -i.xz, -i.xy, i.yy, -i.yz, -i.xz, -i.yz, i.zz].map((x) => x * scale);
}

export function inertiaOf(t: M3): Inertia {
  return { xx: t[0]!, yy: t[4]!, zz: t[8]!, xy: -t[1]!, xz: -t[2]!, yz: -t[5]! };
}

/** R·J·Rᵀ, R: rotation part of a 4×4 column-major matrix. */
export function rotateTensor(m: number[], t: M3): M3 {
  const R = (r: number, c: number) => m[c * 4 + r]!;
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) s += R(i, k) * t[k * 3 + l]! * R(j, l);
      out[i * 3 + j] = s;
    }
  return out;
}

/** Huygens' theorem: adds m(|d|²E − d dᵀ) to the tensor (d: from the reduction point to the part's center of gravity). */
export function shiftTensor(t: M3, m: number, d: V3): M3 {
  const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return t.map((x, k) => {
    const i = Math.floor(k / 3);
    const j = k % 3;
    return x + m * ((i === j ? d2 : 0) - d[i]! * d[j]!);
  });
}

/**
 * Inertia of a set of bodies (mass, center, tensor at the body's center, absolute frame), reduced
 * to the center of gravity `cog` of the set and to the origin. Bodies without a tensor are ignored.
 */
export function combineInertia(bodies: { m: number; c: V3; t: M3 | null }[], cog: V3, mass: number): { cog: Inertia; origin: Inertia } | null {
  if (!bodies.some((b) => b.t)) return null;
  let t: M3 = new Array<number>(9).fill(0);
  for (const b of bodies) {
    if (!b.t) continue;
    const atG = shiftTensor(b.t, b.m, [b.c[0] - cog[0], b.c[1] - cog[1], b.c[2] - cog[2]]);
    t = t.map((x, k) => x + atG[k]!);
  }
  return { cog: inertiaOf(t), origin: inertiaOf(shiftTensor(t, mass, cog)) };
}
