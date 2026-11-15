/**
 * Geometric recipes of plugin parametric features.
 *
 * A plugin does not manipulate the kernel: its function `build(params)` returns a recipe (JSON tree of primitives,
 * extruded or revolved profiles, booleans and transformations), which the kernel interprets synchronously and deterministically.
 * - the same plugin works with both kernels (OCCT TypeScript and cad-core): only the interpreter has to be ported;
 * - the recipe is stored in the feature (`Feature.plugin.recipe`): without the plugin, the document still opens
 *   and recomputes (frozen shape: its parameters can no longer be modified);
 * - it is validated and bounded (size, depth) before reaching the kernel.
 *
 * Units: mm and degrees. Frame: that of the part, or the `plane` of a profile.
 */

import type { V3 } from "./sketch3d.ts";

export type V2 = [number, number];

/** Plane of a 2D profile: base plane, or origin + normal + X direction (Y = normal × X). */
export type RecipePlane = "XY" | "XZ" | "YZ" | { origin: V3; normal: V3; xDir: V3 };

/** Closed loop of a profile: polygon (vertices in order) or circle. */
export type Loop = { kind: "polygon"; points: V2[] } | { kind: "circle"; center: V2; r: number };

/** Planar profile: outer loop and holes. */
export interface Profile {
  outer: Loop;
  holes?: Loop[];
}

export type Solid =
  /** Box with corner `at` (default: origin). */
  | { op: "box"; size: V3; at?: V3 }
  /** Cylinder with base centered at `at`, along axis `dir` (default Z). */
  | { op: "cylinder"; r: number; h: number; at?: V3; dir?: V3 }
  | { op: "cone"; r1: number; r2: number; h: number; at?: V3; dir?: V3 }
  | { op: "sphere"; r: number; at?: V3 }
  /** Profile extruded along the plane normal (on both sides if `symmetric`). */
  | { op: "extrude"; profile: Profile; h: number; plane?: RecipePlane; symmetric?: boolean }
  /** Profile extruded while turning by `twist` degrees around the normal (twisted extrusion, e.g. helical gear teeth). */
  | { op: "twistExtrude"; profile: Profile; h: number; twist: number; plane?: RecipePlane; symmetric?: boolean }
  /** Profile revolved around the Y axis of the plane (passing through its origin). */
  | { op: "revolve"; profile: Profile; angle: number; plane?: RecipePlane }
  | { op: "union"; solids: Solid[] }
  | { op: "cut"; from: Solid; tools: Solid[] }
  | { op: "intersect"; solids: Solid[] }
  | { op: "translate"; solid: Solid; by: V3 }
  /** Rotation by `angle` degrees around the `axis` passing through `origin` (default: origin). */
  | { op: "rotate"; solid: Solid; axis: V3; angle: number; origin?: V3 }
  /** Fillet or chamfer on all the edges of the solid. */
  | { op: "fillet"; solid: Solid; r: number }
  | { op: "chamfer"; solid: Solid; d: number }
  /** Body of the part before the feature (error if there is none). */
  | { op: "body" };

export interface GeometryRecipe {
  solid: Solid;
  /** Added to the body (default), removed from the body, or replacing the body. */
  mode?: "add" | "cut" | "replace";
}

/** Limits of a recipe. */
export const RECIPE_LIMITS = { nodes: 5000, depth: 64, points: 100_000, size: 1e6 } as const;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= RECIPE_LIMITS.size;
const isV = (v: unknown, n: 2 | 3): boolean => Array.isArray(v) && v.length === n && v.every(isNum);
const isPos = (v: unknown): boolean => isNum(v) && v > 0;
const nonZero = (v: unknown): boolean => isV(v, 3) && (v as number[]).some((x) => x !== 0);

/** Validates a recipe; returns the list of errors (empty if valid). */
export function validateRecipe(r: unknown): string[] {
  const errors: string[] = [];
  let nodes = 0;
  let points = 0;
  const err = (path: string, msg: string): void => {
    if (errors.length < 20) errors.push(`${path} : ${msg}`);
  };

  const plane = (p: unknown, path: string) => {
    if (p === undefined || p === "XY" || p === "XZ" || p === "YZ") return;
    const o = p as { origin?: unknown; normal?: unknown; xDir?: unknown };
    if (!o || typeof o !== "object" || !isV(o.origin, 3) || !nonZero(o.normal) || !nonZero(o.xDir)) err(path, "plan invalide");
  };
  const loop = (l: unknown, path: string) => {
    const x = l as Loop;
    if (x?.kind === "circle") {
      if (!isV(x.center, 2) || !isPos(x.r)) err(path, "cercle invalide");
    } else if (x?.kind === "polygon") {
      if (!Array.isArray(x.points) || x.points.length < 3 || !x.points.every((p) => isV(p, 2))) err(path, "polygone invalide (3 sommets au moins)");
      else points += x.points.length;
    } else err(path, "contour inconnu");
  };
  const profile = (p: unknown, path: string) => {
    const x = p as Profile;
    if (!x || typeof x !== "object") return err(path, "profil absent");
    loop(x.outer, `${path}.outer`);
    if (x.holes !== undefined) {
      if (!Array.isArray(x.holes)) err(path, "holes : tableau attendu");
      else x.holes.forEach((h, i) => loop(h, `${path}.holes[${i}]`));
    }
  };
  const solid = (s: unknown, path: string, depth: number): void => {
    if (++nodes > RECIPE_LIMITS.nodes) {
      if (nodes === RECIPE_LIMITS.nodes + 1) err(path, `plus de ${RECIPE_LIMITS.nodes} nœuds`);
      return;
    }
    if (depth > RECIPE_LIMITS.depth) return err(path, "imbrication trop profonde");
    const x = s as Record<string, unknown>;
    if (!x || typeof x !== "object") return err(path, "solide attendu");
    const list = (k: string, min: number) => {
      const a = x[k];
      if (!Array.isArray(a) || a.length < min) return err(path, `${k} : ${min} solide(s) au moins`);
      a.forEach((c, i) => solid(c, `${path}.${k}[${i}]`, depth + 1));
    };
    const opt3 = (k: string) => {
      if (x[k] !== undefined && !isV(x[k], 3)) err(path, `${k} : [x, y, z] attendu`);
    };
    switch (x.op) {
      case "box":
        if (!isV(x.size, 3) || !(x.size as number[]).every((v) => v > 0)) err(path, "size : dimensions positives attendues");
        opt3("at");
        break;
      case "cylinder":
      case "cone":
        if (x.op === "cylinder" ? !isPos(x.r) : !(isNum(x.r1) && isNum(x.r2) && (x.r1 as number) >= 0 && (x.r2 as number) >= 0 && ((x.r1 as number) > 0 || (x.r2 as number) > 0)))
          err(path, "rayon invalide");
        if (!isPos(x.h)) err(path, "h : hauteur positive attendue");
        opt3("at");
        if (x.dir !== undefined && !nonZero(x.dir)) err(path, "dir : direction non nulle attendue");
        break;
      case "sphere":
        if (!isPos(x.r)) err(path, "rayon invalide");
        opt3("at");
        break;
      case "extrude":
        profile(x.profile, `${path}.profile`);
        if (!isPos(x.h)) err(path, "h : hauteur positive attendue");
        plane(x.plane, path);
        break;
      case "twistExtrude":
        profile(x.profile, `${path}.profile`);
        if (!isPos(x.h)) err(path, "h : hauteur positive attendue");
        if (!isNum(x.twist) || Math.abs(x.twist as number) > 720) err(path, "twist : [-720, 720] degrés attendus");
        plane(x.plane, path);
        break;
      case "revolve":
        profile(x.profile, `${path}.profile`);
        if (!isPos(x.angle) || (x.angle as number) > 360) err(path, "angle : ]0, 360] attendu");
        plane(x.plane, path);
        break;
      case "union":
      case "intersect":
        list("solids", 1);
        break;
      case "cut":
        solid(x.from, `${path}.from`, depth + 1);
        list("tools", 1);
        break;
      case "translate":
        if (!isV(x.by, 3)) err(path, "by : [x, y, z] attendu");
        solid(x.solid, `${path}.solid`, depth + 1);
        break;
      case "rotate":
        if (!nonZero(x.axis)) err(path, "axis : direction non nulle attendue");
        if (!isNum(x.angle)) err(path, "angle invalide");
        opt3("origin");
        solid(x.solid, `${path}.solid`, depth + 1);
        break;
      case "fillet":
      case "chamfer":
        if (!isPos(x.op === "fillet" ? x.r : x.d)) err(path, "dimension positive attendue");
        solid(x.solid, `${path}.solid`, depth + 1);
        break;
      case "body":
        break;
      default:
        err(path, `opération inconnue « ${String(x.op)} »`);
    }
  };

  const x = r as GeometryRecipe;
  if (!x || typeof x !== "object") return ["recette absente"];
  if (x.mode !== undefined && x.mode !== "add" && x.mode !== "cut" && x.mode !== "replace") err("mode", "add, cut ou replace attendu");
  solid(x.solid, "solid", 0);
  if (points > RECIPE_LIMITS.points) err("solid", `plus de ${RECIPE_LIMITS.points} sommets`);
  return errors;
}

/** Plugin feature of a part: original plugin, and its last recipe (frozen shape if the plugin is absent). */
export interface PluginFeatureData {
  id: string;
  version: string;
  recipe?: GeometryRecipe;
  /** Build error returned by the plugin (shown on the feature). */
  error?: string;
}
