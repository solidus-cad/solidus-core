import type { PartDocument } from "./document.ts";
import type { SkGeometry } from "./sketch.ts";
import type { ProjectedView, SceneItem, SceneView, ViewKind } from "./drawing.ts";

/**
 * Mesh returned by the kernel, ready to load into a BufferGeometry.
 * Groups = triplets [start, count, identifier]:
 *  - faceGroups: indexed into `indices`;
 *  - edgeGroups: indexed into the points of `edges` (segments, two points per segment).
 */
export interface MeshPayload {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceGroups: Int32Array;
  edges: Float32Array;
  edgeGroups: Int32Array;
  /**
   * Stable topological names (core/NAMING.md), indexed by mesh identifier: `faces[faceGroups[3k + 2]]`,
   * `edges[edgeGroups[3k + 2]]`. Provided by cad-core; absent with a kernel without naming.
   */
  names?: { faces: string[]; edges: string[] };
  /**
   * Bodies of the part (multi-body), in creation order: their faces and edges have contiguous mesh identifiers,
   * `[first, count]`. Provided by cad-core.
   */
  bodies?: MeshBody[];
  /** Identifiers (3rd value of the `edgeGroups` triplets) of the free edges: surface boundaries. */
  freeEdges?: number[];
}

export interface MeshBody {
  /** Body identifier (that of the feature which created it). */
  id: string;
  faces: [number, number];
  edges: [number, number];
  /** Body kind: closed volume, or surface (open shell, shown double-sided). Absent: solid. */
  kind?: "solid" | "surface";
  /** Body used by a feature (thickened surface, cutting tool...): hidden by default in the view. */
  consumed?: boolean;
}

export type FeatureStatus =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string };

export interface MassProperties {
  volume: number;
  area: number;
  center: [number, number, number];
  /**
   * Moments of inertia of the volume (density 1, mm⁵) at the center of gravity, axes parallel to the absolute frame.
   * Products of inertia in the sense ∫xy dV (the tensor has −xy off the diagonal). Multiplying by the density
   * gives the mass inertia. Absent if the kernel does not compute it.
   */
  inertia?: Inertia;
  /** Properties of each body when the part has several (the fields above are then their sum). */
  bodies?: { id: string; volume: number; area: number; center: [number, number, number] }[];
}

/** Moments (xx, yy, zz) and products (xy, xz, yz) of inertia. */
export interface Inertia {
  xx: number;
  yy: number;
  zz: number;
  xy: number;
  xz: number;
  yz: number;
}

/** Sketch as solved by the kernel (with the global parameters up to date). */
export interface SketchSolveInfo {
  geometry: SkGeometry[];
  dof: number;
  conflicting: string[];
  redundant: string[];
}

export interface RecomputeResult {
  statuses: FeatureStatus[];
  sketches: Record<string, SketchSolveInfo>;
  parameterErrors: Record<string, string>;
  mesh: MeshPayload | null;
  mass: MassProperties | null;
  /**
   * Feature that created each mesh face (rank k of the `faceGroups[3k…]` triplet), null if unknown.
   * The kernel may restrict itself to the features that have a color (`doc.appearance.features`).
   */
  faceFeatures?: (string | null)[];
  /** Number of features actually recomputed (the others come from the cache). */
  rebuilt: number;
  /** Active body at the end of the recompute: default target of a new feature (absent without bodies, or with an old kernel). */
  activeBody?: string;
  /** Bodies of the part at the end of the recompute, in creation order (the mesh may show an earlier state). */
  partBodies?: string[];
  /** Bodies of the part and active body just before the feature RecomputeOptions.bodiesBefore (if requested and reached). */
  bodiesBefore?: { bodies: string[]; active: string };
  ms: number;
}

export type ExportFormat = "step" | "stl";

/** Occurrence of a placed part (assembly), for computations that involve several parts. */
export interface PlacedPart {
  key: string;
  doc: PartDocument;
  /** 4×4 matrix, column-major. */
  matrix: number[];
}

/** Interference between two occurrences: common volume (mm³). */
export interface Interference {
  a: string;
  b: string;
  volume: number;
}

export interface RecomputeOptions {
  /**
   * Display the body as it is BEFORE this feature (id), while computing the full tree
   * (statuses, mass properties). Used to pick the original edges or faces of a fillet, a shell...
   */
  meshBefore?: string;
  /** Also read the bodies as they are BEFORE this feature (id): those it can target while being edited. */
  bodiesBefore?: string;
}

/** Curvature shown by the surface analysis (mm⁻¹; mm⁻² for the Gaussian curvature). */
export type CurvatureKind = "gaussian" | "mean" | "min" | "max";

/** Deviations between the two faces of an edge at a point of it: distance (mm), angle of the normals (°), curvature gap (mm⁻¹). */
export interface ContinuitySample {
  p: [number, number, number];
  g0: number;
  g1: number;
  g2: number;
}

/** Single interface to the kernel: Web Worker (WASM) on the web, Tauri IPC (native) on the desktop. */
export interface KernelClient {
  readonly ready: Promise<void>;
  recompute(doc: PartDocument, opts?: RecomputeOptions): Promise<RecomputeResult>;
  /** Exports the last computed shape of the document `docId` (by default: the last recomputed). */
  exportShape(format: ExportFormat, docId?: string): Promise<Uint8Array>;
  /** Exports several placed parts into a single file (assembly, optional depending on the kernel). The parts are recomputed. */
  exportPlaced?(format: ExportFormat, parts: PlacedPart[]): Promise<Uint8Array>;
  /**
   * Fine mesh of the body of `doc` for CAM (3D toolpaths): linear deflection `deflection` in mm, independent
   * of the display mesh. Optional: without it, CAM uses the display mesh.
   */
  camMesh?(doc: PartDocument, deflection: number): Promise<MeshPayload | null>;
  /** Interference detection between placed occurrences (optional depending on the kernel). */
  interferences?(parts: PlacedPart[]): Promise<Interference[]>;
  /** Drawing: projections with hidden lines of the requested views (optional depending on the kernel). */
  project?(doc: PartDocument, views: ViewKind[]): Promise<ProjectedView[]>;
  /** Drawing of a scene (several placed parts), with optional section (optional depending on the kernel). */
  projectScene?(items: SceneItem[], views: SceneView[]): Promise<ProjectedView[]>;
  /** Sheet metal: flat pattern of the part (optional depending on the kernel). */
  flatPattern?(doc: PartDocument): Promise<FlatPattern>;
  /**
   * Curvature at each vertex of the display mesh of the last recompute of `doc` (`positions` order), NaN where it is not
   * defined (optional depending on the kernel).
   */
  surfaceAnalysis?(doc: PartDocument, kind: CurvatureKind): Promise<Float32Array>;
  /** Continuity along an edge (topological name) between its two faces, at points spread along it (optional). */
  continuity?(doc: PartDocument, edge: string): Promise<ContinuitySample[]>;
  /** Frees the cached results of a closed document (optional depending on the kernel). */
  forget?(docId: string): void;
  /**
   * Feature that created a face of the last recompute of the document (null: unknown).
   * `faceId`: mesh face identifier (`faceGroups[3k + 2]`); `point`: point picked on the face.
   * cad-core reads the topological name of the face; the OCCT TypeScript kernel, which has no naming, infers it from the point.
   */
  featureAt?(docId: string, faceId: number, point: [number, number, number]): Promise<string | null>;
  dispose(): void;
}

export type KernelRequest =
  | { id: number; kind: "recompute"; doc: PartDocument; opts?: RecomputeOptions }
  | { id: number; kind: "export"; format: ExportFormat; docId?: string };

/** Additional requests (kernels that support them). */
export type KernelRequestExt =
  | KernelRequest
  | { id: number; kind: "interferences"; parts: PlacedPart[] }
  | { id: number; kind: "exportPlaced"; format: ExportFormat; parts: PlacedPart[] }
  | { id: number; kind: "project"; doc: PartDocument; views: ViewKind[] }
  | { id: number; kind: "projectScene"; items: SceneItem[]; views: SceneView[] }
  | { id: number; kind: "flatPattern"; doc: PartDocument }
  | { id: number; kind: "camMesh"; doc: PartDocument; deflection: number }
  | { id: number; kind: "surfaceAnalysis"; doc: PartDocument; analysis: CurvatureKind }
  | { id: number; kind: "continuity"; doc: PartDocument; edge: string }
  | { id: number; kind: "forget"; docId: string }
  | { id: number; kind: "featureAt"; docId: string; faceId: number; point: [number, number, number] };

/** Feature of origin of a face, from its topological name (`feature/role…`, see core/NAMING.md). */
export function featureOfFaceName(name: string | undefined): string | null {
  const i = name ? name.indexOf("/") : -1;
  return i > 0 ? name!.slice(0, i) : null;
}

/** Flat pattern of a sheet, in the frame of the base sheet (mm). */
export interface FlatPattern {
  /** Outer contour and cutouts: 2D segments (x1, y1, x2, y2, …). */
  outline: Float32Array;
  /** Recognized circles and arcs: (cx, cy, r) repeated. */
  circles: Float32Array;
  /** Bend lines (middle of the bent zone), angle in degrees, direction as seen from above the pattern. */
  bends: { x1: number; y1: number; x2: number; y2: number; angle: number; up: boolean }[];
  bounds: [number, number, number, number];
  thickness: number;
  radius: number;
  kFactor: number;
}

export type KernelResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
