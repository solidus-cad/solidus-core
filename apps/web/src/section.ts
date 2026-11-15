import { createStore, produce } from "solid-js/store";
import type { SectionSettings } from "@solidus-cad/viewer";
import { getViewer, state } from "./store.ts";
import { activeKind, ws } from "./workspace.ts";

/**
 * Cross-section view of the active part or assembly: an offset reference plane, kept side,
 * filling, and occurrences not cut. Or a section lamp, a hole that follows the pointer.
 * Display state per document (not saved, no history).
 */

export type SectionPlane = "XY" | "XZ" | "YZ";

/** Section by a plane, or lamp: hole along the view around the point under the pointer. */
export type SectionMode = "plane" | "lamp";

export interface SectionState {
  plane: SectionPlane;
  offset: number;
  flip: boolean;
  cap: boolean;
  /** Settings panel closed: the section stays displayed. */
  panelClosed: boolean;
  /** Occurrences (top-level keys or paths) not cut. */
  excluded: string[];
  mode: SectionMode;
  /** Lamp: radius of the hole and depth beyond the surface under the pointer (mm). */
  radius: number;
  depth: number;
  /** Lamp: follows the pointer; otherwise it stays where it is. */
  follow: boolean;
}

const NORMALS: Record<SectionPlane, [number, number, number]> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };

const [sections, setSections] = createStore<Record<string, SectionState | undefined>>({});

/** Section of the active document (part or assembly). */
export function activeSection(): SectionState | undefined {
  return activeKind() === "drawing" ? undefined : sections[ws.activeId];
}

export function sectionSettings(s: SectionState | undefined): SectionSettings | null {
  if (!s) return null;
  const lamp = s.mode === "lamp" ? { radius: s.radius, depth: s.depth, follow: s.follow } : undefined;
  return { normal: NORMALS[s.plane], offset: s.offset, flip: s.flip, cap: s.cap, excluded: [...s.excluded], lamp };
}

/** Extent of the model along the plane normal (the position slider depends on it). */
export function sectionRange(plane: SectionPlane): { min: number; max: number } {
  void state.mass; // dependencies: geometry of the part or assembly
  void ws.asm?.components.length;
  void ws.masses;
  const r = getViewer()?.extentAlong(NORMALS[plane]);
  return r && r.max > r.min ? r : { min: -100, max: 100 };
}

/** Size of the model: its largest extent along the axes (bounds the radius and depth of the lamp). */
export function modelSize(): number {
  return Math.max(
    ...(["XY", "XZ", "YZ"] as SectionPlane[]).map((p) => {
      const r = sectionRange(p);
      return r.max - r.min;
    }),
  );
}

/** Length rounded to 2 significant digits. */
const roundLength = (v: number): number => Number(Math.max(v, 1e-3).toPrecision(2));

/** Kept side, such that the section faces the camera. */
function facingFlip(plane: SectionPlane): boolean {
  const d = getViewer()?.viewDirection();
  if (!d) return false;
  const n = NORMALS[plane];
  return n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0;
}

function middle(plane: SectionPlane): number {
  const r = sectionRange(plane);
  return Math.round(((r.min + r.max) / 2) * 100) / 100;
}

/** Off → on, on with the panel closed → panel reopened, on with the panel open → off. */
export function toggleSection(): void {
  const id = ws.activeId;
  if (activeKind() === "drawing") return;
  const s = sections[id];
  if (s?.panelClosed) setSections(id, "panelClosed", false);
  else if (s) setSections(id, undefined);
  else {
    const size = modelSize();
    setSections(id, {
      plane: "XZ",
      offset: middle("XZ"),
      flip: facingFlip("XZ"),
      cap: true,
      panelClosed: false,
      excluded: [],
      mode: "plane",
      radius: roundLength(size / 8),
      depth: roundLength(size / 4),
      follow: true,
    });
  }
}

/** Closes the settings panel and keeps the section. */
export function closeSectionPanel(): void {
  updateSection({ panelClosed: true });
}

export function setSectionPlane(plane: SectionPlane): void {
  const id = ws.activeId;
  if (sections[id]) setSections(id, { plane, offset: middle(plane), flip: facingFlip(plane) });
}

export function updateSection(patch: Partial<Omit<SectionState, "plane" | "excluded">>): void {
  const id = ws.activeId;
  if (sections[id]) setSections(id, patch);
}

/** Cuts or not an assembly occurrence. */
export function toggleCut(key: string): void {
  const id = ws.activeId;
  if (!sections[id]) return;
  setSections(
    id,
    produce((s) => {
      s!.excluded = s!.excluded.includes(key) ? s!.excluded.filter((k) => k !== key) : [...s!.excluded, key];
    }),
  );
}
