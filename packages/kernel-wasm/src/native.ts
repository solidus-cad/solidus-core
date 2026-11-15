import {
  featureOfFaceName,
  type ExportFormat,
  type ContinuitySample,
  type CurvatureKind,
  type FlatPattern,
  type Interference,
  type KernelClient,
  type MeshPayload,
  type PartDocument,
  type PlacedPart,
  type ProjectedView,
  type RecomputeOptions,
  type RecomputeResult,
  type SceneItem,
  type SceneView,
  type ViewKind,
} from "@solidus-cad/sdk";
import type { SketchSolver } from "@solidus-cad/sketch";
import { assembleResult, completeDeferred, type CoreMesh, type CoreResult, type WasmRecomputeResult } from "./engine.ts";
import { prepareDocument, SketchPreparer } from "./prepare.ts";

/**
 * Native cad-core (desktop application): the kernel runs in a separate process, `cad-kernel`
 * (bindings/native/kernel_main.cpp), driven by frames over stdin / stdout. The preparation (expressions, PlaneGCS,
 * catalogs) stays in TypeScript, as for WASM: same results, same messages.
 *
 * Deferred preparation (body edges projected into a sketch): during a recompute, the kernel sends a "callback"
 * frame; the client resolves the sketch and replies with a "reply" frame, then the kernel resumes. The transport
 * remains a simple request → response exchange: `exchange(frame)` returns the kernel's next frame.
 */

/** Sends a JSON frame to the kernel and returns its next frame (result, callback or error). */
export type Exchange = (frame: string) => Promise<ArrayBuffer | Uint8Array>;

type Typed = Float32Array | Uint32Array | Int32Array | Uint8Array;

interface Header {
  type: "result" | "callback" | "error";
  message?: string;
  featureId?: string;
  payload?: unknown;
  value?: unknown;
  buffers?: { name: string; type: "f32" | "u32" | "i32" | "u8"; length: number }[];
  [key: string]: unknown;
}

interface Frame {
  header: Header;
  buffers: Record<string, Typed>;
}

/** Decodes a kernel frame: [u32 header length][JSON header][4-byte padding][binary arrays]. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): Frame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as Header;
  let offset = (4 + headerLength + 3) & ~3;
  const buffers: Record<string, Typed> = {};
  for (const b of header.buffers ?? []) {
    const size = b.type === "u8" ? 1 : 4;
    // Copy into a new buffer: guarantees alignment and transferability.
    const chunk = bytes.slice(offset, offset + b.length * size).buffer;
    buffers[b.name] = b.type === "f32" ? new Float32Array(chunk) : b.type === "u32" ? new Uint32Array(chunk) : b.type === "i32" ? new Int32Array(chunk) : new Uint8Array(chunk);
    offset += b.length * size;
  }
  return { header, buffers };
}

const f32 = (v: unknown) => Float32Array.from((v as number[] | undefined) ?? []);

function projectedView(v: Record<string, unknown>): ProjectedView {
  const out: ProjectedView = { visible: f32(v.visible), hidden: f32(v.hidden), circles: f32(v.circles), bounds: v.bounds as ProjectedView["bounds"] };
  if (Array.isArray(v.hatches)) out.hatches = (v.hatches as { key: string; segments: number[] }[]).map((h) => ({ key: h.key, segments: f32(h.segments) }));
  return out;
}

/**
 * Native cad-core engine: same contract as WasmKernelEngine, asynchronous. Requests are serialized (only one
 * in progress in the kernel process, callbacks included).
 */
export class NativeKernelEngine {
  private readonly sketches: SketchPreparer;
  private readonly faceNames = new Map<string, string[]>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly exchange: Exchange,
    solver: SketchSolver,
  ) {
    this.sketches = new SketchPreparer(solver);
  }

  /** Runs `fn` once the previous requests have completed. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Simple request (no callback): kernel result or error. */
  private async call(kind: string, body: Record<string, unknown> = {}): Promise<Frame> {
    const frame = decodeFrame(await this.exchange(JSON.stringify({ type: "request", kind, ...body })));
    if (frame.header.type === "error") throw new Error(frame.header.message ?? "Erreur du noyau");
    if (frame.header.type !== "result") throw new Error(`Trame inattendue du noyau : ${frame.header.type}`);
    return frame;
  }

  /** Checks that the kernel process responds. */
  ping(): Promise<string> {
    return this.serial(async () => (await this.call("ping")).header.value as string);
  }

  recompute(doc: PartDocument, opts: RecomputeOptions = {}): Promise<WasmRecomputeResult> {
    return this.serial(() => this.recomputeNow(doc, opts));
  }

  private async recomputeNow(doc: PartDocument, opts: RecomputeOptions = {}): Promise<WasmRecomputeResult> {
    const t0 = performance.now();
    const prep = prepareDocument(doc, this.sketches, { meshBefore: opts.meshBefore, bodiesBefore: opts.bodiesBefore });
    const t1 = performance.now();
    let frame = decodeFrame(await this.exchange(JSON.stringify({ type: "request", kind: "recompute", input: prep.input })));
    // Deferred preparation: the kernel waits for the reply before continuing the recompute.
    while (frame.header.type === "callback") {
      const result = completeDeferred(prep, frame.header.featureId ?? "", frame.header.payload);
      frame = decodeFrame(await this.exchange(JSON.stringify({ type: "reply", result })));
    }
    if (frame.header.type === "error") throw new Error(frame.header.message ?? "Erreur du noyau");
    const core = frame.header as unknown as CoreResult;
    const b = frame.buffers;
    const mesh: CoreMesh | null = b.indices
      ? {
          positions: b.positions as Float32Array,
          normals: b.normals as Float32Array,
          indices: b.indices as Uint32Array,
          faceGroups: b.faceGroups as Int32Array,
          edges: b.edges as Float32Array,
          edgeGroups: b.edgeGroups as Int32Array,
        }
      : null;
    this.faceNames.set(doc.id ?? "", core.topology.faces);
    return assembleResult(prep, core, mesh, t0, t1);
  }

  exportShape(format: ExportFormat, docId?: string): Promise<Uint8Array> {
    return this.serial(async () => (await this.call("export", { format, docId: docId ?? null })).buffers.data as Uint8Array);
  }

  /** Fine mesh of the document body (CAM): recompute (kernel cache), then meshing at the requested deflection. */
  camMesh(doc: PartDocument, deflection: number): Promise<MeshPayload | null> {
    return this.serial(async () => {
      await this.recomputeNow(doc);
      const b = (await this.call("camMesh", { docId: doc.id ?? "", deflection })).buffers;
      if (!b.indices) return null;
      return {
        positions: b.positions as Float32Array,
        normals: b.normals as Float32Array,
        indices: b.indices as Uint32Array,
        faceGroups: b.faceGroups as Int32Array,
        edges: b.edges as Float32Array,
        edgeGroups: b.edgeGroups as Int32Array,
      };
    });
  }

  /** Recomputes each distinct document once: the shapes used always match the content received. */
  private async recomputeAll(docs: PartDocument[]): Promise<void> {
    const done = new Set<string>();
    for (const d of docs) {
      const id = d.id ?? "";
      if (done.has(id)) continue;
      await this.recomputeNow(d);
      done.add(id);
    }
  }

  exportPlaced(format: ExportFormat, parts: PlacedPart[]): Promise<Uint8Array> {
    return this.serial(async () => {
      await this.recomputeAll(parts.map((p) => p.doc));
      const r = await this.call("exportPlaced", { format, parts: parts.map((p) => ({ key: p.key, docId: p.doc.id ?? "", matrix: p.matrix })) });
      return r.buffers.data as Uint8Array;
    });
  }

  interferences(parts: PlacedPart[]): Promise<Interference[]> {
    return this.serial(async () => {
      await this.recomputeAll(parts.map((p) => p.doc));
      const r = await this.call("interferences", { parts: parts.map((p) => ({ key: p.key, docId: p.doc.id ?? "", matrix: p.matrix })) });
      return r.header.value as Interference[];
    });
  }

  project(doc: PartDocument, views: ViewKind[]): Promise<ProjectedView[]> {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return this.projectScene([{ key: doc.id ?? "", doc, matrix: identity }], views.map((kind) => ({ kind })));
  }

  projectScene(items: SceneItem[], views: SceneView[]): Promise<ProjectedView[]> {
    return this.serial(async () => {
      await this.recomputeAll(items.map((i) => i.doc));
      const r = await this.call("projectScene", {
        items: items.map((i) => ({ key: i.key, docId: i.doc.id ?? "", matrix: i.matrix, cut: i.cut !== false })),
        views,
      });
      return (r.header.value as Record<string, unknown>[]).map(projectedView);
    });
  }

  flatPattern(doc: PartDocument): Promise<FlatPattern> {
    return this.serial(async () => {
      await this.recomputeNow(doc);
      const v = (await this.call("flatPattern", { docId: doc.id ?? "" })).header.value as Record<string, unknown>;
      return { ...(v as unknown as FlatPattern), outline: f32(v.outline), circles: f32(v.circles) };
    });
  }

  surfaceAnalysis(doc: PartDocument, kind: CurvatureKind): Promise<Float32Array> {
    return this.serial(async () => {
      await this.recomputeNow(doc);
      return (await this.call("surfaceAnalysis", { docId: doc.id ?? "", analysis: kind })).buffers.values as Float32Array;
    });
  }

  continuity(doc: PartDocument, edge: string): Promise<ContinuitySample[]> {
    return this.serial(async () => {
      await this.recomputeNow(doc);
      return (await this.call("continuity", { docId: doc.id ?? "", edge })).header.value as ContinuitySample[];
    });
  }

  forget(docId: string): Promise<void> {
    this.faceNames.delete(docId);
    return this.serial(async () => void (await this.call("forget", { docId })));
  }

  trim(): Promise<void> {
    return this.serial(async () => void (await this.call("trim")));
  }

  resolveName(docId: string, name: string): Promise<number> {
    return this.serial(async () => (await this.call("resolveName", { docId, name })).header.value as number);
  }

  featureAt(docId: string, faceId: number): string | null {
    return featureOfFaceName(this.faceNames.get(docId)?.[faceId]);
  }
}

/**
 * KernelClient of the desktop application, on native cad-core. As with the Worker clients, recomputations requested
 * while another one is in progress are merged per document: only the most recent one is computed.
 */
export class NativeKernelClient implements KernelClient {
  readonly ready: Promise<void>;
  private inFlight = false;
  private queue = new Map<string, { doc: PartDocument; opts?: RecomputeOptions; waiters: { resolve: (r: RecomputeResult) => void; reject: (e: Error) => void }[] }>();

  constructor(private readonly engine: NativeKernelEngine) {
    this.ready = engine.ping().then(() => undefined);
  }

  recompute(doc: PartDocument, opts?: RecomputeOptions): Promise<RecomputeResult> {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (this.inFlight) {
        const k = doc.id ?? "";
        this.queue.set(k, { doc, opts, waiters: [...(this.queue.get(k)?.waiters ?? []), waiter] });
      } else this.run(doc, opts, [waiter]);
    });
  }

  private run(doc: PartDocument, opts: RecomputeOptions | undefined, waiters: { resolve: (r: RecomputeResult) => void; reject: (e: Error) => void }[]): void {
    this.inFlight = true;
    // JSON: strips the reactive proxies of the interface.
    const plain = JSON.parse(JSON.stringify(doc)) as PartDocument;
    this.engine
      .recompute(plain, opts)
      .then(
        (r) => waiters.forEach((w) => w.resolve(r)),
        (e: Error) => waiters.forEach((w) => w.reject(e)),
      )
      .finally(() => {
        this.inFlight = false;
        void this.engine.trim().catch(() => undefined);
        const [k, next] = this.queue.entries().next().value ?? [];
        if (next) {
          this.queue.delete(k!);
          this.run(next.doc, next.opts, next.waiters);
        }
      });
  }

  exportShape(format: ExportFormat, docId?: string): Promise<Uint8Array> {
    return this.engine.exportShape(format, docId);
  }

  camMesh(doc: PartDocument, deflection: number): Promise<MeshPayload | null> {
    return this.engine.camMesh(JSON.parse(JSON.stringify(doc)) as PartDocument, deflection);
  }

  exportPlaced(format: ExportFormat, parts: PlacedPart[]): Promise<Uint8Array> {
    return this.engine.exportPlaced(format, JSON.parse(JSON.stringify(parts)) as PlacedPart[]);
  }

  interferences(parts: PlacedPart[]): Promise<Interference[]> {
    return this.engine.interferences(JSON.parse(JSON.stringify(parts)) as PlacedPart[]);
  }

  project(doc: PartDocument, views: ViewKind[]): Promise<ProjectedView[]> {
    return this.engine.project(JSON.parse(JSON.stringify(doc)) as PartDocument, views);
  }

  projectScene(items: SceneItem[], views: SceneView[]): Promise<ProjectedView[]> {
    return this.engine.projectScene(JSON.parse(JSON.stringify(items)) as SceneItem[], views);
  }

  flatPattern(doc: PartDocument): Promise<FlatPattern> {
    return this.engine.flatPattern(JSON.parse(JSON.stringify(doc)) as PartDocument);
  }

  surfaceAnalysis(doc: PartDocument, kind: CurvatureKind): Promise<Float32Array> {
    return this.engine.surfaceAnalysis(JSON.parse(JSON.stringify(doc)) as PartDocument, kind);
  }

  continuity(doc: PartDocument, edge: string): Promise<ContinuitySample[]> {
    return this.engine.continuity(JSON.parse(JSON.stringify(doc)) as PartDocument, edge);
  }

  forget(docId: string): void {
    void this.engine.forget(docId).catch(() => undefined);
  }

  featureAt(docId: string, faceId: number): Promise<string | null> {
    return Promise.resolve(this.engine.featureAt(docId, faceId));
  }

  dispose(): void {}
}

/** Tauri transport: desktop `kernel_exchange` command (apps/desktop/src-tauri/src/kernel.rs). */
export function tauriExchange(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): Exchange {
  return async (frame) => (await invoke("kernel_exchange", { frame })) as ArrayBuffer;
}
