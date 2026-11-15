import type { I18nText } from "./bench.ts";

export type MaterialFamily =
  | "steel"
  | "stainless"
  | "castIron"
  | "aluminium"
  | "copper"
  | "titanium"
  | "otherMetal"
  | "plastic"
  | "composite"
  | "elastomer"
  | "wood"
  | "mineral";

/** Families in display order. */
export const MATERIAL_FAMILIES: { id: MaterialFamily; label: I18nText }[] = [
  { id: "steel", label: { fr: "Aciers", en: "Steels" } },
  { id: "stainless", label: { fr: "Aciers inoxydables", en: "Stainless steels" } },
  { id: "castIron", label: { fr: "Fontes", en: "Cast irons" } },
  { id: "aluminium", label: { fr: "Aluminiums", en: "Aluminium alloys" } },
  { id: "copper", label: { fr: "Cuivreux", en: "Copper alloys" } },
  { id: "titanium", label: { fr: "Titanes", en: "Titanium alloys" } },
  { id: "otherMetal", label: { fr: "Autres métaux", en: "Other metals" } },
  { id: "plastic", label: { fr: "Plastiques", en: "Plastics" } },
  { id: "composite", label: { fr: "Composites", en: "Composites" } },
  { id: "elastomer", label: { fr: "Élastomères", en: "Elastomers" } },
  { id: "wood", label: { fr: "Bois", en: "Wood" } },
  { id: "mineral", label: { fr: "Verres, céramiques, minéraux", en: "Glass, ceramics, minerals" } },
];

/** Material data sheet. Only the name and the density are required. */
export interface Material {
  name: string;
  /** Absent in documents predating the families. */
  family?: MaterialFamily;
  /** Density (g/cm³). */
  density: number;
  /** Young's modulus (GPa). */
  young?: number;
  /** Poisson's ratio. */
  poisson?: number;
  /** Yield strength Re / Rp0.2 (MPa). */
  yieldStrength?: number;
  /** Tensile strength Rm (MPa). */
  tensileStrength?: number;
  /** Thermal expansion (µm/(m·K)). */
  expansion?: number;
  /** Thermal conductivity (W/(m·K)). */
  conductivity?: number;
  /** Appearance color applied when the material is chosen. */
  color?: string;
}

const _ = undefined;

/** Factory of data sheets for a family: name, ρ, E, ν, Re, Rm, α, λ, color (otherwise the family color). */
function family(id: MaterialFamily, defaultColor: string) {
  return (
    name: string,
    density: number,
    young?: number,
    poisson?: number,
    yieldStrength?: number,
    tensileStrength?: number,
    expansion?: number,
    conductivity?: number,
    color = defaultColor,
  ): Material => {
    const m: Material = { name, family: id, density, color };
    const opt = { young, poisson, yieldStrength, tensileStrength, expansion, conductivity };
    for (const [k, v] of Object.entries(opt)) if (v !== undefined) (m as unknown as Record<string, number>)[k] = v;
    return m;
  };
}

const steel = family("steel", "#8a9099");
const stainless = family("stainless", "#c0c4ca");
const castIron = family("castIron", "#5a6270");
const alu = family("aluminium", "#d0d4d9");
const copper = family("copper", "#d9b46a");
const titanium = family("titanium", "#9a9a96");
const metal = family("otherMetal", "#a4a8ad");
const plastic = family("plastic", "#e8e2d4");
const composite = family("composite", "#3a3d42");
const elastomer = family("elastomer", "#2a2a2a");
const wood = family("wood", "#b38b5d");
const mineral = family("mineral", "#c9ccc8");

/**
 * Simple material database: typical values at room temperature, in the usual delivery condition
 * (stated in the name when it clearly changes the values). Indicative values, not contractual.
 * Composites and wood: values along the fibers.
 */
export const MATERIALS: Material[] = [
  steel("Acier S235", 7.85, 210, 0.3, 235, 360, 12, 50),
  steel("Acier S275", 7.85, 210, 0.3, 275, 430, 12, 50),
  steel("Acier S355", 7.85, 210, 0.3, 355, 510, 12, 50),
  steel("Acier E295", 7.85, 210, 0.3, 295, 470, 12, 50),
  steel("Acier DC01 (tôle emboutissage)", 7.85, 210, 0.3, 210, 330, 12, 55),
  steel("Acier galvanisé DX51D+Z", 7.85, 210, 0.3, _, 270, 12, 55, "#b4bac0"),
  steel("Acier C22", 7.85, 210, 0.3, 240, 430, 11.5, 50),
  steel("Acier C35", 7.85, 210, 0.3, 300, 550, 11.5, 48),
  steel("Acier C45", 7.85, 210, 0.3, 340, 620, 11.5, 45, "#7f868f"),
  steel("Acier 11SMnPb30 (décolletage)", 7.85, 210, 0.3, 410, 510, 12, 50),
  steel("Acier 16MnCr5 (cémentation)", 7.85, 210, 0.3, 310, 550, 11.5, 44),
  steel("Acier 42CrMo4 traité", 7.85, 210, 0.3, 650, 900, 12.5, 42, "#6f767f"),
  steel("Acier 34CrNiMo6 traité", 7.85, 210, 0.3, 800, 1000, 12, 38, "#6f767f"),
  steel("Acier 100Cr6 (roulements)", 7.83, 210, 0.3, 450, 700, 12, 43),
  steel("Acier 51CrV4 (ressorts) traité", 7.85, 206, 0.3, 1200, 1400, 12, 46),
  steel("Acier anti-usure 400 HBW", 7.85, 210, 0.3, 1000, 1250, 12, 40, "#6a7078"),
  steel("Acier outils 1.2312 prétraité", 7.85, 210, 0.3, 850, 1000, 12, 34, "#6a7078"),
  steel("Acier outils 1.2343 trempé", 7.8, 215, 0.3, 1300, 1600, 11.5, 25, "#6a7078"),
  steel("Acier outils 1.2379 recuit", 7.7, 210, 0.3, _, 850, 10.5, 20, "#6a7078"),

  stainless("Inox 304 (1.4301)", 7.9, 193, 0.29, 210, 520, 16, 16),
  stainless("Inox 304L (1.4307)", 7.9, 193, 0.29, 200, 500, 16, 16),
  stainless("Inox 303 (1.4305)", 7.9, 193, 0.29, 190, 500, 16, 15),
  stainless("Inox 316L (1.4404)", 8.0, 193, 0.29, 220, 520, 16, 15),
  stainless("Inox 310S (1.4845)", 7.9, 200, 0.29, 210, 500, 15.5, 14),
  stainless("Inox 430 (1.4016)", 7.7, 220, 0.28, 260, 450, 10, 25),
  stainless("Inox 420 (1.4021) traité", 7.7, 215, 0.28, 600, 800, 10.5, 30),
  stainless("Inox 17-4PH (1.4542)", 7.8, 197, 0.27, 1000, 1070, 10.8, 18),
  stainless("Inox duplex 2205 (1.4462)", 7.8, 200, 0.3, 450, 650, 13, 15),

  castIron("Fonte EN-GJL-200", 7.15, 100, 0.26, _, 200, 10, 50),
  castIron("Fonte EN-GJL-250", 7.2, 110, 0.26, _, 250, 10, 48),
  castIron("Fonte EN-GJS-400-15", 7.1, 169, 0.275, 250, 400, 12.5, 36),
  castIron("Fonte EN-GJS-500-7", 7.1, 169, 0.275, 320, 500, 12.5, 35),
  castIron("Fonte EN-GJS-700-2", 7.2, 176, 0.275, 420, 700, 12.5, 31),

  alu("Aluminium 1050 H14", 2.71, 69, 0.33, 85, 110, 24, 229),
  alu("Aluminium 2017A T4", 2.79, 72.5, 0.33, 260, 390, 23, 134),
  alu("Aluminium 2024 T3", 2.78, 73, 0.33, 345, 483, 23.2, 121),
  alu("Aluminium 5083 H111", 2.66, 71, 0.33, 125, 275, 23.8, 117),
  alu("Aluminium 5754 H111", 2.67, 70, 0.33, 80, 190, 23.9, 147),
  alu("Aluminium 6060 T6", 2.7, 69, 0.33, 150, 190, 23.4, 209),
  alu("Aluminium 6061 T6", 2.7, 69, 0.33, 276, 310, 23.6, 167),
  alu("Aluminium 6082 T6", 2.7, 70, 0.33, 260, 310, 23.1, 172),
  alu("Aluminium 7075 T6", 2.81, 72, 0.33, 503, 572, 23.4, 130),
  alu("Aluminium AlSi10Mg (fonderie)", 2.67, 71, 0.33, 180, 240, 21, 150),
  alu("Aluminium AlSi7Mg0,3 T6 (fonderie)", 2.68, 72, 0.33, 210, 260, 21.5, 150),

  copper("Cuivre Cu-ETP", 8.93, 117, 0.34, 70, 220, 17, 390, "#c8743c"),
  copper("Laiton CuZn39Pb3", 8.47, 97, 0.35, 250, 430, 20.9, 123),
  copper("Laiton CuZn37", 8.44, 110, 0.35, 250, 370, 20.2, 120),
  copper("Bronze CuSn8", 8.8, 115, 0.34, 400, 450, 17, 67, "#b98a4e"),
  copper("Bronze CuSn12 (fonderie)", 8.7, 95, 0.34, 150, 280, 18.5, 55, "#b98a4e"),
  copper("Cupro-aluminium CuAl10Ni5Fe4", 7.6, 120, 0.32, 400, 680, 17, 42, "#c9a24f"),
  copper("Cuivre-béryllium CuBe2 traité", 8.25, 128, 0.3, 1000, 1200, 17, 105, "#c98f5a"),
  copper("Cupronickel CuNi10Fe1Mn", 8.9, 135, 0.33, 150, 300, 17, 50, "#c7b9a6"),

  titanium("Titane grade 2", 4.51, 105, 0.37, 345, 485, 8.6, 16.4),
  titanium("Titane Ti-6Al-4V (grade 5)", 4.43, 114, 0.34, 880, 950, 8.6, 6.7),

  metal("Magnésium AZ91", 1.81, 45, 0.35, 150, 230, 26, 72),
  metal("Zamak 5 (ZnAl4Cu1)", 6.7, 85, 0.3, 230, 330, 27, 109),
  metal("Alliage de nickel 718 traité", 8.19, 200, 0.29, 1030, 1240, 13, 11.4),
  metal("Plomb", 11.34, 16, 0.44, 5, 17, 29, 35, "#7d8187"),

  plastic("ABS", 1.05, 2.3, 0.35, 40, 43, 90, 0.17),
  plastic("PA6", 1.14, 2.8, 0.39, 70, 80, 85, 0.25, "#efe9d8"),
  plastic("PA66", 1.14, 3.0, 0.39, 80, 85, 80, 0.25, "#efe9d8"),
  plastic("PA6 GF30", 1.36, 9.5, 0.35, _, 160, 25, 0.3, "#2f2f2f"),
  plastic("PA12 (frittage laser)", 1.01, 1.7, 0.4, _, 48, 110, 0.22, "#f0efea"),
  plastic("POM-C", 1.41, 2.9, 0.35, 65, 67, 110, 0.31, "#f2f2ee"),
  plastic("PEHD", 0.95, 1.0, 0.42, 25, 30, 200, 0.45, "#ecece6"),
  plastic("PE-UHMW (PE 1000)", 0.93, 0.7, 0.46, 20, 40, 200, 0.4, "#f4f4f0"),
  plastic("PP", 0.905, 1.4, 0.42, 32, 33, 150, 0.22, "#ecebe4"),
  plastic("PVC-U", 1.4, 3.0, 0.38, 50, 52, 80, 0.16, "#8d9298"),
  plastic("PC", 1.2, 2.35, 0.37, 63, 65, 70, 0.2, "#dfe6ea"),
  plastic("PMMA", 1.19, 3.2, 0.37, _, 70, 75, 0.19, "#dbe8ee"),
  plastic("PET", 1.38, 2.8, 0.39, 80, 80, 70, 0.24),
  plastic("PTFE", 2.17, 0.5, 0.46, 10, 25, 120, 0.25, "#f6f6f4"),
  plastic("PEEK", 1.31, 3.6, 0.4, 100, 100, 47, 0.25, "#cdb894"),
  plastic("PLA (impression 3D)", 1.24, 3.5, 0.36, _, 55, 68, 0.13),
  plastic("PETG (impression 3D)", 1.27, 2.0, 0.38, 50, 52, 68, 0.2),

  composite("Carbone/époxy quasi-isotrope", 1.55, 55, 0.3, _, 600, 2, 5),
  composite("Verre/époxy (FR4)", 1.85, 22, 0.12, _, 300, 14, 0.3, "#b9b46a"),

  elastomer("Caoutchouc NBR 70 Shore A", 1.3, 0.006, 0.49, _, 15, 200, 0.25),
  elastomer("Polyuréthane 90 Shore A", 1.2, 0.03, 0.48, _, 40, 150, 0.2, "#c8873a"),
  elastomer("Silicone 50 Shore A", 1.15, 0.002, 0.49, _, 8, 250, 0.2, "#d24a3a"),

  wood("Chêne", 0.75, 11, _, _, 90, 5, 0.17, "#a87b4f"),
  wood("Hêtre", 0.72, 14, _, _, 135, 5, 0.17, "#c9a074"),
  wood("Pin", 0.52, 11, _, _, 100, 5, 0.13, "#d8b77f"),
  wood("Épicéa", 0.45, 10, _, _, 90, 5, 0.12, "#e0c690"),
  wood("Contreplaqué bouleau", 0.68, 8, _, _, 40, 6, 0.15, "#d9bf8f"),
  wood("MDF", 0.75, 3, _, _, 20, 10, 0.12, "#a8865e"),

  mineral("Verre sodocalcique", 2.5, 70, 0.22, _, 45, 9, 1.0, "#cfe3e6"),
  mineral("Alumine 99,5 %", 3.9, 370, 0.22, _, 260, 8, 30, "#f1eee6"),
  mineral("Granit", 2.7, 50, 0.25, _, _, 8, 2.8, "#8b8a88"),
  mineral("Béton C25/30", 2.4, 31, 0.2, _, 2.6, 10, 1.7, "#a9a8a2"),
];

/** Legacy names of the database (documents saved before it was extended). */
const LEGACY_NAMES: Record<string, string> = {
  "Acier inoxydable 304L": "Inox 304L (1.4307)",
  "Aluminium 6061": "Aluminium 6061 T6",
  "Aluminium 5083": "Aluminium 5083 H111",
  Cuivre: "Cuivre Cu-ETP",
  "Titane Ti-6Al-4V": "Titane Ti-6Al-4V (grade 5)",
  POM: "POM-C",
};

/**
 * Effective data sheet: the document's own, completed from the database (`base`, by default the built-in database)
 * for documents that only have the name and the density.
 */
export function materialSheet(m: Material | undefined, base: Material[] = MATERIALS): Material | undefined {
  if (!m) return undefined;
  const name = LEGACY_NAMES[m.name] ?? m.name;
  return { ...base.find((x) => x.name === m.name || x.name === name), ...m };
}
