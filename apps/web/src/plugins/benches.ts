import type { Bench, FeatureDefinition } from "@solidus-cad/sdk";
import { partBench } from "@solidus-cad/bench-part";
import { sheetMetalBench } from "@solidus-cad/bench-sheetmetal";
import { createRegistry } from "./registry.ts";
import { pluginFeatureTypes } from "./features.ts";

/**
 * Loaded part workbenches. Each workbench is a plugin: the built-in workbenches (Part, Sheet metal)
 * are registered here; plugins add their own on activation.
 */
export const benchRegistry = createRegistry<Bench>([partBench, sheetMetalBench]);

export const benches = (): Bench[] => benchRegistry.list();

/** Paid feature required by a part workbench of a module (Surfaces: "surface"); the others are free. */
const benchFeatures = new Map<string, string>();
export function registerBenchFeature(benchId: string, feature: string): void {
  benchFeatures.set(benchId, feature);
}
export const benchFeatureOf = (benchId: string): string | undefined => benchFeatures.get(benchId);

/** Definition of a feature, whatever the workbench or plugin that declares it. */
export function definitionOf(type: string): FeatureDefinition | undefined {
  for (const b of benchRegistry.list()) {
    const f = b.features.find((d) => d.type === type);
    if (f) return f;
  }
  return pluginFeatureTypes.get(type)?.definition;
}
