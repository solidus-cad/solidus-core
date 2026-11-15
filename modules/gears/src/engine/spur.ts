import type { GeometryRecipe, Profile } from "@solidus-cad/sdk";
import { spurGeometry, spurOutline } from "./involute.ts";
import { GearError, type Representation } from "./types.ts";

const rad = (d: number) => (d * Math.PI) / 180;

export interface SpurParams {
  /** Normal module (mm). */
  module: number;
  teeth: number;
  width: number;
  bore: number;
  /** Normal pressure angle (°). */
  pressure: number;
  /** Profile shift coefficient. */
  shift: number;
  /** Helix angle (°); 0 = straight toothing. */
  helix: number;
  /** Helix hand: 1 right, -1 left. */
  hand: 1 | -1;
  representation: Representation;
}

/** Derived quantities of a gear (transverse plane), for the centre distance and checks. */
export function spurInfo(p: SpurParams) {
  const beta = rad(p.helix);
  const mt = p.module / Math.cos(beta);
  const alphaT = (Math.atan(Math.tan(rad(p.pressure)) / Math.cos(beta)) * 180) / Math.PI;
  const g = spurGeometry(mt, p.teeth, alphaT, p.shift);
  return { ...g, mt, alphaT, pitchDiameter: 2 * g.rp, tipDiameter: 2 * g.ra, rootDiameter: 2 * g.rf };
}

/** Centre distance of two gears with the same normal module and opposite helix angles. */
export const centerDistance = (module: number, z1: number, z2: number, helix = 0) => (module * (z1 + z2)) / (2 * Math.cos(rad(helix)));

function validate(p: SpurParams) {
  if (!(p.module > 0)) throw new GearError("le module doit être positif");
  if (!Number.isInteger(p.teeth) || p.teeth < 6 || p.teeth > 300) throw new GearError("nombre de dents entre 6 et 300");
  if (!(p.width > 0)) throw new GearError("l'épaisseur doit être positive");
  if (p.bore < 0) throw new GearError("alésage négatif");
  if (Math.abs(p.helix) >= 45) throw new GearError("angle d'hélice limité à ±45°");
  if (p.shift < -1 || p.shift > 1) throw new GearError("déport entre -1 et 1");
  const info = spurInfo(p);
  if (info.rf <= 0) throw new GearError("diamètre de pied nul : module trop grand pour ce nombre de dents");
  if (p.bore >= 2 * info.rf - 0.5) throw new GearError("alésage trop grand pour le diamètre de pied");
}

/** Geometric recipe of a cylindrical gear (straight or helical). */
export function spurRecipe(p: SpurParams): GeometryRecipe {
  const q = { ...p, teeth: Math.round(p.teeth) };
  validate(q);
  const info = spurInfo(q);
  const holes = q.bore > 0 ? [{ kind: "circle" as const, center: [0, 0] as [number, number], r: q.bore / 2 }] : [];
  const profile: Profile =
    q.representation === "simplified"
      ? { outer: { kind: "circle", center: [0, 0], r: info.rp }, holes }
      : { outer: { kind: "polygon", points: spurOutline(info.mt, q.teeth, info.alphaT, q.shift) }, holes };
  if (q.helix === 0 || q.representation === "simplified") return { mode: "add", solid: { op: "extrude", profile, h: q.width } };
  // Helix: twist of the apparent section over the face width = b·tanβ / rp (apparent pitch radius).
  const twist = ((q.hand * q.width * Math.tan(rad(q.helix))) / info.rp) * (180 / Math.PI);
  return { mode: "add", solid: { op: "twistExtrude", profile, h: q.width, twist } };
}
