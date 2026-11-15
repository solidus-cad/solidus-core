import { newId, type DocumentProperties } from "./document.ts";

/**
 * Drawing: a standard sheet, a title block, projected views of a part, dimensions and notes.
 * Sheet units: mm. View coordinates are those of the projection (model mm); the scale places them on the sheet.
 */

export type SheetSize = "A4" | "A3" | "A2" | "A1" | "A0" | "ANSI A" | "ANSI B" | "ANSI C" | "ANSI D" | "ANSI E";

/** Sheet dimensions in landscape (width, height) in mm: ISO 216 (A4…A0) and ASME Y14.1 (ANSI A…E, inches). */
export const SHEET_SIZES: Record<SheetSize, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  "ANSI A": [279.4, 215.9],
  "ANSI B": [431.8, 279.4],
  "ANSI C": [558.8, 431.8],
  "ANSI D": [863.6, 558.8],
  "ANSI E": [1117.6, 863.6],
};

/**
 * Drafting standard of a drawing: ISO (ISO 128, 129, 5457, 7200…) or US (ASME Y14.1, Y14.2, Y14.3, Y14.5, AWS A2.4):
 * third angle projection, ANSI sheets, unidirectional dimensions, inch values without a leading zero, hole notes
 * "4X ⌀.257 THRU", unified threads "1/4-20 UNC-2B", zones numbered from the right and lettered from the bottom.
 */
export type DrawingStandard = "ISO" | "ASME";

/** Sheet sizes of each standard, from the smallest; equivalents have the same index (A4 ↔ ANSI A…). */
export const STANDARD_SHEETS: Record<DrawingStandard, SheetSize[]> = {
  ISO: ["A4", "A3", "A2", "A1", "A0"],
  ASME: ["ANSI A", "ANSI B", "ANSI C", "ANSI D", "ANSI E"],
};

/** Standard of a drawing (ISO when absent: drawings made before the US standard). */
export const drawingStandard = (d: Pick<DrawingDocument, "standard">): DrawingStandard => d.standard ?? "ISO";

export type ViewKind = "front" | "top" | "right" | "left" | "bottom" | "back" | "iso";

export interface DrawingView {
  id: string;
  /** Projected part (PartDocument.id), or, if `assemblyId` is set, the reference part for the title block. */
  partId: string;
  /** View of an assembly (AssemblyDocument.id). */
  assemblyId?: string;
  /** Occurrences hidden in this view (assembly views). */
  hiddenComponents?: string[];
  /** Occurrences not cut in a section view (shafts, screws, pins...). */
  uncutComponents?: string[];
  /** Section view: plane perpendicular to the viewing direction, at `depth` mm; label (A, B...). */
  section?: { depth: number; label: string };
  /** Detail view: enlargement of a disk (coordinates of the parent view); label (C, D...). */
  detail?: { parent: string; cx: number; cy: number; r: number; label: string };
  /** Projected or section view: stays aligned with this parent view (same vertical or same horizontal) and at the same scale. */
  alignedTo?: string;
  /** Unfolded view (sheet metal): flat pattern of the part. */
  flat?: boolean;
  kind: ViewKind;
  /** Center of the view on the sheet (mm, origin at bottom left). */
  x: number;
  y: number;
  /** Scale (1 = full size, 0.5 = 1:2). */
  scale: number;
  hiddenLines: boolean;
  label?: string;
}

/** Bounding box of a projection [xmin, ymin, xmax, ymax]. */
export type ViewBounds = [number, number, number, number];

/**
 * Associative reference to the projected geometry of a view (model coordinates of the view):
 * vertex, point on a straight edge, circle (center, or contour point at the given angle), corner of the bounding box.
 * `vb`: bounding box of the view at the last resolution (used to predict the new position).
 */
export type GeoRef =
  | { kind: "vertex"; p: [number, number]; vb: ViewBounds }
  | { kind: "edge"; a: [number, number]; b: [number, number]; t: number; vb: ViewBounds }
  | { kind: "circle"; c: [number, number]; r: number; angle?: number; vb: ViewBounds }
  | { kind: "bound"; sx: 0 | 1; sy: 0 | 1 };

/**
 * Dimension of a view, between two points of the projection (model coordinates of the view).
 * Angle: refA and refB are the two straight edges, a and b the picked points on them (the measured sector is
 * the one that contains them), `offset` the radius of the dimension arc (sheet mm).
 */
export interface DrawingDimension {
  /** References of points a and b (associative dimension); for Ø / R, refA is the circle. */
  refA?: GeoRef;
  refB?: GeoRef;
  /** A reference was not found again after a change to the part. */
  lost?: boolean;
  id: string;
  view: string;
  type: "aligned" | "horizontal" | "vertical" | "diameter" | "radius" | "angle";
  a: [number, number];
  b: [number, number];
  /** Offset of the dimension line (sheet mm), or text position for radii. */
  offset: number;
  /** Forced text (otherwise the measured value). */
  text?: string;
  /** Prefix ("4×"...). */
  prefix?: string;
  /** Tolerance: symmetric (±upper), deviations (upper / lower) or ISO 286 fit ("H7"). */
  tolerance?: DimensionTolerance;
}

/** Drawing attached to the PDF export, for an exact inventory of the requirements when reading the PDF (quoting). */
export const DRAWING_PDF_ATTACHMENT = "cad-drawing.json";

/**
 * Geometry of an angle dimension: vertex (intersection of the two edges), unit directions toward the picked
 * points, angle in degrees. Null if the edges are missing or parallel.
 */
export function angleGeometry(d: Pick<DrawingDimension, "a" | "b" | "refA" | "refB">): { o: [number, number]; u1: [number, number]; u2: [number, number]; deg: number } | null {
  const ea = d.refA?.kind === "edge" ? d.refA : null;
  const eb = d.refB?.kind === "edge" ? d.refB : null;
  if (!ea || !eb) return null;
  const d1 = [ea.b[0] - ea.a[0], ea.b[1] - ea.a[1]];
  const d2 = [eb.b[0] - eb.a[0], eb.b[1] - eb.a[1]];
  const cross = d1[0]! * d2[1]! - d1[1]! * d2[0]!;
  const l1 = Math.hypot(d1[0]!, d1[1]!);
  const l2 = Math.hypot(d2[0]!, d2[1]!);
  if (l1 < 1e-9 || l2 < 1e-9 || Math.abs(cross) < 1e-6 * l1 * l2) return null;
  const t = ((eb.a[0] - ea.a[0]) * d2[1]! - (eb.a[1] - ea.a[1]) * d2[0]!) / cross;
  const o: [number, number] = [ea.a[0] + d1[0]! * t, ea.a[1] + d1[1]! * t];
  // Direction of each edge from the vertex toward the picked point (or the far end of the edge).
  const dir = (p: [number, number], e: [number, number], f: [number, number], l: number): [number, number] => {
    let v = [p[0] - o[0], p[1] - o[1]];
    if (Math.hypot(v[0]!, v[1]!) < 1e-6 * l) v = Math.hypot(e[0] - o[0], e[1] - o[1]) > Math.hypot(f[0] - o[0], f[1] - o[1]) ? [e[0] - o[0], e[1] - o[1]] : [f[0] - o[0], f[1] - o[1]];
    const n = Math.hypot(v[0]!, v[1]!) || 1;
    return [v[0]! / n, v[1]! / n];
  };
  const u1 = dir(d.a, ea.a, ea.b, l1);
  const u2 = dir(d.b, eb.a, eb.b, l2);
  const deg = (Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) * 180) / Math.PI;
  return { o, u1, u2, deg };
}

/** Value of a dimension, in model mm (degrees for an angle). */
export function dimensionValue(d: DrawingDimension): number {
  if (d.type === "angle") return angleGeometry(d)?.deg ?? 0;
  const dx = Math.abs(d.b[0] - d.a[0]);
  const dy = Math.abs(d.b[1] - d.a[1]);
  if (d.type === "horizontal") return dx;
  if (d.type === "vertical") return dy;
  if (d.type === "diameter") return Math.hypot(dx, dy) * 2;
  return Math.hypot(dx, dy);
}

export interface DimensionTolerance {
  kind: "sym" | "dev" | "fit";
  upper?: number;
  lower?: number;
  fit?: string;
  /**
   * Fit: display of the code only ("Ø20 H7"), of the code and the ISO 286 deviations ("Ø20 H7 (+0.021 / 0)"),
   * of the deviations only, or of the limit dimensions ("Ø20.021 / Ø20.000").
   */
  display?: "code" | "codeDeviations" | "deviations" | "limits";
}

export interface DrawingNote {
  id: string;
  x: number;
  y: number;
  text: string;
}

/** Built-in title block fields (value taken from the drawing, the part, or computed). */
export type BuiltinField =
  | "title"
  | "company"
  | "reference"
  | "material"
  | "scale"
  | "size"
  | "drawnBy"
  | "date"
  | "revision"
  | "projection"
  | "sheet"
  | "logo"
  | "generalTolerance"
  | "roughness"
  | "treatment"
  | "paint"
  | "edgeDefault";

export interface TitleBlockCell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Label (small text at the top left of the cell). */
  label: string;
  /** Displayed field: built-in or custom (`custom:client`); without a field, `text` is fixed text. */
  field?: BuiltinField | `custom:${string}`;
  text?: string;
  /** Height of the value text (mm). */
  size?: number;
  bold?: boolean;
}

/** Title block template: cells in mm, origin at the bottom left of the title block. */
export interface TitleBlockTemplate {
  name: string;
  width: number;
  height: number;
  cells: TitleBlockCell[];
}

/** Default title block (180 × 40 mm). */
export const DEFAULT_TITLE_BLOCK: TitleBlockTemplate = {
  name: "ISO 7200",
  width: 180,
  height: 40,
  cells: [
    { x: 0, y: 26, w: 120, h: 14, label: "Titre|Title", field: "title", size: 5, bold: true },
    { x: 120, y: 26, w: 60, h: 14, label: "Société|Company", field: "company" },
    { x: 0, y: 13, w: 60, h: 13, label: "Référence|Part number", field: "reference" },
    { x: 60, y: 13, w: 60, h: 13, label: "Matériau|Material", field: "material" },
    { x: 120, y: 13, w: 30, h: 13, label: "Échelle|Scale", field: "scale" },
    { x: 150, y: 13, w: 30, h: 13, label: "Format|Size", field: "size" },
    { x: 0, y: 0, w: 45, h: 13, label: "Dessiné par|Drawn by", field: "drawnBy" },
    { x: 45, y: 0, w: 35, h: 13, label: "Date|Date", field: "date" },
    { x: 80, y: 0, w: 20, h: 13, label: "Rév.|Rev.", field: "revision" },
    { x: 100, y: 0, w: 50, h: 13, label: "Projection|Projection", field: "projection" },
    { x: 150, y: 0, w: 30, h: 13, label: "Feuille|Sheet", field: "sheet" },
  ],
};

/** Cell label in the requested language ("fr|en" or a single text). */
/**
 * ASME Y14.1 title block (180 × 46 mm): tolerance block on the left, company, title, size, drawing number,
 * revision, scale, projection and sheet on the right.
 */
export const ASME_TITLE_BLOCK: TitleBlockTemplate = {
  name: "ASME Y14.1",
  width: 180,
  height: 46,
  cells: [
    { x: 0, y: 33, w: 70, h: 13, label: "SAUF INDICATION CONTRAIRE|UNLESS OTHERWISE SPECIFIED", field: "generalTolerance", size: 2.5 },
    { x: 70, y: 33, w: 110, h: 13, label: "SOCIÉTÉ|COMPANY", field: "company" },
    { x: 0, y: 20, w: 35, h: 13, label: "DESSINÉ|DRAWN", field: "drawnBy" },
    { x: 35, y: 20, w: 35, h: 13, label: "DATE|DATE", field: "date" },
    { x: 70, y: 20, w: 110, h: 13, label: "TITRE|TITLE", field: "title", size: 4.5, bold: true },
    { x: 0, y: 10, w: 70, h: 10, label: "MATÉRIAU|MATERIAL", field: "material" },
    { x: 70, y: 10, w: 20, h: 10, label: "FORMAT|SIZE", field: "size" },
    { x: 90, y: 10, w: 65, h: 10, label: "N° DE PLAN|DWG NO.", field: "reference", bold: true },
    { x: 155, y: 10, w: 25, h: 10, label: "RÉV.|REV", field: "revision" },
    { x: 0, y: 0, w: 70, h: 10, label: "FINITION|FINISH", field: "treatment" },
    { x: 70, y: 0, w: 35, h: 10, label: "ÉCHELLE|SCALE", field: "scale" },
    { x: 105, y: 0, w: 40, h: 10, label: "PROJECTION|PROJECTION", field: "projection" },
    { x: 145, y: 0, w: 35, h: 10, label: "FEUILLE|SHEET", field: "sheet" },
  ],
};

/** Built-in title block template of a standard. */
export const standardTitleBlock = (s: DrawingStandard): TitleBlockTemplate => (s === "ASME" ? ASME_TITLE_BLOCK : DEFAULT_TITLE_BLOCK);

export function cellLabel(label: string, lang: "fr" | "en"): string {
  const [fr, en] = label.split("|");
  return (lang === "en" ? en : fr) ?? fr ?? "";
}

export interface Revision {
  rev: string;
  date: string;
  description: string;
  author: string;
}

export interface TitleBlock {
  company: string;
  title: string;
  drawnBy: string;
  date: string;
  /** Fields taken from the part properties when they are empty here. */
  reference: string;
  material: string;
  revision: string;
  /** General tolerances ("ISO 2768-mK"...). */
  generalTolerance?: string;
  /** General roughness: criterion and value in µm ("Ra 3.2", "Rz 6.3"...). */
  roughness?: string;
  /** Surface or heat treatment ("Blackened", "White zinc plating"...). */
  treatment?: string;
  /** Paint: shade ("RAL 9005", "NCS S 2050-Y90R"...) and process ("Polyester powder"...). */
  paintColor?: string;
  paintSystem?: string;
  /** Custom fields, by key. */
  fields?: Record<string, string>;
  revisions?: Revision[];
  /** Logo (JPEG data URL) and its width / height ratio. */
  logo?: string;
  logoAspect?: number;
  /** Title block template (default: DEFAULT_TITLE_BLOCK). */
  template?: TitleBlockTemplate;
}

/** ISO 13715 edge condition: deviations (mm); positive = burr / overrun, negative = broken / undercut. */
export interface EdgeSpec {
  upper: string;
  lower?: string;
  /** External or internal edge. */
  internal?: boolean;
  /** Direction of the permitted burr (external edge): horizontal or vertical. */
  direction?: "h" | "v";
  allAround?: boolean;
}

export type GdtCharacteristic =
  | "straightness"
  | "flatness"
  | "circularity"
  | "cylindricity"
  | "lineProfile"
  | "surfaceProfile"
  | "parallelism"
  | "perpendicularity"
  | "angularity"
  | "position"
  | "concentricity"
  | "symmetry"
  | "circularRunout"
  | "totalRunout";

export const GDT_CHARACTERISTICS: GdtCharacteristic[] = [
  "straightness",
  "flatness",
  "circularity",
  "cylindricity",
  "lineProfile",
  "surfaceProfile",
  "parallelism",
  "perpendicularity",
  "angularity",
  "position",
  "concentricity",
  "symmetry",
  "circularRunout",
  "totalRunout",
];

export type WeldSymbol = "fillet" | "square" | "v" | "bevel" | "u" | "j" | "spot" | "plug" | "seam";

export interface WeldSide {
  symbol: WeldSymbol;
  /** Section dimension ("a5", "s8"). */
  size?: string;
  /** Length or "n×l (e)". */
  length?: string;
}

/** Anchor point and position common to all annotations. */
interface AnnotationBase {
  id: string;
  /** Attached view: `anchor` is then in the model coordinates of the view; otherwise in sheet mm. */
  view?: string;
  anchor: [number, number];
  /** Position of the text / symbol (sheet mm). */
  x: number;
  y: number;
  /** Anchor reference (edge, vertex, circle): the annotation follows the part. */
  ref?: GeoRef;
  /** The reference was not found again. */
  lost?: boolean;
}

export type DrawingAnnotation = AnnotationBase &
  (
    | { kind: "leader"; text: string }
    | { kind: "balloon"; item?: number; partId?: string }
    /** Hole dimension: circle (center = anchor, radius r in model mm), text recomputed unless forced. */
    /** `drill`: a tapped hole also shows its tap drill (only the thread by default, ISO 6410). */
    | { kind: "hole"; r: number; text?: string; drill?: boolean }
    | { kind: "datum"; letter: string }
    | { kind: "gdt"; characteristic: GdtCharacteristic; tolerance: string; diameter?: boolean; modifier?: string; datums: string[] }
    | {
        kind: "surface";
        value: string;
        removal: "any" | "required" | "prohibited";
        process?: string;
        lay?: string;
        allAround?: boolean;
      }
    | { kind: "weld"; arrow?: WeldSide; other?: WeldSide; allAround?: boolean; field?: boolean; tail?: string }
    | ({ kind: "edge" } & EdgeSpec)
  );

export type AnnotationKind = DrawingAnnotation["kind"];

export type EntityStyle = "visible" | "thin" | "axis" | "hidden";

/** Free drawing: sheet coordinates (mm), or model coordinates if attached to a view. */
export type DrawingEntity = { id: string; view?: string; style: EntityStyle } & (
  | { kind: "line"; pts: [number, number][] }
  | { kind: "polyline"; pts: [number, number][]; closed?: boolean }
  | { kind: "rect"; pts: [number, number][] }
  | { kind: "circle"; c: [number, number]; r: number }
  | { kind: "arc"; c: [number, number]; r: number; a0: number; a1: number }
  | { kind: "text"; at: [number, number]; text: string; size: number }
);

export interface DrawingTable {
  id: string;
  /** Top left corner (sheet mm). */
  x: number;
  y: number;
  cols: number[];
  rows: number[];
  cells: string[][];
  textSize: number;
}

export type BomColumn = "item" | "reference" | "designation" | "material" | "quantity" | "mass";

export interface DrawingBom {
  assemblyId: string;
  /** Bottom right corner (sheet mm); by default above the title block. */
  x?: number;
  y?: number;
  columns: BomColumn[];
}

export interface DrawingDocument {
  format: "cad.drawing";
  formatVersion: 1;
  id: string;
  name: string;
  /** Sheet; `grid`: zone referencing in the margin (ISO 5457), shown unless false. */
  sheet: { size: SheetSize; orientation: "landscape" | "portrait"; grid?: boolean };
  /** Projection convention: European (first angle, ISO E) or American (third angle). */
  projection: "first" | "third";
  /** Drafting standard (ISO when absent). */
  standard?: DrawingStandard;
  titleBlock: TitleBlock;
  views: DrawingView[];
  dimensions: DrawingDimension[];
  notes: DrawingNote[];
  annotations?: DrawingAnnotation[];
  sketch?: DrawingEntity[];
  tables?: DrawingTable[];
  bom?: DrawingBom;
  /** General ISO 13715 edge condition note (near the title block). */
  edgeDefault?: EdgeSpec;
  properties?: DocumentProperties;
}

/** ISO holes (mm): tap drill, clearance hole (ISO 273), counterbore ISO 4762, countersink ISO 10642 (90°). */
export const ISO_HOLES: Record<string, { tap: number; clear: number; cbD: number; cbH: number; cskD: number }> = {
  M3: { tap: 2.5, clear: 3.4, cbD: 6.5, cbH: 3.4, cskD: 6.9 },
  M4: { tap: 3.3, clear: 4.5, cbD: 8, cbH: 4.4, cskD: 9.2 },
  M5: { tap: 4.2, clear: 5.5, cbD: 10, cbH: 5.4, cskD: 11.5 },
  M6: { tap: 5, clear: 6.6, cbD: 11, cbH: 6.5, cskD: 13.7 },
  M8: { tap: 6.8, clear: 9, cbD: 15, cbH: 8.6, cskD: 18.3 },
  M10: { tap: 8.5, clear: 11, cbD: 18, cbH: 10.8, cskD: 22.7 },
  M12: { tap: 10.2, clear: 13.5, cbD: 20, cbH: 13, cskD: 27.2 },
  M16: { tap: 14, clear: 17.5, cbD: 26, cbH: 17.5, cskD: 33.9 },
  M20: { tap: 17.5, clear: 22, cbD: 33, cbH: 21.5, cskD: 40.7 },
  M24: { tap: 21, clear: 26, cbD: 40, cbH: 25.5, cskD: 48 },
};

/**
 * Thread standards of tapped holes: metric coarse (ISO 261), metric fine, pipe threads G (ISO 228-1) and
 * Rc (ISO 7-1, taper), NPT (ASME B1.20.1), unified UNC / UNF (ASME B1.1), or a custom metric thread.
 */
export type ThreadStandard = "M" | "MF" | "G" | "Rc" | "NPT" | "UNC" | "UNF" | "custom";

/** Thread sizes (mm): nominal (major) diameter and tap drill. */
type ThreadTable = Record<string, { major: number; tap: number }>;

// Pipe sizes and major diameter (an array: integer-like keys of an object would be reordered).
const PIPE: [string, number][] = [["1/8", 9.728], ["1/4", 13.157], ["3/8", 16.662], ["1/2", 20.955], ["3/4", 26.441], ["1", 33.249], ["1 1/4", 41.91], ["1 1/2", 47.803], ["2", 59.614]];
const table = (rows: [string, number, number][]): ThreadTable => Object.fromEntries(rows.map(([n, major, tap]) => [n, { major, tap }]));

export const THREADS: Record<Exclude<ThreadStandard, "custom">, ThreadTable> = {
  M: Object.fromEntries(Object.entries(ISO_HOLES).map(([n, h]) => [n, { major: Number(n.slice(1)), tap: h.tap }])),
  MF: table([
    ["M6×0.75", 6, 5.2], ["M8×1", 8, 7], ["M10×1", 10, 9], ["M10×1.25", 10, 8.8], ["M12×1.25", 12, 10.8], ["M12×1.5", 12, 10.5],
    ["M14×1.5", 14, 12.5], ["M16×1.5", 16, 14.5], ["M18×1.5", 18, 16.5], ["M20×1.5", 20, 18.5], ["M22×1.5", 22, 20.5], ["M24×1.5", 24, 22.5], ["M24×2", 24, 22],
  ]),
  G: table(PIPE.map(([n, d], i) => [`G${n}`, d, [8.8, 11.8, 15.25, 19, 24.5, 30.75, 39.5, 45.25, 57][i]!])),
  Rc: table(PIPE.map(([n, d], i) => [`Rc${n}`, d, [8.4, 11.2, 14.75, 18.25, 23.75, 30, 38.5, 44.5, 56][i]!])),
  NPT: table([
    ["1/8-27 NPT", 10.287, 8.7], ["1/4-18 NPT", 13.716, 11.1], ["3/8-18 NPT", 17.145, 14.5], ["1/2-14 NPT", 21.336, 18],
    ["3/4-14 NPT", 26.67, 23], ["1-11.5 NPT", 33.401, 29], ["1 1/4-11.5 NPT", 42.164, 38], ["1 1/2-11.5 NPT", 48.26, 44.5], ["2-11.5 NPT", 60.325, 56],
  ]),
  UNC: table([
    ["#4-40 UNC", 2.845, 2.35], ["#6-32 UNC", 3.505, 2.85], ["#8-32 UNC", 4.166, 3.5], ["#10-24 UNC", 4.826, 3.9], ["1/4-20 UNC", 6.35, 5.1],
    ["5/16-18 UNC", 7.938, 6.6], ["3/8-16 UNC", 9.525, 8], ["7/16-14 UNC", 11.113, 9.4], ["1/2-13 UNC", 12.7, 10.8], ["5/8-11 UNC", 15.875, 13.5],
    ["3/4-10 UNC", 19.05, 16.5], ["1-8 UNC", 25.4, 22.25],
  ]),
  UNF: table([
    ["#10-32 UNF", 4.826, 4.1], ["1/4-28 UNF", 6.35, 5.5], ["5/16-24 UNF", 7.938, 6.9], ["3/8-24 UNF", 9.525, 8.5], ["7/16-20 UNF", 11.113, 9.9],
    ["1/2-20 UNF", 12.7, 11.5], ["5/8-18 UNF", 15.875, 14.5], ["3/4-16 UNF", 19.05, 17.5], ["1-12 UNF", 25.4, 23.25],
  ]),
};

/** Parameter holding the size of each thread standard in a hole feature (metric coarse keeps `size`). */
export const THREAD_SIZE_KEY: Record<Exclude<ThreadStandard, "custom">, string> = {
  M: "size",
  MF: "sizeMF",
  G: "sizeG",
  Rc: "sizeRc",
  NPT: "sizeNPT",
  UNC: "sizeUNC",
  UNF: "sizeUNF",
};

/**
 * Thread of a tapped hole feature: designation, nominal diameter and tap drill (mm). `num` evaluates a length
 * parameter (custom thread: nominal diameter `threadD` and pitch `threadPitch`, tap drill = D − P).
 */
export function holeThread(params: Record<string, string | undefined>, num: (key: string) => number): { name: string; major: number; tap: number } | null {
  const std = (params.thread ?? "M") as ThreadStandard;
  if (std === "custom") {
    const d = num("threadD");
    const p = num("threadPitch");
    if (!(d > 0) || !(p > 0) || p >= d) return null;
    const f = (v: number) => String(Math.round(v * 1000) / 1000);
    return { name: `M${f(d)}×${f(p)}`, major: d, tap: Math.round((d - p) * 1000) / 1000 };
  }
  const tableOf = THREADS[std];
  if (!tableOf) return null;
  const name = params[THREAD_SIZE_KEY[std]] ?? (std === "M" ? "M6" : Object.keys(tableOf)[Math.min(2, Object.keys(tableOf).length - 1)]!);
  const t = tableOf[name];
  return t ? { name, ...t } : null;
}

export function createDrawingDocument(name: string): DrawingDocument {
  return {
    format: "cad.drawing",
    formatVersion: 1,
    id: newId(),
    name,
    sheet: { size: "A3", orientation: "landscape" },
    projection: "first",
    titleBlock: { company: "", title: name, drawnBy: "", date: new Date().toISOString().slice(0, 10), reference: "", material: "", revision: "" },
    views: [],
    dimensions: [],
    notes: [],
  };
}

export function sheetDimensions(d: Pick<DrawingDocument, "sheet">): [number, number] {
  const [w, h] = SHEET_SIZES[d.sheet.size] ?? SHEET_SIZES.A3;
  return d.sheet.orientation === "landscape" ? [w, h] : [h, w];
}

/** Standard scales (ISO 5455). */
export const STANDARD_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100];

export function scaleLabel(s: number): string {
  return s >= 1 ? `${Math.round(s)}:1` : `1:${Math.round(1 / s)}`;
}

/** Projection of a view computed by the kernel. */
export interface ProjectedView {
  /** Visible segments, as pairs of 2D points (x1, y1, x2, y2, ...), model coordinates. */
  visible: Float32Array;
  hidden: Float32Array;
  /** Recognized visible circles and arcs: (cx, cy, r) repeated. */
  circles: Float32Array;
  /** Bounding box [xmin, ymin, xmax, ymax]. */
  bounds: [number, number, number, number];
  /** Section view: contours of the cut faces, per occurrence (2D segments, to hatch). */
  hatches?: { key: string; segments: Float32Array }[];
  /** Unfolded view: bend lines and their annotation (direction, angle). */
  bends?: { x1: number; y1: number; x2: number; y2: number; text: string }[];
}

/** Occurrence projected in a view: placed part, optionally excluded from the cut (shafts, screws...). */
export interface SceneItem {
  key: string;
  doc: import("./document.ts").PartDocument;
  /** 4×4 matrix, column-major. */
  matrix: number[];
  /** Cut by the section plane (true by default). */
  cut?: boolean;
}

/** View to project; `section.depth`: position of the section plane along the viewing direction (mm). */
export interface SceneView {
  kind: ViewKind;
  section?: { depth: number };
}

type V3 = [number, number, number];

/** Direction toward the observer (n) and horizontal axis (x) of each standard view. */
const VIEW_AXES_RAW: Record<ViewKind, { n: V3; x: V3 }> = {
  front: { n: [0, -1, 0], x: [1, 0, 0] },
  back: { n: [0, 1, 0], x: [-1, 0, 0] },
  top: { n: [0, 0, 1], x: [1, 0, 0] },
  bottom: { n: [0, 0, -1], x: [1, 0, 0] },
  right: { n: [1, 0, 0], x: [0, 1, 0] },
  left: { n: [-1, 0, 0], x: [0, -1, 0] },
  iso: { n: [1, -1, 1], x: [1, 1, 0] },
};

const unit = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Standard frame of a view: n (toward the observer), x and y of the projection (y = n × x). */
export function viewAxes(kind: ViewKind): { n: V3; x: V3; y: V3 } {
  const n = unit(VIEW_AXES_RAW[kind].n);
  const x = unit(VIEW_AXES_RAW[kind].x);
  return { n, x, y: [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]] };
}

/** Standard view whose viewing direction is `n` (within 1e-6), if any. */
export function viewKindFor(n: V3): ViewKind | undefined {
  return (Object.keys(VIEW_AXES_RAW) as ViewKind[]).find((k) => {
    const a = viewAxes(k).n;
    return Math.abs(a[0] - n[0]) + Math.abs(a[1] - n[1]) + Math.abs(a[2] - n[2]) < 1e-6;
  });
}
