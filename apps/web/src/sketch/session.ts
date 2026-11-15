import { batch } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import gcsWasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import {
  evaluate,
  newId,
  sketchFrame,
  sketchToWorld,
  SKETCH_AXIS_H,
  SKETCH_AXIS_V,
  SKETCH_ORIGIN,
  type DimensionKind,
  type ExternalRef,
  type GeomRef,
  type SkConstraint,
  type SkDimension,
  type SketchData,
  type SkGeometry,
} from "@solidus-cad/sdk";
import {
  analyzeProfiles,
  closeGaps,
  filletCorner,
  findGaps,
  freeEndpoints,
  interpolateBSpline,
  measureDimension,
  offsetCurves,
  pointMap,
  SketchSolver,
  trimSketch,
  type Gap,
  type ProfileAnalysis,
} from "@solidus-cad/sketch";
import { datumFrame, editingSketch, parameterScope, recompute, state, updateSketch } from "../store.ts";
import { t } from "../i18n.ts";
import { encodeLen, isInch, lenExpr, MM_PER_INCH } from "../units.ts";
import { textContours, type TextStyle } from "./text.ts";

/**
 * Sketch editing session: active tool, selection, local solving (PlaneGCS in the main thread),
 * history specific to the sketch. The changes are applied to the feature being edited.
 */

export type Tool = "select" | "line" | "rect" | "rectCenter" | "circle" | "arc" | "spline" | "point" | "dimension" | "constraint" | "trim" | "fillet" | "project" | "text";

/** Point designated by the user: existing point (id) or new position. */
export interface PickPoint {
  id?: string;
  x: number;
  y: number;
  /** Curve (sketch axis) the new point snaps to: "point on curve" constraint at creation. */
  on?: string;
}

export type Pending =
  | { tool: "line"; start: PickPoint; first: PickPoint }
  | { tool: "rect" | "rectCenter" | "circle"; start: PickPoint }
  | { tool: "arc"; center: PickPoint; start?: PickPoint }
  /** Spline: points it goes through, in order. */
  | { tool: "spline"; through: PickPoint[] }
  | { tool: "dimension"; first: string };

/** Dimension type imposed by the dimension tool (null: "smart" dimension). */
export type DimensionTool = "horizontalDistance" | "verticalDistance" | "angle" | null;

interface Session {
  tool: Tool;
  selection: string[];
  hover: string | null;
  pending: Pending | null;
  cursor: { x: number; y: number } | null;
  dof: number;
  solved: boolean;
  conflicting: string[];
  redundant: string[];
  profiles: ProfileAnalysis | null;
  /** Nearby ends that do not touch (contours to close). */
  gaps: Gap[];
  /** Free ends: ends of the open contours. */
  freeEnds: string[];
  message: string;
  /** Dimension being edited (value field open). */
  editingDim: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Offset distance input open. */
  offsetOpen: boolean;
  /** Text insertion position: the input panel is open while it is set. */
  textAt: { x: number; y: number } | null;
  /** Dimension type of the active dimension tool. */
  dimKind: DimensionTool;
  /** Constraint of the active constraint tool (elements clicked one by one). */
  constraintCmd: ConstraintCommand | null;
  /** Construction mode: the drawing tools create construction geometry. */
  construction: boolean;
}

export const [session, setSession] = createStore<Session>({
  tool: "select",
  selection: [],
  hover: null,
  pending: null,
  cursor: null,
  dof: 0,
  solved: true,
  conflicting: [],
  redundant: [],
  profiles: null,
  gaps: [],
  freeEnds: [],
  message: "",
  editingDim: null,
  canUndo: false,
  canRedo: false,
  offsetOpen: false,
  textAt: null,
  dimKind: null,
  constraintCmd: null,
  construction: false,
});

let solver: SketchSolver | null = null;
const solverReady = SketchSolver.create(gcsWasmUrl).then((s) => {
  solver = s;
  solveNow();
});

const past: SketchData[] = [];
const future: SketchData[] = [];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(unwrap(v))) as T;

export function startSession(): void {
  past.length = future.length = 0;
  setSession({
    tool: state.editing?.isNew ? "line" : "select",
    selection: [],
    hover: null,
    pending: null,
    cursor: null,
    message: "",
    editingDim: null,
    canUndo: false,
    canRedo: false,
    construction: false,
  });
  void solverReady.then(() => solveNow());
}

export function sketch(): SketchData | undefined {
  return editingSketch();
}

/** Solves the current sketch and updates the positions. */
export function solveNow(drag?: Record<string, { x: number; y: number }>): void {
  const sk = editingSketch();
  if (!sk || !solver) return;
  const r = solver.solve(unwrap(sk), { scope: parameterScope(), drag: drag ? { points: drag } : undefined });
  const geometry = r.ok ? r.geometry : unwrap(sk).geometry;
  batch(() => {
    if (r.ok) updateSketch((s) => void (s.geometry = r.geometry), { recompute: false });
    setSession({
      solved: r.ok,
      conflicting: r.conflicting,
      redundant: r.redundant,
      profiles: analyzeProfiles(geometry),
      gaps: findGaps(geometry, gapTolerance(geometry)),
      freeEnds: freeEndpoints(geometry),
    });
    if (!drag) setSession("dof", r.dof);
  });
}

/** Edit with history entry, solving and model recompute. */
export function sketchOp(mutate: (s: SketchData) => void): void {
  const sk = editingSketch();
  if (!sk) return;
  past.push(clone(sk));
  future.length = 0;
  updateSketch((s) => {
    mutate(s);
    pruneExternals(s, session.selection);
  }, { recompute: false });
  solveNow();
  recompute();
  setSession({ canUndo: true, canRedo: false });
}

export function sketchUndo(): void {
  const sk = editingSketch();
  const prev = past.pop();
  if (!sk || !prev) return;
  future.push(clone(sk));
  updateSketch((s) => Object.assign(s, prev), { recompute: false });
  solveNow();
  recompute();
  setSession({ canUndo: past.length > 0, canRedo: true, selection: [], pending: null });
}

export function sketchRedo(): void {
  const sk = editingSketch();
  const next = future.pop();
  if (!sk || !next) return;
  past.push(clone(sk));
  updateSketch((s) => Object.assign(s, next), { recompute: false });
  solveNow();
  recompute();
  setSession({ canUndo: true, canRedo: future.length > 0, selection: [], pending: null });
}

export function setTool(tool: Tool, dimKind: DimensionTool = null, constraintCmd: ConstraintCommand | null = null): void {
  setSession({ tool, pending: null, message: "", dimKind, constraintCmd });
  pruneNow();
}

export function message(msg: string): void {
  setSession("message", msg);
}

// --- Access to the geometry---------------------------------------------------------------

export function geo(id: string): SkGeometry | undefined {
  return editingSketch()?.geometry.find((g) => g.id === id);
}

export function pointPos(id: string): { x: number; y: number } | undefined {
  if (id === SKETCH_ORIGIN) return { x: 0, y: 0 };
  const g = geo(id);
  return g?.type === "point" ? { x: g.x, y: g.y } : undefined;
}

function kindOf(id: string): string | undefined {
  if (id === SKETCH_AXIS_H || id === SKETCH_AXIS_V) return "line";
  if (id === SKETCH_ORIGIN) return "point";
  return geo(id)?.type;
}

// --- Geometry creation---------------------------------------------------------------

/** Returns the id of the point (existing or created in `s`). */
function ensurePoint(s: SketchData, p: PickPoint): string {
  if (p.id) return p.id;
  const id = newId();
  s.geometry.push({ id, type: "point", x: p.x, y: p.y });
  if (p.on) s.constraints.push({ id: newId(), type: "pointOnCurve", point: id, curve: p.on });
  return id;
}

const AXIS_SNAP = 3; // degrees

/** Adds a line; adds horizontal/vertical if it is close to it (inference). Returns the ids of the ends. */
export function addLine(a: PickPoint, b: PickPoint, construction = false): { p1: string; p2: string } | null {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 || (a.id && a.id === b.id)) return null;
  const id = newId();
  let p1 = "";
  let p2 = "";
  sketchOp((s) => {
    p1 = ensurePoint(s, a);
    p2 = ensurePoint(s, b);
    s.geometry.push({ id, type: "line", p1, p2, construction });
    const ang = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
    // Line lying on an axis (ends snapped to the axis or to the origin): already aligned, no redundant constraint.
    const onAxis = (axis: string) => [a, b].every((p) => p.on === axis || p.id === SKETCH_ORIGIN);
    if (ang < AXIS_SNAP && !onAxis(SKETCH_AXIS_H)) s.constraints.push({ id: newId(), type: "horizontal", a: id });
    else if (ang > 90 - AXIS_SNAP && !onAxis(SKETCH_AXIS_V)) s.constraints.push({ id: newId(), type: "vertical", a: id });
  });
  return { p1, p2 };
}

export function addRect(a: PickPoint, b: PickPoint, centered: boolean, construction = false): void {
  const c = centered ? a : null;
  const [x0, y0, x1, y1] = centered ? [2 * a.x - b.x, 2 * a.y - b.y, b.x, b.y] : [a.x, a.y, b.x, b.y];
  if (Math.abs(x1 - x0) < 1e-6 || Math.abs(y1 - y0) < 1e-6) return;
  sketchOp((s) => {
    const p0 = centered ? ensurePoint(s, { x: x0, y: y0 }) : ensurePoint(s, a);
    const p2 = ensurePoint(s, centered ? b : b);
    const p1 = ensurePoint(s, { x: x1, y: y0 });
    const p3 = ensurePoint(s, { x: x0, y: y1 });
    const ids = [newId(), newId(), newId(), newId()];
    const lines: [string, string, string][] = [
      [ids[0]!, p0, p1],
      [ids[1]!, p1, p2],
      [ids[2]!, p2, p3],
      [ids[3]!, p3, p0],
    ];
    for (const [id, p, q] of lines) s.geometry.push({ id, type: "line", p1: p, p2: q, construction });
    s.constraints.push(
      { id: newId(), type: "horizontal", a: ids[0]! },
      { id: newId(), type: "horizontal", a: ids[2]! },
      { id: newId(), type: "vertical", a: ids[1]! },
      { id: newId(), type: "vertical", a: ids[3]! },
    );
    if (c) {
      // Construction diagonal whose centre is the midpoint.
      const center = ensurePoint(s, c);
      const diag = newId();
      s.geometry.push({ id: diag, type: "line", p1: p0, p2: p2, construction: true });
      s.constraints.push({ id: newId(), type: "midpoint", point: center, curve: diag });
    }
  });
}

export function addCircle(center: PickPoint, r: number, construction = false): void {
  if (r < 1e-6) return;
  sketchOp((s) => {
    const c = ensurePoint(s, center);
    s.geometry.push({ id: newId(), type: "circle", c, r, construction });
  });
}

/** Trigonometric arc from `start` to the direction of `end` (the end point is brought back onto the circle). */
export function addArc(center: PickPoint, start: PickPoint, end: { x: number; y: number; id?: string }, construction = false): void {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (r < 1e-6) return;
  const a = Math.atan2(end.y - center.y, end.x - center.x);
  const endPt: PickPoint = end.id ? end : { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
  sketchOp((s) => {
    const c = ensurePoint(s, center);
    const p0 = ensurePoint(s, start);
    const p1 = ensurePoint(s, endPt);
    if (p0 === p1) return;
    s.geometry.push({ id: newId(), type: "arc", c, start: p0, end: p1, construction });
  });
}

/**
 * Spline through the points `through` (closed: periodic, the first point is not repeated). The spline is stored by its
 * poles: an open spline starts and ends at its first and last points; the other poles are construction points.
 */
export function addSpline(through: PickPoint[], closed: boolean, construction = false): void {
  const fit = interpolateBSpline(through, closed);
  if (!fit) return;
  sketchOp((s) => {
    const n = fit.poles.length;
    const poles = fit.poles.map((p, i) =>
      !closed && (i === 0 || i === n - 1) ? ensurePoint(s, through[i === 0 ? 0 : through.length - 1]!) : ensurePoint(s, { x: p.x, y: p.y }),
    );
    for (const g of s.geometry) if (g.type === "point" && poles.includes(g.id) && (closed || (g.id !== poles[0] && g.id !== poles[n - 1]))) g.construction = true;
    s.geometry.push({ id: newId(), type: "bspline", poles, degree: fit.degree, ...(closed ? { periodic: true } : {}), construction });
  });
}

/** Ends the spline being drawn (at least two points); returns false if there was none. */
export function finishSpline(): boolean {
  const pend = session.pending;
  if (pend?.tool !== "spline") return false;
  if (pend.through.length >= 2) addSpline(pend.through, false, session.construction);
  setSession("pending", null);
  return true;
}

/** Inserts the text as closed lines (glyph outlines) starting at `at`. */
export async function insertText(text: string, style: TextStyle, at: { x: number; y: number }): Promise<void> {
  if (!text.trim() || !(style.height > 0)) return;
  const contours = await textContours(text, style);
  if (contours.length === 0) return message(t("sk.textEmpty"));
  sketchOp((s) => {
    for (const poly of contours) {
      const ids = poly.map((p) => ensurePoint(s, { x: at.x + p.x, y: at.y + p.y }));
      ids.forEach((p1, i) => s.geometry.push({ id: newId(), type: "line", p1, p2: ids[(i + 1) % ids.length]! }));
    }
  });
  setSession({ textAt: null, tool: "select", message: "" });
}

export function addPoint(p: PickPoint): void {
  if (p.id) return;
  sketchOp((s) => void ensurePoint(s, p));
}

// --- Selection and deletion--------------------------------------------------------------

export function select(id: string | null, additive: boolean): void {
  if (!id) {
    if (!additive) setSession("selection", []);
    pruneNow();
    return;
  }
  setSession("selection", (sel) => (additive ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id]));
  pruneNow();
}

/** References of a geometry to other ids. */
function refsOf(g: SkGeometry): string[] {
  if (g.type === "line") return [g.p1, g.p2];
  if (g.type === "circle") return [g.c];
  if (g.type === "arc") return [g.c, g.start, g.end];
  if (g.type === "bspline") return g.poles;
  return [];
}

function constraintRefs(c: SkConstraint): string[] {
  switch (c.type) {
    case "horizontal":
    case "vertical":
      return [c.a];
    case "parallel":
    case "perpendicular":
    case "equal":
    case "tangent":
    case "concentric":
      return [c.a, c.b];
    case "pointOnCurve":
    case "midpoint":
      return [c.point, c.curve];
    case "symmetric":
      return [c.a, c.b, c.axis];
    case "fix":
      return [c.point];
  }
}

/** Removes ids and everything that depends on them (constraints, dimensions, orphan points). */
function removeIds(s: SketchData, ids: Set<string>): void {
  const curves = s.geometry.filter((g) => ids.has(g.id) && g.type !== "point");
  s.geometry = s.geometry.filter((g) => !ids.has(g.id));
  // Orphan points of the deleted curves.
  const used = new Set(s.geometry.flatMap(refsOf));
  for (const c of curves) for (const p of refsOf(c)) if (!used.has(p)) ids.add(p);
  // A line with a deleted end disappears too.
  const broken = s.geometry.filter((g) => g.type !== "point" && refsOf(g).some((r) => ids.has(r)));
  for (const g of broken) ids.add(g.id);
  s.geometry = s.geometry.filter((g) => !ids.has(g.id));
  s.constraints = s.constraints.filter((c) => !ids.has(c.id) && !constraintRefs(c).some((r) => ids.has(r)));
  s.dimensions = s.dimensions.filter((d) => !ids.has(d.id) && !ids.has(d.a) && !(d.b && ids.has(d.b)));
}

export function deleteSelection(): void {
  const sel = new Set(session.selection);
  sel.delete(SKETCH_ORIGIN);
  if (sel.size === 0) return;
  sketchOp((s) => removeIds(s, sel));
  setSession("selection", []);
}

/**
 * Construction button: turns the construction mode off when it is on; otherwise switches the selected
 * curves (select tool), or turns the mode on (kept from one drawing tool to the next).
 */
export function toggleConstruction(): void {
  if (session.construction) return setSession("construction", false);
  const ids = session.tool === "select" ? session.selection.filter((id) => ["line", "circle", "arc", "bspline"].includes(kindOf(id) ?? "")) : [];
  if (ids.length === 0) return setSession("construction", true);
  sketchOp((s) => {
    for (const g of s.geometry) if (ids.includes(g.id)) g.construction = !g.construction;
  });
}

// --- Constraints---------------------------------------------------------------------------

export type ConstraintCommand =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "equal"
  | "concentric"
  | "midpoint"
  | "symmetric"
  | "fix";

/** Merges `b` into `a` (coincidence of two points). */
function mergePoints(s: SketchData, a: string, b: string): void {
  const swap = (id: string) => (id === b ? a : id);
  for (const g of s.geometry) {
    if (g.type === "line") {
      g.p1 = swap(g.p1);
      g.p2 = swap(g.p2);
    } else if (g.type === "circle") g.c = swap(g.c);
    else if (g.type === "arc") {
      g.c = swap(g.c);
      g.start = swap(g.start);
      g.end = swap(g.end);
    } else if (g.type === "bspline") g.poles = g.poles.map(swap);
  }
  s.geometry = s.geometry.filter((g) => g.id !== b && !(g.type === "line" && g.p1 === g.p2));
  for (const c of s.constraints) {
    if ("point" in c) c.point = swap(c.point);
    if (c.type === "symmetric") {
      c.a = swap(c.a);
      c.b = swap(c.b);
    }
  }
  s.dimensions = s.dimensions.filter((d) => !(d.b && new Set([swap(d.a), swap(d.b)]).size === 1));
  for (const d of s.dimensions) {
    d.a = swap(d.a);
    if (d.b) d.b = swap(d.b);
  }
}

/** Number of elements the constraint tool waits for before applying the constraint. */
const ARITY: Record<ConstraintCommand, number> = {
  coincident: 2,
  horizontal: 1,
  vertical: 1,
  parallel: 2,
  perpendicular: 2,
  tangent: 2,
  equal: 2,
  concentric: 2,
  midpoint: 2,
  symmetric: 3,
  fix: 1,
};

/** Element kinds each constraint accepts. */
const ACCEPTS: Record<ConstraintCommand, string[]> = {
  coincident: ["point", "line", "circle", "arc", "bspline"],
  horizontal: ["line"],
  vertical: ["line"],
  parallel: ["line"],
  perpendicular: ["line"],
  tangent: ["line", "circle", "arc", "bspline"],
  equal: ["line", "circle", "arc"],
  concentric: ["circle", "arc"],
  midpoint: ["point", "line"],
  symmetric: ["point", "line"],
  fix: ["point"],
};

const HINTS: Record<ConstraintCommand, string> = {
  coincident: "Coïncidence : cliquez sur deux points, ou un point et une courbe.",
  horizontal: "Horizontale : cliquez sur les lignes.",
  vertical: "Verticale : cliquez sur les lignes.",
  parallel: "Parallèle : cliquez sur deux lignes.",
  perpendicular: "Perpendiculaire : cliquez sur deux lignes.",
  tangent: "Tangence : cliquez sur une ligne ou un cercle, et un cercle ou un arc.",
  equal: "Égalité : cliquez sur deux lignes, ou deux cercles ou arcs.",
  concentric: "Concentrique : cliquez sur deux cercles ou arcs.",
  midpoint: "Milieu : cliquez sur un point et une ligne.",
  symmetric: "Symétrie : cliquez sur deux points et une ligne (l'axe).",
  fix: "Fixe : cliquez sur les points.",
};

/**
 * Constraint button: applied at once to a complete selection; otherwise the constraint tool waits
 * for the missing elements (the compatible elements already selected are kept).
 */
export function constrain(cmd: ConstraintCommand): void {
  if (session.tool === "constraint" && session.constraintCmd === cmd) return setTool("select");
  const sel = session.selection.filter((id) => ACCEPTS[cmd].includes(kindOf(id) ?? ""));
  if (sel.length >= ARITY[cmd]) {
    // A constraint applies to the selection: the drawing tool is left so as not to draw on the next click.
    if (session.tool !== "select") setTool("select");
    const err = applyConstraint(cmd, session.selection);
    if (err) message(err);
    return;
  }
  setTool("constraint", null, cmd);
  setSession("selection", sel);
  message(HINTS[cmd]);
}

/** Element clicked with the constraint tool: the constraint is applied once enough elements are picked, and the tool stays active. */
export function constraintPick(id: string | null): void {
  const cmd = session.constraintCmd;
  if (!cmd) return;
  if (!id) return void setSession({ selection: [], message: HINTS[cmd] });
  if (!ACCEPTS[cmd].includes(kindOf(id) ?? "")) return message(HINTS[cmd]);
  if (session.selection.includes(id)) return void setSession("selection", (s) => s.filter((x) => x !== id));
  const sel = [...session.selection, id];
  if (sel.length < ARITY[cmd]) return void setSession("selection", sel);
  const err = applyConstraint(cmd, sel);
  setSession({ selection: [], message: err ?? HINTS[cmd] });
}

/** Applies the constraint to the elements; returns the error message if they do not suit it. */
function applyConstraint(cmd: ConstraintCommand, ids: string[]): string | null {
  const sel = ids.filter((id) => kindOf(id));
  const kinds = sel.map((id) => kindOf(id)!);
  const lines = sel.filter((_, i) => kinds[i] === "line");
  const points = sel.filter((_, i) => kinds[i] === "point");
  const roundCurves = sel.filter((_, i) => kinds[i] === "circle" || kinds[i] === "arc");
  const curves = sel.filter((_, i) => kinds[i] !== "point");
  const add = (...cs: SkConstraint[]) => (sketchOp((s) => void s.constraints.push(...cs)), null);
  const fail = (msg: string) => msg;

  switch (cmd) {
    case "coincident":
      if (points.length >= 2) {
        // Fixed point kept: origin, then external reference.
        const keep = points.includes(SKETCH_ORIGIN) ? SKETCH_ORIGIN : (points.find((p) => geo(p)?.external) ?? points[0]!);
        sketchOp((s) => {
          for (const p of points) if (p !== keep) mergePoints(s, keep, p);
        });
        return null;
      }
      if (points.length === 1 && curves.length === 1) return add({ id: newId(), type: "pointOnCurve", point: points[0]!, curve: curves[0]! });
      return fail("Coïncidence : sélectionnez deux points, ou un point et une courbe.");
    case "horizontal":
    case "vertical":
      if (lines.length === 0) return fail("Sélectionnez une ou plusieurs lignes.");
      return add(...lines.map((a) => ({ id: newId(), type: cmd, a }) as SkConstraint));
    case "parallel":
    case "perpendicular":
      if (lines.length !== 2) return fail("Sélectionnez deux lignes.");
      return add({ id: newId(), type: cmd, a: lines[0]!, b: lines[1]! });
    case "equal":
      if (lines.length >= 2) return add(...lines.slice(1).map((b) => ({ id: newId(), type: "equal", a: lines[0]!, b }) as SkConstraint));
      if (roundCurves.length >= 2)
        return add(...roundCurves.slice(1).map((b) => ({ id: newId(), type: "equal", a: roundCurves[0]!, b }) as SkConstraint));
      return fail("Égalité : sélectionnez des lignes, ou des cercles et arcs.");
    case "tangent":
      if (curves.length !== 2 || roundCurves.length === 0) return fail("Tangence : sélectionnez une ligne ou un cercle, et un cercle ou un arc.");
      return add({ id: newId(), type: "tangent", a: curves[0]!, b: curves[1]! });
    case "concentric":
      if (roundCurves.length !== 2) return fail("Sélectionnez deux cercles ou arcs.");
      return add({ id: newId(), type: "concentric", a: roundCurves[0]!, b: roundCurves[1]! });
    case "midpoint":
      if (points.length !== 1 || lines.length !== 1) return fail("Milieu : sélectionnez un point et une ligne.");
      return add({ id: newId(), type: "midpoint", point: points[0]!, curve: lines[0]! });
    case "symmetric":
      if (points.length !== 2 || lines.length !== 1) return fail("Symétrie : sélectionnez deux points et une ligne (l'axe).");
      return add({ id: newId(), type: "symmetric", a: points[0]!, b: points[1]!, axis: lines[0]! });
    case "fix":
      if (points.length === 0) return fail("Sélectionnez un ou plusieurs points.");
      return add(...points.filter((p) => p !== SKETCH_ORIGIN).map((p) => ({ id: newId(), type: "fix", point: p }) as SkConstraint));
  }
}

// --- Dimensions -----------------------------------------------------------------------------------

/** Initial expression of a new dimension: angle in degrees, length rounded in the display unit. */
function round(v: number, type: DimensionKind): string {
  return type === "angle" ? String(Math.round(v * 1000) / 1000) : lenExpr(v);
}

/** Creates a dimension at the current value; if the sketch is already constrained, the dimension becomes driven. */
export function addDimension(type: DimensionKind, a: string, b?: string): void {
  const sk = editingSketch();
  if (!sk) return;
  const d: SkDimension = { id: newId(), type, a, b, value: "0", driving: true };
  const v = measureDimension(d, unwrap(sk).geometry);
  if (v === null) return message("Cote impossible sur cette sélection.");
  d.value = round(v, type);
  sketchOp((s) => void s.dimensions.push(d));
  if (session.conflicting.length || session.redundant.length) {
    // Over-constrained: the dimension is kept as a driven measurement, as commercial modelers do.
    updateSketch((s) => {
      const x = s.dimensions.find((y) => y.id === d.id);
      if (x) x.driving = false;
    }, { recompute: false });
    solveNow();
    message("Esquisse déjà contrainte : la cote est ajoutée en mesure (pilotée).");
  } else {
    setSession("editingDim", d.id);
  }
  setSession("selection", []);
}

/** "Smart" dimension from a selection of one or two elements. */
export function dimensionFor(ids: string[], kind?: DimensionTool): boolean {
  const [a, b] = ids;
  if (!a) return false;
  const ka = kindOf(a);
  const kb = b ? kindOf(b) : undefined;
  if (kind === "angle") {
    if (ka === "line" && kb === "line") return addDimension("angle", a, b), true;
    return false;
  }
  if (kind) {
    if (ka === "line" && !b) return addDimension(kind, a), true;
    if (ka === "point" && kb === "point") return addDimension(kind, a, b), true;
    return false;
  }
  if (!b) {
    if (ka === "line") return addDimension("distance", a), true;
    if (ka === "circle") return addDimension("diameter", a), true;
    if (ka === "arc") return addDimension("radius", a), true;
    return false;
  }
  if (ka === "point" && kb === "point") return addDimension("distance", a, b), true;
  if ((ka === "point" && kb === "line") || (ka === "line" && kb === "point")) return addDimension("distance", a, b), true;
  if (ka === "line" && kb === "line") return addDimension("angle", a, b), true;
  return false;
}

export function dimensionSelection(kind?: DimensionTool): void {
  if (session.selection.length === 0) {
    setTool("dimension", kind ?? null);
    return message(t(kind === "angle" ? "sk.dimAngleHint" : "sk.dimHint"));
  }
  if (!dimensionFor(session.selection, kind))
    message(kind === "angle" ? t("sk.dimAngleHint") : "Cote : sélectionnez une ligne, un cercle, deux points, un point et une ligne, ou deux lignes.");
}

export function setDimensionValue(id: string, value: string): void {
  sketchOp((s) => {
    const d = s.dimensions.find((x) => x.id === id);
    if (!d || !value.trim()) return;
    d.value = d.type === "angle" ? value.trim().replace(/^(-?\d*),(\d+)$/, "$1.$2") : encodeLen(value);
  });
}

export function toggleDriving(id: string): void {
  sketchOp((s) => {
    const d = s.dimensions.find((x) => x.id === id);
    if (d) d.driving = !d.driving;
  });
}

export function moveDimensionLabel(id: string, offset: { x: number; y: number }): void {
  updateSketch((s) => {
    const d = s.dimensions.find((x) => x.id === id);
    if (d) d.offset = offset;
  }, { recompute: false });
}

// --- Sketch symmetry---------------------------------------------------------------------------

/** Symmetric copy of the selected elements about the last selected line. */
export function mirrorSelection(): void {
  const sel = [...session.selection];
  const axis = [...sel].reverse().find((id) => kindOf(id) === "line");
  const items = sel.filter((id) => id !== axis && ["line", "circle", "arc", "point"].includes(kindOf(id) ?? ""));
  if (!axis || items.length === 0) return message("Symétrie : sélectionnez les éléments, puis la ligne d'axe en dernier.");
  const sk = editingSketch()!;
  const axisLine = axis === SKETCH_AXIS_H ? { p1: SKETCH_ORIGIN, p2: "O:H" } : axis === SKETCH_AXIS_V ? { p1: SKETCH_ORIGIN, p2: "O:V" } : (geo(axis) as { p1: string; p2: string });
  const ref = (id: string) => (id === "O:H" ? { x: 1, y: 0 } : id === "O:V" ? { x: 0, y: 1 } : pointPos(id)!);
  const a = ref(axisLine.p1);
  const b = ref(axisLine.p2);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const reflect = (p: { x: number; y: number }) => {
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const fx = a.x + t * dx;
    const fy = a.y + t * dy;
    return { x: 2 * fx - p.x, y: 2 * fy - p.y };
  };
  sketchOp((s) => {
    const map = new Map<string, string>();
    const onAxis = (id: string) => {
      const p = ref(id);
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) < 1e-6;
    };
    const mirrorPoint = (id: string): string => {
      if (id === SKETCH_ORIGIN && onAxis(id)) return id;
      const done = map.get(id);
      if (done) return done;
      if (onAxis(id)) return id; // a point on the axis is its own mirror image
      const nid = newId();
      const q = reflect(ref(id));
      s.geometry.push({ id: nid, type: "point", x: q.x, y: q.y });
      s.constraints.push({ id: newId(), type: "symmetric", a: id, b: nid, axis });
      map.set(id, nid);
      return nid;
    };
    const source = unwrap(sk).geometry;
    for (const id of items) {
      const g = source.find((x) => x.id === id);
      if (!g) continue;
      if (g.type === "point") mirrorPoint(g.id);
      else if (g.type === "line") s.geometry.push({ id: newId(), type: "line", p1: mirrorPoint(g.p1), p2: mirrorPoint(g.p2), construction: g.construction });
      else if (g.type === "circle") {
        const nid = newId();
        s.geometry.push({ id: nid, type: "circle", c: mirrorPoint(g.c), r: g.r, construction: g.construction });
        s.constraints.push({ id: newId(), type: "equal", a: g.id, b: nid });
      } else if (g.type === "arc") {
        // Symmetry reverses the direction of travel: start and end are swapped.
        s.geometry.push({ id: newId(), type: "arc", c: mirrorPoint(g.c), start: mirrorPoint(g.end), end: mirrorPoint(g.start), construction: g.construction });
      }
    }
  });
  setSession("selection", []);
}

// --- Mouse drag------------------------------------------------------------------------

let dragState: {
  ids: string[];
  origin: { x: number; y: number };
  starts: Map<string, { x: number; y: number }>;
  before: SketchData;
  /** Circle grabbed by its edge: its radius is changed. */
  radius?: string;
} | null = null;

/** Points dragged by an element (its ends, its centre). */
function pointsOf(id: string): string[] {
  const g = geo(id);
  if (!g) return [];
  if (g.type === "point") return [g.id];
  return refsOf(g).filter((p) => p !== SKETCH_ORIGIN);
}

export function beginDrag(ids: string[], at: { x: number; y: number }): boolean {
  const sk = editingSketch();
  const only = ids.length === 1 ? geo(ids[0]!) : undefined;
  if (sk && only?.type === "circle") {
    dragState = { ids: [], origin: at, starts: new Map(), before: clone(sk), radius: only.id };
    return true;
  }
  const pts = [...new Set(ids.flatMap(pointsOf))];
  if (!sk || pts.length === 0) return false;
  dragState = { ids: pts, origin: at, starts: new Map(pts.map((p) => [p, pointPos(p)!])), before: clone(sk) };
  return true;
}

export function dragTo(at: { x: number; y: number }): void {
  if (!dragState) return;
  if (dragState.radius) {
    const c = geo(dragState.radius);
    const center = c?.type === "circle" ? pointPos(c.c) : undefined;
    if (center) resizeCircle(dragState.radius, Math.hypot(at.x - center.x, at.y - center.y));
    return;
  }
  const dx = at.x - dragState.origin.x;
  const dy = at.y - dragState.origin.y;
  const target: Record<string, { x: number; y: number }> = {};
  for (const [id, p] of dragState.starts) target[id] = { x: p.x + dx, y: p.y + dy };
  solveNow(target);
}

export function endDrag(): void {
  if (!dragState) return;
  past.push(dragState.before);
  future.length = 0;
  dragState = null;
  solveNow();
  recompute();
  setSession({ canUndo: true, canRedo: false });
}

export function isDragging(): boolean {
  return dragState !== null;
}

function resizeCircle(id: string, r: number): void {
  updateSketch((s) => {
    const g = s.geometry.find((x) => x.id === id);
    if (g?.type === "circle") g.r = Math.max(r, 1e-3);
  }, { recompute: false });
  solveNow();
}

// --- Trim, sketch fillet, offset----------------------------------------------

/** Replaces the sketch content with the result of a tool (with history). */
function applyResult(next: SketchData | null, failMessage: string): boolean {
  if (!next) {
    message(failMessage);
    return false;
  }
  sketchOp((s) => {
    s.geometry = next.geometry;
    s.constraints = next.constraints;
    s.dimensions = next.dimensions;
  });
  return true;
}

/** Gap beyond which two ends are no longer considered "close": 2 % of the sketch extent. */
function gapTolerance(geometry: SkGeometry[]): number {
  const ps = geometry.filter((g) => g.type === "point" && !g.construction) as { x: number; y: number }[];
  if (ps.length === 0) return 0;
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return 0.02 * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** Welds the nearby ends that do not touch, to close the contours. */
export function closeContours(): void {
  const sk = editingSketch();
  if (!sk) return;
  const g = unwrap(sk).geometry;
  const n = findGaps(g, gapTolerance(g)).length;
  if (applyResult(closeGaps(unwrap(sk), gapTolerance(g)), t("sk.noGaps"))) message(`${n} ${t("sk.gapsClosed")}`);
}

export function trimAt(curveId: string, at: { x: number; y: number }): void {
  const sk = editingSketch();
  if (!sk) return;
  applyResult(trimSketch(unwrap(sk), curveId, at, newId), "Ajuster : cliquez sur une ligne, un cercle ou un arc.");
}

/** Fillet on the clicked corner; the proposed radius can be edited immediately (dimension field open). */
export function filletAt(pointId: string): void {
  const sk = editingSketch();
  if (!sk) return;
  const lines = unwrap(sk).geometry.filter((g) => g.type === "line" && !g.construction && (g.p1 === pointId || g.p2 === pointId));
  const len = (l: SkGeometry) => {
    if (l.type !== "line") return 0;
    const a = pointPos(l.p1)!;
    const b = pointPos(l.p2)!;
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const short = lines.length === 2 ? Math.min(len(lines[0]!), len(lines[1]!)) * 0.2 : 0;
  // Proposed radius: 20 % of the shorter line, rounded to 0.1 mm (or 0.01 in).
  const r = !short ? 0 : isInch() ? Math.max(Math.round((short / MM_PER_INCH) * 100) / 100, 0.01) * MM_PER_INCH : Math.max(Math.round(short * 10) / 10, 0.1);
  const before = new Set(unwrap(sk).dimensions.map((d) => d.id));
  if (applyResult(lines.length === 2 ? filletCorner(unwrap(sk), pointId, r, newId) : null, "Congé : cliquez sur le coin commun à deux lignes.")) {
    const dim = editingSketch()!.dimensions.find((d) => !before.has(d.id));
    if (dim) {
      if (isInch()) updateSketch((s) => void (s.dimensions.find((x) => x.id === dim.id)!.value = lenExpr(r)), { recompute: false });
      setSession("editingDim", dim.id);
    }
  }
}

export function offsetSelection(distance: number): void {
  const sk = editingSketch();
  if (!sk) return;
  const ids = session.selection.filter((id) => ["line", "circle", "arc"].includes(geo(id)?.type ?? ""));
  if (ids.length === 0) return message("Décalage : sélectionnez des lignes, cercles ou arcs.");
  if (applyResult(offsetCurves(unwrap(sk), ids, distance, newId), "Décalage impossible avec cette distance.")) {
    setSession({ selection: [], offsetOpen: false });
  }
}

// --- Projection of model edges-------------------------------------------------------------

/**
 * Adds to the sketch the projection of an edge (polyline already brought into the sketch plane):
 * a segment if the points are aligned, otherwise a circle (closed polyline) or an arc through three points.
 * The curve keeps the reference of the edge: the kernel re-snaps it to the model at each recompute.
 */
export function addProjected(points: { x: number; y: number }[], ref: GeomRef | ExternalRef): void {
  if (points.length < 2) return;
  const a = points[0]!;
  const span = Math.max(...points.map((p) => Math.hypot(p.x - a.x, p.y - a.y)));
  if (span < 1e-6) return message(t("sk.projectDegenerate"));
  sketchOp((s) => {
    const r = pushProjected(s, points, ref, {});
    if (typeof r !== "string") message(t("sk.projectUnsupported"));
  });
}

/**
 * Adds to `s` the projected curve of a polyline: a segment, a circle (closed polyline) or an arc through three points.
 * Returns the id of the curve, or `null` for an unsupported curve (ellipse, spline).
 */
function pushProjected(s: SketchData, points: { x: number; y: number }[], ref: GeomRef | ExternalRef, extra: { construction?: boolean; external?: boolean }): string | null {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  // Ends of the covered segment: a curved edge seen edge-on (circle, arc) projects to a segment
  // whose ends are not necessarily those of the edge.
  const far = (o: { x: number; y: number }) => points.reduce((m, p) => (Math.hypot(p.x - o.x, p.y - o.y) > Math.hypot(m.x - o.x, m.y - o.y) ? p : m));
  const e1 = far(a);
  const e2 = far(e1);
  const [s1, s2] = Math.hypot(e2.x - a.x, e2.y - a.y) <= Math.hypot(e1.x - a.x, e1.y - a.y) ? [e2, e1] : [e1, e2];
  const span = Math.hypot(s2.x - s1.x, s2.y - s1.y);
  const dist = (p: { x: number; y: number }) => {
    const dx = s2.x - s1.x;
    const dy = s2.y - s1.y;
    return span < 1e-9 ? Math.hypot(p.x - s1.x, p.y - s1.y) : Math.abs((p.x - s1.x) * dy - (p.y - s1.y) * dx) / span;
  };
  const tol = Math.max(span * 1e-3, 1e-4);
  const id = newId();
  {
    const pt = (p: { x: number; y: number }) => {
      const pid = newId();
      s.geometry.push({ id: pid, type: "point", x: p.x, y: p.y, ...extra });
      return pid;
    };
    if (points.every((p) => dist(p) < tol)) {
      s.geometry.push({ id, type: "line", p1: pt(s1), p2: pt(s2), projected: ref, ...extra });
      return id;
    }
    // Circle through three points (start, middle, end of the polyline).
    const m = points[Math.floor(points.length / 2)]!;
    const q = points[Math.floor(points.length / 4)]!;
    const closed = Math.hypot(b.x - a.x, b.y - a.y) < tol;
    const p3 = closed ? q : m;
    const p2 = closed ? m : b;
    const d = 2 * (a.x * (p3.y - p2.y) + p3.x * (p2.y - a.y) + p2.x * (a.y - p3.y));
    if (Math.abs(d) < 1e-12) return null;
    const ux = ((a.x ** 2 + a.y ** 2) * (p3.y - p2.y) + (p3.x ** 2 + p3.y ** 2) * (p2.y - a.y) + (p2.x ** 2 + p2.y ** 2) * (a.y - p3.y)) / d;
    const uy = ((a.x ** 2 + a.y ** 2) * (p2.x - p3.x) + (p3.x ** 2 + p3.y ** 2) * (a.x - p2.x) + (p2.x ** 2 + p2.y ** 2) * (p3.x - a.x)) / d;
    const c = { x: ux, y: uy };
    const r = Math.hypot(a.x - ux, a.y - uy);
    // A non-circular edge in this plane (ellipse, spline) is not yet supported.
    if (points.some((p) => Math.abs(Math.hypot(p.x - ux, p.y - uy) - r) > Math.max(r * 0.01, tol))) return null;
    if (closed) {
      s.geometry.push({ id, type: "circle", c: pt(c), r, projected: ref, ...extra });
      return id;
    }
    const ccw = (a.x - ux) * (m.y - uy) - (a.y - uy) * (m.x - ux) > 0;
    s.geometry.push({ id, type: "arc", c: pt(c), start: pt(ccw ? a : b), end: pt(ccw ? b : a), projected: ref, ...extra });
    return id;
  }
}

// --- External references ------------------------------------------------------------------------

/** Element of another feature picked from the sketch (coordinates already brought into the plane). */
export type ExternalPick =
  | { kind: "edge"; ref: GeomRef | ExternalRef; points: { x: number; y: number }[] }
  | { kind: "vertex"; ref: GeomRef | ExternalRef; anchor: "start" | "end" | "center"; x: number; y: number }
  | { kind: "sketch"; sketch: string; entity: string; geometry: SkGeometry[] };

const sameRef = (a: SkGeometry["projected"], b: SkGeometry["projected"]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * External reference for a dimension or a constraint: reuses the existing one, otherwise adds it
 * (hidden, fixed, construction, without a history entry). Returns its id, or null if unsupported.
 */
export function addExternal(pick: ExternalPick): string | null {
  const sk = editingSketch();
  if (!sk) return null;
  const extra = { construction: true, external: true };
  const ref: SkGeometry["projected"] = pick.kind === "sketch" ? { kind: "sketch", sketch: pick.sketch, entity: pick.entity } : pick.ref;
  const existing = sk.geometry.find(
    (g) => g.external && sameRef(g.projected, ref) && (pick.kind !== "vertex" ? g.type !== "point" || pick.kind === "sketch" : g.type === "point" && g.anchor === pick.anchor && Math.hypot(g.x - pick.x, g.y - pick.y) < 1e-6),
  );
  if (existing) return existing.id;
  let id: string | null = null;
  updateSketch((s) => {
    if (pick.kind === "vertex") {
      id = newId();
      s.geometry.push({ id, type: "point", x: pick.x, y: pick.y, anchor: pick.anchor, projected: ref, ...extra });
    } else if (pick.kind === "edge") {
      if (pick.points.length >= 2) id = pushProjected(s, pick.points, pick.ref, extra);
    } else {
      // Element of another sketch: copy (points included), re-snapped by the kernel at each recompute.
      const src = pick.geometry.find((g) => g.id === pick.entity);
      const pos = (pid: string) => pick.geometry.find((g) => g.id === pid && g.type === "point") as { x: number; y: number } | undefined;
      const pt = (pid: string) => {
        const nid = newId();
        const p = pos(pid) ?? { x: 0, y: 0 };
        s.geometry.push({ id: nid, type: "point", x: p.x, y: p.y, projected: { kind: "sketch", sketch: pick.sketch, entity: pid }, ...extra });
        return nid;
      };
      if (!src) return;
      id = newId();
      if (src.type === "point") s.geometry.push({ id, type: "point", x: src.x, y: src.y, projected: ref, ...extra });
      else if (src.type === "line") s.geometry.push({ id, type: "line", p1: pt(src.p1), p2: pt(src.p2), projected: ref, ...extra });
      else if (src.type === "circle") s.geometry.push({ id, type: "circle", c: pt(src.c), r: src.r, projected: ref, ...extra });
      else if (src.type === "arc") s.geometry.push({ id, type: "arc", c: pt(src.c), start: pt(src.start), end: pt(src.end), projected: ref, ...extra });
    }
  }, { recompute: false });
  if (!id) message(t("sk.projectUnsupported"));
  solveNow();
  return id;
}

/** Removes the external references no longer used by anything (dimensions, constraints, sketch curves, `keep`). */
function pruneExternals(s: SketchData, keep: Iterable<string>): void {
  if (!s.geometry.some((g) => g.external)) return;
  const used = new Set<string>(keep);
  for (const c of s.constraints) for (const r of constraintRefs(c)) used.add(r);
  for (const d of s.dimensions) {
    used.add(d.a);
    if (d.b) used.add(d.b);
  }
  for (const g of s.geometry) if (!g.external) for (const r of refsOf(g)) used.add(r);
  // A kept external curve keeps its points.
  for (const g of s.geometry) if (g.external && used.has(g.id)) for (const r of refsOf(g)) used.add(r);
  const drop = s.geometry.filter((g) => g.external && !used.has(g.id));
  if (drop.length === 0) return;
  const ids = new Set(drop.map((g) => g.id));
  s.geometry = s.geometry.filter((g) => !ids.has(g.id));
}

/** Prunes the external references that have become useless (after a selection change). */
function pruneNow(): void {
  const sk = editingSketch();
  if (!sk?.geometry.some((g) => g.external)) return;
  const keep = [...session.selection, ...(session.pending?.tool === "dimension" ? [session.pending.first] : [])];
  const before = sk.geometry.length;
  updateSketch((s) => pruneExternals(s, keep), { recompute: false });
  if (editingSketch()!.geometry.length !== before) solveNow();
}

// --- Skeleton sketch ------------------------------------------------------------------------

/**
 * Takes over the curves of a skeleton sketch (placed earlier in the tree) as associative references:
 * fixed, construction, re-snapped by the kernel when the skeleton changes.
 */
export function importSkeleton(sourceId: string): void {
  const sk = editingSketch();
  const src = state.doc.features.find((f) => f.id === sourceId);
  const solved = state.sketchInfos[sourceId]?.geometry ?? src?.sketch?.geometry;
  if (!sk || !src?.sketch || !solved) return;
  const scope = parameterScope();
  const off = (expr: string) => {
    try {
      return evaluate(expr, scope);
    } catch {
      return 0;
    }
  };
  const from = sketchFrame(src.sketch.plane, off(src.sketch.plane.offset), datumFrame);
  const to = sketchFrame(sk.plane, off(sk.plane.offset), datumFrame);
  const pts = pointMap(solved);
  const map = (id: string) => {
    const p = pts.get(id)!;
    const w = sketchToWorld(from, p.x, p.y);
    const d = { x: w.x - to.origin.x, y: w.y - to.origin.y, z: w.z - to.origin.z };
    return { x: d.x * to.xDir.x + d.y * to.xDir.y + d.z * to.xDir.z, y: d.x * to.yDir.x + d.y * to.yDir.y + d.z * to.yDir.z };
  };
  const already = new Set(sk.geometry.flatMap((g) => (g.projected?.kind === "sketch" && g.projected.sketch === sourceId ? [g.projected.entity] : [])));
  let count = 0;
  sketchOp((s) => {
    const pt = (id: string) => {
      const nid = newId();
      s.geometry.push({ id: nid, type: "point", ...map(id) });
      return nid;
    };
    for (const g of solved) {
      if (g.type === "point" || already.has(g.id)) continue;
      const projected = { kind: "sketch" as const, sketch: sourceId, entity: g.id };
      if (g.type === "line") s.geometry.push({ id: newId(), type: "line", p1: pt(g.p1), p2: pt(g.p2), construction: true, projected });
      else if (g.type === "circle") s.geometry.push({ id: newId(), type: "circle", c: pt(g.c), r: g.r, construction: true, projected });
      else if (g.type === "arc") s.geometry.push({ id: newId(), type: "arc", c: pt(g.c), start: pt(g.start), end: pt(g.end), construction: true, projected });
      else continue;
      count++;
    }
  });
  message(`${count} ${t("sk.skeletonImported")}`);
}
