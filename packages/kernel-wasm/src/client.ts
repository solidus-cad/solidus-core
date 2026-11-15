import type {
  ContinuitySample,
  CurvatureKind,
  FlatPattern,
  ExportFormat,
  Interference,
  KernelClient,
  MeshPayload,
  PlacedPart,
  ProjectedView,
  SceneItem,
  SceneView,
  ViewKind,
  KernelRequestExt,
  KernelResponse,
  PartDocument,
  RecomputeOptions,
  RecomputeResult,
} from "@solidus-cad/sdk";

type RequestBody = KernelRequestExt extends infer R ? (R extends KernelRequestExt ? Omit<R, "id"> : never) : never;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * cad-core kernel (C++ → WASM) run in a Web Worker: the interface never blocks.
 * Recomputations requested while another one is in progress are merged: only the last document is computed.
 */
export class WasmKernelClient implements KernelClient {
  readonly ready: Promise<void>;
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private inFlight = false;
  /** Pending recomputations, one per document: only the most recent one of each document is computed. */
  private queue = new Map<string, { doc: PartDocument; opts?: RecomputeOptions; waiters: Pending[] }>();

  constructor() {
    this.ready = new Promise((resolve, reject) => this.pending.set(0, { resolve: () => resolve(), reject }));
    this.worker.onmessage = (ev: MessageEvent<KernelResponse>) => {
      const res = ev.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || "Erreur du noyau");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  recompute(doc: PartDocument, opts?: RecomputeOptions): Promise<RecomputeResult> {
    return new Promise((resolve, reject) => {
      const waiter: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (this.inFlight) {
        const k = doc.id ?? "";
        this.queue.set(k, { doc, opts, waiters: [...(this.queue.get(k)?.waiters ?? []), waiter] });
      } else {
        this.run(doc, opts, [waiter]);
      }
    });
  }

  exportShape(format: ExportFormat, docId?: string): Promise<Uint8Array> {
    return this.request({ kind: "export", format, docId }) as Promise<Uint8Array>;
  }

  exportPlaced(format: ExportFormat, parts: PlacedPart[]): Promise<Uint8Array> {
    return this.request({ kind: "exportPlaced", format, parts: JSON.parse(JSON.stringify(parts)) as PlacedPart[] }) as Promise<Uint8Array>;
  }

  camMesh(doc: PartDocument, deflection: number): Promise<MeshPayload | null> {
    return this.request({ kind: "camMesh", doc: JSON.parse(JSON.stringify(doc)) as PartDocument, deflection }) as Promise<MeshPayload | null>;
  }

  interferences(parts: PlacedPart[]): Promise<Interference[]> {
    return this.request({ kind: "interferences", parts: JSON.parse(JSON.stringify(parts)) as PlacedPart[] }) as Promise<Interference[]>;
  }

  project(doc: PartDocument, views: ViewKind[]): Promise<ProjectedView[]> {
    return this.request({ kind: "project", doc: JSON.parse(JSON.stringify(doc)) as PartDocument, views }) as Promise<ProjectedView[]>;
  }

  projectScene(items: SceneItem[], views: SceneView[]): Promise<ProjectedView[]> {
    return this.request({ kind: "projectScene", items: JSON.parse(JSON.stringify(items)) as SceneItem[], views }) as Promise<ProjectedView[]>;
  }

  flatPattern(doc: PartDocument): Promise<FlatPattern> {
    return this.request({ kind: "flatPattern", doc: JSON.parse(JSON.stringify(doc)) as PartDocument }) as Promise<FlatPattern>;
  }

  surfaceAnalysis(doc: PartDocument, kind: CurvatureKind): Promise<Float32Array> {
    return this.request({ kind: "surfaceAnalysis", doc: JSON.parse(JSON.stringify(doc)) as PartDocument, analysis: kind }) as Promise<Float32Array>;
  }

  continuity(doc: PartDocument, edge: string): Promise<ContinuitySample[]> {
    return this.request({ kind: "continuity", doc: JSON.parse(JSON.stringify(doc)) as PartDocument, edge }) as Promise<ContinuitySample[]>;
  }

  forget(docId: string): void {
    void this.request({ kind: "forget", docId });
  }

  featureAt(docId: string, faceId: number, point: [number, number, number]): Promise<string | null> {
    return this.request({ kind: "featureAt", docId, faceId, point }) as Promise<string | null>;
  }

  dispose(): void {
    this.worker.terminate();
  }

  private run(doc: PartDocument, opts: RecomputeOptions | undefined, waiters: Pending[]): void {
    this.inFlight = true;
    // JSON: strips the reactive proxies of the interface, which do not pass structured cloning.
    const plain = JSON.parse(JSON.stringify(doc)) as PartDocument;
    this.request({ kind: "recompute", doc: plain, opts }).then(
      (r) => waiters.forEach((w) => w.resolve(r)),
      (e: Error) => waiters.forEach((w) => w.reject(e)),
    ).finally(() => {
      this.inFlight = false;
      const [k, next] = this.queue.entries().next().value ?? [];
      if (next) {
        this.queue.delete(k!);
        this.run(next.doc, next.opts, next.waiters);
      }
    });
  }

  private request(body: RequestBody): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...body, id });
    });
  }
}
