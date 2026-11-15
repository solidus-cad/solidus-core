import { createEffect, createRoot, createSignal, on, untrack, type Component } from "solid-js";
import { createStore } from "solid-js/store";
import type { Inertia, Material } from "@solidus-cad/sdk";
import { combineInertia, rotateTensor, tensorOf, type M3 } from "./inertia.ts";
import { circlePoints, type CirclePick, type SnapPoint, type Viewer } from "@solidus-cad/viewer";
import { applyMaterial, editingSketch, setMaterial, state } from "./store.ts";
import { activeKind, asmLeaves, occurrenceLabel, partDoc, redrawAssembly, setColorOverride, updatePartDoc, ws } from "./workspace.ts";

/**
 * Tools workbench (formerly Measure), on the active part or assembly:
 * - liaison graph of an assembly (kinematic classes and normalised joints, see LiaisonGraph.tsx);
 * - tools contributed by modules (`registerMeasureTool`: pipe / cable routing…);
 * - distance between two snapped points (vertex, circle centre, edge, face);
 * - diameter and radius of a circular edge (circle or arc) or of a cylindrical face;
 * - volume, mass and centre of gravity of the part, of the selected occurrences, or of the whole assembly.
 * Parts without a material are flagged (list and 3D view): their mass is not counted.
 * Display state, not saved.
 */

export type MeasureTool = "distance" | "circle" | "mass" | "liaisons" | (string & {});

/**
 * Tool of the Tools workbench provided by a module (pipe / cable routing…): it takes over the picking in the view
 * and the measurement panel while it is the current tool (`measure.tool === id`). Its ribbon button is a
 * `toolRegistry` entry (plugins/tools.ts) whose `run` calls `setTool(id)`.
 */
export interface MeasureToolExtension {
  id: string;
  title: () => string;
  /** Content of the measurement panel, and CSS class added to the panel. */
  panel: Component;
  panelClass?: string;
  /** Available in assemblies only (back to the distance tool elsewhere). */
  assemblyOnly?: boolean;
  /** A result is displayed (Clear button, Escape). */
  hasMeasure?(): boolean;
  clear?(): void;
  /** Escape: undoes the last input; false if there was nothing to undo. */
  undo?(): boolean;
  /** Point / circle picking in the view while the tool is current (null: none). */
  pointPicking?(): ((p: SnapPoint) => void) | null;
  circlePicking?(): ((c: CirclePick) => void) | null;
  /** Graphics shown in the view while the tool is current (same arguments as `Viewer.setMeasureGraphics`). */
  graphics?(): { points: V3[]; segments: [V3, V3][]; polylines: V3[][] };
}

const [moduleTools, setModuleTools] = createSignal<readonly MeasureToolExtension[]>([]);
export function registerMeasureTool(tool: MeasureToolExtension): void {
  setModuleTools((all) => [...all.filter((x) => x.id !== tool.id), tool]);
}
/** Module tool currently selected, if any. */
export const currentModuleTool = (): MeasureToolExtension | undefined => moduleTools().find((x) => x.id === measure.tool);
type V3 = [number, number, number];

interface MeasureState {
  on: boolean;
  tool: MeasureTool;
  /** Picked points (two at most; a third click restarts the measurement). */
  points: SnapPoint[];
  /** Picked circle (diameter / radius measurement). */
  circle: CirclePick | null;
  /** Assembly: selected occurrences or the whole assembly. */
  scope: "selection" | "all";
  /** Reduction point for the inertia. */
  inertiaAt: "cog" | "origin";
  /** Centre of gravity and volume centre displayed in the view. */
  showCentres: boolean;
}

export const [measure, setMeasure] = createStore<MeasureState>({ on: false, tool: "distance", points: [], circle: null, scope: "all", inertiaAt: "cog", showCentres: true });

/**
 * Circle picking taken over by a module tool of the Tools tab (belt drive…): while set, it replaces the
 * measurement picking (points and circles) and the measurement panel is hidden.
 */
const [moduleCircle, setModuleCircle] = createSignal<((c: CirclePick) => void) | null>(null);
export function takeCirclePicking(fn: ((c: CirclePick) => void) | null): void {
  setModuleCircle(() => fn);
}
/** True while a module tool picks circles in the view. */
export const modulePicking = (): boolean => !!moduleCircle();

/** Colour of the parts without a material during the mass calculation. */
export const MISSING_COLOR = "#e5484d";

export function openMeasure(tool: MeasureTool = measure.tool): void {
  if (activeKind() === "drawing") return;
  setMeasure({ on: true, tool, scope: activeKind() === "assembly" && ws.selection.length > 0 ? "selection" : measure.scope });
}

export function closeMeasure(): void {
  setMeasure({ on: false, points: [], circle: null });
}

export function setTool(tool: MeasureTool): void {
  setMeasure({ tool, scope: tool === "mass" && ws.selection.length > 0 ? "selection" : measure.scope });
}

/** Clears the current measurement (points, circle). */
export function clearPoints(): void {
  currentModuleTool()?.clear?.();
  setMeasure({ points: [], circle: null });
}

/** True if a measurement of the current tool is displayed (Clear button, Escape key). */
export function hasMeasure(): boolean {
  return (measure.tool === "distance" && measure.points.length > 0) || (measure.tool === "circle" && !!measure.circle) || !!currentModuleTool()?.hasMeasure?.();
}

/** End of the displayed radius (point on the circle). */
export function radiusEnd(c: CirclePick): V3 {
  return circlePoints(c.center, c.normal, c.radius, 4)[0]!;
}

function addPoint(p: SnapPoint): void {
  setMeasure("points", (pts) => (pts.length >= 2 ? [p] : [...pts, p]));
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Distance and per-axis deltas between the two picked points. */
export function distance(): { d: number; delta: V3 } | null {
  const [a, b] = measure.points;
  if (!a || !b) return null;
  const delta = sub(b.point, a.point);
  return { d: Math.hypot(...delta), delta };
}

export type Axis = "X" | "Y" | "Z";

/** Axis colours (CAD convention, identical to the view cube). */
export const AXIS_COLORS: Record<Axis, string> = { X: "#e5484d", Y: "#30a46c", Z: "#3e63dd" };

/** Path from the first to the second point parallel to the axes (X, then Y, then Z); zero deltas are omitted. */
export function axisLegs(): { axis: Axis; a: V3; b: V3; d: number }[] {
  const [p, q] = measure.points;
  if (!p || !q) return [];
  const out: { axis: Axis; a: V3; b: V3; d: number }[] = [];
  let a: V3 = [...p.point];
  (["X", "Y", "Z"] as const).forEach((axis, i) => {
    const d = q.point[i]! - p.point[i]!;
    if (Math.abs(d) < 1e-6) return;
    const b: V3 = [...a];
    b[i] = q.point[i]!;
    out.push({ axis, a, b, d });
    a = b;
  });
  return out;
}

/** Name of the element carrying a point (assembly occurrence or part). */
export function pointOwner(p: { key: string | null }): string {
  return p.key ? occurrenceLabel(p.key) : state.doc.name;
}

// --- Volume and mass --------------------------------------------------------------------------------

export interface MassLine {
  partId: string;
  name: string;
  quantity: number;
  material: string | null;
  /** Unit volume (mm³), null until the part is computed. */
  volume: number | null;
  /** Unit mass (kg), null without a material. */
  mass: number | null;
}

export interface MassReport {
  lines: MassLine[];
  /** Total volume (mm³) of the computed parts. */
  volume: number;
  /** Total mass (kg) of the parts that have a material. */
  mass: number;
  /** Centre of gravity (parts with a material), null without mass. */
  cog: V3 | null;
  /** Volume centre (all computed parts): distinct from the centre of gravity if the materials differ. */
  cov: V3 | null;
  /** Mass inertia (kg·mm²), axes parallel to the absolute frame: at the centre of gravity and at the origin. */
  inertia: { cog: Inertia; origin: Inertia } | null;
  /** Partial inertia: parts without a material (or without a computed inertia) are not counted. */
  inertiaPartial: boolean;
  /** Parts without a material (their mass is missing from the total). */
  missing: number;
  /** Parts not yet computed. */
  pending: number;
}

const kg = (volume: number, density: number) => (volume / 1000) * density / 1000;

function applyPoint(m: number[], p: V3): V3 {
  return [0, 1, 2].map((i) => m[i]! * p[0] + m[4 + i]! * p[1] + m[8 + i]! * p[2] + m[12 + i]!) as V3;
}

/** Occurrences kept for the calculation (assembly): all of them, or those under the selection. */
function scopedLeaves() {
  const leaves = asmLeaves().filter((l) => !l.skeleton);
  if (measure.scope === "all" || ws.selection.length === 0) return leaves;
  return leaves.filter((l) => ws.selection.some((s) => l.key === s || l.key.startsWith(`${s}/`)));
}

export function massReport(): MassReport {
  const asm = activeKind() === "assembly";
  const rows: { partId: string; name: string; matrix: number[] | null }[] = asm
    ? scopedLeaves().map((l) => ({ partId: l.partId, name: l.name, matrix: l.matrix }))
    : [{ partId: state.doc.id ?? "", name: state.doc.name, matrix: null }];
  const lines = new Map<string, MassLine>();
  /** Contributions of the parts with a material: mass, centre and tensor (absolute frame, at the part centre). */
  const bodies: { m: number; c: V3; t: M3 | null }[] = [];
  let volume = 0;
  let mass = 0;
  let pending = 0;
  const cm: V3 = [0, 0, 0];
  const cv: V3 = [0, 0, 0];
  for (const r of rows) {
    const doc = asm ? partDoc(r.partId) : state.doc;
    const props = asm ? ws.masses[r.partId] : state.mass;
    const density = doc?.material?.density ?? null;
    const line = lines.get(r.partId);
    if (line) line.quantity++;
    else
      lines.set(r.partId, {
        partId: r.partId,
        name: doc?.name ?? r.name,
        quantity: 1,
        material: doc?.material?.name ?? null,
        volume: props?.volume ?? null,
        mass: props && density ? kg(props.volume, density) : null,
      });
    if (!props) {
      pending++;
      continue;
    }
    const c = r.matrix ? applyPoint(r.matrix, props.center) : props.center;
    volume += props.volume;
    for (let i = 0; i < 3; i++) cv[i]! += c[i]! * props.volume;
    if (density) {
      const m = kg(props.volume, density);
      mass += m;
      for (let i = 0; i < 3; i++) cm[i]! += c[i]! * m;
      // Volume inertia (mm⁵) × density (g/cm³ = 1e-6 kg/mm³) → kg·mm².
      const t = props.inertia ? tensorOf(props.inertia, density * 1e-6) : null;
      bodies.push({ m, c, t: t && r.matrix ? rotateTensor(r.matrix, t) : t });
    }
  }
  const all = [...lines.values()];
  const cog: V3 | null = mass > 0 ? (cm.map((x) => x / mass) as V3) : null;
  const cov: V3 | null = volume > 0 ? (cv.map((x) => x / volume) as V3) : null;
  const inertia = cog ? combineInertia(bodies, cog, mass) : null;
  const missing = all.filter((l) => !l.material).reduce((n, l) => n + l.quantity, 0);
  return {
    lines: all.sort((a, b) => Number(a.material !== null) - Number(b.material !== null) || a.name.localeCompare(b.name)),
    volume,
    mass,
    cog,
    cov,
    inertia,
    inertiaPartial: missing > 0 || bodies.some((b) => !b.t),
    missing,
    pending,
  };
}

/** Assigns a material to a part, from the active part or from the assembly. */
export function assignMaterial(partId: string, m: Material): void {
  if (activeKind() === "part") return setMaterial(m);
  updatePartDoc(partId, (d) => applyMaterial(d, m));
}

// --- Link with the view -----------------------------------------------------------------------------

createRoot(() => {
  // Document change: the points are no longer valid; no measurement in a drawing or a sketch.
  createEffect(
    on(
      () => ws.activeId,
      () => {
        clearPoints();
        if (activeKind() === "drawing") closeMeasure();
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    if (editingSketch() || ws.sketch3d) closeMeasure();
  });
  // Liaison graph: assemblies only (back to the distance tool on a part).
  createEffect(() => {
    if ((measure.tool === "liaisons" || currentModuleTool()?.assemblyOnly) && activeKind() !== "assembly") setMeasure("tool", "distance");
  });
});

// Escape: clears the current measurement, then leaves the workbench.
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape" || !measure.on) return;
  const el = ev.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
  if (currentModuleTool()?.undo?.()) return;
  if (hasMeasure()) clearPoints();
  else closeMeasure();
});

/** Display effects of the measurement in the view (called by the Viewport, within its reactive owner). */
export function bindMeasure(v: Viewer): void {
  // Picking the points.
  createEffect(() => {
    const picking = measure.on && measure.tool === "distance" && activeKind() !== "drawing" && !moduleCircle();
    const mod = measure.on ? currentModuleTool() : undefined;
    v.setPointPicking(picking ? addPoint : (mod?.pointPicking?.() ?? null));
  });

  // Picking the circles.
  createEffect(() => {
    const picking = measure.on && measure.tool === "circle" && activeKind() !== "drawing";
    const mod = measure.on ? currentModuleTool() : undefined;
    const taken = moduleCircle();
    v.setCirclePicking(taken ?? (picking ? (c) => setMeasure("circle", c) : (mod?.circlePicking?.() ?? null)));
  });

  // Points and measurement segment.
  createEffect(() => {
    const mod = measure.on ? currentModuleTool() : undefined;
    if (mod) {
      const g = mod.graphics?.();
      v.setMeasureGraphics(g?.points ?? [], g?.segments ?? [], g?.polylines ?? []);
      return;
    }
    const c = measure.on && measure.tool === "circle" ? measure.circle : null;
    if (c) {
      v.setMeasureGraphics([[...c.center]], [[[...c.center], radiusEnd(c)]], [circlePoints(c.center, c.normal, c.radius)]);
      return;
    }
    const pts = measure.on && measure.tool === "distance" ? measure.points.map((p) => [...p.point] as V3) : [];
    // A single non-zero delta: the axis branch would coincide with the diagonal, no need to duplicate it.
    const legs = axisLegs();
    const colored = legs.length > 1 ? legs.map((l) => ({ a: l.a, b: l.b, color: AXIS_COLORS[l.axis] })) : [];
    v.setMeasureGraphics(pts, pts.length === 2 ? [[pts[0]!, pts[1]!]] : [], [], colored);
  });

  // Centre of gravity and volume centre (the second only if it adds information).
  createEffect(() => {
    const r = measure.on && measure.tool === "mass" && measure.showCentres && activeKind() !== "drawing" ? massReport() : null;
    const markers: { point: V3; kind: "cog" | "cov" }[] = [];
    if (r?.cog) markers.push({ point: r.cog, kind: "cog" });
    if (r?.cov && (activeKind() === "assembly" || !r.cog)) markers.push({ point: r.cov, kind: "cov" });
    v.setMassMarkers(markers);
  });

  // Parts without a material in red during the mass calculation.
  createEffect(() => {
    const highlight = measure.on && measure.tool === "mass";
    const kind = activeKind();
    if (kind === "assembly") {
      void ws.partRev; // material assigned from the panel
      setColorOverride(highlight ? (partId) => (partDoc(partId)?.material ? undefined : MISSING_COLOR) : null);
      untrack(redrawAssembly);
    } else if (kind === "part") {
      v.setColor(highlight && !state.doc.material ? MISSING_COLOR : state.doc.appearance.color);
    }
  });
}
