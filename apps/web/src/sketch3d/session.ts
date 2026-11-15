import { createStore, produce, unwrap } from "solid-js/store";
import {
  AXIS_DIR,
  emptySketch3D,
  evaluate,
  effectiveParameters,
  newId,
  resolveParameters,
  type Axis3,
  type MeshPayload,
  type Scope,
  type Sk3Constraint,
  type Sk3Dimension,
  type Sk3Geometry,
  type Sk3Plane,
  type Sk3Point,
  type Sketch3DData,
  type V3,
} from "@solidus-cad/sdk";
import { measure3D, solveSketch3D } from "@solidus-cad/sketch";
import { asmLeaves, insertSkeleton, onLeaveAssembly, partDoc, partMesh, redrawAssembly, setWs, updatePartDoc, ws } from "../workspace.ts";
import { invRigid } from "../assembly/flex.ts";
import { mul4 } from "../workspace.ts";
import { getViewer, setMessage } from "../store.ts";
import { lang, t } from "../i18n.ts";
import { skeletonEntities } from "../sketch/segments.ts";
import { meshSnapPoints, add, autoBase, BASE_NORMAL, norm, parseTyped, planeFrom3, scale, sub, unit, type BasePlane3, type Inference } from "./infer.ts";
import { editBlocked } from "../edition.ts";
import { encodeLen, fromUnit, lenExpr } from "../units.ts";

/**
 * 3D sketch editing session, in the assembly view.
 * The sketch belongs to a skeleton part; it is written there only at the end of the session (one history entry).
 * All coordinates in the session are in the skeleton part frame.
 */

export type Tool3 = "select" | "line" | "spline" | "point" | "plane" | "dimension";

/** Work plane: automatic (most facing the camera), principal fixed, or chosen (face, three points, sketch). */
export type WorkPlane = { mode: "auto" } | { mode: "base"; base: BasePlane3 } | { mode: "custom"; plane: Sk3Plane; label: string };

interface S3State {
  data: Sketch3DData;
  name: string;
  tool: Tool3;
  work: WorkPlane;
  lock: Axis3 | null;
  /**
   * Current polyline or spline: last placed point; `created`: point created by this first click; `spline`: the spline
   * being drawn (from its second point on).
   */
  pending: { from: string; created: boolean; spline?: string } | null;
  cursor: Inference | null;
  /** Keyboard input in progress (length, coordinates). */
  typed: string;
  selection: string[];
  hover: string | null;
  dof: number;
  conflicting: string[];
  editingDim: string | null;
  /** Designations in progress (plane tool: points; dimension tool: first element). */
  picks: string[];
  canUndo: boolean;
  canRedo: boolean;
}

const initial = (): S3State => ({
  data: emptySketch3D(),
  name: "",
  tool: "line",
  work: { mode: "auto" },
  lock: null,
  pending: null,
  cursor: null,
  typed: "",
  selection: [],
  hover: null,
  dof: 0,
  conflicting: [],
  editingDim: null,
  picks: [],
  canUndo: false,
  canRedo: false,
});

export const [s3, setS3] = createStore<S3State>(initial());

let past: Sketch3DData[] = [];
let future: Sketch3DData[] = [];
let isNew = false;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(unwrap(v))) as T;
const pointOf = (id: string): Sk3Point | undefined => s3.data.geometry.find((g): g is Sk3Point => g.id === id && g.type === "point");
export const posOf = (id: string): V3 | null => {
  const p = pointOf(id);
  return p ? [p.x, p.y, p.z] : null;
};

// --- Frames-----------------------------------------------------------------------------------------

/** World matrix of the edited skeleton occurrence. */
export function skeletonMatrix(): number[] {
  const c = ws.asm?.components.find((x) => x.id === ws.sketch3d?.componentId);
  return c ? [...c.matrix] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

const apply = (m: number[], p: V3, w = 1): V3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]! * w,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]! * w,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]! * w,
];
export const toWorld = (p: V3): V3 => apply(skeletonMatrix(), p);
export const toLocal = (p: V3): V3 => apply(invRigid(skeletonMatrix()), p);
export const dirToLocal = (d: V3): V3 => apply(invRigid(skeletonMatrix()), d, 0);

function scope(): Scope {
  const doc = ws.sketch3d ? partDoc(ws.sketch3d.partId) : undefined;
  return doc ? resolveParameters(effectiveParameters(unwrap(doc))).scope : new Map();
}
/** Parameters of the part of the 3D sketch (dimension expressions). */
export const s3Scope = scope;

// --- Lifecycle------------------------------------------------------------------------------------

/** Opens an existing 3D sketch, or creates one in the selected skeleton (created if needed). */
export function startSketch3D(featureId?: string, componentId?: string): void {
  if (editBlocked()) return;
  const a = ws.asm;
  if (!a || ws.sketch3d) return;
  const selected = a.components.find((c) => c.skeleton && ws.selection.includes(c.id));
  let comp = componentId ? a.components.find((c) => c.id === componentId) : (selected ?? a.components.find((c) => c.skeleton));
  if (!comp) {
    const id = insertSkeleton();
    comp = ws.asm?.components.find((c) => c.id === id);
  }
  const doc = comp ? partDoc(comp.partId) : undefined;
  if (!comp || !doc) return;
  const existing = featureId ? doc.features.find((f) => f.id === featureId && f.type === "sketch3d") : undefined;
  isNew = !existing;
  let name = existing?.name;
  if (!name) {
    let n = 1;
    while (doc.features.some((f) => f.name === `${t("s3d.name")}${n}`)) n++;
    name = `${t("s3d.name")}${n}`;
  }
  past = [];
  future = [];
  setS3({ ...initial(), data: clone(existing?.sketch3d ?? emptySketch3D()), name });
  setWs({ sketch3d: { componentId: comp.id, partId: comp.partId, featureId: existing?.id ?? newId() }, gizmo: "none", mateDraft: null, selection: [] });
  onLeaveAssembly(finishSketch3D);
  snapCache = null;
  resolve();
  redrawAssembly();
}

/** Saves the sketch into the skeleton part and leaves editing. */
export function finishSketch3D(): void {
  const e = ws.sketch3d;
  if (!e) return;
  const data = clone(s3.data);
  const empty = data.geometry.length === 0;
  if (!(isNew && empty)) {
    updatePartDoc(e.partId, (doc) => {
      const f = doc.features.find((x) => x.id === e.featureId);
      if (f) {
        f.sketch3d = data;
        f.name = s3.name;
      } else {
        // Added after the last computed feature (rollback bar included).
        const at = Math.min(doc.rollback, doc.features.length);
        doc.features.splice(at, 0, { id: e.featureId, type: "sketch3d", name: s3.name, params: {}, sketch3d: data });
        if (doc.rollback >= at) doc.rollback = doc.rollback + 1;
      }
    });
  }
  close();
}

export function cancelSketch3D(): void {
  close();
}

function close(): void {
  onLeaveAssembly(null);
  setWs("sketch3d", null);
  setS3(initial());
  redrawAssembly();
}

// --- Edits------------------------------------------------------------------------------------

function syncFlags(): void {
  setS3({ canUndo: past.length > 0, canRedo: future.length > 0 });
}

/** Sketch edit: undo entry, then resolution. */
export function edit(mutate: (d: Sketch3DData) => void): void {
  if (editBlocked()) return;
  past.push(clone(s3.data));
  if (past.length > 200) past.shift();
  future = [];
  setS3("data", produce(mutate));
  resolve();
  syncFlags();
}

export function resolve(targets?: Record<string, V3>): void {
  const r = solveSketch3D(clone(s3.data), { scope: scope(), targets });
  setS3({ dof: r.dof, conflicting: [...r.conflicting, ...Object.keys(r.dimensionErrors)] });
  setS3("data", "geometry", r.geometry);
}

export function undo3(): void {
  const prev = past.pop();
  if (!prev) return;
  future.push(clone(s3.data));
  setS3({ data: prev, pending: null, selection: [], picks: [] });
  resolve();
  syncFlags();
}

export function redo3(): void {
  const next = future.pop();
  if (!next) return;
  past.push(clone(s3.data));
  setS3({ data: next, pending: null, selection: [], picks: [] });
  resolve();
  syncFlags();
}

const pushPoint = (d: Sketch3DData, p: V3): string => {
  const id = newId();
  d.geometry.push({ id, type: "point", x: p[0], y: p[1], z: p[2] });
  return id;
};

/** Designated point: existing point, or new point with the inference constraints (fixed vertex, plane). */
function placeIn(d: Sketch3DData, inf: Inference): string {
  if (inf.id) return inf.id;
  const id = pushPoint(d, inf.p);
  if (inf.vertex) d.constraints.push({ id: newId(), type: "fix", point: id });
  else if (inf.plane) d.constraints.push({ id: newId(), type: "inPlane", target: id, plane: clone(inf.plane) });
  return id;
}

export function setTool(tool: Tool3): void {
  cancelPending();
  setS3({ tool, picks: [], typed: "", lock: null });
}

/** Line tool click: first point, then successive segments (polyline). */
export function lineClick(inf: Inference): void {
  const pend = s3.pending;
  if (!pend) {
    let id = inf.id;
    let created = false;
    if (!id) {
      edit((d) => void (id = placeIn(d, inf)));
      created = true;
    }
    setS3({ pending: { from: id!, created }, typed: "" });
    return;
  }
  if (inf.id === pend.from) return;
  let to = "";
  let lineId = "";
  edit((d) => {
    to = placeIn(d, inf);
    if (to === pend.from) return;
    lineId = newId();
    d.geometry.push({ id: lineId, type: "line", p1: pend.from, p2: to });
    if (inf.axis) d.constraints.push({ id: newId(), type: "axis", line: lineId, axis: inf.axis });
  });
  if (!lineId) return;
  // Segment closed on an already connected point: end of the polyline.
  const closes = !!inf.id && s3.data.geometry.some((g) => g.type === "line" && g.id !== lineId && (g.p1 === inf.id || g.p2 === inf.id));
  setS3({ pending: closes ? null : { from: to, created: false }, typed: "", lock: null });
}

/** Spline tool click: first point, then each click adds a point through which the spline passes. */
export function splineClick(inf: Inference): void {
  const pend = s3.pending;
  if (!pend) {
    let id = inf.id;
    let created = false;
    if (!id) {
      edit((d) => void (id = placeIn(d, inf)));
      created = true;
    }
    setS3({ pending: { from: id!, created }, typed: "" });
    return;
  }
  if (inf.id === pend.from) return;
  let to = "";
  let spline = pend.spline ?? "";
  edit((d) => {
    to = placeIn(d, inf);
    const g = d.geometry.find((x) => x.id === spline);
    if (g?.type === "spline") g.points.push(to);
    else {
      spline = newId();
      d.geometry.push({ id: spline, type: "spline", points: [pend.from, to] });
    }
  });
  // Spline ended on an existing point (attached to another curve, or closing on itself).
  setS3({ pending: inf.id ? null : { from: to, created: false, spline }, typed: "", lock: null });
}

/** Does a curve use the point? */
const usesPoint = (g: Sk3Geometry, id: string) => (g.type === "line" && (g.p1 === id || g.p2 === id)) || (g.type === "spline" && g.points.includes(id));

export function pointClick(inf: Inference): void {
  if (inf.id) return;
  edit((d) => void placeIn(d, inf));
}

/** Stops the current polyline (the start point created alone is removed). */
export function cancelPending(): void {
  const pend = s3.pending;
  if (!pend) return;
  setS3({ pending: null, typed: "" });
  const used = s3.data.geometry.some((g) => usesPoint(g, pend.from));
  if (pend.created && !used) {
    // Simply cancels the point creation (without an extra history entry).
    const prev = past.pop();
    if (prev) setS3("data", prev);
    syncFlags();
  }
}

/** Enter (locked shortcut): applies the current input, cancels the current point, or finishes. */
export function applyTypedOrFinish(): void {
  if (s3.typed) return void applyTyped();
  if (s3.pending) return cancelPending();
  finishSketch3D();
}

/** Escape (locked shortcut): clears the input, cancels the point, unlocks, returns to auto/select, clears the selection. */
export function escapeCascade(): void {
  if (s3.typed) setS3("typed", "");
  else if (s3.pending) cancelPending();
  else if (s3.lock) setS3("lock", null);
  else if (s3.work.mode !== "auto") setWorkPlane({ mode: "auto" });
  else if (s3.tool !== "select") setTool("select");
  else setS3("selection", []);
}

/**
 * Validates the keyboard input: length (driving dimension, in the locked or targeted direction),
 * absolute point "x;y;z" or displacement "@dx;dy;dz". "=expression": parametric length.
 */
export function applyTyped(): boolean {
  const text = s3.typed.trim();
  if (!text) return false;
  const from = s3.pending ? posOf(s3.pending.from) : null;
  let parsed = text.startsWith("=") ? null : parseTyped(text);
  // Typed numbers are in the display unit; the geometry is in mm.
  let expr = parsed?.kind === "length" ? encodeLen(String(parsed.value)) : "";
  if (parsed?.kind === "length") parsed = { kind: "length", value: fromUnit(parsed.value) };
  else if (parsed?.kind === "absolute") parsed = { kind: "absolute", p: parsed.p.map(fromUnit) as V3 };
  else if (parsed?.kind === "relative") parsed = { kind: "relative", d: parsed.d.map(fromUnit) as V3 };
  if (text.startsWith("=")) {
    expr = text.slice(1).trim();
    try {
      parsed = { kind: "length", value: evaluate(expr, scope()) };
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return true;
    }
  }
  if (!parsed) {
    setMessage(t("s3d.badInput"));
    return true;
  }
  let target: V3;
  let axis: Axis3 | undefined;
  if (parsed.kind === "absolute" || parsed.kind === "relative") {
    target = parsed.kind === "absolute" ? parsed.p : add(from ?? [0, 0, 0], parsed.d);
    // Point entered on the axis of the previous one: axis constraint, as with mouse inference.
    if (from) {
      const d = sub(target, from);
      const big = [0, 1, 2].filter((i) => Math.abs(d[i]!) > 1e-9);
      if (big.length === 1) axis = (["X", "Y", "Z"] as const)[big[0]!];
    }
  } else {
    if (!from) {
      setMessage(t("s3d.needStart"));
      return true;
    }
    axis = s3.lock ?? s3.cursor?.axis;
    const dir = axis ? AXIS_DIR[axis] : s3.cursor ? unit(sub(s3.cursor.p, from)) : null;
    if (!dir || norm(dir) < 1e-9) {
      setMessage(t("s3d.needDirection"));
      return true;
    }
    // Direction: that of the cursor along the axis.
    const sign = axis && s3.cursor && dotSign(sub(s3.cursor.p, from), dir) < 0 ? -1 : 1;
    target = add(from, scale(dir, sign * parsed.value));
  }
  // Coordinates of an existing point: this point is reused (polyline closed by keyboard).
  const existing = s3.data.geometry.find((g): g is Sk3Point => g.type === "point" && Math.hypot(g.x - target[0], g.y - target[1], g.z - target[2]) < 1e-6);
  const inf: Inference = { p: target, id: existing?.id, axis, align: [], kind: existing ? "point" : "plane" };
  if (s3.tool === "spline") {
    splineClick(inf);
    setS3("typed", "");
    return true;
  }
  if (s3.tool === "point" || !s3.pending) {
    if (s3.tool === "line") return lineClick(inf), true;
    pointClick(inf);
    setS3("typed", "");
    return true;
  }
  const pendFrom = s3.pending.from;
  lineClick(inf);
  if (parsed.kind === "length") {
    // Driving dimension on the created segment.
    const line = [...s3.data.geometry].reverse().find((g) => g.type === "line" && g.p1 === pendFrom);
    if (line) edit((d) => void d.dimensions.push({ id: newId(), type: "length", a: line.id, value: expr, driving: true }));
  }
  return true;
}

const dotSign = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// --- Selection and constraints---------------------------------------------------------------------------

export function select(id: string | null, additive: boolean): void {
  if (!id) return void (additive || setS3("selection", []));
  setS3("selection", (sel) => (additive ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id]));
}

const kindOf = (id: string) => s3.data.geometry.find((g) => g.id === id)?.type;
const selected = (type: "point" | "line" | "spline") => s3.selection.filter((id) => kindOf(id) === type);

export type ConstraintCmd = "X" | "Y" | "Z" | "inPlane" | "parallel" | "perpendicular" | "equal" | "pointOnLine" | "coincident" | "fix";

/** Constraints applicable to the current selection. */
export function canConstrain(cmd: ConstraintCmd): boolean {
  const L = selected("line").length;
  const P = selected("point").length;
  switch (cmd) {
    case "X":
    case "Y":
    case "Z":
      return L > 0;
    case "inPlane":
      return L + P + selected("spline").length > 0;
    case "parallel":
    case "perpendicular":
    case "equal":
      return L === 2;
    case "pointOnLine":
      return L === 1 && P === 1;
    case "coincident":
      return P === 2;
    case "fix":
      return P > 0;
  }
}

export function constrain(cmd: ConstraintCmd): void {
  if (!canConstrain(cmd)) return setMessage(t("s3d.selectFirst"));
  if (s3.tool !== "select") setTool("select");
  const lines = selected("line");
  const points = selected("point");
  edit((d) => {
    const push = (c: Sk3Constraint) => d.constraints.push(c);
    switch (cmd) {
      case "X":
      case "Y":
      case "Z":
        for (const line of lines) {
          d.constraints = d.constraints.filter((c) => !(c.type === "axis" && c.line === line));
          push({ id: newId(), type: "axis", line, axis: cmd });
        }
        return;
      case "inPlane": {
        const plane = currentPlane(points[0] ? posOf(points[0]) : lines[0] ? posOf(lineEnds(lines[0])[0]) : null);
        for (const target of [...lines, ...selected("spline"), ...points]) push({ id: newId(), type: "inPlane", target, plane: { p: plane.p, n: plane.n } });
        return;
      }
      case "parallel":
      case "perpendicular":
      case "equal":
        return void push({ id: newId(), type: cmd, a: lines[0]!, b: lines[1]! });
      case "pointOnLine":
        return void push({ id: newId(), type: "pointOnLine", point: points[0]!, line: lines[0]! });
      case "coincident":
        return mergePoints(d, points[0]!, points[1]!);
      case "fix":
        for (const point of points) if (!d.constraints.some((c) => c.type === "fix" && c.point === point)) push({ id: newId(), type: "fix", point });
        return;
    }
  });
  setS3("selection", []);
}

function lineEnds(id: string): [string, string] {
  const g = s3.data.geometry.find((x) => x.id === id);
  return g?.type === "line" ? [g.p1, g.p2] : ["", ""];
}

/** Merges `drop` into `keep` (coincidence): the lines and constraints of `drop` move to `keep`. */
function mergePoints(d: Sketch3DData, keep: string, drop: string): void {
  for (const g of d.geometry) {
    if (g.type === "spline") g.points = g.points.map((p) => (p === drop ? keep : p)).filter((p, i, all) => i === 0 || p !== all[i - 1]);
    if (g.type !== "line") continue;
    if (g.p1 === drop) g.p1 = keep;
    if (g.p2 === drop) g.p2 = keep;
  }
  d.geometry = d.geometry.filter((g) => g.id !== drop && !(g.type === "line" && g.p1 === g.p2) && !(g.type === "spline" && g.points.length < 2));
  for (const c of d.constraints) {
    if ("point" in c && c.point === drop) c.point = keep;
    if (c.type === "inPlane" && c.target === drop) c.target = keep;
  }
  for (const m of d.dimensions) {
    if (m.a === drop) m.a = keep;
    if (m.b === drop) m.b = keep;
  }
  d.dimensions = d.dimensions.filter((m) => m.a !== m.b);
}

/** Deletes the selection (a point takes its lines, a spline its point; orphan constraints and dimensions disappear). */
export function deleteSelection3(): void {
  const sel = new Set(s3.selection);
  if (!sel.size) return;
  edit((d) => {
    const gone = new Set(sel);
    for (const g of d.geometry) {
      if (g.type === "line" && (gone.has(g.p1) || gone.has(g.p2))) gone.add(g.id);
      // A spline loses its deleted points, and disappears below two points.
      if (g.type === "spline") {
        g.points = g.points.filter((p) => !gone.has(p));
        if (g.points.length < 2) gone.add(g.id);
      }
    }
    d.geometry = d.geometry.filter((g) => !gone.has(g.id));
    const refs = (c: Sk3Constraint): string[] =>
      c.type === "axis" ? [c.line] : c.type === "inPlane" ? [c.target] : c.type === "pointOnLine" ? [c.point, c.line] : c.type === "fix" ? [c.point] : [c.a, c.b];
    d.constraints = d.constraints.filter((c) => !gone.has(c.id) && !refs(c).some((r) => gone.has(r)));
    d.dimensions = d.dimensions.filter((m) => !gone.has(m.id) && !gone.has(m.a) && !(m.b && gone.has(m.b)));
  });
  setS3({ selection: [], pending: null });
}

// --- Dimensions---------------------------------------------------------------------------------------------

/** Dimension tool: line → length; point then point → distance; line then line → angle. */
export function dimensionClick(id: string | null): void {
  if (!id) return void setS3("picks", []);
  const first = s3.picks[0];
  const kind = kindOf(id);
  if (!first) {
    setS3({ picks: [id], selection: [id] });
    return;
  }
  const k0 = kindOf(first);
  let dim: Omit<Sk3Dimension, "id" | "value"> | null = null;
  if (id === first && k0 === "line") dim = { type: "length", a: id, driving: true };
  else if (k0 === "point" && kind === "point" && id !== first) dim = { type: "distance", a: first, b: id, driving: true };
  else if (k0 === "line" && kind === "line" && id !== first) dim = { type: "angle", a: first, b: id, driving: true };
  setS3({ picks: [], selection: [] });
  if (!dim) return;
  addDimension(dim);
}

/** Length dimension of a line (shortcut: double-click on the line with the dimension tool). */
export function addDimension(dim: Omit<Sk3Dimension, "id" | "value">): void {
  const m = measure3D(s3.data, dim);
  if (m == null) return;
  const id = newId();
  edit((d) => void d.dimensions.push({ ...dim, id, value: dim.type === "angle" ? String(Math.round(m * 100) / 100) : lenExpr(m) }));
  // Surplus dimension: it becomes driven (measurement only).
  if (s3.conflicting.includes(id)) {
    past.pop();
    edit((d) => {
      const x = d.dimensions.find((y) => y.id === id);
      if (x) x.driving = false;
    });
    setMessage(t("s3d.overDimensioned"));
  }
  setS3("editingDim", s3.data.dimensions.find((x) => x.id === id)?.driving ? id : null);
}

export function setDimensionValue(id: string, value: string): void {
  const v = value.trim().replace(/^(-?\d+),(\d+)$/, "$1.$2");
  if (!v) return;
  edit((d) => {
    const x = d.dimensions.find((y) => y.id === id);
    if (x) x.value = x.type === "angle" ? v : encodeLen(v);
  });
}

export function toggleDriving(id: string): void {
  edit((d) => {
    const x = d.dimensions.find((y) => y.id === id);
    if (x) x.driving = !x.driving;
  });
}

// --- Drag---------------------------------------------------------------------------------------

let dragging: string | null = null;
export function beginDrag3(id: string): void {
  past.push(clone(s3.data));
  future = [];
  dragging = id;
  syncFlags();
}
export function dragTo3(p: V3): void {
  if (dragging) resolve({ [dragging]: p });
}
export function endDrag3(): void {
  dragging = null;
}
export const isDragging3 = () => dragging !== null;

// --- Work plane--------------------------------------------------------------------------------------

/** View direction in the part frame. */
export function viewDirLocal(): V3 {
  const v = getViewer();
  return v ? dirToLocal(v.viewDirection()) : [0, 0, -1];
}

/** Effective work plane, passing through `through` (previous point) for the principal planes. */
export function currentPlane(through: V3 | null): Sk3Plane & { fixed?: boolean; base?: BasePlane3 } {
  const w = s3.work;
  if (w.mode === "custom") return { ...w.plane, fixed: true };
  const base = w.mode === "base" ? w.base : autoBase(viewDirLocal());
  return { p: through ?? [0, 0, 0], n: BASE_NORMAL[base], base };
}

export function planeLabel(): string {
  const w = s3.work;
  if (w.mode === "custom") return w.label;
  const base = w.mode === "base" ? w.base : autoBase(viewDirLocal());
  return w.mode === "auto" ? `${base} (${t("s3d.auto")})` : base;
}

/** Tab: next principal plane, fixed. */
export function cyclePlane(): void {
  const order: BasePlane3[] = ["XY", "XZ", "YZ"];
  const w = s3.work;
  const cur = w.mode === "base" ? w.base : autoBase(viewDirLocal());
  const next = w.mode === "base" ? order[(order.indexOf(cur) + 1) % 3]! : cur === "XY" ? "XZ" : "XY";
  setS3("work", w.mode === "auto" && next === cur ? { mode: "base", base: cur } : { mode: "base", base: next });
}

export function setWorkPlane(w: WorkPlane): void {
  setS3({ work: w, picks: [] });
}

/** Planes chosen from the list: planes of the 2D sketches of the edited skeleton. */
export function sketchPlanes(): { label: string; plane: Sk3Plane }[] {
  void ws.partRev;
  const e = ws.sketch3d;
  const doc = e ? partDoc(e.partId) : undefined;
  if (!doc) return [];
  // 2D sketches: their plane is known without solving (sketch frame).
  const solved = Object.fromEntries(doc.features.filter((f) => f.type === "sketch" && f.sketch).map((f) => [f.id, { geometry: f.sketch!.geometry, dof: 0, conflicting: [], redundant: [] }]));
  return skeletonEntities(unwrap(doc), solved, lang())
    .filter((x) => x.kind === "plane")
    .map((x) => ({ label: x.label, plane: { p: x.p, n: x.d } }));
}

/** Plane tool: planar face of a part (world frame), or three points of the sketch. */
export function planeFromFace(p: V3, n: V3): void {
  setWorkPlane({ mode: "custom", plane: { p: toLocal(p), n: unit(dirToLocal(n)) }, label: t("s3d.planeFace") });
  setS3("tool", "line");
}

export function planePointClick(id: string): void {
  const picks = s3.picks.includes(id) ? s3.picks : [...s3.picks, id];
  if (picks.length < 3) return void setS3({ picks, selection: picks });
  const [a, b, c] = picks.map((x) => posOf(x)!) as [V3, V3, V3];
  const plane = planeFrom3(a, b, c);
  if (!plane) {
    setS3({ picks: [], selection: [] });
    return setMessage(t("s3d.aligned"));
  }
  setWorkPlane({ mode: "custom", plane, label: t("s3d.plane3") });
  setS3({ tool: "line", selection: [] });
}

/** Camera normal to the work plane. */
export function lookAtPlane(): void {
  const v = getViewer();
  if (!v) return;
  const pl = currentPlane(s3.pending ? posOf(s3.pending.from) : null);
  const n = unit(apply(skeletonMatrix(), pl.n, 0));
  const up: V3 = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  // Camera on the normal's side (as for a 2D sketch).
  v.lookAlong({ x: n[0], y: n[1], z: n[2] }, { x: up[0], y: up[1], z: up[2] });
}

// --- Snaps on the other parts-------------------------------------------------------------------

const snapsOfMesh = new WeakMap<MeshPayload, V3[]>();
let snapCache: { key: string; meshes: (MeshPayload | null)[]; pts: V3[] } | null = null;

/** Notable points of the visible parts (skeleton frame), plus the origin. */
export function snapVertices(): V3[] {
  void ws.masses; // dependency: meshes recomputed
  const leaves = asmLeaves().filter((l) => !l.hidden && !l.skeleton);
  const key = JSON.stringify([skeletonMatrix(), leaves.map((l) => [l.key, l.partId, l.matrix])]);
  const used = leaves.map((l) => partMesh(l.partId));
  // Valid as long as the occurrences, their positions and the meshes (recomputed parts) are the same.
  if (snapCache?.key === key && snapCache.meshes.every((m, i) => m === used[i])) return snapCache.pts;
  const inv = invRigid(skeletonMatrix());
  const pts: V3[] = [[0, 0, 0]];
  for (const [i, l] of leaves.entries()) {
    const mesh = used[i];
    if (!mesh) continue;
    let local = snapsOfMesh.get(mesh);
    if (!local) {
      local = meshSnapPoints(mesh.edges, mesh.edgeGroups);
      snapsOfMesh.set(mesh, local);
    }
    const m = mul4(inv, [...l.matrix]);
    for (const p of local) pts.push(apply(m, p));
  }
  snapCache = { key, meshes: used, pts };
  return pts;
}

export type { Sk3Geometry };
