import type { Feature, PartDocument } from "./document.ts";

/**
 * Translated text. French is the reference language and English the fallback. The other UI languages
 * ("de", "zh-TW", ...) are optional: a module may supply its own (workbench, properties panel).
 */
export interface I18nText {
  fr: string;
  en: string;
  [lang: string]: string | undefined;
}

interface ParamBase {
  key: string;
  label: I18nText;
  default: string;
  /** Show the parameter only if another parameter has one of these values. */
  when?: ParamCondition;
}

/** Condition on the value of another parameter: `and` must also hold, `or` is an alternative. */
export interface ParamCondition {
  key: string;
  is: string[];
  and?: ParamCondition;
  or?: ParamCondition;
}

/** Is the condition met? `value` gives the value of a parameter. */
export function conditionMet(c: ParamCondition, value: (key: string) => string): boolean {
  return (c.is.includes(value(c.key)) && (!c.and || conditionMet(c.and, value))) || (!!c.or && conditionMet(c.or, value));
}

/** Is a parameter shown for these feature parameters (missing values: defaults of `specs`)? */
export function paramShown(spec: { when?: ParamCondition }, params: Record<string, string | undefined>, specs: readonly { key: string; default: string }[]): boolean {
  return !spec.when || conditionMet(spec.when, (k) => params[k] ?? specs.find((s) => s.key === k)?.default ?? "");
}

/** Readable form of a condition ("type=a|b & mode=c"). */
export function conditionText(c: ParamCondition): string {
  const self = `${c.key}=${c.is.join("|")}${c.and ? ` & ${conditionText(c.and)}` : ""}`;
  return c.or ? `(${self}) | (${conditionText(c.or)})` : self;
}

export type ParamSpec =
  | (ParamBase & { kind: "length" | "angle" | "number" })
  | (ParamBase & { kind: "enum"; options: { value: string; label: I18nText }[] })
  /**
   * Reference to a sketch placed higher in the feature tree. `space`: plane sketches only (default), 3D sketches
   * only, or both (sweep path, loft guide).
   */
  | (ParamBase & { kind: "sketch"; space?: SketchSpace })
  /** Ordered list of sketches (comma-separated identifiers): loft sections, guides. `max`: at most so many. */
  | (ParamBase & { kind: "sketches"; space?: SketchSpace; max?: number })
  /** Line of the sketch referenced by the `sketch` parameter (or the H/V axis of the sketch). */
  | (ParamBase & { kind: "sketchAxis" })
  /** Previous feature whose volume is repeated; `allowBody`: an empty value means the whole body. */
  | (ParamBase & { kind: "feature"; allowBody?: boolean })
  /** Base plane (XY, XZ, YZ) or reference plane placed higher in the feature tree. */
  | (ParamBase & { kind: "plane" })
  /**
   * Part bodies other than the target body (multi-body): comma-separated identifiers. `filter` limits the list
   * to solids or surfaces.
   */
  | (ParamBase & { kind: "bodies"; filter?: "solid" | "surface" });

/** Sketches a parameter accepts: plane ("sketch" features), 3D ("sketch3d" features), or both. */
export type SketchSpace = "2d" | "3d" | "any";

/** Does a feature of type `type` fit a sketch parameter of this space? */
export function sketchFits(type: string, space: SketchSpace = "2d"): boolean {
  if (type === "sketch") return space !== "3d";
  if (type === "sketch3d") return space !== "2d";
  return false;
}

/** Parametric feature declared by a workbench. Its geometric construction is done by the kernel. */
export interface FeatureDefinition {
  type: string;
  label: I18nText;
  /** SVG content (24×24, stroke `currentColor`). */
  icon: string;
  params: ParamSpec[];
  /** Elements to pick in the view (edges or faces), stored in `Feature.refs` (default group, without `group`). */
  refs?: { kind: "edge" | "face"; label: I18nText; hint: I18nText };
  /**
   * Several groups of elements to pick (boundary edges and support faces of a fill, ...): each reference
   * carries the key of its group (`GeomRef.group`). Elements may come from several bodies. Whole bodies
   * are chosen with a parameter of `kind: "bodies"`.
   */
  refGroups?: RefGroup[];
  /**
   * Accepted target body (`Feature.body`): a solid (default, volume operations), any body (move, delete),
   * or none (the feature creates its own body, such as a surface). The kernel rejects a surface as a solid target.
   */
  bodyTarget?: "solid" | "any" | "none";
}

/** Group of elements to pick in the view (FeatureDefinition.refGroups). */
export interface RefGroup {
  /** Key written to `GeomRef.group`. */
  key: string;
  kind: "edge" | "face";
  label: I18nText;
  hint: I18nText;
  /** Expected number of elements (bounds included); the UI flags an incomplete group. */
  min?: number;
  max?: number;
  /** Pickable elements: from a solid body, from a surface, or free edges of a surface (edges only). */
  filter?: "solid" | "surface" | "freeEdge";
  /** Setting of each picked element (continuity of a fill edge…), stored in `GeomRef.choice`; absent: `default`. */
  choice?: { label: I18nText; default: string; options: { value: string; label: I18nText }[] };
  /** Group shown (and pickable) only under this condition on the parameters, like `ParamSpec.when`. */
  when?: ParamCondition;
}

/** What a workbench can do in the application. */
export interface BenchContext {
  document(): PartDocument;
  /** Opens the properties panel to create a feature, with live preview. */
  beginFeature(type: string): void;
  editFeature(feature: Feature): void;
  /** Application action (export, dialog, ...) identified by its name; ignored if unknown. */
  invoke?(action: string): void;
}

export interface Command {
  id: string;
  label: I18nText;
  icon: string;
  run(ctx: BenchContext): void;
}

/** A workbench is a plugin: it declares its features and its commands. */
export interface Bench {
  id: string;
  label: I18nText;
  features: FeatureDefinition[];
  /** Command groups shown in the ribbon. */
  ribbon: { label: I18nText; commands: Command[]; /** `stacked`: small buttons spread over 3 rows to shorten the ribbon. */ stacked?: boolean }[];
}
