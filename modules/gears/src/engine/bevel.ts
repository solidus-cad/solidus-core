import type { GeometryRecipe } from "@solidus-cad/sdk";
import { GearError } from "./types.ts";

export interface BevelParams {
  /** Module at the large diameter. */
  module: number;
  teeth: number;
  /** Number of teeth of the mating gear (defines the pitch cone angle). */
  mateTeeth: number;
  /** Angle between the axes (°). */
  shaftAngle: number;
  /** Face width along the generatrix. */
  faceWidth: number;
  bore: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Half-angle of the pitch cone (°): tan δ = sin Σ / (z2/z1 + cos Σ). */
export function pitchConeAngle(p: Pick<BevelParams, "teeth" | "mateTeeth" | "shaftAngle">): number {
  const s = rad(p.shaftAngle);
  return (Math.atan2(Math.sin(s), p.mateTeeth / p.teeth + Math.cos(s)) * 180) / Math.PI;
}

/** Derived quantities: pitch diameter at the large end, cone angle, generatrix (distance to the apex). */
export function bevelInfo(p: BevelParams) {
  const delta = pitchConeAngle(p);
  const rp = (p.module * p.teeth) / 2;
  return { delta, pitchDiameter: 2 * rp, apexDistance: rp / Math.sin(rad(delta)) };
}

/**
 * Simplified bevel gear: truncated cone at the pitch diameter m·z (axis Z, large end at z = 0),
 * optionally bored. The teeth are not modelled.
 */
export function bevelRecipe(p: BevelParams): GeometryRecipe {
  const q = { ...p, teeth: Math.round(p.teeth), mateTeeth: Math.round(p.mateTeeth) };
  if (!(q.module > 0)) throw new GearError("le module doit être positif");
  if (q.teeth < 6 || q.mateTeeth < 6 || q.teeth > 300 || q.mateTeeth > 300) throw new GearError("nombres de dents entre 6 et 300");
  if (q.shaftAngle <= 0 || q.shaftAngle >= 180) throw new GearError("angle des axes entre 0 et 180°");
  if (!(q.faceWidth > 0)) throw new GearError("largeur de denture positive");
  const { delta, apexDistance } = bevelInfo(q);
  if (q.faceWidth >= apexDistance) throw new GearError("largeur de denture supérieure à la génératrice");
  const d = rad(delta);
  const r1 = (q.module * q.teeth) / 2;
  const r2 = r1 - q.faceWidth * Math.sin(d);
  const h = q.faceWidth * Math.cos(d);
  const cone = { op: "cone" as const, r1, r2, h };
  if (!(q.bore > 0)) return { mode: "add", solid: cone };
  if (q.bore / 2 >= r2) throw new GearError("alésage trop grand pour la petite section");
  return { mode: "add", solid: { op: "cut", from: cone, tools: [{ op: "cylinder", r: q.bore / 2, h }] } };
}
