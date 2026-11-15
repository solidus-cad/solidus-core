import type { SketchData } from "./sketch.ts";
import type { PluginFeatureData } from "./geometry.ts";
import type { Sketch3DData } from "./sketch3d.ts";
import type { FrameStepData } from "./frame.ts";
import type { DatumPlaneDef } from "./datum.ts";
import type { Material } from "./materials.ts";
import type { Finish } from "./finishes.ts";
import type { AnalysisStudies } from "./analysis.ts";

/** Expression: a value or a formula ("2 * H + 10"), evaluated by the kernel. */
export type Expr = string;

export interface Parameter {
  name: string;
  expr: Expr;
}

export interface Feature {
  id: string;
  type: string;
  name: string;
  suppressed?: boolean;
  /** Numeric parameters (expressions) or enumerated values (raw identifiers). */
  params: Record<string, Expr>;
  /** Sketch data, for "sketch" type features. */
  sketch?: SketchData;
  /** 3D sketch data, for "sketch3d" type features (skeleton parts). */
  sketch3d?: Sketch3DData;
  /** Welded frame step ("frameMembers" features): dressed lines and node settings. */
  frame?: FrameStepData;
  /** Construction of a datum plane ("plane" features). */
  datum?: DatumPlaneDef;
  /** References to edges or faces of the model (geometric signatures). */
  refs?: GeomRef[];
  /** Imported body ("importStep" features): the original file, embedded in the part. */
  imported?: ImportedBody;
  /** Feature provided by a plugin: its geometric recipe, built by the plugin and interpreted by the kernel. */
  plugin?: PluginFeatureData;
  /**
   * Target body (multi-body): identifier of a body, i.e. of the feature that created it. Absent: the active body
   * (last created or modified), which gives the behavior of single-body parts.
   */
  body?: string;
}

/**
 * Imported CAD file, embedded in the document (base64) so that the part stays self-contained: it is saved,
 * copied into a CAM program or a quote, and reopened without the original file.
 */
export interface ImportedBody {
  format: "step";
  fileName: string;
  /** Content fingerprint: kernel cache key (avoids hashing the file at each recompute). */
  hash: string;
  data: string;
}

/**
 * Reference to an edge or a face: its topological name (cad-core) when the kernel provides one, and its geometry
 * (type, midpoint, normal or tangent, size), which serves as a fallback and for a kernel without naming.
 */
export interface GeomRef {
  /**
   * Stable topological name (core/NAMING.md), read from MeshPayload.names at picking. Takes precedence over the geometry:
   * it follows the element when the model changes upstream. Absent with a kernel without naming.
   */
  name?: string;
  kind: "edge" | "face";
  /** Representative point (edge midpoint, face center). */
  p: [number, number, number];
  /** Face normal or edge direction (optional). */
  d?: [number, number, number];
  /** Characteristic size (edge length, face area). */
  size: number;
  /** Cylindrical face: `d` is its axis (CAM picking). */
  axis?: boolean;
  /** Index of the face in the mesh at the time of picking (switch of a picking). */
  face?: number;
  /** Body of the element (multi-body): restricts the geometric fallback to this body. */
  body?: string;
  /** Picking group (RefGroup.key); absent: default group (FeatureDefinition.refs). */
  group?: string;
  /** Setting of the element in its group (RefGroup.choice); absent: the default of the group. */
  choice?: string;
}

export interface PartDocument {
  format: "cad.part";
  formatVersion: 1;
  /** Stable identifier of the document (referenced from assemblies and drawings). */
  id?: string;
  name: string;
  units: "mm";
  parameters: Parameter[];
  features: Feature[];
  /** Part family (configurations), optional. */
  family?: PartFamily;
  /** Library family published from this document: the next publication proposes a new version. */
  publication?: { library: string; family: string };
  /** Configuration taken from a family (replacement in an assembly): document of the original family. */
  familyOrigin?: string;
  /** Rollback bar: only features with index < rollback are computed. */
  rollback: number;
  appearance: Appearance;
  /** Material: copy of the selected data sheet (older documents only have the name and the density). */
  material?: Material;
  /** Document properties, used by the title block and the BOM. */
  properties?: DocumentProperties;
  /** Welded frame: skeleton part whose lines carry the profiles. */
  frameSource?: { partId: string };
  /** Analysis studies (beams on a skeleton, finite elements on the body). */
  analysis?: AnalysisStudies;
  /** Display (does not affect the geometry or the recompute). */
  display?: DisplaySettings;
  /** Bodies of the part (multi-body): name, color, visibility, per body identifier. No effect on the recompute. */
  bodies?: Record<string, BodyDisplay>;
}

/** Display settings of a body. */
export interface BodyDisplay {
  name?: string;
  /** Body color (replaces the part color, not those of features or faces). */
  color?: string;
  /** Chosen visibility; absent: visible, except a consumed body (thickened surface...), hidden by default. */
  hidden?: boolean;
}

/**
 * Part colors: general color, replaced on the faces created by some features,
 * itself replaced on faces picked one by one (priority: face, then feature, then part).
 */
export interface Appearance {
  color: string;
  /** Part finish (rendered surface appearance); absent: color only. Faces colored separately have none. */
  finish?: Finish;
  /** Color of the faces created by a feature (feature identifier → color). */
  features?: Record<string, string>;
  /** Color of picked faces (geometric reference, like the edges of a fillet). */
  faces?: { ref: GeomRef; color: string }[];
}

/** Visibility of the elements of a document: datum planes, sketches, bodies. */
export interface DisplaySettings {
  planes?: Partial<Record<"XY" | "XZ" | "YZ", boolean>>;
  /** Datum planes ("plane" features) hidden. */
  hiddenDatums?: string[];
  /** Sketches: true = always shown, false = hidden; absent = automatic (shown if unused). */
  sketches?: Record<string, boolean>;
  bodyHidden?: boolean;
}

export interface DocumentProperties {
  reference: string;
  designation: string;
  author: string;
  revision: string;
  /**
   * Characteristics of the part, free label / value pairs (filled by the user or by a module that generates
   * the part: profile, length and teeth of a belt…).
   */
  custom?: CustomProperty[];
}

/** Text properties of a document (all of them except the characteristics). */
export type TextProperty = Exclude<keyof DocumentProperties, "custom">;

/** Characteristic of a part: label, value (free text, unit included). */
export interface CustomProperty {
  label: string;
  value: string;
}

/**
 * Part family: one row per configuration, one column per global parameter.
 * The values of the active configuration replace those of the parameters (importable/exportable as .xlsx).
 */
export interface PartFamily {
  columns: string[];
  rows: { name: string; values: Expr[] }[];
  active: number;
}

/** Effective parameters: those of the document, replaced or completed by the active configuration of the family. */
export function effectiveParameters(doc: Pick<PartDocument, "parameters" | "family">): Parameter[] {
  const row = doc.family?.rows[doc.family.active];
  if (!doc.family || !row) return doc.parameters;
  const overrides = new Map(doc.family.columns.map((c, i) => [c, row.values[i] ?? ""] as const).filter(([, v]) => v.trim() !== ""));
  const out = doc.parameters.map((p) => (overrides.has(p.name) ? { name: p.name, expr: overrides.get(p.name)! } : p));
  for (const [name, expr] of overrides) if (!out.some((p) => p.name === name)) out.push({ name, expr });
  return out;
}

export function createPartDocument(name: string): PartDocument {
  return {
    format: "cad.part",
    formatVersion: 1,
    id: newId(),
    name,
    units: "mm",
    parameters: [],
    features: [],
    rollback: 0,
    appearance: { color: "#8fa8c8" },
  };
}

/** Features actually computed: before the rollback bar and not suppressed. */
export function activeFeatures(doc: PartDocument): Feature[] {
  return doc.features.slice(0, doc.rollback).filter((f) => !f.suppressed);
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Stable identifier derived from parts (version and configuration of a library part, family row…): the same parts give the same identifier. */
export async function stableId(...parts: string[]): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000"))));
  const h = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // UUID format (version 8: "custom").
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** FNV-1a 64-bit fingerprint (hexadecimal): cache key, not a cryptographic hash. */
export function contentHash(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) h = ((h ^ BigInt(b)) * prime) & mask;
  return h.toString(16).padStart(16, "0");
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromBase64(data: string): Uint8Array {
  const s = atob(data);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Part made of a single body imported from a STEP file (name: the file name without extension). */
export function createImportedPart(fileName: string, bytes: Uint8Array): PartDocument {
  const doc = createPartDocument(fileName.replace(/\.(step|stp)$/i, ""));
  doc.features.push({
    id: newId(),
    type: "importStep",
    name: fileName,
    params: {},
    imported: { format: "step", fileName, hash: contentHash(bytes), data: toBase64(bytes) },
  });
  doc.rollback = doc.features.length;
  return doc;
}
