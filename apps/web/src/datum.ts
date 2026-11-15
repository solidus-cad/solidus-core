import { acceptsRef, DATUM_METHODS, type DatumMethod, type DatumPlaneDef, type DatumRef } from "@solidus-cad/sdk";

/** Editing of a reference plane (part and assembly): construction operations, without UI. */

/** New method: compatible elements are kept in place. */
export function changeMethod(d: DatumPlaneDef, method: DatumMethod): void {
  const spec = DATUM_METHODS[method];
  const old = d.refs;
  d.method = method;
  d.refs = spec.roles.map((role, i) => {
    const r = old[i];
    return r && acceptsRef(role, r) ? r : null;
  });
  if (spec.distance && d.distance === undefined) d.distance = "20";
  if (spec.angle && d.angle === undefined) d.angle = method === "angle" ? "45" : "0";
}

/**
 * Assigns a picked element to the `slot`; returns the next slot to fill (null: all filled).
 * An element incompatible with the role is ignored (returns `slot`).
 */
export function assignRef(d: DatumPlaneDef, slot: number, ref: DatumRef): number | null {
  const roles = DATUM_METHODS[d.method].roles;
  if (slot >= roles.length || !acceptsRef(roles[slot]!, ref)) return slot;
  d.refs[slot] = ref;
  for (let i = 1; i <= roles.length; i++) {
    const k = (slot + i) % roles.length;
    if (!d.refs[k] && !(DATUM_METHODS[d.method].optional && k === roles.length - 1)) return k;
  }
  return null;
}

/** First slot to fill in a construction (null: complete). */
export function firstEmptySlot(d: DatumPlaneDef): number | null {
  const spec = DATUM_METHODS[d.method];
  const i = spec.roles.findIndex((_, k) => !d.refs[k] && !(spec.optional && k === spec.roles.length - 1));
  return i < 0 ? null : i;
}

type V3 = [number, number, number];

/** Visual markers of the picked elements (world coordinates): points, and segments for axes. */
export function refMarks(d: DatumPlaneDef, matrix: (key: string) => number[] | undefined, size: number): { points: V3[]; segments: [V3, V3][] } {
  const points: V3[] = [];
  const segments: [V3, V3][] = [];
  for (const r of d.refs) {
    if (!r || r.kind === "base" || r.kind === "datum") continue;
    const m = r.component ? matrix(r.component) : undefined;
    if (r.component && !m) continue;
    const P = (p: V3): V3 => (m ? [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!] : p);
    const D = (p: V3): V3 => (m ? [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2], m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2], m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2]] : p);
    if (r.kind === "point") points.push(P(r.p));
    else if (r.kind === "plane") points.push(P(r.p));
    else {
      const c = P(r.kind === "cylinder" ? r.at : r.p);
      const a = P(r.p);
      const u = D(r.d);
      const l = Math.hypot(...u) || 1;
      // Axis: segment centred on the picked point.
      const k = ((c[0] - a[0]) * u[0] + (c[1] - a[1]) * u[1] + (c[2] - a[2]) * u[2]) / (l * l);
      const mid: V3 = [a[0] + u[0] * k, a[1] + u[1] * k, a[2] + u[2] * k];
      const h = size / l;
      segments.push([
        [mid[0] - u[0] * h, mid[1] - u[1] * h, mid[2] - u[2] * h],
        [mid[0] + u[0] * h, mid[1] + u[1] * h, mid[2] + u[2] * h],
      ]);
      if (r.kind === "cylinder") points.push(c);
    }
  }
  return { points, segments };
}
