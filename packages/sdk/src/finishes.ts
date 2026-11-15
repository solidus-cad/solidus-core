import type { I18nText } from "./bench.ts";
import type { MaterialFamily } from "./materials.ts";

/** Finish: surface appearance rendered in the view (reflections, roughness, pattern), in addition to the part color. */
export type Finish = "polished" | "brushed" | "sandblasted" | "glossy" | "grained" | "wood";

/** Finishes in display order, named in all the UI languages. */
export const FINISHES: { id: Finish; label: I18nText }[] = [
  {
    id: "polished",
    label: {
      fr: "Métal poli", en: "Polished metal", de: "Poliertes Metall", es: "Metal pulido", it: "Metallo lucidato",
      pt: "Metal polido", pl: "Metal polerowany", cs: "Leštěný kov", tr: "Parlatılmış metal",
      ru: "Полированный металл", ja: "研磨金属", ko: "연마 금속", zh: "抛光金属", "zh-TW": "拋光金屬", ar: "معدن مصقول",
    },
  },
  {
    id: "brushed",
    label: {
      fr: "Métal brossé", en: "Brushed metal", de: "Gebürstetes Metall", es: "Metal cepillado",
      it: "Metallo spazzolato", pt: "Metal escovado", pl: "Metal szczotkowany", cs: "Kartáčovaný kov",
      tr: "Fırçalanmış metal", ru: "Шлифованный металл", ja: "ヘアライン金属", ko: "브러시드 금속", zh: "拉丝金属", "zh-TW": "髮絲紋金屬",
      ar: "معدن مصقول بالفرشاة",
    },
  },
  {
    id: "sandblasted",
    label: {
      fr: "Métal sablé", en: "Sandblasted metal", de: "Sandgestrahltes Metall", es: "Metal arenado",
      it: "Metallo sabbiato", pt: "Metal jateado", pl: "Metal piaskowany", cs: "Pískovaný kov",
      tr: "Kumlanmış metal", ru: "Пескоструйный металл", ja: "サンドブラスト金属", ko: "샌드블라스트 금속", zh: "喷砂金属",
      "zh-TW": "噴砂金屬", ar: "معدن مسفوع بالرمل",
    },
  },
  {
    id: "glossy",
    label: {
      fr: "Plastique brillant", en: "Glossy plastic", de: "Glänzender Kunststoff", es: "Plástico brillante",
      it: "Plastica lucida", pt: "Plástico brilhante", pl: "Tworzywo błyszczące", cs: "Lesklý plast",
      tr: "Parlak plastik", ru: "Глянцевый пластик", ja: "光沢プラスチック", ko: "유광 플라스틱", zh: "亮面塑料", "zh-TW": "亮面塑膠",
      ar: "بلاستيك لامع",
    },
  },
  {
    id: "grained",
    label: {
      fr: "Plastique grainé", en: "Textured plastic", de: "Genarbter Kunststoff", es: "Plástico texturizado",
      it: "Plastica goffrata", pt: "Plástico texturizado", pl: "Tworzywo teksturowane", cs: "Zrnitý plast",
      tr: "Dokulu plastik", ru: "Текстурированный пластик", ja: "シボ加工プラスチック", ko: "텍스처 플라스틱", zh: "皮纹塑料",
      "zh-TW": "咬花塑膠", ar: "بلاستيك محبب",
    },
  },
  {
    id: "wood",
    label: {
      fr: "Bois", en: "Wood", de: "Holz", es: "Madera", it: "Legno", pt: "Madeira", pl: "Drewno", cs: "Dřevo",
      tr: "Ahşap", ru: "Дерево", ja: "木材", ko: "목재", zh: "木材", "zh-TW": "木材", ar: "خشب",
    },
  },
];

const FAMILY_FINISH: Partial<Record<MaterialFamily, Finish>> = {
  steel: "brushed",
  stainless: "brushed",
  castIron: "sandblasted",
  aluminium: "brushed",
  copper: "polished",
  titanium: "brushed",
  otherMetal: "brushed",
  plastic: "grained",
  composite: "glossy",
  elastomer: "grained",
  wood: "wood",
};

/** Finish applied when a material of this family is chosen (none for minerals: glass, ceramic, concrete). */
export function familyFinish(family: MaterialFamily | undefined): Finish | undefined {
  return family && FAMILY_FINISH[family];
}
