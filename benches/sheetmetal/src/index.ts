import type { Bench, FeatureDefinition, ParamSpec } from "@solidus-cad/sdk";

/**
 * Sheet metal workbench: base sheet (closed contour or open profile), flanges, cuts and flattening.
 * Features live in the part document; the kernel maintains the flat pattern in parallel with the folded model.
 */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

const ICONS = {
  base: svg('<path d="M3 15l9-4 9 4-9 4z"/><path d="M3 15v1.5l9 4 9-4V15"/>'),
  flange: svg('<path d="M3 17l9-4 6 2.7"/><path d="M18 15.7V6l3-1.3v9.7z"/><path d="M3 17v1.5l9-4"/>'),
  cut: svg('<path d="M3 15l9-4 9 4-9 4z"/><ellipse cx="12" cy="15" rx="3" ry="1.3"/><path d="M12 4v7" stroke-dasharray="2 1.5"/>'),
  lineBend: svg('<path d="M3 16l7-3 4 1.8"/><path d="M14 14.8 20 9l1 .4-6 5.8"/><path d="M10 13l4 1.8" stroke-dasharray="1.5 1.5"/><path d="M3 16v1.3l7-3"/>'),
  flat: svg('<path d="M3 16l9-4 9 4-9 4z"/><path d="M8.5 13.5l7 3.2" stroke-dasharray="2 1.5"/><path d="M14 5v4m-2-2 2 2 2-2"/>'),
  dxf: svg('<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8 17l8-6M8 11l8 6" stroke-dasharray="2 1.5"/>'),
};

const yes = (key: string, fr: string, en: string): ParamSpec => ({
  key,
  label: { fr, en },
  kind: "enum",
  default: "no",
  options: [
    { value: "no", label: { fr: "Non", en: "No" } },
    { value: "yes", label: { fr: "Oui", en: "Yes" } },
  ],
});

const features: FeatureDefinition[] = [
  {
    type: "sheetBase",
    label: { fr: "Tôle de base", en: "Base flange" },
    icon: ICONS.base,
    params: [
      { key: "sketch", label: { fr: "Esquisse (contour fermé ou ligne brisée)", en: "Sketch (closed contour or polyline)" }, kind: "sketch", default: "" },
      { key: "thickness", label: { fr: "Épaisseur", en: "Thickness" }, kind: "length", default: "2" },
      { key: "radius", label: { fr: "Rayon de pliage intérieur", en: "Inner bend radius" }, kind: "length", default: "2" },
      { key: "kFactor", label: { fr: "Facteur K", en: "K-factor" }, kind: "number", default: "0.44" },
      { key: "depth", label: { fr: "Profondeur (profil ouvert)", en: "Depth (open profile)" }, kind: "length", default: "50" },
      {
        key: "depthMode",
        label: { fr: "Extrusion (profil ouvert)", en: "Extrusion (open profile)" },
        kind: "enum",
        default: "oneSide",
        options: [
          { value: "oneSide", label: { fr: "D'un côté (sens de la normale)", en: "One side (along the normal)" } },
          { value: "symmetric", label: { fr: "Symétrique", en: "Mid-plane" } },
        ],
      },
      yes("reverse", "Inverser le côté de la matière", "Flip material side"),
    ],
  },
  {
    type: "edgeFlange",
    label: { fr: "Bord tombé", en: "Edge flange" },
    icon: ICONS.flange,
    params: [
      { key: "length", label: { fr: "Longueur (partie droite)", en: "Length (straight part)" }, kind: "length", default: "20" },
      { key: "angle", label: { fr: "Angle de pliage", en: "Bend angle" }, kind: "angle", default: "90" },
      {
        key: "direction",
        label: { fr: "Sens du pli", en: "Bend direction" },
        kind: "enum",
        default: "same",
        options: [
          { value: "same", label: { fr: "Vers la face de l'arête", en: "Towards the edge's face" } },
          { value: "opposite", label: { fr: "Côté opposé", en: "Opposite side" } },
        ],
      },
      {
        key: "position",
        label: { fr: "Position du pli", en: "Flange position" },
        kind: "enum",
        default: "bendOutside",
        options: [
          { value: "bendOutside", label: { fr: "Pli à l'extérieur", en: "Bend outside" } },
          { value: "materialInside", label: { fr: "Matière à l'intérieur", en: "Material inside" } },
          { value: "materialOutside", label: { fr: "Matière à l'extérieur", en: "Material outside" } },
        ],
      },
      { key: "offsetStart", label: { fr: "Retrait au début de l'arête", en: "Start offset" }, kind: "length", default: "0" },
      { key: "offsetEnd", label: { fr: "Retrait à la fin de l'arête", en: "End offset" }, kind: "length", default: "0" },
      {
        key: "relief",
        label: { fr: "Dégagement de pli", en: "Bend relief" },
        kind: "enum",
        default: "rect",
        options: [
          { value: "rect", label: { fr: "Rectangulaire", en: "Rectangular" } },
          { value: "round", label: { fr: "Arrondi", en: "Obround" } },
          { value: "none", label: { fr: "Aucun", en: "None" } },
        ],
      },
      {
        key: "corner",
        label: { fr: "Coins entre arêtes désignées (90°)", en: "Corners between selected edges (90°)" },
        kind: "enum",
        default: "open",
        options: [
          { value: "open", label: { fr: "Ouverts", en: "Open" } },
          { value: "overlap", label: { fr: "Fermés, recouvrement", en: "Closed, overlap" } },
          { value: "butt", label: { fr: "Fermés, bout à bout", en: "Closed, butt" } },
        ],
      },
    ],
    refs: {
      kind: "edge",
      label: { fr: "Arêtes", en: "Edges" },
      hint: {
        fr: "Cliquez une ou plusieurs arêtes droites du dessus ou du dessous de la tôle.",
        en: "Click one or more straight edges on the top or bottom of the sheet.",
      },
    },
  },
  {
    type: "sheetCut",
    label: { fr: "Découpe", en: "Cut" },
    icon: ICONS.cut,
    params: [{ key: "sketch", label: { fr: "Esquisse (contours fermés)", en: "Sketch (closed contours)" }, kind: "sketch", default: "" }],
  },
  {
    type: "sketchedBend",
    label: { fr: "Pli sur ligne", en: "Sketched bend" },
    icon: ICONS.lineBend,
    params: [
      { key: "sketch", label: { fr: "Esquisse (une ligne sur la tôle)", en: "Sketch (one line on the sheet)" }, kind: "sketch", default: "" },
      { key: "angle", label: { fr: "Angle de pliage", en: "Bend angle" }, kind: "angle", default: "90" },
      {
        key: "direction",
        label: { fr: "Sens du pli", en: "Bend direction" },
        kind: "enum",
        default: "same",
        options: [
          { value: "same", label: { fr: "Vers la normale de l'esquisse", en: "Towards the sketch normal" } },
          { value: "opposite", label: { fr: "Côté opposé", en: "Opposite side" } },
        ],
      },
      yes("flip", "Inverser le côté mobile", "Flip moving side"),
    ],
  },
  {
    type: "sheetFlat",
    label: { fr: "Mise à plat", en: "Flatten" },
    icon: ICONS.flat,
    params: [],
  },
];

const command = (f: FeatureDefinition) => ({
  id: `sheetmetal.${f.type}`,
  label: f.label,
  icon: f.icon,
  run: (ctx: { beginFeature(type: string): void }) => ctx.beginFeature(f.type),
});

export const sheetMetalBench: Bench = {
  id: "sheetmetal",
  label: { fr: "Tôlerie", en: "Sheet metal" },
  features,
  ribbon: [
    { label: { fr: "Esquisse", en: "Sketch" }, commands: [{ id: "sheetmetal.sketch", label: { fr: "Esquisse", en: "Sketch" }, icon: svg('<path d="M4 18h16M4 18V6"/><path d="m14 4 6 6-8 8H6v-6z"/>'), run: (ctx) => ctx.beginFeature("sketch") }] },
    { label: { fr: "Tôle", en: "Sheet" }, commands: features.slice(0, 4).map(command) },
    {
      label: { fr: "Développé", en: "Flat pattern" },
      commands: [
        command(features[4]!),
        { id: "sheetmetal.exportDxf", label: { fr: "Développé DXF", en: "Flat pattern DXF" }, icon: ICONS.dxf, run: (ctx) => ctx.invoke?.("sheetmetal.exportFlatDxf") },
      ],
    },
  ],
};
