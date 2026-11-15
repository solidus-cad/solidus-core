import { defineTexts } from "@app/i18n.ts";

/** Texts of the Gears tab (module-specific dictionary, same mechanism as the core `i18n.ts`). */
const dict = {
  "bench": { fr: "Engrenages", en: "Gears" },
  "g.gears": { fr: "Dentures", en: "Gearing" },
  "spur": { fr: "Roue cylindrique", en: "Spur / helical gear" },
  "spurHint": { fr: "Roue à développante, droite ou hélicoïdale, détaillée ou simplifiée", en: "Involute gear, straight or helical, detailed or simplified" },
  "rack": { fr: "Crémaillère", en: "Rack" },
  "rackHint": { fr: "Crémaillère à dents droites, détaillée ou simplifiée", en: "Straight-tooth rack, detailed or simplified" },
  "bevel": { fr: "Roue conique", en: "Bevel gear" },
  "bevelHint": { fr: "Roue conique simplifiée : cône au diamètre primitif m·Z", en: "Simplified bevel gear: cone at the pitch diameter m·Z" },
} as const;

export type GKey = keyof typeof dict;

export const gt: (key: GKey) => string = defineTexts("gears", dict, import.meta.glob<Record<string, string>>("../locales/*.json", { import: "default" }));
