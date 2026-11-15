import {
  effectiveParameters,
  evaluate,
  resolveParameters,
  validateRecipe,
  type FeatureDefinition,
  type GeometryRecipe,
  type PartDocument,
  type PluginFeatureData,
} from "@solidus-cad/sdk";
import { createRegistry } from "./registry.ts";

/**
 * Parametric features of plugins: definitions (properties panel) and recipe construction.
 *
 * Before each recompute, the application evaluates the parameters of each plugin feature and requests its recipe
 * from the plugin (direct call or RPC); the recipe is written into the feature, which the kernel then interprets.
 * Plugin absent: the last recorded recipe stays in use (frozen form).
 */

export type ParamValues = Record<string, number | string>;

export interface PluginFeatureType {
  /** Full type of the feature: "<plugin>/<type>". */
  id: string;
  pluginId: string;
  version: string;
  definition: FeatureDefinition;
  build(values: ParamValues): Promise<GeometryRecipe>;
}

export const pluginFeatureTypes = createRegistry<PluginFeatureType>();

/** Plugin that provides this feature type (undefined for a built-in feature). */
export function pluginOwner(type: string): { id: string; version: string } | undefined {
  const t = pluginFeatureTypes.get(type);
  return t && { id: t.pluginId, version: t.version };
}

/** Time limit for a plugin to build a recipe. */
const BUILD_MS = 10_000;
const CACHE_MAX = 200;
/** Recipes already built, by type, version and parameter values. */
const cache = new Map<string, { recipe?: GeometryRecipe; error?: string }>();

function remember(key: string, v: { recipe?: GeometryRecipe; error?: string }) {
  cache.delete(key);
  cache.set(key, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

async function build(t: PluginFeatureType, values: ParamValues): Promise<{ recipe?: GeometryRecipe; error?: string }> {
  const key = JSON.stringify([t.id, t.version, values]);
  const hit = cache.get(key);
  if (hit) return hit;
  let out: { recipe?: GeometryRecipe; error?: string };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recipe = await Promise.race([
      t.build(values),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("délai dépassé")), BUILD_MS))),
    ]).finally(() => clearTimeout(timer));
    const errors = validateRecipe(recipe);
    out = errors.length ? { error: `recette invalide : ${errors[0]}` } : { recipe: JSON.parse(JSON.stringify(recipe)) as GeometryRecipe };
  } catch (e) {
    out = { error: e instanceof Error ? e.message : String(e) };
  }
  // Errors are not stored: the plugin may have been fixed or reloaded.
  if (out.recipe) remember(key, out);
  return out;
}

/** Evaluated values of a plugin feature's parameters (numbers in mm / degrees, raw enumerations). */
export function paramValues(def: FeatureDefinition, params: Record<string, string>, scope: Map<string, number>): ParamValues {
  const values: ParamValues = {};
  for (const p of def.params) {
    const raw = params[p.key] ?? p.default;
    values[p.key] = p.kind === "enum" ? raw : evaluate(raw, scope);
  }
  return values;
}

/**
 * Builds the recipes of the active plugin features of a part.
 * Returns the data to write into each modified feature (identifier → plugin data).
 */
export async function resolvePluginRecipes(doc: PartDocument): Promise<Map<string, PluginFeatureData>> {
  const changed = new Map<string, PluginFeatureData>();
  const features = doc.features.filter((f, i) => i < doc.rollback && !f.suppressed && f.plugin && pluginFeatureTypes.get(f.type));
  if (!features.length) return changed;
  const { scope } = resolveParameters(effectiveParameters(doc));
  await Promise.all(
    features.map(async (f) => {
      const t = pluginFeatureTypes.get(f.type)!;
      let res: { recipe?: GeometryRecipe; error?: string };
      try {
        res = await build(t, paramValues(t.definition, f.params, scope));
      } catch (e) {
        res = { error: e instanceof Error ? e.message : String(e) };
      }
      // On error, the previous recipe is kept in the file (frozen form), but the kernel reports the error.
      const next: PluginFeatureData = { id: t.pluginId, version: t.version, recipe: res.recipe ?? f.plugin!.recipe, ...(res.error ? { error: res.error } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(f.plugin)) changed.set(f.id, next);
    }),
  );
  return changed;
}

/** Document sent to the kernel: plugin features with their new data. */
export function withPluginData(doc: PartDocument, changed: Map<string, PluginFeatureData>): PartDocument {
  if (!changed.size) return doc;
  return { ...doc, features: doc.features.map((f) => (changed.has(f.id) ? { ...f, plugin: changed.get(f.id) } : f)) };
}
