import type { FeatureDefinition, GeometryRecipe, ParamSpec } from "@solidus-cad/sdk";
import { bevelRecipe, rackRecipe, spurRecipe, type Representation } from "../engine/index.ts";
import { GEAR_ICONS } from "./GearsRibbon.tsx";

/** Evaluated parameter values (numbers in mm / degrees, raw enumerations). */
type Values = Record<string, number | string>;

export const PLUGIN_ID = "pro.solidus.gears";
export const SPUR = `${PLUGIN_ID}/spur`;
export const RACK = `${PLUGIN_ID}/rack`;
export const BEVEL = `${PLUGIN_ID}/bevel`;

const representation: ParamSpec = {
  key: "representation",
  label: { fr: "Représentation", en: "Representation" },
  kind: "enum",
  default: "detailed",
  options: [
    { value: "detailed", label: { fr: "Détaillée (dents)", en: "Detailed (teeth)" } },
    { value: "simplified", label: { fr: "Simplifiée (diamètre primitif)", en: "Simplified (pitch diameter)" } },
  ],
};

const module_: ParamSpec = { key: "module", label: { fr: "Module", en: "Module" }, kind: "length", default: "2" };
const teeth = (def: string): ParamSpec => ({ key: "teeth", label: { fr: "Nombre de dents", en: "Teeth" }, kind: "number", default: def });
const pressure: ParamSpec = {
  key: "pressure",
  label: { fr: "Angle de pression", en: "Pressure angle" },
  kind: "enum",
  default: "20",
  options: [
    { value: "20", label: { fr: "20°", en: "20°" } },
    { value: "14.5", label: { fr: "14,5°", en: "14.5°" } },
    { value: "25", label: { fr: "25°", en: "25°" } },
  ],
};

export const SPUR_DEF: FeatureDefinition = {
  type: SPUR,
  label: { fr: "Roue cylindrique", en: "Spur / helical gear" },
  icon: GEAR_ICONS.spur,
  params: [
    module_,
    teeth("20"),
    { key: "width", label: { fr: "Épaisseur", en: "Face width" }, kind: "length", default: "10" },
    { key: "bore", label: { fr: "Alésage", en: "Bore" }, kind: "length", default: "8" },
    pressure,
    { key: "shift", label: { fr: "Coefficient de déport", en: "Profile shift" }, kind: "number", default: "0" },
    { key: "helix", label: { fr: "Angle d'hélice (0 = droite)", en: "Helix angle (0 = straight)" }, kind: "angle", default: "0" },
    {
      key: "hand",
      label: { fr: "Sens de l'hélice", en: "Helix hand" },
      kind: "enum",
      default: "right",
      options: [
        { value: "right", label: { fr: "À droite", en: "Right" } },
        { value: "left", label: { fr: "À gauche", en: "Left" } },
      ],
      when: { key: "representation", is: ["detailed"] },
    },
    representation,
  ],
};

export const RACK_DEF: FeatureDefinition = {
  type: RACK,
  label: { fr: "Crémaillère", en: "Rack" },
  icon: GEAR_ICONS.rack,
  params: [
    module_,
    teeth("12"),
    { key: "width", label: { fr: "Épaisseur", en: "Face width" }, kind: "length", default: "10" },
    { key: "base", label: { fr: "Hauteur de base", en: "Base height" }, kind: "length", default: "8" },
    pressure,
    representation,
  ],
};

export const BEVEL_DEF: FeatureDefinition = {
  type: BEVEL,
  label: { fr: "Roue conique", en: "Bevel gear" },
  icon: GEAR_ICONS.bevel,
  params: [
    module_,
    teeth("20"),
    { key: "mateTeeth", label: { fr: "Dents de la roue conjuguée", en: "Mating gear teeth" }, kind: "number", default: "20" },
    { key: "shaftAngle", label: { fr: "Angle entre axes", en: "Shaft angle" }, kind: "angle", default: "90" },
    { key: "faceWidth", label: { fr: "Largeur de denture", en: "Face width" }, kind: "length", default: "10" },
    { key: "bore", label: { fr: "Alésage", en: "Bore" }, kind: "length", default: "8" },
  ],
};

const num = (v: Values, k: string) => Number(v[k]);
const rep = (v: Values) => (v.representation === "simplified" ? "simplified" : "detailed") as Representation;

export const buildSpur = (v: Values): GeometryRecipe =>
  spurRecipe({
    module: num(v, "module"),
    teeth: num(v, "teeth"),
    width: num(v, "width"),
    bore: num(v, "bore"),
    pressure: Number(v.pressure),
    shift: num(v, "shift"),
    helix: num(v, "helix"),
    hand: v.hand === "left" ? -1 : 1,
    representation: rep(v),
  });

export const buildRack = (v: Values): GeometryRecipe =>
  rackRecipe({ module: num(v, "module"), teeth: num(v, "teeth"), width: num(v, "width"), base: num(v, "base"), pressure: Number(v.pressure), representation: rep(v) });

export const buildBevel = (v: Values): GeometryRecipe =>
  bevelRecipe({
    module: num(v, "module"),
    teeth: num(v, "teeth"),
    mateTeeth: num(v, "mateTeeth"),
    shaftAngle: num(v, "shaftAngle"),
    faceWidth: num(v, "faceWidth"),
    bore: num(v, "bore"),
  });
