import { batch } from "solid-js";
import { emit } from "./events.ts";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import {
  activeFeatures,
  createPartDocument,
  defaultDatumPlane,
  effectiveParameters,
  emptySketch,
  featureOfFaceName,
  partDatumPlanes,
  type DatumOutcome,
  type DatumPlaneDef,
  type DatumRef,
  type ExternalLink,
  newId,
  resolveParameters,
  type AnalysisStudies,
  type BodyDisplay,
  type DisplaySettings,
  type CustomProperty,
  type TextProperty,
  type Material,
  type Finish,
  familyFinish,
  type GeomRef,
  type RefGroup,
  type RecomputeOptions,
  type SketchData,
  type SketchSolveInfo,
  type RecomputeResult,
  type Interference,
  type PlacedPart,
  type ProjectedView,
  type SceneItem,
  type SceneView,
  type BenchContext,
  type Feature,
  type FeatureDefinition,
  type ContinuitySample,
  type CurvatureKind,
  type ParamSpec,
  sketchFits,
  paramShown,
  type MassProperties,
  type MeshPayload,
  type PartDocument,
  type FlatPattern,
} from "@solidus-cad/sdk";
import { createKernel } from "./kernel.ts";
import { objectsTo3mf, placeTriangles, readTriangles, stlToObj, trianglesToObj, trianglesToStl, type PrintObject } from "./obj.ts";
import { faceColorsOf, hideBodies, type DisplayMode, type FacePick, type Viewer } from "@solidus-cad/viewer";
import { t, tx } from "./i18n.ts";
import { isSecondaryWindow } from "./desktop.ts";
import { unpackHistory, type History } from "./history.ts";
import { assignRef } from "./datum.ts";

/** Loaded workbenches (built-in and plugins): registry in plugins/benches.ts. */
import { definitionOf } from "./plugins/benches.ts";
import { guardEdit } from "./host.ts";
import { pluginOwner, resolvePluginRecipes, withPluginData } from "./plugins/features.ts";
import { editBlocked } from "./edition.ts";
export { benches, definitionOf } from "./plugins/benches.ts";

export type KernelState = "loading" | "ready" | "busy" | "error";

interface Editing {
  featureId: string;
  isNew: boolean;
  /** Document before editing: restored if the user cancels. */
  before: PartDocument;
}

interface AppState {
  doc: PartDocument;
  editing: Editing | null;
  activeFeatureId: string | null;
  statuses: Record<string, string | null>;
  /** Sketches solved by the kernel (3D display). */
  sketchInfos: Record<string, SketchSolveInfo>;
  parameterErrors: Record<string, string>;
  mass: MassProperties | null;
  /** Bodies of the part (multi-body), in creation order, and active body at the end of the last recompute. */
  bodies: string[];
  activeBody: string | null;
  /** Body picked in the tree as the target of the next features (null: the active body). */
  targetBody: string | null;
  /** Kind of each body (absent: solid), from the mesh of the last recompute. */
  bodyKinds: Record<string, "solid" | "surface">;
  /** Bodies consumed by a feature (thickened surface…): hidden by default. */
  consumedBodies: string[];
  /**
   * Bodies as they are BEFORE the feature being edited, and the active body at that point: those it can target,
   * which differ from `bodies` when it is in the middle of the tree or when it creates a body itself. null outside editing.
   */
  editBodies: { bodies: string[]; active: string | null } | null;
  lastMs: number;
  kernel: KernelState;
  message: string;
  hover: FacePick | null;
  selection: FacePick[];
  displayMode: DisplayMode;
  /** During the picking of edges/faces: show the result rather than the original body. */
  refPreview: boolean;
  /** Active picking group (RefGroup.key) of a feature with several groups; null: the first. */
  refGroup: string | null;
  /** Selected plane (click in the view or in the tree): base plane, or identifier of a reference plane. */
  selectedPlane: string | null;
  /** Reference plane being edited: slot that receives the element picked in the view. */
  datumSlot: number | null;
  /** Feature (hole, slot) launched without a sketch: choice of the plane, then sketch `sketchId`, then the feature. */
  sketchFor: { type: string; sketchId?: string } | null;
  gridVisible: boolean;
  /** Realistic rendering (environment reflections) in the view. */
  realistic: boolean;
  /** Feature whose dimensions are displayed in the view, editable without entering the feature. */
  dimsFeature: string | null;
  /** In-place modification: face of another part picked (plane in the part frame, link to the face). */
  ghostFace: { plane: { p: [number, number, number]; n: [number, number, number] } | null; link: ExternalLink } | null;
  canUndo: boolean;
  canRedo: boolean;
}

const AUTOSAVE_KEY = "cad.autosave";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(unwrap(v))) as T;
}

function loadAutosave(): PartDocument | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    const doc = raw ? (JSON.parse(raw) as PartDocument) : null;
    return doc?.format === "cad.part" && doc.features.length > 0 ? doc : null;
  } catch {
    return null;
  }
}

// Additional window: starts on a new part, without autosave (desktop.ts, isSecondaryWindow).
const recovered = isSecondaryWindow ? null : loadAutosave();
/** The starting document comes from the autosave (work not saved to a file). */
export const wasRecovered = recovered !== null;

export const [state, setState] = createStore<AppState>({
  doc: recovered ?? createPartDocument("Pièce1"),
  editing: null,
  activeFeatureId: null,
  statuses: {},
  sketchInfos: {},
  parameterErrors: {},
  mass: null,
  bodies: [],
  activeBody: null,
  targetBody: null,
  bodyKinds: {},
  consumedBodies: [],
  editBodies: null,
  lastMs: 0,
  kernel: "loading",
  message: recovered ? t("status.recovered") : "",
  hover: null,
  selection: [],
  displayMode: "shadedEdges",
  refPreview: false,
  refGroup: null,
  selectedPlane: null,
  datumSlot: null,
  sketchFor: null,
  gridVisible: true,
  realistic: false,
  dimsFeature: null,
  ghostFace: null,
  canUndo: false,
  canRedo: false,
});

// --- Kernel and view------------------------------------------------------------

const kernel = createKernel();
let viewer: Viewer | null = null;

kernel.ready.then(
  () => {
    setState("kernel", "ready");
    emit({ type: "kernel.ready", ms: performance.now() });
    recompute();
  },
  (e: Error) => {
    emit({ type: "kernel.error", message: e.message });
    batch(() => {
      setState("kernel", "error");
      setState("message", e.message);
    });
  },
);

export function attachViewer(v: Viewer | null): void {
  viewer = v;
  if (v) {
    v.setColor(state.doc.appearance.color);
    v.setDisplayMode(state.displayMode);
    v.setGridVisible(state.gridVisible);
    v.setRealistic(state.realistic);
    v.setFinish(state.doc.appearance.finish ?? null);
    recompute();
  }
}

export const getViewer = () => viewer;

let generation = 0;

export function recompute(): void {
  if (state.kernel === "loading" || state.kernel === "error") return;
  const gen = ++generation;
  setState("kernel", "busy");
  // Plugin features: recipes built by the plugins (asynchronous), written into the document, then recompute.
  const send = (): Promise<RecomputeResult> => kernel.recompute(withId(state.doc), recomputeOptions());
  const sent = state.doc.features.some((f) => f.plugin)
    ? resolvePluginRecipes(clone(withId(state.doc))).then((changed) => {
        if (gen !== generation) return new Promise<RecomputeResult>(() => {}); // a more recent recompute has already been sent
        batch(() => {
          for (const [id, data] of changed) setState("doc", "features", (f) => f.id === id, "plugin", data);
        });
        return send();
      })
    : send();
  sent.then(
    (r) => {
      if (gen !== generation) return; // a more recent recompute has already been sent
      batch(() => {
        setState("statuses", reconcile(Object.fromEntries(r.statuses.map((s) => [s.id, s.ok ? null : s.error]))));
        setState("parameterErrors", reconcile(r.parameterErrors));
        setState("sketchInfos", reconcile(r.sketches));
        setState("mass", r.mass);
        setState("bodies", reconcile(r.partBodies ?? []));
        // Body kinds: read from the mesh, which may only show an earlier state (editing); bodies absent from it
        // keep the kind already known.
        const meshBodies = r.mesh?.bodies ?? [];
        const kinds = Object.fromEntries(meshBodies.map((b) => [b.id, b.kind ?? "solid"]));
        setState("bodyKinds", reconcile(Object.fromEntries(state.bodies.map((id) => [id, kinds[id] ?? state.bodyKinds[id] ?? "solid"]))));
        setState("consumedBodies", reconcile(meshBodies.filter((b) => b.consumed).map((b) => b.id)));
        setState("activeBody", r.activeBody ?? null);
        if (state.targetBody && !state.bodies.includes(state.targetBody)) setState("targetBody", null);
        setState("editBodies", r.bodiesBefore ? { bodies: r.bodiesBefore.bodies, active: r.bodiesBefore.active || null } : null);
        setState("lastMs", r.ms);
        setState("kernel", "ready");
      });
      emit({ type: "recompute", ms: r.ms, features: r.statuses.length, failed: r.statuses.filter((s) => !s.ok).length });
      lastResult = r;
      if (partMeshVisible) showPartMesh(r);
      partListeners.forEach((cb) => cb(r));
    },
    (e: Error) => {
      if (gen !== generation) return;
      batch(() => {
        setState("kernel", "ready");
        setState("message", e.message);
      });
    },
  );
}

/**
 * While editing a feature that picks edges or faces, the view shows the body BEFORE
 * this feature (the elements to click are the original ones); the full tree stays computed (errors, mass).
 * The bodies from before the feature are also recorded: they are the ones the panel offers as target or tool.
 */
function recomputeOptions(): RecomputeOptions | undefined {
  const f = editingFeature();
  if (!f) return undefined;
  if (!designates(f.type) || state.refPreview) return { bodiesBefore: f.id };
  return { meshBefore: f.id, bodiesBefore: f.id };
}

/** Does the feature pick elements in the view (default group or several groups)? */
function designates(type: string): boolean {
  const def = definitionOf(type);
  return !!(def?.refs || def?.refGroups?.length);
}

/**
 * What a click in the view designates while editing `f`: element kind, filter, and group (absent: default
 * group). null if the feature designates nothing.
 */
export function refTarget(f: Feature): { kind: "edge" | "face"; filter?: RefGroup["filter"]; group?: string } | null {
  const def = definitionOf(f.type);
  const groups = def?.refGroups?.filter((g) => paramShown(g, f.params, def.params));
  if (groups?.length) {
    const g = groups.find((x) => x.key === state.refGroup) ?? groups[0]!;
    return { kind: g.kind, group: g.key, ...(g.filter ? { filter: g.filter } : {}) };
  }
  // Default group of a volume operation: solid elements only (a surface is not its target).
  if (!def?.refs) return null;
  return (def.bodyTarget ?? "solid") === "solid" ? { kind: def.refs.kind, filter: "solid" } : { kind: def.refs.kind };
}

/** Active picking group (multi-group feature). */
export function setRefGroup(key: string): void {
  setState("refGroup", key);
}

export function setRefPreview(on: boolean): void {
  setState("refPreview", on);
  recompute();
}

/**
 * Same picked element: by the topological name when both references have one (cad-core), otherwise by the point and
 * the size, to the precision of the picking.
 */
function sameRef(a: GeomRef, b: GeomRef): boolean {
  if (a.name && b.name) return a.name === b.name;
  return Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < 1e-6 + 1e-3 * Math.max(a.size, 1) && Math.abs(a.size - b.size) < 1e-3 * Math.max(a.size, 1);
}

/** Adds the picked reference, or removes it if it was already there. */
export function toggleRef(ref: GeomRef): void {
  const id = state.editing?.featureId;
  if (!id) return;
  preview((d) => {
    const f = d.features.find((x) => x.id === id);
    if (!f) return;
    const refs = f.refs ?? [];
    const group = refTarget(f)?.group;
    if (group) ref = { ...ref, group };
    const same = (r: GeomRef) => r.kind === ref.kind && r.group === ref.group && sameRef(r, ref);
    if (refs.some(same)) return void (f.refs = refs.filter((r) => !same(r)));
    // Multi-body: a single-group feature acts on the body of its elements. An element from another body redirects it
    // to that body, and the elements of the old one, not found in the new one, are removed. Multiple groups
    // (filling…) take their elements from several bodies.
    if (!group && ref.body && ref.body !== f.body) {
      f.body = ref.body;
      f.refs = [...refs.filter((r) => r.body === ref.body), ref];
    } else f.refs = [...refs, ref];
  });
  advanceRefGroup();
}

/** Active group full (its `max` reached): the next clicks go to the first other group still short of elements. */
function advanceRefGroup(): void {
  const f = editingFeature();
  const def = f && definitionOf(f.type);
  const target = f && refTarget(f);
  if (!f || !def?.refGroups || !target?.group) return;
  const count = (key: string) => (f.refs ?? []).filter((r) => r.group === key).length;
  const active = def.refGroups.find((g) => g.key === target.group);
  if (active?.max === undefined || count(active.key) < active.max) return;
  const next = def.refGroups.find((g) => g !== active && paramShown(g, f.params, def.params) && count(g.key) < Math.max(g.min ?? 1, 1));
  if (next) setState("refGroup", next.key);
}

/** Clears the picked elements of a group (`group` absent: default group). */
/** Setting of the `index`-th element of the group `group` (RefGroup.choice) of the edited feature. */
export function setRefChoice(group: string, index: number, value: string): void {
  const id = state.editing?.featureId;
  if (!id) return;
  preview((d) => {
    const f = d.features.find((x) => x.id === id);
    const ref = (f?.refs ?? []).filter((r) => r.group === group)[index];
    if (ref) ref.choice = value;
  });
}

export function clearRefs(group?: string): void {
  const id = state.editing?.featureId;
  if (!id) return;
  preview((d) => {
    const f = d.features.find((x) => x.id === id);
    if (f) f.refs = (f.refs ?? []).filter((r) => r.group !== group);
  });
}

/** Fine mesh of a part for CAM (null if the kernel cannot do it: the display mesh is kept). */
export function camMesh(doc: PartDocument, deflection: number): Promise<MeshPayload | null> {
  return kernel.camMesh ? kernel.camMesh(doc, deflection) : Promise.resolve(null);
}

/** Curvature at each vertex of the displayed mesh of the active part (surface analysis). */
export function surfaceAnalysis(kind: CurvatureKind): Promise<Float32Array> {
  return kernel.surfaceAnalysis ? kernel.surfaceAnalysis(withId(state.doc), kind) : Promise.reject(new Error("Analyse non disponible avec ce noyau"));
}

/** Continuity along an edge of the active part (topological name) between its two faces. */
export function edgeContinuity(edge: string): Promise<ContinuitySample[]> {
  return kernel.continuity ? kernel.continuity(withId(state.doc), edge) : Promise.reject(new Error("Analyse non disponible avec ce noyau"));
}

export async function exportShape(format: "step" | "stl" | "obj" | "3mf"): Promise<Uint8Array> {
  if (format === "obj") return stlToObj(await kernel.exportShape("stl", state.doc.id), state.doc.name);
  if (format === "3mf") return objectsTo3mf([{ name: state.doc.name, tris: readTriangles(await kernel.exportShape("stl", state.doc.id)), placements: [undefined] }]);
  return kernel.exportShape(format, state.doc.id);
}

/**
 * Export of an assembly. STEP: compound of the placed parts, built by the kernel.
 * STL/OBJ: each part is recomputed, exported to STL, then placed and merged here.
 * 3MF: same recompute, but one object per part and one transform per occurrence: the slicer can separate them.
 */
export async function exportPlaced(format: "step" | "stl" | "obj" | "3mf", parts: PlacedPart[], name: string): Promise<Uint8Array> {
  if (format === "step") {
    if (!kernel.exportPlaced) throw new Error("Export d'assemblage non disponible avec ce noyau");
    return kernel.exportPlaced("step", parts);
  }
  const tris: ReturnType<typeof placeTriangles> = [];
  const done = new Set<string>();
  const objects = new Map<string, PrintObject>();
  for (const p of parts) {
    const id = p.doc.id ?? "";
    if (!done.has(id)) {
      await kernel.recompute(p.doc);
      done.add(id);
      if (format === "3mf") objects.set(id, { name: p.doc.name, tris: readTriangles(await kernel.exportShape("stl", id)), placements: [] });
    }
    if (format === "3mf") objects.get(id)!.placements.push(p.matrix);
    else tris.push(...placeTriangles(await kernel.exportShape("stl", id), p.matrix));
  }
  if (format === "3mf") return objectsTo3mf([...objects.values()]);
  if (!tris.length) throw new Error("Aucune géométrie à exporter");
  return format === "obj" ? trianglesToObj(tris, name) : trianglesToStl(tris);
}

// --- Several open documents (used by workspace.ts) ----------------------------------

/** Old files have no identifier: one is assigned to them, once and for all. */
function withId(doc: PartDocument): PartDocument {
  if (!doc.id) setState("doc", "id", newId());
  return state.doc;
}

let partMeshVisible = true;
const partListeners = new Set<(r: RecomputeResult) => void>();
/** Last recompute of the active part: redisplayed without recomputing when a body is hidden or recoloured. */
let lastResult: RecomputeResult | null = null;

/** Displays the part mesh, without its hidden bodies, with the colours of the faces, features and bodies. */
/** Hidden body: the user's choice, otherwise hidden if it is consumed (like a used sketch). */
export function bodyHidden(id: string): boolean {
  return state.doc.bodies?.[id]?.hidden ?? state.consumedBodies.includes(id);
}

/** Shows or hides a body; the setting is kept only if it differs from the default visibility. */
export function toggleBodyHidden(id: string): void {
  const next = !bodyHidden(id);
  setBodyDisplay(id, (b) => void (b.hidden = next === state.consumedBodies.includes(id) ? undefined : next));
}

/**
 * Sketches used by a feature (hidden by default, like a consumed body): profile, path, and the ordered lists of
 * loft sections and guides (comma-separated identifiers).
 */
export function consumedSketches(features: readonly { params: Record<string, string> }[]): Set<string> {
  const ids = features.flatMap((f) => [f.params.sketch, f.params.path, f.params.profileSketch, ...(f.params.sections ?? "").split(","), ...(f.params.guides ?? "").split(",")]);
  return new Set(ids.filter((x): x is string => !!x));
}

/** Kind of a body (solid by default). */
export function bodyKind(id: string): "solid" | "surface" {
  return state.bodyKinds[id] ?? "solid";
}

function showPartMesh(r: RecomputeResult): void {
  const hidden = new Set((r.mesh?.bodies ?? []).map((b) => b.id).filter(bodyHidden));
  const mesh = r.mesh && hideBodies(r.mesh, hidden);
  viewer?.setMesh(mesh);
  if (!mesh) return viewer?.setFaceColors([]);
  // Filtered mesh: face indices shifted; the original feature is read back from the names (identifiers unchanged).
  const owners = mesh === r.mesh ? r.faceFeatures : Array.from({ length: mesh.faceGroups.length / 3 }, (_, k) => featureOfFaceName(mesh.names?.faces[mesh.faceGroups[k * 3 + 2]!]));
  viewer?.setFaceColors(faceColorsOf(mesh, state.doc.appearance, owners, state.doc.bodies));
}

/** Display settings of a body (name, colour, visibility): without recompute or history, like setDisplay. */
export function setBodyDisplay(id: string, mutate: (b: BodyDisplay) => void): void {
  setState(
    "doc",
    produce((doc) => {
      doc.bodies ??= {};
      const b = (doc.bodies[id] ??= {});
      mutate(b);
      if (!b.name && !b.color && b.hidden === undefined) delete doc.bodies[id];
      if (!Object.keys(doc.bodies).length) delete doc.bodies;
    }),
  );
  autosave();
  if (lastResult && partMeshVisible) showPartMesh(lastResult);
}

/** Target body of the next features (null: the active body). */
export function setTargetBody(id: string | null): void {
  setState("targetBody", id);
}

/** Deletes a body: "deleteBody" feature on this body (validated in the panel, undoable). */
export function deleteBodyOf(id: string): void {
  setState("targetBody", id);
  beginFeature("deleteBody");
}

/** Is the view showing the active part (false when an assembly is displayed)? */
export function setPartMeshVisible(on: boolean): void {
  partMeshVisible = on;
  if (on) recompute();
  else viewer?.setMesh(null);
}

/** Recompute results of the active part (to update the open assemblies). */
export function onPartRecomputed(cb: (r: RecomputeResult) => void): () => void {
  partListeners.add(cb);
  return () => partListeners.delete(cb);
}

export function projectScene(items: SceneItem[], views: SceneView[]): Promise<ProjectedView[]> {
  if (!kernel.projectScene) return Promise.reject(new Error("Mise en plan non disponible avec ce noyau"));
  return kernel.projectScene(items, views);
}

/** Sheet metal: flat pattern of a part. */
export function computeFlatPattern(doc: PartDocument): Promise<FlatPattern> {
  if (!kernel.flatPattern) return Promise.reject(new Error("Développé non disponible avec ce noyau"));
  return kernel.flatPattern(doc);
}

/** Application actions called by the workbenches (export, dialogs). */
const appActions = new Map<string, () => void>();
export function registerAction(id: string, run: () => void): void {
  appActions.set(id, run);
}

export function computeInterferences(parts: PlacedPart[]): Promise<Interference[]> {
  if (!kernel.interferences) return Promise.reject(new Error("Interférences non disponibles avec ce noyau"));
  return kernel.interferences(parts);
}

/** Releases the shapes kept in cache by the kernel for a closed document. */
export function forgetKernelDoc(id: string): void {
  kernel.forget?.(id);
}

/** Recomputes any part (not active) without touching the interface state. */
export async function recomputeDoc(doc: PartDocument): Promise<RecomputeResult> {
  const plain = JSON.parse(JSON.stringify(unwrap(doc))) as PartDocument;
  return kernel.recompute(plain.features.some((f) => f.plugin) ? withPluginData(plain, await resolvePluginRecipes(plain)) : plain);
}

/** Archived part (inactive document): its history can be compressed. */
export interface PartSession extends History<PartDocument> {
  doc: PartDocument;
}

/** Removes the active part (with its history), to archive it while another document is active. */
export function takePartSession(): PartSession {
  if (state.editing) confirmEdit();
  const s = { doc: clone(withId(state.doc)), past, future };
  // The history now belongs to the archived session (which may compress it).
  past = [];
  future = [];
  return s;
}

/** Makes an archived part (or new one) active again, with its history. */
export function restorePartSession(s: PartSession): void {
  if (state.editing) cancelEdit();
  unpackHistory(s);
  past = s.past;
  future = s.future;
  syncHistoryFlags();
  setState("activeFeatureId", null);
  replaceDoc(s.doc);
}

// --- History (undo / redo)-------------------------------------------

let past: PartDocument[] = [];
let future: PartDocument[] = [];
const MAX_HISTORY = 200;

function syncHistoryFlags(): void {
  setState("canUndo", past.length > 0);
  setState("canRedo", future.length > 0);
}

let autosaveTimer = 0;
function autosave(): void {
  if (isSecondaryWindow) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(unwrap(state.doc)));
    } catch {
      /* storage full or unavailable */
    }
  }, 500);
}

/** Modifies the document creating a history entry. */
export function commit(mutate: (doc: PartDocument) => void, before: PartDocument = clone(state.doc)): void {
  if (editBlocked()) return;
  past.push(before);
  if (past.length > MAX_HISTORY) past.shift();
  future.length = 0;
  setState("doc", produce(mutate));
  syncHistoryFlags();
  autosave();
  recompute();
}

/** Modifies the document without history or preview: consequence of another document (external references re-snapped). */
export function updateLinked(mutate: (doc: PartDocument) => void): void {
  setState("doc", produce(mutate));
  autosave();
  recompute();
}

/** Modifies the document without history (preview while editing a feature). */
function preview(mutate: (doc: PartDocument) => void): void {
  setState("doc", produce(mutate));
  recompute();
}

function replaceDoc(doc: PartDocument): void {
  if (state.dimsFeature && !doc.features.some((f) => f.id === state.dimsFeature)) setState("dimsFeature", null);
  setState("doc", reconcile(doc));
  viewer?.setColor(doc.appearance.color);
  viewer?.setFinish(doc.appearance.finish ?? null);
  autosave();
  recompute();
}

/** Replaces the active part with another version (checkpoint), keeping the identifier: undoable. */
export function restoreDoc(doc: PartDocument): void {
  if (state.editing) cancelEdit();
  past.push(clone(state.doc));
  if (past.length > MAX_HISTORY) past.shift();
  future.length = 0;
  replaceDoc({ ...doc, id: state.doc.id });
  syncHistoryFlags();
}

export function undo(): void {
  if (state.editing) return cancelEdit();
  const prev = past.pop();
  if (!prev) return;
  emit({ type: "undo" });
  future.push(clone(state.doc));
  replaceDoc(prev);
  syncHistoryFlags();
}

export function redo(): void {
  if (state.editing) return;
  const next = future.pop();
  if (!next) return;
  emit({ type: "redo" });
  past.push(clone(state.doc));
  replaceDoc(next);
  syncHistoryFlags();
}

export function newDocument(): void {
  cancelEdit();
  past.length = future.length = 0;
  syncHistoryFlags();
  replaceDoc(createPartDocument(state.doc.name === "Pièce1" ? "Pièce2" : "Pièce1"));
  getViewer()?.setView("iso", false);
}

export function loadDocument(doc: PartDocument): void {
  cancelEdit();
  past.length = future.length = 0;
  syncHistoryFlags();
  replaceDoc(doc);
}

// --- Editing features-----------------------------------------------------

/** Initial value of a parameter: the last available sketch (of the accepted space) for a "sketch" parameter. */
function defaultParam(spec: ParamSpec): string {
  const active = state.doc.features.slice(0, state.doc.rollback);
  if (spec.kind === "feature") {
    const tools = ["box", "cylinder", "extrude", "twistExtrude", "thinExtrude", "revolve", "sweep", "loft", "hole", "slot", "profile"];
    return [...active].reverse().find((f) => tools.includes(f.type) && !f.suppressed)?.id ?? spec.default;
  }
  if (spec.kind !== "sketch") return spec.default;
  const fits = (f: Feature) => sketchFits(f.type, spec.space) && !f.suppressed;
  const selected = active.find((f) => f.id === state.activeFeatureId && fits(f));
  return (selected ?? [...active].reverse().find(fits))?.id ?? "";
}

function uniqueName(def: FeatureDefinition): string {
  const base = tx(def.label);
  let n = 1;
  while (state.doc.features.some((f) => f.name === `${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Features that, without a selected sketch, first have their sketch drawn. */
const SKETCH_FIRST = new Set(["hole", "slot"]);

const BASE_PLANES = new Set(["XY", "XZ", "YZ"]);

/** A sketch plane is picked: selected plane, or a single selected face. */
const planeDesignated = () => state.selection.length === 1 || !!state.ghostFace || !!(state.selectedPlane && (BASE_PLANES.has(state.selectedPlane) || activeDatums().get(state.selectedPlane)?.frame));

export function beginFeature(type: string): void {
  if (editBlocked()) return;
  const def = definitionOf(type);
  if (!def || state.kernel === "loading") return;
  if (state.editing) confirmEdit();
  setState("sketchFor", null);
  const active = state.doc.features.slice(0, state.doc.rollback);
  // Hole / slot: selected sketch required; other features on a sketch: no sketch available.
  const needsSketch = SKETCH_FIRST.has(type)
    ? !active.some((f) => f.id === state.activeFeatureId && f.type === "sketch")
    : def.params.some((p) => p.kind === "sketch" && !p.when) && !active.some((f) => f.type === "sketch");
  if (needsSketch) {
    setState("sketchFor", { type });
    // Without any sketch: go directly into a sketch (picked plane, otherwise XY).
    if (planeDesignated() || !SKETCH_FIRST.has(type)) continueSketchFor(true);
    else setState("message", t("sk.pickPlaneFor"));
    return;
  }
  const before = clone(state.doc);
  const feature: Feature = {
    id: newId(),
    type,
    name: uniqueName(def),
    params: Object.fromEntries(def.params.map((p) => [p.key, defaultParam(p)])),
  };
  const owner = pluginOwner(type);
  if (owner) feature.plugin = owner;
  // Multi-body: the feature targets the chosen body (if it is of a kind it accepts), otherwise the active body (last
  // solid). With a single body, nothing is written (behaviour unchanged even if the first feature is deleted or reordered).
  // A feature that creates its own body (surface) has no target.
  const bodyTarget = def.bodyTarget ?? "solid";
  const chosen = state.targetBody && (bodyTarget === "any" || bodyKind(state.targetBody) === "solid") ? state.targetBody : null;
  const target = chosen ?? state.activeBody;
  if (bodyTarget !== "none" && state.bodies.length > 1 && target && type !== "plane" && type !== "sketch3d") feature.body = target;
  const sel = state.selection;
  const face = sel.length === 1 && viewer ? viewer.planeOfFace(sel[0]!.index) : null;
  const datum = state.selectedPlane && activeDatums().get(state.selectedPlane)?.frame ? state.selectedPlane : null;
  const ghost = !sel.length ? state.ghostFace : null;
  if (type === "sketch") {
    const base = state.selectedPlane === "XY" || state.selectedPlane === "XZ" || state.selectedPlane === "YZ" ? state.selectedPlane : "XY";
    feature.sketch = emptySketch(base);
    // A flat face picked in the view becomes the sketch plane; otherwise the selected reference plane.
    if (face) feature.sketch.plane.face = face;
    else if (sel.length === 1) setState("message", t("sk.notPlanar"));
    else if (ghost?.plane) {
      // Face of another part of the assembly: linked plane, re-snapped when the parts move.
      feature.sketch.plane.face = ghost.plane;
      feature.sketch.plane.external = clone(ghost.link);
    } else if (ghost) setState("message", t("sk.notPlanar"));
    else if (datum) feature.sketch.plane.datum = datum;
  }
  if (type === "plane") {
    // First element: the selected flat face, or the selected plane (base or reference).
    const first: DatumRef | null = face
      ? { kind: "plane", p: face.p, n: face.n }
      : datum
        ? { kind: "datum", id: datum }
        : state.selectedPlane === "XY" || state.selectedPlane === "XZ" || state.selectedPlane === "YZ"
          ? { kind: "base", name: state.selectedPlane }
          : null;
    feature.datum = defaultDatumPlane("offset", first);
    setState("datumSlot", first ? null : 0);
  }
  setState("refGroup", null);
  setState("editing", { featureId: feature.id, isNew: true, before });
  setState("activeFeatureId", feature.id);
  // Inserted right after the rollback bar.
  preview((d) => {
    d.features.splice(d.rollback, 0, feature);
    d.rollback++;
  });
}

/** Plane picked in the view while waiting for a sketch feature: opens the sketch on this plane (`force`: XY by default). */
export function continueSketchFor(force = false): void {
  const p = state.sketchFor;
  if (!p || p.sketchId || state.editing || (!force && !planeDesignated())) return;
  const sel = state.selection;
  if (sel.length === 1 && !viewer?.planeOfFace(sel[0]!.index)) return setState("message", t("sk.pickPlaneNotPlanar"));
  if (!sel.length && state.ghostFace && !state.ghostFace.plane) return setState("message", t("sk.pickPlaneNotPlanar"));
  beginFeature("sketch");
  setState("sketchFor", { type: p.type, sketchId: editingFeature()?.id });
  // Planes / faces consumed by this sketch: the next feature will ask for its plane again.
  setState("selectedPlane", null);
  viewer?.clearSelection();
  setState("message", t(p.type === "slot" ? "sk.drawSlots" : p.type === "hole" ? "sk.drawHoles" : "sk.drawProfile"));
}

/** Abandons the wait for the sketch plane (Escape). */
export function cancelSketchFor(): void {
  setState("sketchFor", null);
  setState("message", "");
}

export function editFeature(id: string): void {
  if (state.editing?.featureId === id) return;
  const f = state.doc.features.find((x) => x.id === id);
  if (!f) return;
  // 3D sketch: edited in the assembly (snaps on the other parts).
  if (f.type === "sketch3d") return setMessage(t("s3d.editFromAssembly"));
  if (f.type === "frameMembers") return setMessage(t("frm.editFromAssembly"));
  // Missing plugin: the feature keeps its last form (recorded recipe), its parameters are no longer editable.
  if (f.plugin && !definitionOf(f.type)) return setMessage(t("plg.missingEdit").replace("{id}", f.plugin.id));
  // Feature of a paid module: re-editing is subject to its right.
  guardEdit(f.type, () => openEdit(id));
}

function openEdit(id: string): void {
  if (editBlocked()) return;
  if (state.editing) confirmEdit();
  setState("datumSlot", null);
  setState("refGroup", null);
  setState("editing", { featureId: id, isNew: false, before: clone(state.doc) });
  setState("activeFeatureId", id);
  // Body from before the feature (proposed targets) and, if it picks elements, body displayed from before it: the
  // recompute restarts from the cache.
  recompute();
}

// --- Reference planes----------------------------------------------------------

/** Reference planes computed for the active part ("plane" features before the rollback bar). */
export function activeDatums(): Map<string, DatumOutcome> {
  return partDatumPlanes(activeFeatures(state.doc), parameterScope());
}

/** Frame of a reference plane of the active part (sketches placed on this plane). */
export const datumFrame = (id: string) => activeDatums().get(id)?.frame;

/** Modifies the construction of the plane being edited (preview). */
export function updateDatum(mutate: (d: DatumPlaneDef) => void): void {
  const id = state.editing?.featureId;
  if (!id) return;
  preview((d) => {
    const f = d.features.find((x) => x.id === id);
    if (f?.datum) mutate(f.datum);
  });
}

/** Slot of the plane being edited that receives the elements picked in the view (null: none). */
export function setDatumSlot(slot: number | null): void {
  setState("datumSlot", slot);
}

/** Element picked in the view for the plane being edited: stored in the active slot, then in the next slot. */
export function pickDatumRef(ref: DatumRef): void {
  const slot = state.datumSlot;
  const f = editingFeature();
  if (slot === null || !f?.datum || (ref.kind === "datum" && ref.id === f.id)) return;
  let next: number | null = slot;
  updateDatum((d) => void (next = assignRef(d, slot, ref)));
  setState("datumSlot", next);
}

/** Visibility of a reference plane of the part. */
export function toggleDatumVisibility(id: string): void {
  setDisplay((d) => {
    const hidden = new Set(d.hiddenDatums ?? []);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    d.hiddenDatums = [...hidden];
  });
}

export function setFeatureParam(key: string, value: string): void {
  const id = state.editing?.featureId;
  if (!id) return;
  preview((d) => {
    const f = d.features.find((x) => x.id === id);
    if (f) f.params[key] = value;
  });
}

/** Target body of the feature being edited ("": the active body). */
export function setFeatureBody(body: string): void {
  const id = state.editing?.featureId;
  if (!id) return;
  preview((d) => {
    const f = d.features.find((x) => x.id === id);
    if (!f) return;
    if (body) f.body = body;
    else delete f.body;
  });
}

/** Displayed name of a body: the one given by the user, otherwise that of the feature that created it. */
export function bodyName(id: string): string {
  const named = state.doc.bodies?.[id]?.name;
  if (named) return named;
  // Pieces of a cut: "<feature>#k".
  const [fid, k] = id.split("#");
  const f = state.doc.features.find((x) => x.id === fid);
  return f ? (k ? `${f.name} (${k})` : f.name) : id;
}

export function setFeatureName(name: string): void {
  const id = state.editing?.featureId;
  if (!id || !name.trim()) return;
  setState("doc", "features", (f) => f.id === id, "name", name.trim());
}

function emitEnd(id: string, outcome: "confirm" | "cancel"): void {
  const f = state.doc.features.find((x) => x.id === id) ?? state.editing?.before.features.find((x) => x.id === id);
  emit({ type: "feature.end", featureType: f?.type ?? "?", name: f?.name ?? id, outcome });
}

export function confirmEdit(): void {
  const e = state.editing;
  if (!e) return;
  const hadRefs = editingRefsDef(e.featureId);
  emitEnd(e.featureId, "confirm");
  setState("editing", null);
  setState("refPreview", false);
  setState("editBodies", null);
  setState("datumSlot", null);
  // The kernel was showing the body from before the feature: recompute with the feature.
  if (hadRefs) recompute();
  if (JSON.stringify(e.before) !== JSON.stringify(unwrap(state.doc))) {
    past.push(e.before);
    if (past.length > MAX_HISTORY) past.shift();
    future.length = 0;
    syncHistoryFlags();
    autosave();
  }
  // Sketch drawn for a hole / slot: the feature opens on this sketch.
  const p = state.sketchFor;
  if (p?.sketchId === e.featureId) {
    setState("sketchFor", null);
    if (state.doc.features.some((f) => f.id === p.sketchId)) beginFeature(p.type);
  }
}

export function cancelEdit(): void {
  const e = state.editing;
  if (!e) return;
  emitEnd(e.featureId, "cancel");
  setState("editing", null);
  setState("refPreview", false);
  setState("editBodies", null);
  setState("datumSlot", null);
  if (state.sketchFor?.sketchId === e.featureId) setState("sketchFor", null);
  replaceDoc(e.before);
}

export const benchContext: BenchContext = {
  document: () => state.doc,
  beginFeature,
  editFeature: (f) => editFeature(f.id),
  invoke: (action) => appActions.get(action)?.(),
};

// --- Tree----------------------------------------------------------------

export function renameFeature(id: string, name: string): void {
  if (!name.trim()) return;
  commit((d) => {
    const f = d.features.find((x) => x.id === id);
    if (f) f.name = name.trim();
  });
}

export function toggleSuppress(id: string): void {
  commit((d) => {
    const f = d.features.find((x) => x.id === id);
    if (f) f.suppressed = !f.suppressed;
  });
}

export function deleteFeature(id: string): void {
  if (state.editing?.featureId === id) cancelEdit();
  commit((d) => {
    const i = d.features.findIndex((x) => x.id === id);
    if (i < 0) return;
    d.features.splice(i, 1);
    if (i < d.rollback) d.rollback--;
    if (d.appearance.features) delete d.appearance.features[id];
  });
  if (state.activeFeatureId === id) setState("activeFeatureId", null);
}

/** Moves a feature before position `target` (index in the original list). */
export function moveFeature(id: string, target: number): void {
  const from = state.doc.features.findIndex((f) => f.id === id);
  if (from < 0 || target === from || target === from + 1) return;
  commit((d) => {
    const rest = from < d.rollback ? d.rollback - 1 : d.rollback;
    const [f] = d.features.splice(from, 1);
    const to = target > from ? target - 1 : target;
    d.features.splice(to, 0, f!);
    // Dropped before the rollback bar, the feature is computed; after, it is not.
    d.rollback = to <= rest ? rest + 1 : rest;
  });
}

export function setRollback(index: number): void {
  if (state.editing) confirmEdit();
  const clamped = Math.max(0, Math.min(index, state.doc.features.length));
  if (clamped === state.doc.rollback) return;
  commit((d) => {
    d.rollback = clamped;
  });
}

// --- Dimensions displayed in the view (editing without entering the feature)------------------------------

/** Displays the dimensions of a feature (null: hides them). */
export function showFeatureDims(id: string | null): void {
  setState("dimsFeature", id);
}

/**
 * Feature that created a face of the active part, picked in the view (null: unknown).
 * The kernel in service answers: topological name for cad-core, picked point for the TypeScript OCCT kernel.
 */
export function featureAtFace(faceId: number, point: [number, number, number]): Promise<string | null> {
  return kernel.featureAt?.(state.doc.id ?? "", faceId, point).catch(() => null) ?? Promise.resolve(null);
}

/** Changes a parameter of a feature outside editing: undoable, immediate recompute. */
export function setParamValue(featureId: string, key: string, value: string): void {
  const f = state.doc.features.find((x) => x.id === featureId);
  if (!f || !value.trim() || f.params[key] === value.trim()) return;
  guardEdit(f.type, () =>
    commit((d) => {
      const g = d.features.find((x) => x.id === featureId);
      if (g) g.params[key] = value.trim();
    }),
  );
}

/** Changes a sketch dimension outside editing: the kernel solves the sketch at recompute. */
export function setSketchDimension(sketchId: string, dimId: string, value: string): void {
  const dim = state.doc.features.find((x) => x.id === sketchId)?.sketch?.dimensions.find((x) => x.id === dimId);
  if (!dim || !value.trim() || dim.value === value.trim()) return;
  commit((d) => {
    const g = d.features.find((x) => x.id === sketchId)?.sketch?.dimensions.find((x) => x.id === dimId);
    if (g) g.value = value.trim();
  });
}

// --- Global parameters--------------------------------------------------------------

export function addParameter(): void {
  let n = 1;
  while (state.doc.parameters.some((p) => p.name === `P${n}`)) n++;
  commit((d) => {
    d.parameters.push({ name: `P${n}`, expr: "10" });
  });
}

export function updateParameter(index: number, name: string, expr: string): void {
  const p = state.doc.parameters[index];
  if (!p || (p.name === name && p.expr === expr)) return;
  commit((d) => {
    d.parameters[index] = { name, expr };
  });
}

export function removeParameter(index: number): void {
  commit((d) => {
    d.parameters.splice(index, 1);
  });
}

// --- Display -----------------------------------------------------------------------

export function setDisplayMode(mode: DisplayMode): void {
  setState("displayMode", mode);
  viewer?.setDisplayMode(mode);
}

export function toggleGrid(): void {
  setState("gridVisible", (v) => !v);
  viewer?.setGridVisible(state.gridVisible);
}

export function toggleRealistic(): void {
  setState("realistic", (v) => !v);
  viewer?.setRealistic(state.realistic);
}

export function setColor(color: string): void {
  commit((d) => {
    d.appearance.color = color;
  });
  viewer?.setColor(color);
}

/** Colour of the faces created by a feature (null: that of the part). */
export function setFeatureColor(id: string, color: string | null): void {
  if ((state.doc.appearance.features?.[id] ?? null) === color) return;
  commit((d) => {
    const all = { ...d.appearance.features };
    if (color) all[id] = color;
    else delete all[id];
    if (Object.keys(all).length) d.appearance.features = all;
    else delete d.appearance.features;
  });
}

/** Same picked face: same topological name, or point and size to the precision of the picking. */
const sameFaceRef = (a: GeomRef, b: GeomRef) => sameRef(a, b);

/** Colour of faces of the current mesh (`faceGroups` indices), null: removes it. */
export function setFaceColor(faces: number[], color: string | null): void {
  const refs = faces.map((i) => viewer?.faceRefOf(i)).filter((r): r is GeomRef => !!r);
  if (refs.length === 0) return;
  commit((d) => {
    const kept = (d.appearance.faces ?? []).filter((f) => !refs.some((r) => sameFaceRef(r, f.ref)));
    const all = color ? [...kept, ...refs.map((ref) => ({ ref, color }))] : kept;
    if (all.length) d.appearance.faces = all;
    else delete d.appearance.faces;
  });
}

/** Own colour of a face of the current mesh (picked one by one), null if there is none. */
export function faceColorOf(face: number): string | null {
  const ref = viewer?.faceRefOf(face);
  return (ref && state.doc.appearance.faces?.find((f) => sameFaceRef(ref, f.ref))?.color) ?? null;
}

/** Removes all face and feature colours: the part reverts to a single colour. */
export function clearPartialColors(): void {
  if (!state.doc.appearance.faces && !state.doc.appearance.features) return;
  commit((d) => {
    delete d.appearance.faces;
    delete d.appearance.features;
  });
}

/** Assigns a material from the database (or removes it); its colour and its family's finish become those of the part. */
export function setMaterial(m: Material | null): void {
  commit((d) => {
    if (!m) delete d.material;
    else applyMaterial(d, m);
  });
  viewer?.setColor(state.doc.appearance.color);
  viewer?.setFinish(state.doc.appearance.finish ?? null);
}

/** Material of a part, with its colour and its family's finish. */
export function applyMaterial(d: PartDocument, m: Material): void {
  d.material = { ...m };
  if (m.color) d.appearance.color = m.color;
  const finish = familyFinish(m.family);
  if (finish) d.appearance.finish = finish;
  else delete d.appearance.finish;
}

/** Finish of the part (null: colour only). */
export function setFinish(finish: Finish | null): void {
  if ((state.doc.appearance.finish ?? null) === finish) return;
  commit((d) => {
    if (finish) d.appearance.finish = finish;
    else delete d.appearance.finish;
  });
  viewer?.setFinish(finish);
}

export function setProperty(key: TextProperty, value: string): void {
  if ((state.doc.properties?.[key] ?? "") === value) return;
  commit((d) => {
    d.properties = { reference: "", designation: "", author: "", revision: "", ...d.properties, [key]: value };
  });
}

/** Replaces the characteristics of the part (empty rows removed). */
export function setCustomProperties(rows: CustomProperty[]): void {
  const next = rows.map((r) => ({ label: r.label.trim(), value: r.value.trim() })).filter((r) => r.label || r.value);
  if (JSON.stringify(state.doc.properties?.custom ?? []) === JSON.stringify(next)) return;
  commit((d) => {
    d.properties = { reference: "", designation: "", author: "", revision: "", ...d.properties, custom: next };
    if (!next.length) delete d.properties.custom;
  });
}

export function setDocName(name: string): void {
  if (!name.trim() || name === state.doc.name) return;
  commit((d) => {
    d.name = name.trim();
  });
}

/** Document display settings: saved with it, without history or recompute. */
export function setDisplay(mutate: (d: DisplaySettings) => void): void {
  setState(
    "doc",
    produce((doc) => {
      doc.display ??= {};
      mutate(doc.display);
    }),
  );
  autosave();
}

/** Document analysis studies: saved with it, without history or kernel recompute. */
export function setAnalysisData(mutate: (a: AnalysisStudies) => void): void {
  setState(
    "doc",
    produce((doc) => {
      doc.analysis ??= {};
      mutate(doc.analysis);
    }),
  );
  autosave();
}

export function togglePlane(name: "XY" | "XZ" | "YZ"): void {
  setDisplay((d) => {
    d.planes = { ...d.planes, [name]: !d.planes?.[name] };
  });
}

export function selectPlane(name: string | null): void {
  setState("selectedPlane", (p) => (p === name ? null : name));
  continueSketchFor();
}

/** Toggles a sketch: automatic → hidden → shown → automatic. */
export function toggleSketchVisibility(id: string, consumed: boolean): void {
  setDisplay((d) => {
    const cur = d.sketches?.[id];
    const sketches = { ...d.sketches };
    // A used sketch is hidden by default: the first click shows it; a free sketch, the reverse.
    if (cur === undefined) sketches[id] = consumed;
    else delete sketches[id];
    d.sketches = sketches;
  });
}

export function setMessage(msg: string): void {
  setState("message", msg);
}

// --- Sketch being edited------------------------------------------------------

function editingRefsDef(id: string): boolean {
  const f = state.doc.features.find((x) => x.id === id);
  return !!(f && designates(f.type));
}

export function editingFeature(): Feature | undefined {
  const id = state.editing?.featureId;
  return id ? state.doc.features.find((f) => f.id === id) : undefined;
}

export function editingSketch(): SketchData | undefined {
  const f = editingFeature();
  return f?.type === "sketch" ? f.sketch : undefined;
}

/** Modifies the sketch being edited (preview, without document history). */
export function updateSketch(mutate: (s: SketchData) => void, opts: { recompute?: boolean } = {}): void {
  const id = state.editing?.featureId;
  if (!id) return;
  setState(
    "doc",
    produce((d) => {
      const f = d.features.find((x) => x.id === id);
      if (f?.sketch) mutate(f.sketch);
    }),
  );
  if (opts.recompute !== false) recompute();
}

/** Values of the global parameters (with the family's active configuration). */
export function parameterScope(): Map<string, number> {
  return resolveParameters(effectiveParameters(state.doc)).scope;
}
