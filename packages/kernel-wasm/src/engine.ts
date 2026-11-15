import {
  featureOfFaceName,
  type ExportFormat,
  type FeatureStatus,
  type ContinuitySample,
  type CurvatureKind,
  type FlatPattern,
  type Interference,
  type PlacedPart,
  type ProjectedView,
  type SceneItem,
  type SceneView,
  type ViewKind,
  type MassProperties,
  type MeshBody,
  type MeshPayload,
  type PartDocument,
  type RecomputeOptions,
  type RecomputeResult,
} from "@solidus-cad/sdk";
import type { SketchSolver } from "@solidus-cad/sketch";
import { loadKernelModule, type KernelModule, type NativeKernel } from "./module.ts";
import { prepareDocument, SketchPreparer, type DeferredResult, type Preparation } from "./prepare.ts";

/** Raw result of cad-core (Engine::recompute, core/document/engine.cpp). */
export interface CoreResult {
  statuses: FeatureStatus[];
  mass: MassProperties | null;
  rebuilt: number;
  ms: number;
  timings: { features: number; mesh: number; mass: number; names: number };
  topology: { faces: string[]; edges: string[] };
  /** Mesh bodies (absent from a kernel prior to multi-body support). */
  bodies?: MeshBody[];
  freeEdges?: number[];
  activeBody?: string;
  partBodies?: string[];
  bodiesBefore?: { bodies: string[]; active: string };
}

/**
 * Topological names of the body, aligned with the mesh identifiers:
 * faces[faceGroups[3k + 2]] and edges[edgeGroups[3k + 2]]. See core/NAMING.md.
 */
export interface TopologyNames {
  faces: string[];
  edges: string[];
}

/** RecomputeResult, plus what cad-core provides in addition (see core/CONCEPTION.md, "Protocol"). */
export interface WasmRecomputeResult extends RecomputeResult {
  topology: TopologyNames;
  /** Time spent in the C++ kernel (ms), per step. */
  timings: CoreResult["timings"] & { prepare: number };
}

/** Mesh as returned by the kernel, before names are added. */
export type CoreMesh = Omit<MeshPayload, "names">;

/**
 * Deferred preparation: completes the function `id` with the data of the current body sent by the kernel.
 * Never throws: an error is returned to the kernel, which reports it on the function.
 */
export function completeDeferred(prep: Preparation, id: string, payload: unknown): DeferredResult {
  const complete = prep.deferred.get(id);
  if (!complete) return { error: "Préparation différée inconnue" };
  try {
    return complete(payload as Parameters<typeof complete>[0]);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** RecomputeResult from the preparation and the kernel result (WASM or native). */
export function assembleResult(prep: Preparation, core: CoreResult, coreMesh: CoreMesh | null, t0: number, t1: number): WasmRecomputeResult {
  // Topological names: the viewer joins them to the designated references (GeomRef.name).
  const mesh: MeshPayload | null = coreMesh && {
    ...coreMesh,
    names: core.topology,
    ...(core.bodies ? { bodies: core.bodies } : {}),
    ...(core.freeEdges?.length ? { freeEdges: core.freeEdges } : {}),
  };
  const ok = new Set(core.statuses.filter((s) => s.ok).map((s) => s.id));
  const sketches = Object.fromEntries(Object.entries(prep.sketches).filter(([id]) => ok.has(id)));
  return {
    statuses: core.statuses,
    sketches,
    parameterErrors: prep.parameterErrors,
    mesh,
    // Faces named "feature/role": the originating feature is read from the name (face id = 3rd value of the triplet).
    faceFeatures: mesh ? Array.from({ length: mesh.faceGroups.length / 3 }, (_, k) => featureOfFaceName(core.topology.faces[mesh.faceGroups[k * 3 + 2]!])) : undefined,
    mass: core.mass,
    rebuilt: core.rebuilt,
    ...(core.activeBody ? { activeBody: core.activeBody } : {}),
    ...(core.partBodies ? { partBodies: core.partBodies } : {}),
    ...(core.bodiesBefore ? { bodiesBefore: core.bodiesBefore } : {}),
    ms: performance.now() - t0,
    topology: core.topology,
    timings: { ...core.timings, prepare: t1 - t0 },
  };
}

/**
 * cad-core engine (C++ compiled to WASM): recompute(doc) → RecomputeResult, exportShape(format) → file.
 */
export class WasmKernelEngine {
  private readonly kernel: NativeKernel;
  private readonly sketches: SketchPreparer;
  /** Face names from the last recompute of each document (mesh identifier → name). */
  private readonly faceNames = new Map<string, string[]>();

  constructor(module: KernelModule, solver: SketchSolver) {
    this.kernel = new module.Kernel();
    this.sketches = new SketchPreparer(solver);
  }

  static async create(solver: SketchSolver, wasmUrl?: string): Promise<WasmKernelEngine> {
    return new WasmKernelEngine(await loadKernelModule(wasmUrl), solver);
  }

  recompute(doc: PartDocument, opts: RecomputeOptions = {}): WasmRecomputeResult {
    const t0 = performance.now();
    const prep = prepareDocument(doc, this.sketches, { meshBefore: opts.meshBefore, bodiesBefore: opts.bodiesBefore });
    const t1 = performance.now();
    // Deferred preparation: the kernel calls back the client with the data of the current body (projected edges).
    const resolve = (id: string, payload: string): string => JSON.stringify(completeDeferred(prep, id, JSON.parse(payload)));
    const core = JSON.parse(this.kernel.recompute(JSON.stringify(prep.input), resolve)) as CoreResult;
    // Mesh of the displayed body (meshBefore: body before a feature, possibly empty).
    const views = this.kernel.mesh();
    // Single copy, from WASM memory to buffers transferable to the interface thread.
    const mesh: CoreMesh | null = views && {
      positions: views.positions.slice(),
      normals: views.normals.slice(),
      indices: views.indices.slice(),
      faceGroups: views.faceGroups.slice(),
      edges: views.edges.slice(),
      edgeGroups: views.edgeGroups.slice(),
    };
    this.faceNames.set(doc.id ?? "", core.topology.faces);
    return assembleResult(prep, core, mesh, t0, t1);
  }

  /** Fine mesh of the document body (CAM): the document is recomputed (cached), then meshed at the requested deflection. */
  camMesh(doc: PartDocument, deflection: number): MeshPayload | null {
    this.recompute(doc);
    const views = this.kernel.camMesh(doc.id ?? "", deflection);
    return (
      views && {
        positions: views.positions.slice(),
        normals: views.normals.slice(),
        indices: views.indices.slice(),
        faceGroups: views.faceGroups.slice(),
        edges: views.edges.slice(),
        edgeGroups: views.edgeGroups.slice(),
      }
    );
  }

  /** Exports the latest shape of document `docId` (default: the last recomputed one). */
  exportShape(format: ExportFormat, docId?: string): Uint8Array {
    return this.kernel.exportShape(format, docId ?? null).slice();
  }

  /** Recomputes each distinct document once: the shapes used always match the content received. */
  private recomputeAll(docs: PartDocument[]): void {
    const done = new Set<string>();
    for (const d of docs) {
      const id = d.id ?? "";
      if (done.has(id)) continue;
      this.recompute(d);
      done.add(id);
    }
  }

  /** Exports several placed parts into a single file (assembly). */
  exportPlaced(format: ExportFormat, parts: PlacedPart[]): Uint8Array {
    this.recomputeAll(parts.map((p) => p.doc));
    return this.kernel.exportPlaced(format, parts.map((p) => ({ key: p.key, docId: p.doc.id ?? "", matrix: p.matrix }))).slice();
  }

  /** Interferences between occurrences: common volume of each pair whose bounding boxes overlap. */
  interferences(parts: PlacedPart[]): Interference[] {
    this.recomputeAll(parts.map((p) => p.doc));
    return this.kernel.interferences(parts.map((p) => ({ key: p.key, docId: p.doc.id ?? "", matrix: p.matrix })));
  }

  /** Projected views of a part (drawing). */
  project(doc: PartDocument, views: ViewKind[]): ProjectedView[] {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return this.projectScene([{ key: doc.id ?? "", doc, matrix: identity }], views.map((kind) => ({ kind })));
  }

  /** Views of a scene (part or assembly): HLR of all placed parts, with an optional section. */
  projectScene(items: SceneItem[], views: SceneView[]): ProjectedView[] {
    this.recomputeAll(items.map((i) => i.doc));
    return this.kernel.projectScene(
      items.map((i) => ({ key: i.key, docId: i.doc.id ?? "", matrix: i.matrix, cut: i.cut !== false })),
      views,
    );
  }

  /** Sheet metal: flat pattern of the document (outline, holes and bend lines). */
  flatPattern(doc: PartDocument): FlatPattern {
    this.recompute(doc);
    return this.kernel.flatPattern(doc.id ?? "");
  }

  /** Memory of the kernel module (leak checks, diagnostics). */
  memory(): { used: number; heap: number } {
    return this.kernel.memory();
  }

  /** Curvature at each vertex of the display mesh of the document (recomputed first, from the cache). */
  surfaceAnalysis(doc: PartDocument, kind: CurvatureKind): Float32Array {
    this.recompute(doc);
    return this.kernel.surfaceAnalysis(doc.id ?? "", kind);
  }

  /** Continuity along an edge (topological name) between its two faces. */
  continuity(doc: PartDocument, edge: string): ContinuitySample[] {
    this.recompute(doc);
    return this.kernel.continuity(doc.id ?? "", edge);
  }

  /** Frees the cache of a closed document. */
  forget(docId: string): void {
    this.kernel.forget(docId);
    this.faceNames.delete(docId);
  }

  /** Frees the least recent documents beyond the kernel limit (between two requests). */
  trim(): void {
    this.kernel.trim();
  }

  /** Feature that created face `faceId` in the last recompute of the document: prefix of its topological name. */
  featureAt(docId: string, faceId: number): string | null {
    return featureOfFaceName(this.faceNames.get(docId)?.[faceId]);
  }

  /** Mesh identifier of a face or edge of the document designated by its topological name (-1 if it no longer exists). */
  resolveName(docId: string, name: string): number {
    return this.kernel.resolveName(name, docId);
  }

  dispose(): void {
    this.kernel.delete();
  }
}
