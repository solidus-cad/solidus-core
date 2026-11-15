import { batch, createEffect, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { strToU8 } from "fflate";
import {
  createAssemblyDocument,
  createPartDocument,
  IDENTITY,
  mateAccepts,
  newId,
  stableId,
  type AssemblyComponent,
  type AssemblyDocument,
  type MassProperties,
  type Mate,
  type MateRef,
  type MateRefKind,
  type MateType,
  type MachineDefinition,
  type FixtureDefinition,
  type MeshPayload,
  type SketchSolveInfo,
  type PartDocument,
  type RecomputeResult,
} from "@solidus-cad/sdk";
import { axisOf, chainTransform, type AssemblyBundle } from "@solidus-cad/assembly";
import { faceColorsOf, faceOfTriangle, mateRefOf, remapMateRef, resolveNamed, type AsmItem, type MatePick } from "@solidus-cad/viewer";
import { syncExternalRefs, syncLinkedParts } from "./assembly/external.ts";
import { assemblyLiaisons, containsAssembly, invRigid, leavesOf, localOf, pathMatrix, solveAssembly, type Leaf } from "./assembly/flex.ts";
import type { LiaisonGraph } from "@solidus-cad/assembly";
import { lang, t } from "./i18n.ts";
import { skeletonEntities, skeletonLines, skeletonSegments, type SkeletonEntity, type SkeletonLine } from "./sketch/segments.ts";
import {
  computeInterferences,
  forgetKernelDoc,
  getViewer,
  recomputeDoc,
  restoreDoc,
  restorePartSession,
  setMessage,
  setPartMeshVisible,
  state,
  takePartSession,
  wasRecovered,
  type PartSession,
} from "./store.ts";
import { saveActive, saveBlob } from "./files.ts";
import { saveDoc } from "./docfiles/documents.ts";
import { forgetDocFile } from "./docfiles/fs.ts";
import { clearMissing } from "./docfiles/missing.ts";
import { ask } from "./components/Dialog.tsx";
import { docKind, docKinds } from "./host.ts";
import { packHistory, unpackHistory, whenIdle, type History } from "./history.ts";
import {
  addCheckpoint,
  checkpointsOf,
  clearCheckpointDirty,
  forgetCheckpoints,
  isCheckpointDirty,
  setHead,
  snapshotOf,
  type Checkpoint,
} from "./checkpoints.ts";
import { editBlocked } from "./edition.ts";

/**
 * Workspace: several open documents (parts, assemblies, drawings, CAM programs), only one active.
 * The active part lives in `store.ts` (state.doc); the other parts are archived here with their history.
 */

export type DocKind = "part" | "assembly" | "drawing" | "cam" | "quote";

export interface DocEntry {
  id: string;
  kind: DocKind;
  name: string;
  /** Loaded for an assembly: no tab until the user opens it, closed with the assembly. */
  background?: boolean;
}

interface WorkspaceState {
  entries: DocEntry[];
  activeId: string;
  /** Active assembly (null if a part is active). */
  asm: AssemblyDocument | null;
  /** Selected occurrences. */
  selection: string[];
  gizmo: "none" | "translate" | "rotate";
  /** Part masses (for the bill of materials and the status bar), by part identifier. */
  masses: Record<string, MassProperties | null>;
  /** Part opened from an assembly (in-context editing): assembly to return to. */
  returnTo: string | null;
  /** Part edited in place: context assembly, edited occurrence (ghosts of the other parts, external references). */
  inPlace: { asmId: string; path: string; partId: string } | null;
  /** Machine edited from a CAM program ("Machine" context): program to return to. */
  camReturn: string | null;
  canUndo: boolean;
  canRedo: boolean;
  bomOpen: boolean;
  insertOpen: boolean;
  /** Constraint being created: type, value, first selected element (and its highlight in the view). */
  mateDraft: { type: MateType; value: string; flip: boolean; lockRotation: boolean; a: MateRef | null; mark: MatePick | null } | null;
  /** Remaining degrees of freedom after the last solve (-1: unknown). */
  dof: number;
  /** Unsatisfied constraints. */
  failing: string[];
  /** Result of the last interference check (null: not yet run). */
  interferences: { a: string; b: string; volume: number }[] | null;
  /** 3D sketch being edited in the assembly (skeleton occurrence and feature). */
  sketch3d: { componentId: string; partId: string; featureId: string } | null;
  /** Welded frame being edited in the assembly (occurrence and frame part). */
  frame: { componentId: string; partId: string } | null;
  /** Motion workbench open on the assembly: displayed study. */
  motion: { studyId: string } | null;
  /** Feature errors of the assembly's parts, by part then by feature. */
  featureErrors: Record<string, Record<string, string>>;
  /** Change counter of the archived parts (refreshes the tree). */
  partRev: number;
  /** Machine: displayed axis values (demo pose, outside the document; empty = zero position). */
  axisValues: Record<string, number>;
  /** Axes panel closed by the user. */
  jogClosed: boolean;
  /** Machine definition being edited ("Définir comme machine" wizard). */
  machineDraft: MachineDefinition | null;
  /** Fixture definition being edited ("Définir comme posage" wizard). */
  fixtureDraft: FixtureDefinition | null;
  /** Element being selected in the view for the wizard: "spindle", "table", "axis:<rank>". */
  machinePick: string | null;
  /** Version preview tabs (one per versioned document), per open document: source, version and copied documents. */
  previews: Record<string, { source: string; number: number; docs: string[] }>;
}

const firstId = state.doc.id ?? newId();

export const [ws, setWs] = createStore<WorkspaceState>({
  entries: [{ id: firstId, kind: "part", name: state.doc.name }],
  activeId: firstId,
  asm: null,
  selection: [],
  gizmo: "none",
  masses: {},
  returnTo: null,
  inPlace: null,
  camReturn: null,
  canUndo: false,
  canRedo: false,
  bomOpen: false,
  insertOpen: false,
  mateDraft: null,
  dof: -1,
  failing: [],
  interferences: null,
  sketch3d: null,
  frame: null,
  motion: null,
  featureErrors: {},
  partRev: 0,
  axisValues: {},
  jogClosed: false,
  machineDraft: null,
  fixtureDraft: null,
  machinePick: null,
  previews: {},
});

const parts = new Map<string, PartSession>();
const assemblies = new Map<string, AssemblyDocument>();
/** Part meshes, recomputed only when the part's document changes (and solved sketches, for skeletons). */
const meshes = new Map<string, { json: string; mesh: MeshPayload | null; sketches?: Record<string, SketchSolveInfo>; faceColors?: (string | null)[]; stale?: boolean }>();

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(unwrap(v))) as T;

// The active part's name follows the document.
createRoot(() =>
  createEffect(() => {
    const name = state.doc.name;
    const id = state.doc.id;
    if (activeKind() === "part" && id) setWs("entries", (e) => e.id === ws.activeId, { id, name });
  }),
);

export function activeKind(): DocKind {
  return ws.entries.find((e) => e.id === ws.activeId)?.kind ?? "part";
}

/** Part document by identifier (active or archived). */
export function partDoc(id: string): PartDocument | undefined {
  if (activeKind() === "part" && state.doc.id === id) return state.doc;
  return parts.get(id)?.doc;
}

export function openParts(): DocEntry[] {
  return ws.entries.filter((e) => e.kind === "part");
}

// --- Switching between documents ----------------------------------------------------------

export function activate(id: string): void {
  if (id === ws.activeId) return;
  const target = ws.entries.find((e) => e.id === id);
  if (!target) return;
  if (target.background) setWs("entries", (e) => e.id === id, "background", false);
  // Edited in place: the context only applies to the edited part.
  if (ws.inPlace && id !== ws.inPlace.partId) setWs("inPlace", null);
  // 3D sketch, frame or motion study in progress: finished before leaving the assembly.
  if (ws.sketch3d || ws.frame || ws.motion) leaveHook?.();
  // Archive of the document being left.
  if (activeKind() === "part") parts.set(ws.activeId, takePartSession());
  else if (activeKind() === "assembly" && ws.asm) {
    assemblies.set(ws.activeId, clone(ws.asm));
    // The history stays in asmHistory (compressed later): no longer an active reference.
    asmPast = [];
    asmFuture = [];
  }
  else docKind(activeKind())?.leave(ws.activeId);
  getViewer()?.attachGizmo(null);
  // The machine pose, the wizard and the "Machine" context do not survive a document change.
  setWs({ axisValues: {}, machineDraft: null, fixtureDraft: null, machinePick: null, camReturn: null });
  // The document and the active identifier change together: the interface never sees an intermediate state.
  if (target.kind === "part") {
    const s = parts.get(id);
    batch(() => {
      if (s) {
        parts.delete(id);
        restorePartSession(s);
      }
      setWs({ activeId: id, selection: [], asm: null });
    });
    getViewer()?.setAssembly(null);
    setPartMeshVisible(true);
    // Sketches linked to other parts: re-aligned to the current state of the context assembly.
    syncExternalRefs(id);
  } else if (docKind(target.kind)) {
    // Document type of a module (drawing, CAM program...): the view is built by the module as soon as the document is active.
    batch(() => {
      docKind(target.kind)!.enter(id);
      setWs({ activeId: id, selection: [], asm: null });
    });
    setPartMeshVisible(false);
  } else {
    shownCount = 0;
    setWs({ asm: clone(assemblies.get(id)!), activeId: id, selection: [] });
    setPartMeshVisible(false);
    const h = asmHistory.get(id);
    if (h) unpackHistory(h);
    asmPast = h?.past ?? [];
    asmFuture = h?.future ?? [];
    syncAsmFlags();
    refreshAssembly();
  }
  recent = [id, ...recent.filter((x) => x !== id)];
  releaseInactive();
}

/** Documents from most to least recently activated. */
let recent: string[] = [firstId];

/** The most recently activated of these documents (otherwise: the last opened). */
export function mostRecent(ids: string[]): string | undefined {
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i >= 0 ? i : recent.length + ws.entries.length - ws.entries.findIndex((e) => e.id === id);
  };
  return [...ids].sort((a, b) => rank(a) - rank(b))[0];
}

/** Part of the occurrence selected in the active assembly. */
export function selectedPartId(): string | undefined {
  const key = ws.selection[0];
  const c = key ? componentAt(key) : undefined;
  return c && !c.assemblyId ? c.partId : undefined;
}

/** Open assemblies that contain this part (at all levels). */
export function assembliesUsing(partId: string): string[] {
  return ws.entries.filter((e) => e.kind === "assembly" && asmLeaves(assemblyDoc(e.id) ?? null).some((l) => l.partId === partId)).map((e) => e.id);
}

// --- Memory of inactive documents ------------------------------------------------------------
// Each open tab keeps its document, but not everything that depends on it: the histories of inactive documents
// are compressed, the meshes of parts outside the active assembly are bounded, and the kernel keeps
// only the shapes of the most recently recomputed documents (see Engine::trim, core/document/engine.cpp).

/** Maximum size of the meshes kept for parts that are not in the active assembly (bytes). */
const MESH_BUDGET = 256 * 1024 * 1024;

const meshBytes = (m: MeshPayload | null) =>
  m ? [m.positions, m.normals, m.indices, m.faceGroups, m.edges, m.edgeGroups].reduce((n, a) => n + a.byteLength, 0) : 0;

let releaseScheduled = false;

/** After a switch, when the browser is idle: compresses the inactive histories and bounds the meshes. */
function releaseInactive(): void {
  if (releaseScheduled) return;
  releaseScheduled = true;
  whenIdle(() => {
    releaseScheduled = false;
    // `parts` only contains archived parts (the active part lives in store.ts).
    for (const s of parts.values()) packHistory(s);
    for (const [id, h] of asmHistory) if (id !== ws.activeId) packHistory(h);
    for (const k of docKinds()) k.pack(ws.activeId);
    trimMeshes();
  });
}

/** Frees the least recently displayed meshes, except those of the active assembly, beyond the budget. */
function trimMeshes(): void {
  const ctx = ws.inPlace ? (assemblyDoc(ws.inPlace.asmId) ?? null) : null;
  const needed = new Set([...asmLeaves().map((l) => l.partId), ...asmLeaves(ctx).map((l) => l.partId), ...camMeshKeys]);
  let total = 0;
  for (const e of meshes.values()) total += meshBytes(e.mesh);
  // The insertion order of the Map is the usage order (see refreshAssembly).
  for (const [id, e] of meshes) {
    if (total <= MESH_BUDGET) break;
    if (needed.has(id)) continue;
    total -= meshBytes(e.mesh);
    meshes.delete(id);
  }
}

let leaveHook: (() => void) | null = null;
/** Action run before leaving the active assembly (end of a 3D sketch edit). */
export function onLeaveAssembly(fn: (() => void) | null): void {
  leaveHook = fn;
}

export function addEntry(e: DocEntry): void {
  setWs("entries", (list) => [...list, e]);
  // New or opened from a file: nothing to save until it is modified.
  markSaved([e.id]);
}

/** Removes the tab of a document loaded for an assembly. */
export function hideTab(id: string): void {
  setWs("entries", (e) => e.id === id, "background", true);
}

// --- Unsaved changes ---------------------------------------------------------

/** Content of each document at its last save (or at its opening, at its creation). */
const savedJson = new Map<string, string>();
const [savedRev, setSavedRev] = createSignal(0);

/** JSON with sorted keys: the order of properties (variable after `reconcile`) is not a change. */
export const canonical = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) && !ArrayBuffer.isView(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );

function docOf(id: string): object | undefined {
  const kind = ws.entries.find((e) => e.id === id)?.kind;
  return kind === "part" ? partDoc(id) : kind === "assembly" ? assemblyDoc(id) : kind ? docKind(kind)?.doc(id) : undefined;
}

/** Records the current content of the documents as saved. */
export function markSaved(ids: string[]): void {
  for (const id of ids) {
    const d = docOf(id);
    if (d) savedJson.set(id, canonical(unwrap(d)));
  }
  clearCheckpointDirty(ids);
  setSavedRev((n) => n + 1);
}

/** Does the document differ from its last saved version? Reactive (the active document is read via the store). */
export function isDirty(id: string): boolean {
  void savedRev();
  void ws.partRev;
  const d = docOf(id);
  return !!d && (savedJson.get(id) !== canonical(d) || isCheckpointDirty(id));
}

/** Parts and subassemblies saved with an assembly (.vasm file). */
export function assemblyContents(id: string): string[] {
  const a = assemblyDoc(id);
  return a ? [id, ...new Set(asmLeaves(a).map((l) => l.partId)), ...subAssemblies(a)] : [];
}

// Starting document: already "saved", unless it comes from the autosave.
if (!wasRecovered) markSaved([firstId]);

export function newPart(): void {
  let n = 1;
  while (ws.entries.some((e) => e.name === `${t("ws.part")}${n}`)) n++;
  const doc = createPartDocument(`${t("ws.part")}${n}`);
  parts.set(doc.id!, { doc, past: [], future: [] });
  addEntry({ id: doc.id!, kind: "part", name: doc.name });
  activate(doc.id!);
}

export function newAssembly(): void {
  let n = 1;
  while (ws.entries.some((e) => e.name === `${t("ws.assembly")}${n}`)) n++;
  const a = createAssemblyDocument(`${t("ws.assembly")}${n}`);
  assemblies.set(a.id, a);
  addEntry({ id: a.id, kind: "assembly", name: a.name });
  activate(a.id);
}

/** Opens the most recent assembly, or creates one. */
const kindOf = (id: string | undefined) => ws.entries.find((e) => e.id === id)?.kind;

/** Document represented by the active document: the source of a drawing, the part of a CAM program. */
const sourceOf = (id: string) => docKind(kindOf(id) ?? "")?.source(id) ?? id;

/**
 * Assembly of the active document: the one of the drawing, otherwise the most recent that contains the part,
 * otherwise the most recent open one; failing that, a new assembly.
 */
export function openOrCreateAssembly(): void {
  if (activeKind() === "assembly") return;
  const src = sourceOf(ws.activeId);
  if (src && kindOf(src) === "assembly") return activate(src);
  const target = mostRecent(src ? assembliesUsing(src) : []) ?? mostRecent(ws.entries.filter((e) => e.kind === "assembly").map((e) => e.id));
  if (target) activate(target);
  else newAssembly();
}

/**
 * Part of the active document: the one of the drawing; in an assembly, the selected occurrence
 * or the part of the most recently opened assembly.
 */
export function openLinkedPart(): void {
  const kind = activeKind();
  if (kind === "part") return;
  const src = sourceOf(ws.activeId);
  if (src && kindOf(src) === "part") return activate(src);
  const asm = src && kindOf(src) === "assembly" ? (assemblyDoc(src) ?? null) : null;
  const leaves = asmLeaves(asm);
  const solid = leaves.filter((l) => !l.skeleton).map((l) => l.partId);
  const target =
    (kind === "assembly" ? selectedPartId() : undefined) ??
    mostRecent([...new Set(solid.length ? solid : leaves.map((l) => l.partId))]) ??
    mostRecent(openParts().map((e) => e.id));
  if (target) activate(target);
}

// --- Assembly history ------------------------------------------------------------

let asmPast: AssemblyDocument[] = [];
let asmFuture: AssemblyDocument[] = [];
const asmHistory = new Map<string, History<AssemblyDocument>>();

function syncAsmFlags(): void {
  setWs({ canUndo: asmPast.length > 0, canRedo: asmFuture.length > 0 });
  asmHistory.set(ws.activeId, { past: asmPast, future: asmFuture });
}

export function commitAsm(mutate: (a: AssemblyDocument) => void, before?: AssemblyDocument): void {
  if (!ws.asm || editBlocked()) return;
  asmPast.push(before ?? clone(ws.asm));
  asmFuture = [];
  setWs("asm", produce((a) => mutate(a!)));
  syncAsmFlags();
  refreshAssembly();
}

export function undoAsm(): void {
  const prev = asmPast.pop();
  if (!prev || !ws.asm) return;
  asmFuture.push(clone(ws.asm));
  setWs("asm", reconcile(prev));
  syncAsmFlags();
  refreshAssembly();
}

export function redoAsm(): void {
  const next = asmFuture.pop();
  if (!next || !ws.asm) return;
  asmPast.push(clone(ws.asm));
  setWs("asm", reconcile(next));
  syncAsmFlags();
  refreshAssembly();
}

// --- Assembly display ---------------------------------------------------------------

/** Parts of all occurrences of the active assembly (subassemblies expanded). */
export function asmLeaves(a: AssemblyDocument | null = ws.asm): Leaf[] {
  return a ? a.components.flatMap((c) => leavesOf(c, assemblyDoc)) : [];
}

/**
 * Selectable element designated by the path of a part: the top-level occurrence,
 * or the direct part of a flexible subassembly.
 */
export function selectableOf(path: string): string {
  const [head, child] = path.split("/");
  const c = ws.asm?.components.find((x) => x.id === head);
  return c?.assemblyId && c.flexible && child ? `${head}/${child}` : head!;
}

/** Display name of an occurrence path. */
export function occurrenceLabel(path: string): string {
  const names: string[] = [];
  let doc: AssemblyDocument | undefined = ws.asm ?? undefined;
  for (const id of path.split("/")) {
    const c = doc?.components.find((x) => x.id === id);
    if (!c) return names.length ? names.join(" / ") : "?";
    names.push(c.name);
    doc = c.assemblyId ? assemblyDoc(c.assemblyId) : undefined;
  }
  return names.join(" / ");
}

/** Component targeted by a path (top-level occurrence or part of a subassembly). */
export function componentAt(path: string): AssemblyComponent | undefined {
  let doc: AssemblyDocument | undefined = ws.asm ?? undefined;
  let c: AssemblyComponent | undefined;
  for (const id of path.split("/")) {
    c = doc?.components.find((x) => x.id === id);
    if (!c) return undefined;
    doc = c.assemblyId ? assemblyDoc(c.assemblyId) : undefined;
  }
  return c;
}

/** Recomputes the modified parts, then updates the view. */
export function refreshAssembly(): void {
  const a = ws.asm;
  if (!a) return;
  syncFrames(a);
  const ids = [...new Set(asmLeaves(a).map((l) => l.partId))];
  for (const id of ids) {
    const doc = partDoc(id);
    if (!doc) continue;
    ensurePartMesh(id, doc, (r) => {
      setWs("masses", id, r.mass);
      // Replace (not merge): an error that has disappeared must not stay displayed.
      const errs = Object.fromEntries(r.statuses.flatMap((st) => (st.ok ? [] : [[st.id, st.error]])));
      setWs("featureErrors", (all) => ({ ...all, [id]: errs }));
      // Skeleton recomputed: the frames it drives take over its lines.
      if (ws.asm && [...parts.values()].some((p) => p.doc.frameSource?.partId === id)) refreshAssembly();
      // Occurrence replaced: its constraints are re-attached to the new mesh.
      if (pendingRemaps.length) applyRemaps();
      // Part recomputed: the constraints on its named elements follow (dimensions changed, active configuration...).
      if (r.mesh) followNamedMates(id, r.mesh);
      // Parts edited in place: their linked sketches follow the recomputed part.
      if (ws.asm) syncLinkedParts(ws.activeId);
      // Skeleton or part recomputed: the constraints that rely on their planes and lines are solved again (without a history entry).
      const keys = new Set(asmLeaves().filter((l) => l.partId === id).map((l) => l.key));
      if (ws.asm?.mates.some((m) => (m.a.sketchRef && keys.has(m.a.component)) || (m.b.sketchRef && keys.has(m.b.component)))) {
        setWs("asm", produce((a) => solveInto(a!)));
      }
      pushItems();
    });
  }
  // Parts edited in place: their linked sketches follow the moved occurrences.
  syncLinkedParts(ws.activeId);
  pushItems();
}

/**
 * Mesh of a part, recomputed only when its document changes. `onReady` is called when
 * a new mesh arrives (not if it comes from the cache). `key`: cache key (part identifier, or stock shape).
 */
export function ensurePartMesh(key: string, doc: PartDocument, onReady?: (r: RecomputeResult) => void): void {
  // Analysis studies do not change the geometry: no recomputation when they change.
  const json = JSON.stringify(unwrap(doc), (k, v: unknown) => (k === "analysis" ? undefined : v));
  const cached = meshes.get(key);
  if (cached?.json === json) {
    // Most recently used: moved to the end of the Map (freed last by trimMeshes).
    meshes.delete(key);
    meshes.set(key, cached);
    return;
  }
  meshes.delete(key);
  meshes.set(key, { json, mesh: cached?.mesh ?? null, sketches: cached?.sketches, faceColors: cached?.faceColors, stale: true });
  void recomputeDoc(doc).then((r) => {
    if (meshes.get(key)?.json !== json) return; // a newer version is on its way
    meshes.set(key, { json, mesh: r.mesh, sketches: r.sketches, faceColors: r.mesh ? faceColorsOf(r.mesh, doc.appearance, r.faceFeatures) : undefined });
    onReady?.(r);
  });
}

/** Face colors of the last mesh of a part. */
export function partFaceColors(key: string): (string | null)[] | undefined {
  return meshes.get(key)?.faceColors;
}

/** Meshes of the CAM view (part, stock, machine): kept by trimMeshes while the program is displayed. */
let camMeshKeys: string[] = [];
export function keepCamMeshes(keys: string[]): void {
  camMeshKeys = keys;
}

let shownCount = 0;

/** Color forced on some parts (Measure workbench: parts without a material); undefined: the part's color. */
let colorOverride: ((partId: string) => string | undefined) | null = null;

export function setColorOverride(fn: ((partId: string) => string | undefined) | null): void {
  colorOverride = fn;
}

/** Occurrences hidden by default (Structures and FEM workbenches: part replaced by its results map). */
let hiddenOverride: ((key: string) => boolean) | null = null;

export function setHiddenOverride(fn: ((key: string) => boolean) | null): void {
  hiddenOverride = fn;
  pushItems();
}

function pushItems(): void {
  const a = ws.asm;
  const v = getViewer();
  if (!a || !v || activeKind() !== "assembly") return;
  // The selection only keeps the occurrences that still exist (after undo, deletion...).
  if (ws.selection.some((k) => !componentAt(k))) {
    setWs("selection", (sel) => sel.filter((k) => !!componentAt(k)));
  }
  const items: AsmItem[] = [];
  const selected = (key: string) => ws.selection.some((s) => key === s || key.startsWith(`${s}/`));
  const pose = posePrefix();
  for (const l of asmLeaves(displayPose ? displayPose(a) : a)) {
    const cached = meshes.get(l.partId);
    const doc = partDoc(l.partId);
    // The 3D sketch being edited is drawn by its editor.
    const lines = l.skeleton && doc && cached?.sketches ? skeletonSegments(unwrap(doc), cached.sketches, ws.sketch3d?.featureId) : undefined;
    const m = l.skeleton ? null : (cached?.mesh ?? null);
    if (!m && !lines?.length) continue;
    items.push({
      key: l.key,
      mesh: m,
      lines,
      matrix: pose ? mul4(pose(l.key), l.matrix) : [...l.matrix],
      color: (!l.skeleton ? colorOverride?.(l.partId) : undefined) ?? doc?.appearance.color ?? "#8fa8c8",
      // Forced color (Measure workbench): it applies to the whole part, faces included.
      faceColors: !l.skeleton && !colorOverride?.(l.partId) ? cached?.faceColors : undefined,
      ...(!l.skeleton && !colorOverride?.(l.partId) && doc?.appearance.finish ? { finish: doc.appearance.finish } : {}),
      selected: selected(l.key),
      hidden: l.hidden || !!hiddenOverride?.(l.key),
    });
  }
  v.setAssembly(items);
  // New component displayed: the view is reframed so it is visible.
  if (items.length > shownCount) v.fit();
  shownCount = items.length;
  updateGizmo();
}

/**
 * Welded frames: each step copies the geometry of the skeleton lines it dresses,
 * and the frame occurrence follows that of the skeleton. No history entry (consequence of the skeleton).
 */
function syncFrames(a: AssemblyDocument): void {
  for (const c of a.components) {
    const s = parts.get(c.partId);
    const src = s?.doc.frameSource;
    if (!s || !src) continue;
    const skel = a.components.find((x) => x.partId === src.partId);
    if (skel && skel.matrix.some((v, i) => Math.abs(v - c.matrix[i]!) > 1e-9)) {
      const i = a.components.indexOf(c);
      setWs("asm", "components", i, "matrix", [...skel.matrix]);
    }
    const lines = skeletonLinesOf(src.partId);
    if (!lines) continue;
    for (const f of s.doc.features) {
      if (f.type !== "frameMembers" || !f.frame) continue;
      const paths = f.frame.segments.flatMap((k) => {
        const l = lines.get(k);
        return l ? [{ key: k, a: l.a, b: l.b }] : [];
      });
      if (JSON.stringify(paths) !== JSON.stringify(f.frame.paths)) {
        f.frame.paths = paths;
        setWs("partRev", (n) => n + 1);
      }
    }
  }
}

/** Lines (2D and 3D) of a skeleton part, by key "sketch:element"; null until it is computed. */
export function skeletonLinesOf(partId: string): Map<string, SkeletonLine> | null {
  const doc = partDoc(partId);
  const solved = meshes.get(partId)?.sketches;
  if (!doc || !solved) return null;
  return new Map(skeletonLines(unwrap(doc), solved, lang()).map((l) => [l.key, l]));
}

/** A part of a flexible subassembly is only locked if the occurrence and the part are fixed. */
function isFixed(key: string): boolean {
  const [head, child] = key.split("/");
  const c = ws.asm?.components.find((x) => x.id === head);
  if (!c) return true;
  if (!child) return !!c.fixed;
  return !!c.fixed && !!componentAt(key)?.fixed;
}

function updateGizmo(): void {
  const v = getViewer();
  const one = ws.selection.length === 1 ? ws.selection[0]! : undefined;
  // The manipulator attaches to a part of the element; the other parts follow (see moveComponent).
  const target = one ? asmLeaves().find((l) => !l.hidden && (l.key === one || l.key.startsWith(`${one}/`)))?.key : undefined;
  if (v && one && target && !isFixed(one) && ws.gizmo !== "none" && !ws.sketch3d && !ws.frame && !isPosed() && !displayPose) v.attachGizmo(target, ws.gizmo);
  else v?.attachGizmo(null);
}

export function setGizmo(mode: "none" | "translate" | "rotate"): void {
  setWs("gizmo", (m) => (m === mode ? "none" : mode));
  if (ws.gizmo !== "none" && isPosed()) setMessage(t("mach.zeroFirst"));
  else if (ws.gizmo !== "none" && ws.selection.length === 0) setMessage(t("asm.selectFirst"));
  updateGizmo();
}

// --- Displayed pose (Motion workbench) ------------------------------------------------------------

/** Assembly displayed in place of the document (image of a motion study); the document is not modified. */
let displayPose: ((a: AssemblyDocument) => AssemblyDocument) | null = null;

export function setDisplayPose(fn: ((a: AssemblyDocument) => AssemblyDocument) | null): void {
  displayPose = fn;
  pushItems();
}

// --- Machine: demo pose -----------------------------------------------------------
// The assembly stays modeled at the zero position; the pose only applies to the display.

/**
 * Displayed kinematics: machine (or fixture) being edited, otherwise that of the assembly
 * (or the machine of the CAM program, displayed machine).
 */
export function activeMachine(): MachineDefinition | FixtureDefinition | null {
  const ext = docKind(activeKind());
  if (ext) return ext.machine?.() ?? null;
  return ws.machineDraft ?? ws.fixtureDraft ?? ws.asm?.machine ?? ws.asm?.fixture ?? null;
}

/** Assembly of the displayed machine: the active assembly, or the machine of the active CAM program. */
export function machineAsm(): AssemblyDocument | null {
  const ext = docKind(activeKind());
  return ext ? (ext.machineAsm?.() ?? null) : ws.asm;
}

/** True if an axis is not at zero (the manipulator is then disabled: it would change the zero position). */
export function isPosed(): boolean {
  return !!activeMachine() && Object.values(ws.axisValues).some((v) => v !== 0);
}

/** Pose transform of a part (by its path), or null at the zero position. */
function posePrefix(): ((key: string) => number[]) | null {
  const m = activeMachine();
  if (!m || !isPosed()) return null;
  const cache = new Map<string, number[]>();
  return (key) => {
    const head = key.split("/")[0]!;
    let p = cache.get(head);
    if (!p) cache.set(head, (p = chainTransform(m, axisOf(m, head)?.id, ws.axisValues)));
    return p;
  };
}

export function setAxisValue(id: string, value: number): void {
  if (!Number.isFinite(value)) return;
  setWs("axisValues", id, value);
  pushItems();
  updateGizmo();
}

export function zeroAxes(): void {
  setWs("axisValues", reconcile({}));
  pushItems();
  updateGizmo();
}

let machinePickHandler: ((key: string, faceIndex: number) => void) | null = null;
/** Receives the faces selected in the view during the machine wizard. */
export function onMachinePick(fn: ((key: string, faceIndex: number) => void) | null): void {
  machinePickHandler = fn;
}

/** Matrix (zero position) of a part of the active assembly, by its path. */
export function leafMatrix(key: string): number[] | null {
  const l = asmLeaves().find((x) => x.key === key);
  return l ? [...l.matrix] : null;
}

// --- Assembly constraints -------------------------------------------------------------------

/** Solves the constraints and places the occurrences (within an assembly edit). */
function solveInto(a: AssemblyDocument): void {
  const r = solveRaw(a);
  for (const u of r.updates) {
    const c = a.components.find((x) => x.id === u.id);
    if (!c) continue;
    c.matrix = u.matrix;
    if (u.flex) c.flex = u.flex;
  }
  setWs({ dof: r.dof, failing: r.failing });
  if (!r.ok) setMessage(t("mate.failing"));
}

/** Solve only (skeleton references updated in `a`, positions unchanged). */
function solveRaw(a: AssemblyDocument, pull?: Map<string, number[]>): ReturnType<typeof solveAssembly> {
  refreshSketchRefs(a);
  return solveAssembly(a, assemblyDoc, { pull });
}

/** Copy of the active assembly ready to solve (skeleton references up to date), for the Motion workbench. */
export function solvableAsm(): AssemblyDocument | null {
  if (!ws.asm) return null;
  const a = clone(ws.asm);
  refreshSketchRefs(a);
  return a;
}

/** Kinematic liaison graph of the active assembly (Tools workbench), null outside an assembly. */
export function asmLiaisons(): LiaisonGraph | null {
  const a = solvableAsm();
  return a ? assemblyLiaisons(a, assemblyDoc) : null;
}

/** Selects these occurrences (or parts of flexible sub-assemblies) in the active assembly. */
export function selectOccurrences(keys: string[]): void {
  setWs("selection", keys.filter((k) => !!componentAt(k)));
  pushItems();
}

/** Skeleton references and part planes: current position of the targeted line or plane. */
function refreshSketchRefs(a: AssemblyDocument): void {
  for (const m of a.mates) {
    for (const ref of [m.a, m.b]) {
      if (!ref.sketchRef) continue;
      const partId = asmLeaves(a).find((l) => l.key === ref.component)?.partId;
      const e = partId ? skeletonEntityOf(partId, ref.sketchRef) : undefined;
      if (e) {
        ref.p = e.p;
        ref.d = e.d;
        ref.kind = e.kind;
      }
    }
  }
}

/** Skeleton elements (lines, planes) of all skeleton parts of the active assembly. */
export function skeletonChoices(): { component: string; componentName: string; entity: SkeletonEntity }[] {
  const a = ws.asm;
  if (!a) return [];
  void ws.masses; // dependency: refreshed when a part is recomputed
  return a.components
    .filter((c) => c.skeleton)
    .flatMap((c) => {
      const doc = partDoc(c.partId);
      const solved = meshes.get(c.partId)?.sketches;
      return doc && solved ? skeletonEntities(unwrap(doc), solved, lang()).map((entity) => ({ component: c.id, componentName: c.name, entity })) : [];
    });
}

/** Planes of ordinary parts (base planes, reference planes, sketch planes), subassembly parts included. */
export function partPlaneChoices(): { component: string; entity: SkeletonEntity }[] {
  if (!ws.asm) return [];
  void ws.masses; // dependency: refreshed when a part is recomputed
  return asmLeaves().flatMap((l) => {
    if (l.skeleton || l.hidden) return [];
    const doc = partDoc(l.partId);
    if (!doc) return [];
    return skeletonEntities(unwrap(doc), meshes.get(l.partId)?.sketches ?? {}, lang())
      .filter((e) => e.kind === "plane")
      .map((entity) => ({ component: l.key, entity }));
  });
}

function skeletonEntityOf(partId: string, ref: { sketch: string; entity: string }): SkeletonEntity | undefined {
  const doc = partDoc(partId);
  if (!doc) return undefined;
  return skeletonEntities(unwrap(doc), meshes.get(partId)?.sketches ?? {}, lang()).find((e) => e.sketch === ref.sketch && e.entity === ref.entity);
}

type V3 = [number, number, number];

/**
 * Concentric with rotation locked: coordinate directions perpendicular to the axis, taken at the current
 * position (axes already coincident) and brought back into each part's frame.
 */
function setLockVectors(a: AssemblyDocument, m: Mate): void {
  const wa = pathMatrix(a, m.a.component.split("/"), assemblyDoc);
  const wb = pathMatrix(a, m.b.component.split("/"), assemblyDoc);
  if (!wa || !wb) return;
  const dir = (M: number[], v: V3): V3 => [0, 1, 2].map((i) => M[i]! * v[0] + M[4 + i]! * v[1] + M[8 + i]! * v[2]) as V3;
  const [dx, dy, dz] = m.a.d;
  // Local vector perpendicular to the axis of A: cross product with the least aligned global axis.
  const k: V3 = Math.abs(dx) <= Math.abs(dy) && Math.abs(dx) <= Math.abs(dz) ? [1, 0, 0] : Math.abs(dy) <= Math.abs(dz) ? [0, 1, 0] : [0, 0, 1];
  const ua: V3 = [dy * k[2] - dz * k[1], dz * k[0] - dx * k[2], dx * k[1] - dy * k[0]];
  const n = Math.hypot(...ua) || 1;
  m.a.u = ua.map((v) => v / n) as V3;
  m.b.u = dir(invRigid(wb), dir(wa, m.a.u));
}

/** Locks or frees the rotation of a concentric constraint (at its current position). */
export function setMateLock(id: string, lock: boolean): void {
  commitAsm((a) => {
    const m = a.mates.find((x) => x.id === id);
    if (!m) return;
    m.lockRotation = lock;
    if (lock) setLockVectors(a, m);
    solveInto(a);
  });
}

/** Designates a skeleton element as an element of a constraint being created. */
export function pickSkeletonForMate(component: string, entity: SkeletonEntity): void {
  pickMateRef({ component, kind: entity.kind, p: entity.p, d: entity.d, sketchRef: { sketch: entity.sketch, entity: entity.entity } });
}

/** Designates an assembly reference plane (fixed reference) as an element of a constraint being created. */
export function pickDatumForMate(id: string, frame: { origin: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } }): void {
  const o = frame.origin;
  const n = frame.normal;
  pickMateRef({ component: "", kind: "plane", p: [o.x, o.y, o.z], d: [n.x, n.y, n.z], datum: id });
}

/** Do both elements belong to the same moving element (same occurrence, or both reference planes)? */
function sameMateBody(a: MateRef, b: MateRef): boolean {
  if (a.datum || b.datum) return !!a.datum && !!b.datum;
  return selectableOf(a.component) === selectableOf(b.component);
}

/** True if an element of this kind, on this occurrence, can complete the constraint being created. */
export function mateAcceptsRef(component: string, kind: MateRefKind): boolean {
  const d = ws.mateDraft;
  if (!d) return false;
  if (d.a && !d.a.datum && component && selectableOf(d.a.component) === selectableOf(component)) return false;
  return mateAccepts(d.type, d.a?.kind, kind);
}

/** Constraint types applicable to the first selected element (all of them while none is selected). */
export function mateTypeAllowed(type: MateType): boolean {
  const a = ws.mateDraft?.a;
  return !a || mateAccepts(type, null, a.kind);
}

/** Element selected in the view (vertex, edge, face) while a constraint is being created. */
export function pickMateEntity(p: MatePick): void {
  if (!ws.mateDraft || !componentAt(p.key)) return;
  pickMateRef({ component: p.key, kind: p.geom.kind, p: [...p.geom.p], d: [...p.geom.d], ...(p.topo ? { topo: { ...p.topo } } : {}) }, p);
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Direction of a reference in the assembly frame. */
function worldDir(ref: MateRef): V3 {
  const m = ref.datum || !ws.asm ? null : pathMatrix(ws.asm, ref.component.split("/"), assemblyDoc);
  const d = ref.d;
  return m ? ([0, 1, 2].map((i) => m[i]! * d[0] + m[4 + i]! * d[1] + m[8 + i]! * d[2]) as V3) : d;
}

/** First element, then second: the constraint is created if it is compatible with the existing constraints. */
function pickMateRef(ref: MateRef, mark: MatePick | null = null): void {
  const draft = ws.mateDraft;
  if (!draft) return;
  if (!mateAccepts(draft.type, draft.a?.kind, ref.kind)) return setMessage(t("mate.incompatible"));
  if (!draft.a) {
    setWs("mateDraft", { a: ref, mark });
    setWs("selection", []);
    pushItems();
    return;
  }
  if (sameMateBody(draft.a, ref)) return setMessage(t("mate.sameComponent"));
  // Parallel or offset planes: the direction closest to the current position (normals in the same or opposite direction) is kept,
  // without flipping the part; "Inverser l'orientation" picks the other one.
  const keepSide = (draft.type === "parallel" || draft.type === "distance") && draft.a.kind === "plane" && ref.kind === "plane" && dot(worldDir(draft.a), worldDir(ref)) > 0;
  const flip = keepSide ? !draft.flip : draft.flip;
  const mate: Mate = { id: newId(), type: draft.type, a: clone(draft.a), b: ref, value: draft.value || undefined, flip };
  const lock = draft.lockRotation && draft.type === "concentric" && draft.a.kind === "axis" && ref.kind === "axis";
  // Trial on a copy: a constraint that cannot be satisfied together with the others is not added.
  const trial = clone(ws.asm!);
  trial.mates.push(mate);
  const before = new Set(ws.failing);
  const r = solveRaw(trial);
  if (r.failing.some((id) => !before.has(id))) return setMessage(t("mate.conflict"));
  commitAsm((a) => {
    a.mates.push(mate);
    solveInto(a);
    // Rotation locked at the position reached once the axes coincide.
    const m = lock ? a.mates.find((x) => x.id === mate.id) : undefined;
    if (m) {
      m.lockRotation = true;
      setLockVectors(a, m);
      solveInto(a);
    }
  });
  setWs({ mateDraft: null, selection: [] });
  pushItems();
}

/** Inserts a new skeleton part (sketches only), to be edited afterwards in context. Returns the created occurrence. */
export function insertSkeleton(): string | undefined {
  if (!ws.asm) return;
  let n = 1;
  while (ws.entries.some((e) => e.name === `${t("asm.skeleton")}${n}`)) n++;
  const doc = createPartDocument(`${t("asm.skeleton")}${n}`);
  doc.display = { planes: { XY: true } };
  registerPart(doc);
  const id = newId();
  commitAsm((a) => void a.components.push({ id, name: doc.name, partId: doc.id!, matrix: [...IDENTITY], fixed: true, skeleton: true }));
  setWs("insertOpen", false);
  return id;
}

/**
 * Modifies an archived part (skeleton edited from the assembly): an entry in its history,
 * then recomputation of the occurrences and constraints that rely on it.
 */
export function updatePartDoc(id: string, mutate: (doc: PartDocument) => void, record = true): void {
  const s = parts.get(id);
  if (!s) return;
  if (record) {
    unpackHistory(s);
    s.past.push(clone(s.doc));
    s.future = [];
  }
  mutate(s.doc);
  setWs("partRev", (n) => n + 1);
  refreshAssembly();
  if (ws.asm?.mates.some((m) => m.a.sketchRef || m.b.sketchRef)) setWs("asm", produce((a) => solveInto(a!)));
  pushItems();
}

/** Current mesh of a part of the assembly (3D sketch attachments). */
export function partMesh(partId: string): MeshPayload | null {
  return meshes.get(partId)?.mesh ?? null;
}

/** Sketches solved at the last recomputation of a part (CAM engraving). */
export function partSketchInfos(partId: string): Record<string, SketchSolveInfo> | undefined {
  return meshes.get(partId)?.sketches;
}

/** Plane or axis of a face selected in the view (part frame) and world matrix of the occurrence. */
export function faceOfLeaf(key: string, triangle: number): { ref: ReturnType<typeof mateRefOf>; matrix: number[] } | null {
  const leaf = asmLeaves().find((l) => l.key === key);
  const mesh = leaf ? meshes.get(leaf.partId)?.mesh : null;
  if (!leaf || !mesh) return null;
  return { ref: mateRefOf(mesh, faceOfTriangle(mesh, triangle)), matrix: [...leaf.matrix] };
}

/** Assembly view to refresh (start and end of a 3D sketch edit). */
export function redrawAssembly(): void {
  pushItems();
  updateGizmo();
}

export function startMate(type: MateType): void {
  // Type change while creating: the first element is kept if it suits the new type.
  const prev = ws.mateDraft;
  const keep = prev?.a && mateAccepts(type, null, prev.a.kind) ? prev : null;
  setWs({
    mateDraft: { type, value: type === "angle" ? "90" : type === "distance" ? "10" : type === "rackpinion" ? "10" : type === "gear" || type === "belt" ? "1" : "", flip: false, lockRotation: false, a: keep?.a ?? null, mark: keep?.mark ?? null },
    gizmo: "none",
  });
  updateGizmo();
}

export function cancelMate(): void {
  setWs("mateDraft", null);
}

export function setMateDraft(patch: Partial<{ value: string; flip: boolean; lockRotation: boolean }>): void {
  if (ws.mateDraft) setWs("mateDraft", patch);
}

export function updateMate(id: string, patch: Partial<Mate>): void {
  commitAsm((a) => {
    const m = a.mates.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
    solveInto(a);
  });
}

export function deleteMate(id: string): void {
  commitAsm((a) => {
    a.mates = a.mates.filter((m) => m.id !== id);
    solveInto(a);
  });
}

let camPickHandler: ((key: string, hit: { faceIndex: number; point?: [number, number, number] }) => void) | null = null;
/** Receives the faces clicked in the CAM view (selection of operations). */
export function onCamPick(fn: typeof camPickHandler): void {
  camPickHandler = fn;
}

export function pickComponent(key: string | null, additive: boolean, hit?: { faceIndex: number; point?: [number, number, number] } | null): void {
  if (activeKind() === "cam") {
    // No occurrence selection in the CAM view: clicks select the faces of the operations.
    if (key && hit) camPickHandler?.(key, hit);
    return;
  }
  if (ws.sketch3d || ws.frame) return; // clicks go to the 3D sketch or frame editor
  if (ws.machinePick) {
    if (key && hit) machinePickHandler?.(key, hit.faceIndex);
    return;
  }
  if (ws.mateDraft) return; // the view selects the constraint elements (pickMateEntity)
  // In the view, a part of a subassembly selects its occurrence (or the part, if the subassembly is flexible).
  if (key && hit !== undefined) key = selectableOf(key);
  setWs("selection", (sel) => (!key ? (additive ? sel : []) : additive ? (sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key]) : [key]));
  pushItems();
}

/** Assembly at the start of the manipulation (the move is always computed from it). */
let dragBefore: AssemblyDocument | null = null;

/**
 * Move with the manipulator. `leaf` is the part carrying the manipulator; the moved element is the
 * selected element (occurrence, or part of a flexible subassembly): it undergoes the same move as the part.
 * A constrained element only moves along its remaining degrees of freedom, during the drag: it is pulled
 * towards the manipulator pose, the constraints keeping priority, and the elements linked to it follow.
 */
export function moveComponent(leaf: string, matrix: number[], final: boolean): void {
  const a0 = ws.asm;
  if (!a0) return;
  if (!dragBefore) dragBefore = clone(a0);
  const start = dragBefore;
  const sel = ws.selection.length === 1 ? ws.selection[0]! : undefined;
  const target = sel && (leaf === sel || leaf.startsWith(`${sel}/`)) ? sel : selectableOf(leaf);
  const current = pathMatrix(start, leaf.split("/"), assemblyDoc);
  if (!current) return;
  const delta = mul4(matrix, invRigid([...current]));
  const [head, child] = target.split("/") as [string, string | undefined];
  /** Free move of the element in `a` (pose at the start of the drag). */
  const apply = (a: AssemblyDocument) => {
    const c = a.components.find((x) => x.id === head);
    if (!c) return;
    if (!child) {
      c.matrix = mul4(delta, [...c.matrix]);
      return;
    }
    const sub = c.assemblyId ? assemblyDoc(c.assemblyId) : undefined;
    const ch = sub?.components.find((x) => x.id === child);
    if (!ch) return;
    const world = mul4(delta, mul4([...c.matrix], [...localOf(c, ch)]));
    c.flex = { ...clone(c.flex ?? {}), [child]: mul4(invRigid([...c.matrix]), world) };
  };
  /** Target poses of the solver bodies of the moved element. */
  const pullOf = (a: AssemblyDocument): Map<string, number[]> => {
    const pull = new Map<string, number[]>();
    const c = a.components.find((x) => x.id === head);
    if (!c) return pull;
    const sub = c.flexible && c.assemblyId ? assemblyDoc(c.assemblyId) : undefined;
    if (!sub) {
      pull.set(head, mul4(delta, [...c.matrix]));
      return pull;
    }
    for (const ch of sub.components) {
      if (child && ch.id !== child) continue;
      pull.set(`${head}/${ch.id}`, mul4(delta, mul4([...c.matrix], [...localOf(c, ch)])));
    }
    return pull;
  };
  const touched = (ref: MateRef) => ref.component === head || ref.component.startsWith(`${head}/`);
  const c0 = start.components.find((x) => x.id === head);
  const constrained = start.mates.some((m) => !m.suppressed && (touched(m.a) || touched(m.b))) || !!(c0?.flexible && c0.assemblyId);
  /**
   * Pose of the assembly for this manipulator position; null if the constraints cannot follow it. The solve
   * starts from the last pose reached (small step at each movement: fast, and no jump to another branch of a
   * mechanism); the target is the manipulator pose, measured from the start of the drag.
   */
  const pose = (): AssemblyDocument | null => {
    if (!constrained) {
      const a = clone(start);
      apply(a);
      return a;
    }
    const a = clone(a0);
    const r = solveRaw(a, pullOf(start));
    // Refused if a constraint breaks (those already failing before the move do not block it).
    if (r.failing.some((id) => !ws.failing.includes(id))) return null;
    for (const u of r.updates) {
      const c = a.components.find((x) => x.id === u.id);
      if (!c) continue;
      c.matrix = u.matrix;
      if (u.flex) c.flex = u.flex;
    }
    return a;
  };
  /** Copies the positions of `src` into `a`. */
  const place = (a: AssemblyDocument, src: AssemblyDocument) => {
    for (const s of src.components) {
      const c = a.components.find((x) => x.id === s.id);
      if (!c) continue;
      if (c.matrix.some((v, i) => v !== s.matrix[i])) c.matrix = [...s.matrix];
      if (JSON.stringify(c.flex) !== JSON.stringify(s.flex)) c.flex = s.flex ? clone(s.flex) : undefined;
    }
  };
  const next = pose();
  if (final) {
    dragBefore = null;
    // Impossible last position: the last pose reached during the drag remains.
    const src = next ?? clone(a0);
    commitAsm((a) => {
      place(a, src);
      if (constrained) solveInto(a);
    }, start);
  } else if (next) {
    setWs("asm", produce((a) => place(a!, next)));
    pushItems();
  } else {
    // The manipulator goes back to the last valid pose.
    pushItems();
  }
}

// --- Operations on occurrences --------------------------------------------------------------

function occurrenceName(a: AssemblyDocument, partId: string): string {
  const base = partDoc(partId)?.name ?? "?";
  const n = a.components.filter((c) => c.partId === partId).length + 1;
  return `${base} <${n}>`;
}

/** Assemblies that can be inserted into the active assembly (without a loop). */
export function insertableAssemblies(): DocEntry[] {
  const self = ws.activeId;
  return ws.entries.filter((e) => e.kind === "assembly" && e.id !== self && !containsAssembly(e.id, self, assemblyDoc));
}

/** Inserts a subassembly (rigid by default). */
export function insertAssembly(id: string): void {
  if (!ws.asm) return;
  const sub = assemblyDoc(id);
  if (!sub) return;
  commitAsm((a) => {
    const base = isFirstBody(a);
    const m = [...IDENTITY];
    if (!base) m[12] = a.components.length * 120;
    const k = a.components.filter((c) => c.assemblyId === id).length + 1;
    a.components.push({ id: newId(), name: `${sub.name} <${k}>`, partId: "", assemblyId: id, matrix: m, fixed: base });
  });
  setWs("insertOpen", false);
}

/** Makes a subassembly flexible (its parts follow their internal constraints) or rigid. */
export function setFlexible(id: string, flexible: boolean): void {
  commitAsm((a) => {
    const c = a.components.find((x) => x.id === id);
    if (!c) return;
    c.flexible = flexible;
    if (!flexible) delete c.flex;
    solveInto(a);
  });
}

/**
 * True as long as the assembly has no base part (skeletons do not count): the next inserted element
 * is one, fixed, with its frame coincident with that of the assembly.
 */
function isFirstBody(a: AssemblyDocument): boolean {
  return !a.components.some((c) => !c.skeleton);
}

export function insertPart(partId: string): void {
  if (!ws.asm) return;
  commitAsm((a) => {
    const base = isFirstBody(a);
    const m = [...IDENTITY];
    if (!base) m[12] = a.components.length * 120; // successive occurrences offset in X so they do not overlap
    a.components.push({ id: newId(), name: occurrenceName(a, partId), partId, matrix: m, fixed: base });
  });
  setWs("insertOpen", false);
}

// --- Drag and drop of a document (Documents panel) into an assembly --------------

/** Document being dragged: dataTransfer is not readable during dragover. */
export const [draggedDoc, setDraggedDoc] = createSignal<string | null>(null);

/** True if the document `docId` can be inserted into the assembly `target` (part, or subassembly without a loop). */
export function canDropInto(docId: string | null, target: string = ws.activeId): boolean {
  if (!docId) return false;
  const dst = ws.entries.find((e) => e.id === target);
  const src = ws.entries.find((e) => e.id === docId);
  if (dst?.kind !== "assembly" || !src) return false;
  if (src.kind === "part") return true;
  return src.kind === "assembly" && !containsAssembly(docId, target, assemblyDoc);
}

/** Inserts the dragged document into the assembly `target` (activated if needed). */
export function dropInto(docId: string, target: string = ws.activeId): void {
  if (!canDropInto(docId, target)) return;
  activate(target);
  if (ws.entries.find((e) => e.id === docId)?.kind === "part") insertPart(docId);
  else insertAssembly(docId);
}

export function copySelection(): void {
  const sel = ws.selection;
  if (!ws.asm || sel.length === 0) return;
  const created: string[] = [];
  commitAsm((a) => {
    for (const id of sel) {
      const c = a.components.find((x) => x.id === id);
      if (!c) continue;
      const m = [...c.matrix];
      m[12] = m[12]! + 20;
      m[13] = m[13]! + 20;
      const nid = newId();
      created.push(nid);
      const name = c.assemblyId ? `${assemblyDoc(c.assemblyId)?.name ?? "?"} <${a.components.filter((x) => x.assemblyId === c.assemblyId).length + 1}>` : occurrenceName(a, c.partId);
      a.components.push({ ...clone(c), id: nid, name, matrix: m, fixed: false });
    }
  });
  setWs("selection", created);
  pushItems();
}

export function deleteSelection(): void {
  // Only top-level occurrences are deleted (a part of a subassembly belongs to it).
  const sel = new Set(ws.selection.filter((k) => !k.includes("/")));
  if (!ws.asm || sel.size === 0) return;
  const gone = (ref: MateRef) => sel.has(ref.component.split("/")[0]!);
  commitAsm((a) => {
    a.components = a.components.filter((c) => !sel.has(c.id));
    a.mates = a.mates.filter((m) => !gone(m.a) && !gone(m.b));
  });
  setWs("selection", []);
}

export function updateComponent(id: string, patch: Partial<AssemblyComponent>): void {
  commitAsm((a) => {
    const c = a.components.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
  });
}

export function groupSelection(): void {
  const sel = ws.selection;
  if (!ws.asm || sel.length === 0) return;
  commitAsm((a) => {
    const gid = newId();
    a.groups.push({ id: gid, name: `${t("asm.group")} ${a.groups.length + 1}` });
    for (const c of a.components) if (sel.includes(c.id)) c.group = gid;
  });
}

export function renameGroup(id: string, name: string): void {
  commitAsm((a) => {
    const g = a.groups.find((x) => x.id === id);
    if (g && name.trim()) g.name = name.trim();
  });
}

export function ungroup(id: string): void {
  commitAsm((a) => {
    a.groups = a.groups.filter((g) => g.id !== id);
    for (const c of a.components) if (c.group === id) delete c.group;
  });
}

/** Reference planes of the assembly (display only: no history). */
export function toggleAssemblyPlane(p: "XY" | "XZ" | "YZ"): void {
  if (!ws.asm) return;
  setWs("asm", "display", (d) => ({ ...d, planes: { ...d?.planes, [p]: !d?.planes?.[p] } }));
}

export function renameAssembly(name: string): void {
  if (!name.trim() || !ws.asm) return;
  commitAsm((a) => void (a.name = name.trim()));
  setWs("entries", (e) => e.id === ws.activeId, "name", name.trim());
}

/** In-context editing: opens the part of an occurrence; a banner allows returning to the assembly. */
export function editPartInContext(componentId: string): void {
  const c = componentAt(componentId);
  if (!c) return;
  const back = ws.activeId;
  activate(c.assemblyId ?? c.partId);
  setWs("returnTo", back);
}

export function returnToAssembly(): void {
  const back = ws.returnTo;
  setWs({ returnTo: null, inPlace: null });
  if (back) activate(back);
}

/**
 * Edit in place: the part opens in its tab, the other parts of the assembly are shown there
 * as ghosts at their relative position; their faces and edges can serve as references (linked).
 */
export function editInPlace(path: string): void {
  const c = componentAt(path);
  if (!ws.asm || !c || c.assemblyId || !c.partId) return;
  const asmId = ws.activeId;
  editPartInContext(path);
  setWs("inPlace", { asmId, path, partId: c.partId });
}

/** Matrix of an occurrence (path) in the frame of an open assembly. */
export function occurrenceMatrix(asmId: string, path: string): number[] | null {
  const a = assemblyDoc(asmId);
  return a ? pathMatrix(a, path.split("/"), assemblyDoc) : null;
}

const [ghostRev, setGhostRev] = createSignal(0);

/** Mesh of an open part, computed when needed; `onReady` when a newly computed mesh arrives. */
export function meshOf(partId: string, onReady?: () => void): MeshPayload | null {
  const doc = partDoc(partId);
  const entry = meshes.get(partId);
  if (doc && (!entry || entry.stale)) ensurePartMesh(partId, doc, () => onReady?.());
  return meshes.get(partId)?.mesh ?? null;
}

/**
 * Ghosts of the edit in place: visible parts of the context assembly (except the edited occurrence),
 * placed in the frame of the edited part. Reactive (meshes computed on demand).
 */
export function inPlaceGhosts(): { key: string; partId: string; mesh: MeshPayload; matrix: number[] }[] {
  void ghostRev();
  const ctx = ws.inPlace;
  const a = ctx ? assemblyDoc(ctx.asmId) : undefined;
  const own = ctx ? occurrenceMatrix(ctx.asmId, ctx.path) : null;
  if (!ctx || !a || !own) return [];
  const inv = invRigid(own);
  return asmLeaves(a).flatMap((l) => {
    // Other occurrences of the same part are excluded: a sketch linked to its own part would be modified endlessly.
    if (l.key === ctx.path || l.partId === ctx.partId || l.hidden || l.skeleton) return [];
    const mesh = meshOf(l.partId, () => setGhostRev((n) => n + 1));
    return mesh ? [{ key: l.key, partId: l.partId, mesh, matrix: mul4(inv, l.matrix) }] : [];
  });
}

// --- Replacing an occurrence ----------------------------------------------------------------

/** Replacements waiting for the mesh of the new part: constraints to re-attach. */
let pendingRemaps: { asmId: string; component: string; partId: string; oldMesh: MeshPayload | null }[] = [];

/** Marks one side of a constraint as not found; true if the constraint has just become so. */
function markLost(m: Mate, side: "a" | "b"): boolean {
  const was = !!m.unresolved;
  m.unresolved = m.unresolved && m.unresolved !== side ? "ab" : side;
  return !was;
}

/** The element on this side is found again: the constraint is no longer flagged on this side; true if something changed. */
function markFound(m: Mate, side: "a" | "b"): boolean {
  if (!m.unresolved || (m.unresolved !== side && m.unresolved !== "ab")) return false;
  if (m.unresolved === "ab") m.unresolved = side === "a" ? "b" : "a";
  else delete m.unresolved;
  return true;
}

/**
 * Replaces top-level occurrences with another part (or a subassembly), keeping their position,
 * fixed state and group. The constraints are kept, then re-attached to the matching elements
 * of the new part; those that cannot be found are flagged (to be selected again).
 */
export function replaceComponent(ids: string[], target: { partId: string } | { assemblyId: string }): void {
  const a0 = ws.asm;
  if (!a0) return;
  const comps = a0.components.filter((c) => ids.includes(c.id) && (c.partId !== ("partId" in target ? target.partId : "") || c.assemblyId !== ("assemblyId" in target ? target.assemblyId : undefined)));
  // Same document (missing file found under another name): nothing to replace, only to display.
  if (!comps.length) return refreshAssembly();
  const toPart = "partId" in target ? target.partId : null;
  const toAsm = "assemblyId" in target ? target.assemblyId : null;
  if (toAsm && containsAssembly(toAsm, ws.activeId, assemblyDoc)) return setMessage(t("asm.replaceLoop"));
  const old = new Map(comps.map((c) => [c.id, c.partId ? (meshes.get(c.partId)?.mesh ?? null) : null]));
  const order = [...old.keys()];
  let lost = 0;
  commitAsm((a) => {
    for (const c of a.components) {
      if (!old.has(c.id)) continue;
      const rank = order.indexOf(c.id) + 1;
      if (toPart) {
        c.name = `${partDoc(toPart)?.name ?? "?"} <${a.components.filter((x) => x.partId === toPart && !old.has(x.id)).length + rank}>`;
        c.partId = toPart;
        delete c.assemblyId;
        delete c.flexible;
        delete c.flex;
      } else if (toAsm) {
        c.name = `${assemblyDoc(toAsm)?.name ?? "?"} <${a.components.filter((x) => x.assemblyId === toAsm && !old.has(x.id)).length + rank}>`;
        c.partId = "";
        c.assemblyId = toAsm;
        delete c.flex;
      }
      delete c.skeleton;
    }
    // References that cannot be re-attached: part of a subassembly, or replacement by a subassembly.
    for (const m of a.mates) {
      for (const side of ["a", "b"] as const) {
        const ref = m[side];
        if (ref.datum || !old.has(ref.component.split("/")[0]!)) continue;
        if ((ref.component.includes("/") || toAsm) && markLost(m, side)) lost++;
      }
    }
    if (lost) solveInto(a);
  });
  if (toPart) pendingRemaps.push(...comps.map((c) => ({ asmId: ws.activeId, component: c.id, partId: toPart, oldMesh: old.get(c.id) ?? null })));
  if (lost) setMessage(t("asm.matesLost").replace("{n}", String(lost)));
  applyRemaps();
}

/** Re-attaches the constraints of the replaced occurrences whose new part mesh is ready. */
function applyRemaps(): void {
  const ready = pendingRemaps.filter((r) => r.asmId === ws.activeId && meshes.get(r.partId)?.mesh && !meshes.get(r.partId)?.stale);
  if (!ready.length || !ws.asm) return;
  pendingRemaps = pendingRemaps.filter((r) => !ready.includes(r));
  let lost = 0;
  setWs(
    "asm",
    produce((a) => {
      for (const r of ready) {
        const mesh = meshes.get(r.partId)!.mesh!;
        if (!a!.components.some((c) => c.id === r.component && c.partId === r.partId)) continue;
        for (const m of a!.mates) {
          for (const side of ["a", "b"] as const) {
            const ref = m[side];
            // Sketch reference (skeleton, part plane): recomputed at solve time.
            if (ref.component !== r.component || ref.datum || ref.sketchRef) continue;
            const hit = remapMateRef({ kind: ref.kind, p: [...ref.p], d: [...ref.d], topo: ref.topo }, r.oldMesh, mesh);
            if (hit) {
              ref.p = hit.p;
              ref.d = hit.d;
              if (hit.topo) ref.topo = hit.topo;
              else delete ref.topo;
              markFound(m, side);
            } else if (markLost(m, side)) lost++;
          }
        }
      }
      solveInto(a!);
    }),
  );
  pushItems();
  if (lost) setMessage(t("asm.matesLost").replace("{n}", String(lost)));
}

/**
 * Constraints whose elements are named (cad-core kernel) on a recomputed part: their geometry follows the element,
 * or they are flagged if it has disappeared. No history entry (consequence of the part), like the sketch references.
 */
function followNamedMates(partId: string, mesh: MeshPayload): void {
  const a = ws.asm;
  if (!a) return;
  const keys = new Set(asmLeaves(a).filter((l) => l.partId === partId).map((l) => l.key));
  const moved = (ref: MateRef, hit: { p: number[]; d: number[] }) => [...ref.p, ...ref.d].some((v, i) => Math.abs(v - [...hit.p, ...hit.d][i]!) > 1e-9);
  const touched = a.mates.some((m) => [m.a, m.b].some((ref) => ref.topo && keys.has(ref.component) && !ref.datum && !ref.sketchRef));
  if (!touched) return;
  let changed = false;
  let lost = 0;
  const next = clone(a);
  for (const m of next.mates) {
    for (const side of ["a", "b"] as const) {
      const ref = m[side];
      if (!ref.topo || !keys.has(ref.component) || ref.datum || ref.sketchRef) continue;
      const hit = resolveNamed({ kind: ref.kind, p: [...ref.p], d: [...ref.d], topo: ref.topo }, mesh);
      if (hit === undefined) continue;
      if (hit === null) {
        if (markLost(m, side)) {
          lost++;
          changed = true;
        }
        continue;
      }
      if (markFound(m, side)) changed = true;
      if (moved(ref, hit)) {
        ref.p = hit.p;
        ref.d = hit.d;
        changed = true;
      }
    }
  }
  if (!changed) return;
  setWs("asm", reconcile(next));
  setWs("asm", produce((x) => solveInto(x!)));
  pushItems();
  if (lost) setMessage(t("asm.matesLost").replace("{n}", String(lost)));
}

/**
 * Constraint flagged after a replacement: it is removed and its creation resumes, the element that remains valid
 * already selected; the user selects the new element.
 */
export function redesignMate(id: string): void {
  const m = ws.asm?.mates.find((x) => x.id === id);
  if (!m) return;
  const keep = m.unresolved === "a" ? m.b : m.unresolved === "b" ? m.a : null;
  const draft = { type: m.type, value: m.value ?? "", flip: !!m.flip, lockRotation: !!m.lockRotation };
  commitAsm((a) => {
    a.mates = a.mates.filter((x) => x.id !== id);
    solveInto(a);
  });
  setWs({ mateDraft: { ...draft, a: keep ? clone(keep) : null, mark: null }, gizmo: "none", selection: [] });
  updateGizmo();
  setMessage(t("asm.redesignHint"));
}

/** Configuration `index` of a part's family: document opened (or created) with this configuration active. */
export async function familyMember(partId: string, index: number): Promise<string | null> {
  const doc = partDoc(partId);
  const row = doc?.family?.rows[index];
  if (!doc?.family || !row) return null;
  if (doc.family.active === index) return partId;
  const source = (doc as PartDocument & { source?: { version?: string } }).source;
  const origin = doc.familyOrigin ?? source?.version ?? doc.id ?? partId;
  // The original part, if it is open with this configuration active.
  const base = partDoc(origin);
  if (base?.family?.active === index) return origin;
  const id = await stableId(origin, row.name);
  if (ws.entries.some((e) => e.id === id)) return id;
  const member = clone(doc);
  member.id = id;
  member.family!.active = index;
  member.familyOrigin = origin;
  const baseName = base?.name ?? (doc.familyOrigin ? doc.name.replace(/ - [^-]*$/, "") : doc.name);
  member.name = `${baseName} - ${row.name}`;
  registerPart(member);
  return id;
}

// --- Interferences ---------------------------------------------------------------------------------

/** Interferences between the visible parts of an assembly (by default the active one; or a pose of the Motion workbench). */
export function interferencesOf(a: AssemblyDocument): ReturnType<typeof computeInterferences> {
  const placed = asmLeaves(a)
    .filter((l) => !l.hidden && !l.skeleton)
    .flatMap((l) => {
      const d = partDoc(l.partId);
      return d ? [{ key: l.key, doc: JSON.parse(JSON.stringify(unwrap(d))) as PartDocument, matrix: [...l.matrix] }] : [];
    });
  return computeInterferences(placed);
}

export async function checkInterferences(): Promise<void> {
  const a = ws.asm;
  if (!a) return;
  setMessage(t("interf.running"));
  try {
    const r = await interferencesOf(a);
    setWs("interferences", r);
    setMessage(r.length === 0 ? t("interf.none") : `${r.length} ${t("interf.found")}`);
  } catch (e) {
    setMessage((e as Error).message);
  }
}

// --- Bill of materials ---------------------------------------------------------------------------------

export interface BomRow {
  item: number;
  partId: string;
  reference: string;
  designation: string;
  material: string;
  quantity: number;
  /** Unit mass (kg), if the material is known. */
  mass: number | null;
}

export function bom(): BomRow[] {
  return bomOf(ws.asm);
}

/** Bill of materials of an assembly (subassemblies expanded, skeletons excluded). */
export function bomOf(a: AssemblyDocument | null | undefined): BomRow[] {
  if (!a) return [];
  const counts = new Map<string, number>();
  for (const l of asmLeaves(a)) if (!l.skeleton) counts.set(l.partId, (counts.get(l.partId) ?? 0) + 1);
  return [...counts].map(([partId, quantity], i) => {
    const d = partDoc(partId);
    const vol = ws.masses[partId]?.volume;
    const density = d?.material?.density;
    return {
      item: i + 1,
      partId,
      reference: d?.properties?.reference || d?.name || "?",
      designation: d?.properties?.designation ?? "",
      material: d?.material?.name ?? "",
      quantity,
      mass: vol !== undefined && density ? (vol / 1000) * density / 1000 : null,
    };
  });
}

export function bomTable(): string[][] {
  return [
    [t("bom.item"), t("doc.reference"), t("doc.designation"), t("doc.material"), t("bom.qty"), t("bom.mass")],
    ...bom().map((r) => [String(r.item), r.reference, r.designation, r.material, String(r.quantity), r.mass === null ? "" : String(Math.round(r.mass * 1000) / 1000)]),
  ];
}

export async function exportBomCsv(): Promise<void> {
  const csv = bomTable()
    .map((row) => row.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";"))
    .join("\r\n");
  try {
    // UTF-8 BOM: Excel displays accented characters correctly.
    await saveBlob(strToU8("﻿" + csv), `${ws.asm?.name ?? "assemblage"}-nomenclature.csv`, "text/csv", ".csv");
  } catch {
    /* cancelled */
  }
}

// --- Assembly files (.vasm: the assembly and all its parts) ------------------------------

/** Saves the active assembly with its parts; false if the user cancelled. */
export function saveAssembly(): Promise<boolean> {
  return ws.asm ? saveDoc(ws.activeId) : Promise.resolve(false);
}

/**
 * A document referenced by an assembly has been found under another identifier (file replaced, copy):
 * the occurrences that designated it now designate the new one.
 */
export function remapAssemblyRef(asmId: string, from: string, to: string): void {
  const fix = (a: AssemblyDocument) => {
    for (const c of a.components) {
      if (c.assemblyId === from) c.assemblyId = to;
      else if (!c.assemblyId && c.partId === from) c.partId = to;
    }
  };
  if (activeKind() === "assembly" && ws.activeId === asmId && ws.asm) setWs("asm", produce((a) => fix(a!)));
  else {
    const a = assemblies.get(asmId);
    if (a) fix(a);
  }
}

/** Subassemblies used (at all levels). */
function subAssemblies(a: AssemblyDocument, out = new Set<string>(), depth = 0): Set<string> {
  for (const c of a.components) {
    if (!c.assemblyId || out.has(c.assemblyId) || depth > 16) continue;
    out.add(c.assemblyId);
    const sub = assemblyDoc(c.assemblyId);
    if (sub) subAssemblies(sub, out, depth + 1);
  }
  return out;
}

/**
 * Opens an assembly and its documents (.vasm archive, catalog machine): the parts and subassemblies
 * not yet open are added, without a tab. `fresh`: the assembly is opened as a new document even if
 * an assembly with the same identifier is already open (two variants of the same catalog machine).
 * `activate: false`: the assembly is only added to the documents (machine of a CAM program).
 */
export function openAssemblyBundle(b: AssemblyBundle, opts: { fresh?: boolean; activate?: boolean } = {}): string {
  for (const doc of b.parts) {
    if (!doc.id || ws.entries.some((e) => e.id === doc.id)) continue;
    parts.set(doc.id, { doc, past: [], future: [] });
    addEntry({ id: doc.id, kind: "part", name: doc.name, background: true });
  }
  for (const sub of b.assemblies) {
    if (!sub.id || ws.entries.some((e) => e.id === sub.id)) continue;
    assemblies.set(sub.id, sub);
    addEntry({ id: sub.id, kind: "assembly", name: sub.name, background: true });
  }
  const open = ws.entries.some((e) => e.id === b.assembly.id);
  const asm = open && opts.fresh ? { ...b.assembly, id: newId() } : b.assembly;
  if (!ws.entries.some((e) => e.id === asm.id)) {
    assemblies.set(asm.id, asm);
    addEntry({ id: asm.id, kind: "assembly", name: asm.name });
  }
  if (opts.activate !== false) activate(asm.id);
  return asm.id;
}

/** Assembly (active by default) with its parts and subassemblies, as plain copies (saving, publishing). */
export function assemblyBundle(a: AssemblyDocument | null = ws.asm): AssemblyBundle {
  if (!a) throw new Error("Aucun assemblage actif");
  const parts = [...new Set(asmLeaves(a).map((l) => l.partId))].map((id) => partDoc(id)).filter((d): d is PartDocument => !!d);
  const subs = [...subAssemblies(a)].map((id) => assemblyDoc(id)).filter((d): d is AssemblyDocument => !!d);
  return { assembly: clone(a), parts: parts.map(clone), assemblies: subs.map(clone) };
}

/**
 * What "Publier le projet" publishes: the active assembly, or, if the active document is a part, the part alone
 * in an assembly wrapper (`partWrapper`) that opening unwraps.
 */
export function projectBundle(): AssemblyBundle {
  if (activeKind() !== "part") return assemblyBundle();
  const part = { ...clone(state.doc), id: ws.activeId };
  const wrapper: AssemblyDocument = {
    ...createAssemblyDocument(part.name),
    partWrapper: true,
    components: [{ id: newId(), name: part.name, partId: part.id, matrix: [...IDENTITY], fixed: true }],
  };
  return { assembly: wrapper, parts: [part], assemblies: [] };
}

/** Adds a part to the open documents without activating it (parts embedded in an assembly or a drawing). */
export function registerPart(doc: PartDocument): void {
  if (!doc.id || ws.entries.some((e) => e.id === doc.id)) return;
  parts.set(doc.id, { doc, past: [], future: [] });
  addEntry({ id: doc.id, kind: "part", name: doc.name });
}

/** Assembly document by identifier (active or archived). */
export function assemblyDoc(id: string): AssemblyDocument | undefined {
  if (activeKind() === "assembly" && ws.activeId === id && ws.asm) return ws.asm;
  return assemblies.get(id);
}

/**
 * Part occurrences of an assembly, subassemblies expanded (composed matrices).
 * `key`: path of the occurrences ("subassembly/occurrence").
 */
export function flattenAssembly(id: string): { key: string; partId: string; matrix: number[]; name: string }[] | null {
  const a = assemblyDoc(id);
  if (!a) return null;
  return a.components
    .flatMap((c) => leavesOf(c, assemblyDoc))
    .filter((l) => !l.hidden && !l.skeleton)
    .map((l) => ({ key: l.key, partId: l.partId, matrix: l.matrix, name: l.name }));
}

/** Product of 4×4 column-major matrices (a × b). */
export function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

/** Opens a part in a new document tab (or activates the one already open). */
export function openPartDocument(doc: PartDocument): void {
  activate(addPartDocument(doc));
}

/** Registers a part among the open documents without activating it; returns its identifier. */
export function addPartDocument(doc: PartDocument): string {
  if (!doc.id) doc.id = newId();
  if (!ws.entries.some((e) => e.id === doc.id)) {
    parts.set(doc.id, { doc, past: [], future: [] });
    addEntry({ id: doc.id, kind: "part", name: doc.name });
  }
  return doc.id;
}

/** Is the document referenced by an assembly, a drawing or a module document? */
function isUsed(id: string): boolean {
  const all = [...assemblies.values(), ...(ws.asm ? [ws.asm] : [])];
  return all.some((a) => a.components.some((c) => c.partId === id || c.assemblyId === id)) || docKinds().some((k) => k.usesDoc(id));
}

/** Closes a document; if it has been modified, first offers to save it. */
export async function closeDocument(id: string): Promise<void> {
  const e = ws.entries.find((x) => x.id === id);
  if (!e) return;
  if (isUsed(id)) return setMessage(t("ws.usedByAssembly"));
  if (isDirty(id)) {
    activate(id); // the user sees the document in question
    const choice = await ask(
      t("ws.unsavedTitle"),
      t("ws.unsavedText").replace("{name}", e.name),
      [
        { id: "save", label: t("ws.save"), primary: true },
        { id: "discard", label: t("ws.discard") },
        { id: "cancel", label: t("ws.cancel") },
      ],
      "cancel",
    );
    if (choice === "cancel") return;
    if (choice === "save" && (ws.activeId !== id || !(await saveActive()))) return;
    if (!ws.entries.some((x) => x.id === id)) return;
  }
  // Last document: a blank part replaces it (the workspace is never empty).
  const others = ws.entries.filter((x) => x.id !== id && !x.background);
  if (!others.length) newPart();
  else if (ws.activeId === id) activate(others[0]!.id);
  dropDocument(e);
  releaseBackground();
}

/** Forgets a closed document. */
function dropDocument({ id, kind }: DocEntry): void {
  parts.delete(id);
  assemblies.delete(id);
  asmHistory.delete(id);
  for (const k of docKinds()) k.forget(id);
  meshes.delete(id);
  savedJson.delete(id);
  forgetCheckpoints(id);
  forgetDocFile(id);
  clearMissing(id);
  if (ws.previews[id]) setWs("previews", produce((x) => void delete x[id]));
  if (kind === "part") forgetKernelDoc(id);
  setWs("entries", (list) => list.filter((x) => x.id !== id));
}

/** Closes the documents without a tab that nothing uses anymore; a modified one gets its tab back. */
function releaseBackground(): void {
  for (let again = true; again; ) {
    again = false;
    for (const e of ws.entries.filter((x) => x.background && !isUsed(x.id))) {
      if (isDirty(e.id)) setWs("entries", (x) => x.id === e.id, "background", false);
      else {
        dropDocument(e);
        again = true; // a closed subassembly releases its parts
      }
    }
  }
}

// --- Checkpoints (numbered and commented versions, see checkpoints.ts) ---------------------------

/** Document of a checkpoint: the part, or the assembly and each of its documents. */
export interface CheckpointItem {
  id: string;
  kind: "part" | "assembly";
  name: string;
  /** Differs from the current version (always true for a document that is no longer open). */
  changed: boolean;
  /** Open in the workspace (otherwise it will be reopened from the checkpoint). */
  open: boolean;
  /** The versioned document itself (first of the list). */
  root: boolean;
}

const isOpen = (id: string) => ws.entries.some((e) => e.id === id);

/** Replaces the whole content of an object (store or archived document) with that of another. */
function replaceContent<T extends object>(target: T, src: T): void {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, clone(src));
}

/**
 * The file of an open part or assembly has been rewritten elsewhere (another window): its content is replaced
 * in place (undoable, identifier kept) and recorded as saved. The assemblies that use it are refreshed.
 */
export function replaceFromFile(id: string, doc: PartDocument | AssemblyDocument): void {
  const kind = ws.entries.find((e) => e.id === id)?.kind;
  if (kind === "part") {
    const d = { ...(doc as PartDocument), id };
    if (activeKind() === "part" && state.doc.id === id) restoreDoc(d);
    else updatePartDoc(id, (x) => replaceContent(x, d));
  } else if (kind === "assembly") {
    const a = { ...(doc as AssemblyDocument), id };
    if (activeKind() === "assembly" && ws.activeId === id && ws.asm) commitAsm((x) => replaceContent(x, a));
    else {
      replaceAssemblyDoc(id, a);
      setWs("partRev", (r) => r + 1);
      refreshAssembly();
    }
  } else return;
  setWs("entries", (e) => e.id === id, "name", doc.name);
  markSaved([id]);
}

/** Creates a checkpoint of the document (part, or assembly with its documents). */
export function createCheckpoint(id: string, comment: string): Checkpoint | undefined {
  const kind = kindOf(id);
  const doc = kind === "part" ? partDoc(id) : kind === "assembly" ? assemblyDoc(id) : undefined;
  if (!doc) return;
  const snap = kind === "part" ? clone(doc as PartDocument) : assemblyBundle(doc as AssemblyDocument);
  const c = addCheckpoint(id, snap, comment.trim(), doc.properties?.author || undefined);
  setMessage(t("ckpt.created").replace("{n}", String(c.number)));
  return c;
}

/** Documents of a checkpoint, compared with their current state. */
export function checkpointItems(id: string, n: number): CheckpointItem[] {
  const snap = snapshotOf(id, n);
  if (!snap) return [];
  const item = (doc: PartDocument | AssemblyDocument, kind: "part" | "assembly", root = false): CheckpointItem => {
    const cur = kind === "part" ? partDoc(doc.id!) : assemblyDoc(doc.id!);
    return { id: doc.id!, kind, name: doc.name, changed: !cur || canonical(cur) !== canonical(doc), open: !!cur, root };
  };
  if ("format" in snap) return [item(snap, "part", true)];
  return [item(snap.assembly, "assembly", true), ...snap.parts.filter((p) => p.id).map((p) => item(p, "part")), ...snap.assemblies.map((a) => item(a, "assembly"))];
}

/** Has the document been modified since its current version (or does it have no version yet)? */
export function hasUnversionedChanges(id: string): boolean {
  const head = checkpointsOf(id).head;
  return head === null || checkpointItems(id, head).some((i) => i.changed);
}

/** Replaces an archived subassembly (one entry in its history). */
function replaceAssemblyDoc(id: string, doc: AssemblyDocument): void {
  const old = assemblies.get(id);
  const h = unpackHistory(asmHistory.get(id) ?? { past: [], future: [] });
  if (old) h.past.push(clone(old));
  h.future = [];
  asmHistory.set(id, h);
  assemblies.set(id, clone(doc));
}

/**
 * Reverts to a version: the document is replaced in place (undoable), the later versions are kept
 * and the next checkpoint will start from this one. Assembly: only the documents of `selected` revert
 * (those that are no longer open are reopened from the checkpoint).
 */
export function restoreCheckpoint(id: string, n: number, selected: Iterable<string> = [id]): void {
  const snap = snapshotOf(id, n);
  if (!snap) return;
  if (ws.activeId !== id) activate(id);
  const rename = (docId: string, name: string) => setWs("entries", (e) => e.id === docId, "name", name);
  if ("format" in snap) restoreDoc(snap);
  else {
    const sel = new Set(selected);
    for (const p of snap.parts) {
      if (!p.id || !sel.has(p.id)) continue;
      if (!isOpen(p.id)) registerPart(p);
      else {
        updatePartDoc(p.id, (d) => replaceContent(d, p));
        rename(p.id, p.name);
      }
    }
    for (const sub of snap.assemblies) {
      if (!sel.has(sub.id)) continue;
      if (!isOpen(sub.id)) {
        assemblies.set(sub.id, sub);
        addEntry({ id: sub.id, kind: "assembly", name: sub.name });
      } else {
        replaceAssemblyDoc(sub.id, sub);
        rename(sub.id, sub.name);
      }
    }
    if (sel.has(id)) {
      commitAsm((a) => replaceContent(a, { ...snap.assembly, id }));
      rename(id, snap.assembly.name);
    } else {
      setWs("partRev", (r) => r + 1);
      refreshAssembly();
    }
  }
  setHead(id, n);
  setMessage(t("ckpt.restored").replace("{n}", String(n)));
  // The previews of this document are no longer needed: the restored state is in its own tab.
  for (const [root, p] of Object.entries(ws.previews)) if (p.source === id) void closePreview(root);
}

/**
 * Opens a version in new tabs (new identifiers), without touching the current document.
 * Returns the opened documents, the versioned document first.
 */
export function openCheckpointCopy(id: string, n: number): string[] {
  const snap = snapshotOf(id, n);
  if (!snap) return [];
  const suffix = ` (v${n})`;
  if ("format" in snap) {
    const doc = { ...snap, id: newId(), name: snap.name + suffix };
    openPartDocument(doc);
    return [doc.id];
  }
  // All documents of the checkpoint get new identifiers (references included).
  let json = JSON.stringify(snap);
  for (const old of [snap.assembly.id, ...snap.parts.map((p) => p.id!), ...snap.assemblies.map((a) => a.id)]) if (old) json = json.split(old).join(newId());
  const b = JSON.parse(json) as AssemblyBundle;
  for (const d of [b.assembly, ...b.parts, ...b.assemblies]) d.name += suffix;
  openAssemblyBundle(b);
  return [b.assembly.id, ...b.assemblies.map((a) => a.id), ...b.parts.map((p) => p.id!)];
}

/** Closes the tabs of a preview; those that have been modified stay open as ordinary documents. */
async function closePreview(rootId: string): Promise<void> {
  const p = ws.previews[rootId];
  if (!p) return;
  setWs("previews", produce((x) => void delete x[rootId]));
  // The assembly first: its parts are no longer used and can then be closed.
  for (const doc of p.docs) if (isOpen(doc) && !isDirty(doc)) await closeDocument(doc);
}

/**
 * Preview of a version: opened in a preview tab, which replaces the previous preview of the same document.
 * Once modified, the preview becomes an ordinary document (it is no longer replaced).
 */
export async function previewCheckpoint(id: string, n: number): Promise<void> {
  const old = Object.entries(ws.previews).find(([root, p]) => p.source === id && isOpen(root))?.[0];
  if (old && ws.previews[old]!.number === n) return activate(old);
  const docs = openCheckpointCopy(id, n);
  if (!docs.length) return;
  setWs("previews", docs[0]!, { source: id, number: n, docs });
  if (old) {
    if (isDirty(old)) setWs("previews", produce((x) => void delete x[old]));
    else await closePreview(old);
  }
}

/** Preview tab of a version (null otherwise, or if it has been modified). Reactive. */
export function previewOf(docId: string): { source: string; number: number } | null {
  const p = ws.previews[docId];
  return p && !isDirty(docId) ? p : null;
}

/**
 * Version preview a document belongs to (the preview's root or one of its parts / subassemblies),
 * as long as it has not been modified: its versions are those of the source document. Reactive.
 */
export function previewSource(docId: string): { source: string; number: number } | null {
  for (const [root, p] of Object.entries(ws.previews)) {
    if ((root === docId || p.docs.includes(docId)) && !isDirty(docId) && isOpen(p.source)) return { source: p.source, number: p.number };
  }
  return null;
}
