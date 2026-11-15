import type {
  ContinuitySample,
  CurvatureKind,
  ExportFormat,
  FlatPattern,
  Interference,
  KernelClient,
  MeshPayload,
  PartDocument,
  PlacedPart,
  ProjectedView,
  RecomputeOptions,
  RecomputeResult,
  SceneItem,
  SceneView,
  ViewKind,
} from "@solidus-cad/sdk";
import { NativeKernelClient, NativeKernelEngine, tauriExchange, WasmKernelClient } from "@solidus-cad/kernel-wasm";
import { SketchSolver } from "@solidus-cad/sketch";
import gcsWasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { invokeDesktop, isDesktop } from "./desktop.ts";

/**
 * Computation kernel of the application:
 *  - desktop: native cad-core (`cad-kernel` process, apps/desktop/src-tauri/src/kernel.rs), 2 to 3 times faster;
 *    falls back to the WASM cad-core if it is absent (development machine without a native build);
 *  - browser: WASM cad-core (packages/kernel-wasm).
 * The WASM cad-core requires packages/kernel-wasm/dist/kernel.wasm (`pnpm --filter @solidus-cad/kernel-wasm build:kernel`);
 * the native one, apps/desktop/src-tauri/binaries/ (`tools/build-kernel.sh native`).
 */
export function createKernel(): KernelClient {
  if (isDesktop) return new FallbackKernelClient(createNativeKernel, () => new WasmKernelClient());
  return new WasmKernelClient();
}

async function createNativeKernel(): Promise<KernelClient> {
  // PlaneGCS in the window: sketch preparation stays in TypeScript; the heavy computation is in the kernel.
  const solver = await SketchSolver.create(gcsWasmUrl);
  return new NativeKernelClient(new NativeKernelEngine(tauriExchange(invokeDesktop), solver));
}

/** Main kernel, or the fallback kernel if it fails to start. Requests wait until the choice is made. */
class FallbackKernelClient implements KernelClient {
  readonly ready: Promise<void>;
  private readonly target: Promise<KernelClient>;

  constructor(primary: () => Promise<KernelClient>, fallback: () => KernelClient) {
    this.target = primary()
      .then(async (k) => {
        await k.ready;
        return k;
      })
      .catch(async (e) => {
        console.warn("Noyau natif indisponible, repli sur cad-core WASM :", e);
        const k = fallback();
        await k.ready;
        return k;
      });
    this.ready = this.target.then(() => undefined);
  }

  recompute(doc: PartDocument, opts?: RecomputeOptions): Promise<RecomputeResult> {
    return this.target.then((k) => k.recompute(doc, opts));
  }

  exportShape(format: ExportFormat, docId?: string): Promise<Uint8Array> {
    return this.target.then((k) => k.exportShape(format, docId));
  }

  exportPlaced(format: ExportFormat, parts: PlacedPart[]): Promise<Uint8Array> {
    return this.target.then((k) => (k.exportPlaced ? k.exportPlaced(format, parts) : Promise.reject(new Error("Export d'assemblage non disponible avec ce noyau"))));
  }

  camMesh(doc: PartDocument, deflection: number): Promise<MeshPayload | null> {
    return this.target.then((k) => (k.camMesh ? k.camMesh(doc, deflection) : Promise.resolve(null)));
  }

  interferences(parts: PlacedPart[]): Promise<Interference[]> {
    return this.target.then((k) => (k.interferences ? k.interferences(parts) : Promise.reject(new Error("Interférences non disponibles avec ce noyau"))));
  }

  project(doc: PartDocument, views: ViewKind[]): Promise<ProjectedView[]> {
    return this.target.then((k) => (k.project ? k.project(doc, views) : Promise.reject(new Error("Mise en plan non disponible avec ce noyau"))));
  }

  projectScene(items: SceneItem[], views: SceneView[]): Promise<ProjectedView[]> {
    return this.target.then((k) => (k.projectScene ? k.projectScene(items, views) : Promise.reject(new Error("Mise en plan non disponible avec ce noyau"))));
  }

  flatPattern(doc: PartDocument): Promise<FlatPattern> {
    return this.target.then((k) => (k.flatPattern ? k.flatPattern(doc) : Promise.reject(new Error("Développé non disponible avec ce noyau"))));
  }

  surfaceAnalysis(doc: PartDocument, kind: CurvatureKind): Promise<Float32Array> {
    return this.target.then((k) => (k.surfaceAnalysis ? k.surfaceAnalysis(doc, kind) : Promise.reject(new Error("Analyse de surface non disponible avec ce noyau"))));
  }

  continuity(doc: PartDocument, edge: string): Promise<ContinuitySample[]> {
    return this.target.then((k) => (k.continuity ? k.continuity(doc, edge) : Promise.reject(new Error("Analyse de continuité non disponible avec ce noyau"))));
  }

  forget(docId: string): void {
    void this.target.then((k) => k.forget?.(docId));
  }

  featureAt(docId: string, faceId: number, point: [number, number, number]): Promise<string | null> {
    return this.target.then((k) => k.featureAt?.(docId, faceId, point) ?? null);
  }

  dispose(): void {
    void this.target.then((k) => k.dispose());
  }
}
