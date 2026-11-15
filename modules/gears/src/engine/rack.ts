import type { GeometryRecipe } from "@solidus-cad/sdk";
import { GearError, type Representation, type V2 } from "./types.ts";

const rad = (d: number) => (d * Math.PI) / 180;

export interface RackParams {
  module: number;
  teeth: number;
  width: number;
  /** Base height below the tooth root (mm). */
  base: number;
  pressure: number;
  representation: Representation;
}

/** Rack pitch (mm). */
export const rackPitch = (module: number) => Math.PI * module;

/**
 * Rack profile in the XY plane: X along the toothing, pitch line at Y = 0, teeth toward +Y.
 * The first tooth is centred at X = pitch/2. Vertices counterclockwise.
 */
export function rackOutline(p: RackParams): V2[] {
  const m = p.module;
  const pitch = rackPitch(m);
  const t = Math.tan(rad(p.pressure));
  const ha = m;
  const hf = 1.25 * m;
  const pts: V2[] = [[0, -hf - p.base], [p.teeth * pitch, -hf - p.base], [p.teeth * pitch, -hf]];
  for (let k = p.teeth - 1; k >= 0; k--) {
    const c = (k + 0.5) * pitch; // tooth axis; half thickness at the pitch line = pitch / 4
    pts.push([c + pitch / 4 + hf * t, -hf], [c + pitch / 4 - ha * t, ha], [c - pitch / 4 + ha * t, ha], [c - pitch / 4 - hf * t, -hf]);
  }
  pts.push([0, -hf]);
  return pts;
}

function validate(p: RackParams) {
  if (!(p.module > 0)) throw new GearError("le module doit être positif");
  if (!Number.isInteger(p.teeth) || p.teeth < 1 || p.teeth > 500) throw new GearError("nombre de dents entre 1 et 500");
  if (!(p.width > 0) || !(p.base > 0)) throw new GearError("épaisseur et base positives");
  if (p.pressure <= 0 || p.pressure >= 30) throw new GearError("angle de pression entre 0 et 30°");
  // Adjacent teeth meet at the root if the root width exceeds the pitch.
  if (p.module * (Math.PI / 2 + 2 * 1.25 * Math.tan(rad(p.pressure))) >= rackPitch(p.module))
    throw new GearError("profil de dent dégénéré (angle de pression trop fort)");
}

/** Recipe of a rack extruded along Z. Simplified: rectangular bar at the pitch line. */
export function rackRecipe(p: RackParams): GeometryRecipe {
  const q = { ...p, teeth: Math.round(p.teeth) };
  validate(q);
  const length = q.teeth * rackPitch(q.module);
  const points: V2[] = q.representation === "simplified" ? [[0, -q.base], [length, -q.base], [length, 0], [0, 0]] : rackOutline(q);
  return { mode: "add", solid: { op: "extrude", profile: { outer: { kind: "polygon", points } }, h: q.width } };
}
