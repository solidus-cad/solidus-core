import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import {
  assemblyDatumPlanes,
  DATUM_METHODS,
  defaultDatumPlane,
  newId,
  type AssemblyDocument,
  type AssemblyPlane,
  type DatumOutcome,
  type DatumPlaneDef,
  type DatumRef,
  type DatumRole,
} from "@solidus-cad/sdk";
import { assignRef, firstEmptySlot } from "../datum.ts";
import { commitAsm, leafMatrix, setWs, ws } from "../workspace.ts";

/**
 * Reference planes of an assembly: built on the base planes, other planes of the assembly
 * or the faces, edges and vertices of parts (in the part's coordinate system: they follow the occurrence when it moves).
 */

interface PlaneEdit {
  id: string;
  isNew: boolean;
  /** Assembly before editing: restored if the user cancels, history entry otherwise. */
  before: AssemblyDocument;
}

export const [asmPlanes, setAsmPlanes] = createStore<{ edit: PlaneEdit | null; slot: number | null; selected: string | null }>({
  edit: null,
  slot: null,
  selected: null,
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(unwrap(v))) as T;

/** Computed planes of the active assembly. */
export function asmDatums(): Map<string, DatumOutcome> {
  const a = ws.asm;
  if (!a?.planes?.length) return new Map();
  void a.components.map((c) => c.matrix); // dependency: planes follow the occurrences
  return assemblyDatumPlanes(a.planes, (key) => leafMatrix(key) ?? undefined);
}

/** Displayed planes: visible, or being edited. */
export function asmDatumViews(): { id: string; frame: NonNullable<DatumOutcome["frame"]>; center: NonNullable<DatumOutcome["center"]> }[] {
  const planes = ws.asm?.planes ?? [];
  const out = asmDatums();
  return planes.flatMap((p) => {
    const r = out.get(p.id);
    return r?.frame && (!p.hidden || asmPlanes.edit?.id === p.id) ? [{ id: p.id, frame: r.frame, center: r.center! }] : [];
  });
}

export function editingAsmPlane(): AssemblyPlane | undefined {
  const id = asmPlanes.edit?.id;
  return id ? ws.asm?.planes?.find((p) => p.id === id) : undefined;
}

/** Role expected by the active slot of the plane being edited (null: no picking in progress). */
export function asmPlaneRole(): DatumRole | null {
  const p = editingAsmPlane();
  const slot = asmPlanes.slot;
  return p && slot !== null ? (DATUM_METHODS[p.def.method].roles[slot] ?? null) : null;
}

function uniqueName(a: AssemblyDocument): string {
  const base = "Plan";
  let n = 1;
  while (a.planes?.some((p) => p.name === `${base}${n}`)) n++;
  return `${base}${n}`;
}

export function beginAsmPlane(): void {
  const a = ws.asm;
  if (!a) return;
  if (asmPlanes.edit) confirmAsmPlane();
  const before = clone(a);
  const sel = asmPlanes.selected;
  const first: DatumRef | null = sel === "XY" || sel === "XZ" || sel === "YZ" ? { kind: "base", name: sel } : sel && a.planes?.some((p) => p.id === sel) ? { kind: "datum", id: sel } : null;
  const plane: AssemblyPlane = { id: newId(), name: uniqueName(a), def: defaultDatumPlane("offset", first) };
  // The assembly picking modes are mutually exclusive.
  setWs({ mateDraft: null, gizmo: "none", insertOpen: false });
  setWs("asm", produce((x) => void (x!.planes = [...(x!.planes ?? []), plane])));
  setAsmPlanes({ edit: { id: plane.id, isNew: true, before }, slot: firstEmptySlot(plane.def) });
}

export function editAsmPlane(id: string): void {
  const a = ws.asm;
  if (!a?.planes?.some((p) => p.id === id) || asmPlanes.edit?.id === id) return;
  if (asmPlanes.edit) confirmAsmPlane();
  setWs({ mateDraft: null, gizmo: "none" });
  setAsmPlanes({ edit: { id, isNew: false, before: clone(a) }, slot: null });
}

/** Modifies the plane being edited (preview, no history). */
export function updateAsmPlane(mutate: (d: DatumPlaneDef) => void): void {
  const id = asmPlanes.edit?.id;
  if (!id) return;
  setWs("asm", produce((a) => {
    const p = a?.planes?.find((x) => x.id === id);
    if (p) mutate(p.def);
  }));
}

export function renameAsmPlane(name: string): void {
  const id = asmPlanes.edit?.id;
  if (!id || !name.trim()) return;
  setWs("asm", produce((a) => {
    const p = a?.planes?.find((x) => x.id === id);
    if (p) p.name = name.trim();
  }));
}

export function setAsmPlaneSlot(slot: number | null): void {
  setAsmPlanes("slot", slot);
}

/** Element picked in the view for the plane being edited. */
export function pickAsmDatumRef(ref: DatumRef): void {
  const slot = asmPlanes.slot;
  const id = asmPlanes.edit?.id;
  if (slot === null || !id || (ref.kind === "datum" && ref.id === id)) return;
  let next: number | null = slot;
  updateAsmPlane((d) => void (next = assignRef(d, slot, ref)));
  setAsmPlanes("slot", next);
}

export function confirmAsmPlane(): void {
  const e = asmPlanes.edit;
  if (!e) return;
  setAsmPlanes({ edit: null, slot: null });
  const after = clone(ws.asm);
  if (!after || JSON.stringify(after) === JSON.stringify(e.before)) return;
  // History entry: state before editing, then final state.
  setWs("asm", reconcile(e.before));
  commitAsm((a) => void (a.planes = after.planes), clone(e.before));
}

export function cancelAsmPlane(): void {
  const e = asmPlanes.edit;
  if (!e) return;
  setAsmPlanes({ edit: null, slot: null });
  setWs("asm", reconcile(e.before));
}

export function deleteAsmPlane(id: string): void {
  if (asmPlanes.edit?.id === id) cancelAsmPlane();
  commitAsm((a) => void (a.planes = (a.planes ?? []).filter((p) => p.id !== id)));
  if (asmPlanes.selected === id) setAsmPlanes("selected", null);
}

/** Visibility of a plane (display only: no history). */
export function toggleAsmPlane(id: string): void {
  setWs("asm", produce((a) => {
    const p = a?.planes?.find((x) => x.id === id);
    if (p) p.hidden = !p.hidden || undefined;
  }));
}

/** Selected plane (click in the tree or the view): first element of the next plane created. */
export function selectAsmPlane(id: string | null): void {
  setAsmPlanes("selected", (s) => (s === id ? null : id));
}
