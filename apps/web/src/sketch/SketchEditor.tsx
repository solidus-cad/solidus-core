import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import {
  evaluate,
  sketchFrame,
  sketchToWorld,
  SKETCH_AXIS_H,
  SKETCH_AXIS_V,
  SKETCH_ORIGIN,
  type ExternalRef,
  type GeomRef,
  type SkConstraint,
  type SkDimension,
  type SkGeometry,
} from "@solidus-cad/sdk";
import { linkedRef } from "../assembly/external.ts";
import { interpolateBSpline, pointMap, sampleBSpline, sampleCurve, type Pt } from "@solidus-cad/sketch";
import { dimensionGraphic } from "./dimGraphics.ts";
import { Stepper } from "../components/Stepper.tsx";
import { decodeLen, lenEvaluator, lenStep } from "../units.ts";
import type { Viewer } from "@solidus-cad/viewer";
import { consumedSketches, datumFrame, parameterScope, state } from "../store.ts";
import { frameOf } from "./segments.ts";
import {
  addArc,
  addCircle,
  addLine,
  addPoint,
  addRect,
  addSpline,
  addProjected,
  addExternal,
  type ExternalPick,
  filletAt,
  trimAt,
  beginDrag,
  constraintPick,
  dimensionFor,
  dragTo,
  endDrag,
  isDragging,
  moveDimensionLabel,
  select,
  session,
  setDimensionValue,
  setSession,
  sketch,
  type PickPoint,
} from "./session.ts";

const POINT_TOL = 8;
const CURVE_TOL = 6;

const GLYPHS: Record<SkConstraint["type"], string> = {
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "T",
  concentric: "◎",
  pointOnCurve: "•",
  midpoint: "M",
  symmetric: "⇋",
  fix: "⚓",
};

type S = { x: number; y: number };

function distToSegment(p: S, a: S, b: S): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Centre of a polyline lying on a circle (through three of its points), otherwise null (segment, ellipse, spline). */
function circleCenter(pts: S[]): S | null {
  if (pts.length < 3) return null;
  const a = pts[0]!;
  const b = pts[Math.floor(pts.length / 3)]!;
  const c = pts[Math.floor((2 * pts.length) / 3)]!;
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x ** 2 + a.y ** 2;
  const b2 = b.x ** 2 + b.y ** 2;
  const c2 = c.x ** 2 + c.y ** 2;
  const o = { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
  const r = Math.hypot(a.x - o.x, a.y - o.y);
  return pts.every((p) => Math.abs(Math.hypot(p.x - o.x, p.y - o.y) - r) < Math.max(r * 0.01, 1e-4)) ? o : null;
}

function distToPolyline(p: S, pts: S[]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i]!, pts[i + 1]!));
  return d;
}

/** 2D sketch editing SVG layer, overlaid on the 3D view (camera normal to the plane). */
export function SketchEditor(props: { viewer: Viewer }) {
  const v = props.viewer;
  const [viewVersion, setViewVersion] = createSignal(0);
  const [settled, setSettled] = createSignal(false);

  const sk = () => sketch()!;
  const geometry = () => sk().geometry;
  const frame = createMemo(() => {
    let offset = 0;
    try {
      offset = evaluate(sk().plane.offset, parameterScope());
    } catch {
      /* invalid offset: plane at the origin */
    }
    return sketchFrame(sk().plane, offset, datumFrame);
  });

  const toScreen = (p: Pt): S => {
    viewVersion();
    return v.worldToScreen(sketchToWorld(frame(), p.x, p.y));
  };
  const toSketch = (sx: number, sy: number): S | null => {
    const f = frame();
    const w = v.screenToPlane(sx, sy, f.origin, f.normal);
    if (!w) return null;
    const d = { x: w.x - f.origin.x, y: w.y - f.origin.y, z: w.z - f.origin.z };
    return { x: d.x * f.xDir.x + d.y * f.xDir.y + d.z * f.xDir.z, y: d.x * f.yDir.x + d.y * f.yDir.y + d.z * f.yDir.z };
  };

  const pts = createMemo(() => pointMap(geometry()));

  /** Points and curves projected on screen (for drawing and detection). */
  const screenPoints = createMemo(() => {
    viewVersion();
    const out: { id: string; s: S }[] = [{ id: SKETCH_ORIGIN, s: toScreen({ x: 0, y: 0 }) }];
    for (const g of geometry()) if (g.type === "point") out.push({ id: g.id, s: toScreen(g) });
    return out;
  });
  const screenCurves = createMemo(() => {
    viewVersion();
    const p = pts();
    return geometry()
      .filter((g): g is Exclude<SkGeometry, { type: "point" }> => g.type !== "point")
      .map((g) => ({ g, s: sampleCurve(g, p).map(toScreen) }));
  });

  /** Control polygons of the splines (poles joined in order), shown dashed. */
  const controlPolygons = createMemo(() => {
    viewVersion();
    const p = pts();
    return geometry().flatMap((g) => {
      if (g.type !== "bspline") return [];
      const poles = g.poles.map((id) => p.get(id)).filter((q): q is Pt => !!q);
      return [(g.periodic ? [...poles, poles[0]!] : poles).map(toScreen)];
    });
  });

  const pathOf = (s: S[]) => (s.length ? "M" + s.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L") : "");

  // --- External references: other sketches and bodies------------------------------------------

  const worldTo2D = (x: number, y: number, z: number): S => {
    const f = frame();
    const d = { x: x - f.origin.x, y: y - f.origin.y, z: z - f.origin.z };
    return { x: d.x * f.xDir.x + d.y * f.xDir.y + d.z * f.xDir.z, y: d.x * f.yDir.x + d.y * f.yDir.y + d.z * f.yDir.z };
  };

  /** Visible sketches placed before this one, brought into the plane of the sketch being edited. */
  const otherSketches = createMemo(() => {
    const doc = unwrap(state.doc);
    const all = state.doc.features;
    const editingId = state.editing?.featureId;
    const idx = all.findIndex((f) => f.id === editingId);
    const consumed = consumedSketches(all);
    const out: { id: string; geometry: SkGeometry[] }[] = [];
    for (const f of all.slice(0, idx < 0 ? all.length : idx)) {
      const info = state.sketchInfos[f.id];
      if (f.type !== "sketch" || f.suppressed || !info) continue;
      const forced = state.doc.display?.sketches?.[f.id];
      if (forced === false || (forced === undefined && consumed.has(f.id))) continue;
      const fr = frameOf(doc, f.id);
      if (!fr) continue;
      const geometry = unwrap(info.geometry).map((g) => {
        if (g.type !== "point") return g;
        const w = sketchToWorld(fr, g.x, g.y);
        return { ...g, ...worldTo2D(w.x, w.y, w.z) };
      });
      out.push({ id: f.id, geometry });
    }
    return out;
  });

  type ExtCandidate = { pick: ExternalPick; path?: S[]; dot?: S };

  /** Element of another feature under the cursor: point or curve of another sketch, vertex or edge of the body. */
  function externalAt(sx: number, sy: number): ExtCandidate | null {
    const c = { x: sx, y: sy };
    let best: ExtCandidate | null = null;
    let bestD = POINT_TOL;
    for (const o of otherSketches()) {
      for (const g of o.geometry) {
        if (g.type !== "point") continue;
        const s = toScreen(g);
        const d = Math.hypot(s.x - sx, s.y - sy);
        if (d < bestD) {
          bestD = d;
          best = { pick: { kind: "sketch", sketch: o.id, entity: g.id, geometry: o.geometry }, dot: s };
        }
      }
    }
    if (best) return best;
    bestD = CURVE_TOL;
    for (const o of otherSketches()) {
      const p = pointMap(o.geometry);
      for (const g of o.geometry) {
        if (g.type === "point") continue;
        const s = sampleCurve(g, p).map(toScreen);
        const d = distToPolyline(c, s);
        if (d < bestD) {
          bestD = d;
          best = { pick: { kind: "sketch", sketch: o.id, entity: g.id, geometry: o.geometry }, path: s };
        }
      }
    }
    if (best) return best;
    // Centres revealed by hovering over a circular edge.
    for (const c of centers()) {
      const s = toScreen(c);
      if (Math.hypot(s.x - sx, s.y - sy) < POINT_TOL + 2) return { pick: { kind: "vertex", ref: c.ref, anchor: "center", x: c.x, y: c.y }, dot: s };
    }
    const r = v.element.getBoundingClientRect();
    const hit = v.edgeAt(sx + r.left, sy + r.top);
    if (!hit || hit.points.length < 2) return null;
    // Edge of another part (in-place modification): reference linked to that part.
    const ref = linkedRef(hit);
    const pts = hit.points.map(([x, y, z]) => worldTo2D(x, y, z));
    const center = circleCenter(pts);
    if (center && !centers().some((c) => sameRefPoint(c, center))) setCenters((cs) => [...cs.slice(-5), { ...center, ref }]);
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    // Closed edge (full circle): no vertex, only the edge and its centre.
    const closed = Math.hypot(last.x - first.x, last.y - first.y) < 1e-6;
    const ends: ["start" | "end", S][] = closed
      ? []
      : [
          ["start", first],
          ["end", last],
        ];
    for (const [anchor, p] of ends) {
      const s = toScreen(p);
      if (Math.hypot(s.x - sx, s.y - sy) < POINT_TOL + 2) return { pick: { kind: "vertex", ref, anchor, x: p.x, y: p.y }, dot: s };
    }
    return { pick: { kind: "edge", ref, points: pts }, path: pts.map(toScreen) };
  }

  /** Centres of the hovered circular edges (then selectable as "centre" vertices). */
  const [centers, setCenters] = createSignal<(S & { ref: GeomRef | ExternalRef })[]>([]);
  const sameRefPoint = (a: S, b: S) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

  const [extHover, setExtHover] = createSignal<ExtCandidate | null>(null);
  const picksExternal = () => session.tool === "select" || session.tool === "dimension" || session.tool === "constraint";

  const isAxis = (id: string | null) => id === SKETCH_AXIS_H || id === SKETCH_AXIS_V;

  /** External reference picked rather than the sketch's own element `own`: outside the sketch or on an axis. */
  function externalOver(own: string | null, sx: number, sy: number): ExtCandidate | null {
    return own && !isAxis(own) ? null : externalAt(sx, sy);
  }

  /** Sketch element under the cursor, otherwise an external reference (created on demand). */
  function hitOrExternal(sx: number, sy: number): string | null {
    const hit = hitTest(sx, sy);
    const ext = externalOver(hit, sx, sy);
    return ext ? addExternal(ext.pick) : hit;
  }

  // --- Detection---------------------------------------------------------------------------

  function hitTest(sx: number, sy: number, pointsOnly = false): string | null {
    const p = { x: sx, y: sy };
    let best: string | null = null;
    let bestD = POINT_TOL;
    for (const sp of screenPoints()) {
      const d = Math.hypot(sp.s.x - sx, sp.s.y - sy);
      if (d < bestD) {
        bestD = d;
        best = sp.id;
      }
    }
    if (best || pointsOnly) return best;
    bestD = CURVE_TOL;
    for (const c of screenCurves()) {
      const d = distToPolyline(p, c.s);
      if (d < bestD) {
        bestD = d;
        best = c.g.id;
      }
    }
    if (best) return best;
    return axisAt(sx, sy);
  }

  /** Sketch axis closest to the cursor, within the curve tolerance. */
  function axisAt(sx: number, sy: number): string | null {
    const o = toScreen({ x: 0, y: 0 });
    const lineDist = (b: S) => Math.abs((b.y - o.y) * sx - (b.x - o.x) * sy + b.x * o.y - b.y * o.x) / Math.hypot(b.x - o.x, b.y - o.y);
    const dh = lineDist(toScreen({ x: 1, y: 0 }));
    const dv = lineDist(toScreen({ x: 0, y: 1 }));
    if (Math.min(dh, dv) >= CURVE_TOL) return null;
    return dh <= dv ? SKETCH_AXIS_H : SKETCH_AXIS_V;
  }

  /** Picked point: existing point under the cursor, otherwise position (with horizontal/vertical inference). */
  const [inference, setInference] = createSignal<"H" | "V" | null>(null);
  function pick(sx: number, sy: number, from?: PickPoint, commit = false): PickPoint | null {
    const hit = hitTest(sx, sy, true);
    if (hit) {
      const p = hit === SKETCH_ORIGIN ? { x: 0, y: 0 } : (geometry().find((g) => g.id === hit) as Pt);
      setInference(null);
      return { id: hit, x: p.x, y: p.y };
    }
    // Body vertex, ghost part (in-place modification) or point of another sketch: snap for the drawing tools.
    const ext = externalAt(sx, sy);
    if (ext?.dot) {
      const q = toSketch(ext.dot.x, ext.dot.y);
      if (q) {
        setInference(null);
        return commit ? { id: addExternal(ext.pick) ?? undefined, x: q.x, y: q.y } : { x: q.x, y: q.y };
      }
    }
    const q = toSketch(sx, sy);
    if (!q) return null;
    setInference(null);
    let r: PickPoint = q;
    if (from) {
      const fs = toScreen(from);
      if (Math.abs(fs.y - sy) < 6) {
        setInference("H");
        r = { x: q.x, y: from.y };
      } else if (Math.abs(fs.x - sx) < 6) {
        setInference("V");
        r = { x: from.x, y: q.y };
      }
    }
    // Snap to an axis: the point is placed on it and will be constrained to it. The alignment with the start point
    // is kept if compatible (intersection of the axis and the horizontal/vertical).
    const axis = axisAt(sx, sy);
    if (axis === SKETCH_AXIS_V) {
      if (inference() === "V") setInference(null);
      return { x: 0, y: r.y, on: axis };
    }
    if (axis === SKETCH_AXIS_H) {
      if (inference() === "H") setInference(null);
      return { x: r.x, y: 0, on: axis };
    }
    return r;
  }

  // --- Mouse---------------------------------------------------------------------------------

  // pan: Shift / Ctrl / Cmd held at press — a drag then pans the view (OrbitControls) instead of moving the item.
  let down: { x: number; y: number; hit: string | null; dragging: boolean; pan: boolean } | null = null;
  const local = (ev: PointerEvent | MouseEvent) => {
    const r = v.element.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const onOverlayUi = (ev: Event) => !!(ev.target as Element).closest?.(".sk-ui");

  const pendingFrom = (): PickPoint | undefined => {
    const p = session.pending;
    if (!p) return undefined;
    if (p.tool === "line") return p.start;
    if (p.tool === "arc") return p.start ?? p.center;
    if (p.tool === "spline") return p.through[p.through.length - 1];
    if (p.tool === "dimension") return undefined;
    return p.start;
  };

  function onDown(ev: PointerEvent) {
    if (ev.button !== 0 || onOverlayUi(ev)) return;
    const p = local(ev);
    const own = session.tool === "select" ? hitTest(p.x, p.y) : null;
    // Click outside the sketch: edge, vertex or element of another sketch (external reference, not movable).
    const ext = session.tool === "select" ? externalOver(own, p.x, p.y) : null;
    const extId = ext ? addExternal(ext.pick) : null;
    const hit = extId ?? own;
    down = { x: p.x, y: p.y, hit: extId ? null : hit, dragging: false, pan: ev.shiftKey || ev.ctrlKey || ev.metaKey };
    if (session.tool === "select") {
      if (hit && !isAxis(hit)) {
        if (!session.selection.includes(hit) || ev.shiftKey || ev.ctrlKey) select(hit, ev.shiftKey || ev.ctrlKey || ev.metaKey);
      } else select(hit, ev.shiftKey || ev.ctrlKey || ev.metaKey);
    }
  }

  function onMove(ev: PointerEvent) {
    const p = local(ev);
    if (down && session.tool === "select" && down.hit && !down.pan && ev.buttons === 1) {
      const moved = Math.hypot(p.x - down.x, p.y - down.y) > 3;
      if (moved && !down.dragging) {
        const start = toSketch(down.x, down.y);
        const ids = session.selection.includes(down.hit) ? [...session.selection] : [down.hit];
        down.dragging = !!start && beginDrag(ids.filter((id) => id !== SKETCH_ORIGIN), start);
      }
      if (down.dragging) {
        const q = toSketch(p.x, p.y);
        if (q) dragTo(q);
        return;
      }
    }
    const cursor = picksExternal() ? toSketch(p.x, p.y) : pick(p.x, p.y, pendingFrom());
    const hover = hitTest(p.x, p.y);
    setSession({ cursor, hover });
    setExtHover(picksExternal() && !ev.buttons ? externalOver(hover, p.x, p.y) : null);
  }

  function onUp(ev: PointerEvent) {
    if (ev.button !== 0 || onOverlayUi(ev)) return;
    const d = down;
    down = null;
    if (d?.dragging || isDragging()) {
      endDrag();
      return;
    }
    const p = local(ev);
    if (d && Math.hypot(p.x - d.x, p.y - d.y) > 4) return;
    toolClick(p.x, p.y);
  }

  function toolClick(sx: number, sy: number) {
    const pend = session.pending;
    switch (session.tool) {
      case "line": {
        const p = pick(sx, sy, pend?.tool === "line" ? pend.start : undefined, true);
        if (!p) return;
        if (pend?.tool !== "line") return setSession("pending", { tool: "line", start: p, first: p });
        const r = addLine(pend.start, p, session.construction);
        if (!r) return;
        const first = pend.first.id ? pend.first : { ...pend.first, id: r.p1 };
        // Loop closed on the first point: end of the polyline.
        if (p.id && p.id === first.id) return setSession("pending", null);
        setSession("pending", { tool: "line", start: { id: r.p2, x: p.x, y: p.y, on: p.on }, first });
        return;
      }
      case "rect":
      case "rectCenter":
      case "circle": {
        const p = pick(sx, sy, pend && "start" in pend ? pend.start : undefined, true);
        if (!p) return;
        if (!pend) return setSession("pending", { tool: session.tool, start: p });
        if (pend.tool === "circle") addCircle(pend.start, Math.hypot(p.x - pend.start.x, p.y - pend.start.y), session.construction);
        else if (pend.tool === "rect" || pend.tool === "rectCenter") addRect(pend.start, p, pend.tool === "rectCenter", session.construction);
        setSession("pending", null);
        return;
      }
      case "arc": {
        const p = pick(sx, sy, undefined, true);
        if (!p) return;
        if (pend?.tool !== "arc") return setSession("pending", { tool: "arc", center: p });
        if (!pend.start) return setSession("pending", { tool: "arc", center: pend.center, start: p });
        addArc(pend.center, pend.start, p, session.construction);
        setSession("pending", null);
        return;
      }
      case "spline": {
        const p = pick(sx, sy, pend?.tool === "spline" ? pend.through[pend.through.length - 1] : undefined, true);
        if (!p) return;
        if (pend?.tool !== "spline") return setSession("pending", { tool: "spline", through: [p] });
        const first = pend.through[0]!;
        const last = pend.through[pend.through.length - 1]!;
        // Click on the first point: closed spline; on the last point again: open spline ended.
        if (pend.through.length >= 3 && ((p.id && p.id === first.id) || Math.hypot(p.x - first.x, p.y - first.y) < 1e-9)) {
          addSpline(pend.through, true, session.construction);
          return setSession("pending", null);
        }
        if ((p.id && p.id === last.id) || Math.hypot(p.x - last.x, p.y - last.y) < 1e-9) {
          if (pend.through.length >= 2) addSpline(pend.through, false, session.construction);
          return setSession("pending", null);
        }
        setSession("pending", { tool: "spline", through: [...pend.through, p] });
        return;
      }
      case "point": {
        const p = pick(sx, sy, undefined, true);
        if (p) addPoint(p);
        return;
      }
      case "text": {
        const p = pick(sx, sy, undefined, true);
        if (p) setSession("textAt", { x: p.x, y: p.y });
        return;
      }
      case "dimension": {
        const hit = hitOrExternal(sx, sy);
        const kind = session.dimKind;
        if (pend?.tool !== "dimension") {
          if (!hit) return;
          const g = geometry().find((x) => x.id === hit);
          if (!kind && (g?.type === "circle" || g?.type === "arc")) return void dimensionFor([hit]);
          setSession({ pending: { tool: "dimension", first: hit }, selection: [hit] });
          return;
        }
        if (hit && hit !== pend.first) dimensionFor([pend.first, hit], kind);
        else if (kind !== "angle") dimensionFor([pend.first], kind);
        setSession({ pending: null, selection: [] });
        return;
      }
      case "constraint":
        return constraintPick(hitOrExternal(sx, sy));
      case "trim": {
        const hit = hitTest(sx, sy);
        const q = toSketch(sx, sy);
        const g = geometry().find((x) => x.id === hit);
        if (q && g && g.type !== "point") trimAt(g.id, q);
        return;
      }
      case "fillet": {
        const hit = hitTest(sx, sy, true);
        if (hit) filletAt(hit);
        return;
      }
      case "project": {
        const r = v.element.getBoundingClientRect();
        const hit = v.edgeAt(sx + r.left, sy + r.top);
        if (!hit) return;
        const f = frame();
        const pts = hit.points.map(([x, y, z]) => {
          const d = { x: x - f.origin.x, y: y - f.origin.y, z: z - f.origin.z };
          return { x: d.x * f.xDir.x + d.y * f.xDir.y + d.z * f.xDir.z, y: d.x * f.yDir.x + d.y * f.yDir.y + d.z * f.yDir.z };
        });
        addProjected(pts, linkedRef(hit));
        return;
      }
      case "select":
        return;
    }
  }

  // --- Lifecycle-------------------------------------------------------------------------------

  onMount(() => {
    const el = v.element;
    const unsub = v.onViewChange(() => {
      setViewVersion((n) => n + 1);
      setSettled(!v.animating);
    });
    const ctx = (ev: MouseEvent) => {
      if (session.pending) {
        ev.preventDefault();
        setSession("pending", null);
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("contextmenu", ctx);
    v.setRotateEnabled(false);
    // Left drag moves points; the view pans with Shift / Ctrl + left drag (or right drag without gesture menu).
    v.setLeftDragPan(false);
    v.setPickingEnabled(false);
    onCleanup(() => {
      unsub();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("contextmenu", ctx);
      v.setRotateEnabled(true);
      v.setLeftDragPan(true);
      v.setPickingEnabled(true);
    });
  });

  // Camera normal to the sketch plane (and at each plane change).
  createEffect(() => {
    const f = frame();
    v.lookAlong(f.normal, f.yDir);
  });

  // --- Rendering----------------------------------------------------------------------------------------

  const fullyConstrained = () => session.solved && session.dof === 0 && session.conflicting.length === 0;
  const selected = (id: string) => session.selection.includes(id);

  const regions = createMemo(() => {
    viewVersion();
    const a = session.profiles;
    if (!a) return [];
    return a.regions.map((r) => [r.outer, ...r.holes].map((l) => pathOf(l.polygon.map(toScreen)) + "Z").join(" "));
  });

  const freeEnds = createMemo(() => {
    viewVersion();
    const p = pts();
    const inGap = new Set(session.gaps.flatMap((g) => [g.a, g.b]));
    return session.freeEnds.filter((id) => !inGap.has(id) && p.has(id)).map((id) => toScreen(p.get(id)!));
  });
  const gaps = createMemo(() => {
    viewVersion();
    const p = pts();
    return session.gaps.filter((g) => p.has(g.a) && p.has(g.b)).map((g) => ({ a: toScreen(p.get(g.a)!), b: toScreen(p.get(g.b)!) }));
  });

  const curveClass = (g: SkGeometry) =>
    ["sk-curve", g.construction ? "construction" : "", g.projected ? "projected" : "", g.external ? "external" : "", fullyConstrained() ? "full" : "", selected(g.id) ? "selected" : "", session.hover === g.id ? "hover" : ""].join(" ");

  /** Constraint badges, grouped by element. */
  const badges = createMemo(() => {
    viewVersion();
    const p = pts();
    const out: { c: SkConstraint; x: number; y: number }[] = [];
    const count = new Map<string, number>();
    const anchorOf = (id: string): S | null => {
      const g = geometry().find((x) => x.id === id);
      if (!g) return null;
      if (g.type === "point") return toScreen(g);
      const s = sampleCurve(g, p);
      if (g.type === "line") return toScreen({ x: (s[0]!.x + s[1]!.x) / 2, y: (s[0]!.y + s[1]!.y) / 2 });
      return toScreen(s[Math.floor(s.length / 2)] ?? s[0]!);
    };
    for (const c of sk().constraints) {
      const ids = "point" in c ? [c.point] : c.type === "symmetric" ? [c.a, c.b] : "b" in c ? [c.a, c.b] : [c.a];
      for (const id of ids) {
        const a = anchorOf(id);
        if (!a) continue;
        const n = count.get(id) ?? 0;
        count.set(id, n + 1);
        out.push({ c, x: a.x + 10 + n * 16, y: a.y - 14 });
      }
    }
    return out;
  });

  const dims = createMemo(() => {
    viewVersion();
    const g = unwrap(geometry());
    const px = v.pixelSize();
    return sk().dimensions.map((d) => {
      const x = dimensionGraphic(d, g, px);
      return x && { d, L: toScreen(x.L), segs: x.segs.map(([a, b]) => [toScreen(a), toScreen(b)] as const), arc: x.arc?.map(toScreen), arrows: x.arrows, text: x.text, mid: x.mid };
    });
  });

  const preview = createMemo(() => {
    viewVersion();
    const pend = session.pending;
    const c = session.cursor;
    if (!pend || !c) return "";
    const P = (p: Pt) => toScreen(p);
    if (pend.tool === "line") return pathOf([P(pend.start), P(c)]);
    if (pend.tool === "rect") return pathOf([pend.start, { x: c.x, y: pend.start.y }, c, { x: pend.start.x, y: c.y }, pend.start].map(P));
    if (pend.tool === "rectCenter") {
      const s = pend.start;
      const o = { x: 2 * s.x - c.x, y: 2 * s.y - c.y };
      return pathOf([o, { x: c.x, y: o.y }, c, { x: o.x, y: c.y }, o].map(P));
    }
    if (pend.tool === "circle") {
      const r = Math.hypot(c.x - pend.start.x, c.y - pend.start.y);
      return pathOf(Array.from({ length: 65 }, (_, i) => ({ x: pend.start.x + r * Math.cos((i / 64) * 2 * Math.PI), y: pend.start.y + r * Math.sin((i / 64) * 2 * Math.PI) })).map(P));
    }
    if (pend.tool === "arc") {
      if (!pend.start) return pathOf([P(pend.center), P(c)]);
      const ce = pend.center;
      const r = Math.hypot(pend.start.x - ce.x, pend.start.y - ce.y);
      const a0 = Math.atan2(pend.start.y - ce.y, pend.start.x - ce.x);
      let a1 = Math.atan2(c.y - ce.y, c.x - ce.x);
      if (a1 <= a0) a1 += 2 * Math.PI;
      return pathOf(Array.from({ length: 49 }, (_, i) => a0 + ((a1 - a0) * i) / 48).map((a) => P({ x: ce.x + r * Math.cos(a), y: ce.y + r * Math.sin(a) })));
    }
    if (pend.tool === "spline") {
      const through = [...pend.through, c];
      const fit = interpolateBSpline(through);
      if (!fit) return pathOf(through.map(P));
      const ids = fit.poles.map((_, i) => `p${i}`);
      const poles = new Map(ids.map((id, i) => [id, fit.poles[i]!]));
      return pathOf(sampleBSpline({ id: "", type: "bspline", poles: ids, degree: fit.degree }, poles, 24).map(P));
    }
    return "";
  });

  // --- Dimension labels: move and input--------------------------------------------------------

  let labelDrag: { id: string; mid: Pt; moved: boolean } | null = null;
  const onLabelDown = (ev: PointerEvent, id: string, mid: Pt) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    labelDrag = { id, mid, moved: false };
    select(id, ev.shiftKey || ev.ctrlKey);
  };
  const onLabelMove = (ev: PointerEvent) => {
    if (!labelDrag) return;
    const p = local(ev);
    const q = toSketch(p.x, p.y);
    if (!q) return;
    labelDrag.moved = true;
    moveDimensionLabel(labelDrag.id, { x: q.x - labelDrag.mid.x, y: q.y - labelDrag.mid.y });
  };
  const onLabelUp = () => {
    labelDrag = null;
  };

  const editing = () => dims().find((x) => x?.d.id === session.editingDim) ?? null;

  return (
    <>
      <svg class="sketch-overlay" data-settled={settled() ? "yes" : "no"}>
        <defs>
          <marker id="sk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" class="sk-arrowhead" />
          </marker>
        </defs>
        {/* Axes and origin */}
        {(() => {
          const axis = (dir: Pt) => {
            const far = 1e5;
            return pathOf([toScreen({ x: -far * dir.x, y: -far * dir.y }), toScreen({ x: far * dir.x, y: far * dir.y })]);
          };
          return (
            <>
              <path d={axis({ x: 1, y: 0 })} class="sk-axis h" classList={{ selected: selected(SKETCH_AXIS_H), hover: session.hover === SKETCH_AXIS_H }} />
              <path d={axis({ x: 0, y: 1 })} class="sk-axis v" classList={{ selected: selected(SKETCH_AXIS_V), hover: session.hover === SKETCH_AXIS_V }} />
            </>
          );
        })()}
        <Index each={regions()}>{(d) => <path d={d()} class="sk-region" classList={{ full: fullyConstrained() }} fill-rule="evenodd" />}</Index>
        <Index each={controlPolygons()}>{(c) => <path d={pathOf(c())} class="sk-control" />}</Index>
        <Index each={screenCurves()}>{(c) => <path d={pathOf(c().s)} class={curveClass(c().g)} />}</Index>
        <For each={dims()}>
          {(x) => (
            <Show when={x}>
              {(dm) => (
                <g class="sk-dim" classList={{ selected: selected(dm().d.id), reference: !dm().d.driving }}>
                  <For each={dm().segs}>
                    {([a, b], i) => (
                      <line
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        marker-end={dm().arrows && i() === dm().segs.length - 1 ? "url(#sk-arrow)" : undefined}
                        marker-start={dm().arrows && i() === dm().segs.length - 1 ? "url(#sk-arrow)" : undefined}
                      />
                    )}
                  </For>
                  <Show when={dm().arc}>{(arc) => <path d={pathOf(arc())} class="sk-dim-arc" marker-start="url(#sk-arrow)" marker-end="url(#sk-arrow)" />}</Show>
                  <g
                    class="sk-ui sk-dim-label"
                    transform={`translate(${dm().L.x},${dm().L.y})`}
                    onPointerDown={(e) => onLabelDown(e, dm().d.id, dm().mid)}
                    onPointerMove={onLabelMove}
                    onPointerUp={onLabelUp}
                    onDblClick={() => setSession("editingDim", dm().d.id)}
                  >
                    <rect x={-(dm().text.length * 3.6 + 6)} y={-10} width={dm().text.length * 7.2 + 12} height={20} rx={4} />
                    <text text-anchor="middle" dominant-baseline="central">
                      {dm().text}
                    </text>
                  </g>
                </g>
              )}
            </Show>
          )}
        </For>
        <Index each={screenPoints()}>
          {(p) => (
            <circle
              cx={p().s.x}
              cy={p().s.y}
              r={p().id === SKETCH_ORIGIN ? 4 : 3}
              class="sk-point"
              classList={{ origin: p().id === SKETCH_ORIGIN, external: !!(geometry().find((g) => g.id === p().id)?.external), full: fullyConstrained(), selected: selected(p().id), hover: session.hover === p().id }}
            />
          )}
        </Index>
        {/* Open contour ends, and nearby ends that do not touch */}
        <Index each={freeEnds()}>{(p) => <circle cx={p().x} cy={p().y} r={5} class="sk-free-end" />}</Index>
        <Index each={gaps()}>
          {(g) => (
            <g class="sk-gap">
              <line x1={g().a.x} y1={g().a.y} x2={g().b.x} y2={g().b.y} />
              <circle cx={(g().a.x + g().b.x) / 2} cy={(g().a.y + g().b.y) / 2} r={Math.max(9, Math.hypot(g().b.x - g().a.x, g().b.y - g().a.y) / 2 + 6)} />
            </g>
          )}
        </Index>
        <Index each={badges()}>
          {(b) => (
            <g
              class="sk-ui sk-badge"
              classList={{ conflict: session.conflicting.includes(b().c.id) || session.redundant.includes(b().c.id), selected: selected(b().c.id) }}
              transform={`translate(${b().x},${b().y})`}
              onPointerDown={(e) => {
                e.stopPropagation();
                select(b().c.id, e.shiftKey || e.ctrlKey);
              }}
            >
              <rect x={-7} y={-7} width={14} height={14} rx={3} />
              <text text-anchor="middle" dominant-baseline="central">
                {GLYPHS[b().c.type]}
              </text>
            </g>
          )}
        </Index>
        <For each={centers()}>
          {(c) => {
            const s = () => toScreen(c);
            return <path d={`M${s().x - 5},${s().y}h10M${s().x},${s().y - 5}v10`} class="sk-ext-center" />;
          }}
        </For>
        <Show when={extHover()}>
          {(e) => (e().dot ? <circle cx={e().dot!.x} cy={e().dot!.y} r={4.5} class="sk-ext-hover dot" /> : <path d={pathOf(e().path ?? [])} class="sk-ext-hover" />)}
        </Show>
        <Show when={preview()}>
          <path d={preview()} class="sk-preview" classList={{ construction: session.construction }} />
        </Show>
        <Show when={inference() && session.cursor && session.pending}>
          {(() => {
            const c = toScreen(session.cursor!);
            return (
              <text x={c.x + 12} y={c.y + 18} class="sk-inference">
                {inference()}
              </text>
            );
          })()}
        </Show>
      </svg>
      <Show when={editing()}>
        {(e) => {
          let input: HTMLInputElement | undefined;
          const isLen = () => e().d.type !== "angle";
          const shown = () => (isLen() ? decodeLen(e().d.value) : e().d.value);
          return (
            <div class="sk-dim-edit sk-ui" style={{ left: `${e().L.x - 50}px`, top: `${e().L.y - 14}px` }}>
              <input
                class="sk-dim-input"
                // Initial value only: the field must not be rewritten during typing.
                value={untrack(shown)}
                ref={(el) => {
                  input = el;
                  queueMicrotask(() => (el.focus(), el.select()));
                }}
                onKeyDown={(ev) => {
                  ev.stopPropagation();
                  if (ev.key === "Enter") {
                    setDimensionValue(e().d.id, ev.currentTarget.value);
                    setSession("editingDim", null);
                  } else if (ev.key === "Escape") setSession("editingDim", null);
                }}
                onBlur={() => setSession("editingDim", null)}
              />
              <Stepper
                get={() => input?.value ?? shown()}
                set={(v) => {
                  if (input) input.value = v;
                  setDimensionValue(e().d.id, v);
                }}
                step={isLen() ? lenStep() : 1}
                evalExpr={isLen() ? lenEvaluator(parameterScope) : undefined}
              />
            </div>
          );
        }}
      </Show>
    </>
  );
}

export type { SkDimension };
