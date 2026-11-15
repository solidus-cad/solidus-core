import { createMemo, createSignal, For, Index, onCleanup, onMount, Show, untrack } from "solid-js";
import { AXIS_DIR, type Axis3, type Sk3Constraint, type Sk3Point, type V3 } from "@solidus-cad/sdk";
import { measure3D, sampleSpline3 } from "@solidus-cad/sketch";
import type { Viewer } from "@solidus-cad/viewer";
import { t } from "../i18n.ts";
import { faceOfLeaf } from "../workspace.ts";
import {
  addDimension,
  beginDrag3,
  currentPlane,
  dimensionClick,
  dirToLocal,
  dragTo3,
  endDrag3,
  isDragging3,
  lineClick,
  planeFromFace,
  planeLabel,
  planePointClick,
  pointClick,
  posOf,
  s3,
  s3Scope,
  select,
  setDimensionValue,
  setS3,
  splineClick,
  cancelPending,
  snapVertices,
  toLocal,
  toWorld,
  viewDirLocal,
} from "./session.ts";
import { add, closestOnLine, cross, dot, infer, intersectPlane, norm, scale, sub, unit, type S2 } from "./infer.ts";
import { Stepper } from "../components/Stepper.tsx";
import { isPlainNumber, splitUnitNumber } from "@solidus-cad/sdk";
import { decodeLen, fmtLen, isInch, lenEvaluator, lenStep, MM_PER_INCH } from "../units.ts";

const POINT_HIT = 8;
const LINE_HIT = 6;

export const AXIS_COLOR: Record<Axis3, string> = { X: "#d64545", Y: "#2f9e5b", Z: "#2f6fd6" };

const GLYPHS: Record<Sk3Constraint["type"], string> = {
  axis: "",
  inPlane: "▱",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  pointOnLine: "•",
  fix: "⚓",
};

const fmt = (v: number) => String(Math.round(v * 10) / 10);
/** Length in the display unit (1 decimal in mm, 2 in inches). */
const fmtL = (v: number) => fmtLen(v, { digits: isInch() ? 2 : 1 });
const isNumber = (s: string) => isPlainNumber(s) || splitUnitNumber(s) !== null;

function distToSegment(p: S2, a: S2, b: S2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

/** Round grid step (1, 2, 5 × 10ⁿ). */
function niceStep(x: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}

/** 3D sketch editing SVG layer, overlaid on the assembly view (the orbit stays free). */
export function Sketch3DEditor(props: { viewer: Viewer }) {
  const v = props.viewer;
  const [viewVersion, setViewVersion] = createSignal(0);
  const [shift, setShift] = createSignal<Axis3 | null>(null);

  const toScreen = (p: V3): S2 => {
    viewVersion();
    const w = toWorld(p);
    return v.worldToScreen({ x: w[0], y: w[1], z: w[2] });
  };
  const local = (ev: PointerEvent | MouseEvent) => {
    const r = v.element.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const rayAt = (s: S2) => {
    const r = v.rayAt(s.x, s.y);
    return { o: toLocal(r.origin), d: unit(dirToLocal(r.dir)) };
  };

  const points = createMemo(() => s3.data.geometry.filter((g): g is Sk3Point => g.type === "point"));
  const screenPoints = createMemo(() => {
    viewVersion();
    return points().map((p) => ({ id: p.id, p: [p.x, p.y, p.z] as V3, s: toScreen([p.x, p.y, p.z]) }));
  });
  // Lines, and splines as short segments of the interpolated curve (same identifier: picked and drawn as one curve).
  const screenLines = createMemo(() => {
    const sp = new Map(screenPoints().map((p) => [p.id, p]));
    return s3.data.geometry.flatMap((g) => {
      if (g.type === "line") {
        const a = sp.get(g.p1);
        const b = sp.get(g.p2);
        return a && b ? [{ id: g.id, a, b, construction: !!g.construction }] : [];
      }
      if (g.type !== "spline") return [];
      const through = g.points.flatMap((id) => (sp.has(id) ? [sp.get(id)!.p] : []));
      if (through.length < 2) return [];
      const at = sampleSpline3(through).map((p) => ({ id: "", p, s: toScreen(p) }));
      return at.slice(1).map((b, i) => ({ id: g.id, a: at[i]!, b, construction: !!g.construction }));
    });
  });

  // --- Detection-----------------------------------------------------------------------------------

  function hitTest(s: S2, pointsOnly = false): string | null {
    let best: string | null = null;
    let bestD = POINT_HIT;
    for (const p of screenPoints()) {
      const d = Math.hypot(p.s.x - s.x, p.s.y - s.y);
      if (d < bestD) [best, bestD] = [p.id, d];
    }
    if (best || pointsOnly) return best;
    bestD = LINE_HIT;
    for (const l of screenLines()) {
      const d = distToSegment(s, l.a.s, l.b.s);
      if (d < bestD) [best, bestD] = [l.id, d];
    }
    return best;
  }

  /** Face of a part under the cursor (skeleton frame): impact point and plane if the face is planar. */
  function faceAt(s: S2): { point: V3; plane?: { p: V3; n: V3 }; world: { p: V3; n: V3 } | null } | null {
    const hit = v.pickAssemblyAt(s.x, s.y);
    if (!hit) return null;
    const f = faceOfLeaf(hit.key, hit.faceIndex);
    const point = toLocal(hit.point);
    if (!f?.ref || f.ref.kind !== "plane") return { point, world: null };
    const m = f.matrix;
    const pw: V3 = [
      m[0]! * f.ref.p[0] + m[4]! * f.ref.p[1] + m[8]! * f.ref.p[2] + m[12]!,
      m[1]! * f.ref.p[0] + m[5]! * f.ref.p[1] + m[9]! * f.ref.p[2] + m[13]!,
      m[2]! * f.ref.p[0] + m[6]! * f.ref.p[1] + m[10]! * f.ref.p[2] + m[14]!,
    ];
    const nw = unit([
      m[0]! * f.ref.d[0] + m[4]! * f.ref.d[1] + m[8]! * f.ref.d[2],
      m[1]! * f.ref.d[0] + m[5]! * f.ref.d[1] + m[9]! * f.ref.d[2],
      m[2]! * f.ref.d[0] + m[6]! * f.ref.d[1] + m[10]! * f.ref.d[2],
    ]);
    return { point, plane: { p: toLocal(pw), n: unit(dirToLocal(nw)) }, world: { p: pw, n: nw } };
  }

  const from = () => (s3.pending ? posOf(s3.pending.from) : null);
  /** Tools that place points (inference, grid, cursor). */
  const drawing = () => s3.tool === "line" || s3.tool === "spline" || s3.tool === "point";

  function inferAt(s: S2) {
    const f = from();
    // Part faces only snap the point with the automatic plane: a chosen plane takes priority.
    const face = s3.work.mode === "auto" && drawing() ? faceAt(s) : null;
    return infer({
      toScreen,
      cursor: s,
      ray: rayAt(s),
      points: screenPoints().map((p) => ({ id: p.id, p: p.p })),
      vertices: snapVertices(),
      from: f ?? undefined,
      fromId: s3.pending?.from,
      lock: s3.lock ?? shift(),
      plane: currentPlane(f),
      face: face ? { point: face.point, plane: face.plane } : null,
    });
  }

  // --- Mouse--------------------------------------------------------------------------------------

  let down: { s: S2; hit: string | null; dragging: boolean; button: number } | null = null;

  function onDown(ev: PointerEvent) {
    if ((ev.target as Element).closest?.(".s3-ui")) return;
    const s = local(ev);
    const hit = s3.tool === "select" ? hitTest(s, true) : null;
    down = { s, hit, dragging: false, button: ev.button };
    // A grabbed point is moved: orbit and pan are suspended during the drag.
    if (ev.button === 0 && hit) {
      v.setRotateEnabled(false);
      v.setPanEnabled(false);
    }
  }

  function onMove(ev: PointerEvent) {
    const s = local(ev);
    if (down?.hit && down.button === 0 && ev.buttons === 1) {
      if (!down.dragging && Math.hypot(s.x - down.s.x, s.y - down.s.y) > 3) {
        down.dragging = true;
        beginDrag3(down.hit);
      }
      if (down.dragging) {
        const p0 = posOf(down.hit);
        if (!p0) return;
        const ray = rayAt(s);
        const lock = s3.lock ?? shift();
        // Dragged point: on the locked axis, otherwise in the plane facing the camera passing through the point.
        const target = lock ? closestOnLine(p0, AXIS_DIR[lock], ray) : intersectPlane(ray, { p: p0, n: unit(viewDirLocal()) });
        if (target) dragTo3(target);
        return;
      }
    }
    if (ev.buttons !== 0) return;
    const cursor = drawing() ? inferAt(s) : null;
    setS3({ cursor, hover: hitTest(s) });
  }

  function onUp(ev: PointerEvent) {
    const d = down;
    down = null;
    v.setRotateEnabled(true);
    v.setPanEnabled(true);
    if (d?.dragging || isDragging3()) {
      endDrag3();
      return;
    }
    if (ev.button !== 0 || (ev.target as Element).closest?.(".s3-ui")) return;
    const s = local(ev);
    if (d && Math.hypot(s.x - d.s.x, s.y - d.s.y) > 4) return; // orbit
    click(s, ev.shiftKey || ev.ctrlKey || ev.metaKey);
  }

  function click(s: S2, additive: boolean) {
    switch (s3.tool) {
      case "line":
      case "spline":
      case "point": {
        const inf = inferAt(s);
        if (!inf) return;
        if (s3.tool === "line") lineClick(inf);
        else if (s3.tool === "spline") splineClick(inf);
        else pointClick(inf);
        setS3("cursor", inferAt(s));
        return;
      }
      case "plane": {
        const id = hitTest(s, true);
        if (id) return planePointClick(id);
        const f = faceAt(s);
        if (f?.world) planeFromFace(f.world.p, f.world.n);
        return;
      }
      case "dimension":
        return dimensionClick(hitTest(s));
      case "select":
        return select(hitTest(s), additive);
    }
  }

  function onDblClick(ev: MouseEvent) {
    if (s3.tool !== "select" && s3.tool !== "dimension") return;
    const id = hitTest(local(ev));
    if (id && s3.data.geometry.find((g) => g.id === id)?.type === "line") {
      setS3("picks", []);
      addDimension({ type: "length", a: id, driving: true });
    }
  }

  onMount(() => {
    const el = v.element;
    const unsub = v.onViewChange(() => setViewVersion((n) => n + 1));
    const ctx = (ev: MouseEvent) => {
      if (s3.pending) {
        ev.preventDefault();
        cancelPending();
      }
    };
    // Shift held: freezes the current axis inference.
    const kd = (ev: KeyboardEvent) => {
      if (ev.key === "Shift" && !shift() && s3.cursor?.axis) setShift(s3.cursor.axis);
    };
    const ku = (ev: KeyboardEvent) => {
      if (ev.key === "Shift") setShift(null);
    };
    // Capture: before the orbit, to suspend it when a point is grabbed.
    el.addEventListener("pointerdown", onDown, { capture: true });
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDblClick);
    el.addEventListener("contextmenu", ctx);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    v.setPickingEnabled(false);
    onCleanup(() => {
      unsub();
      el.removeEventListener("pointerdown", onDown, { capture: true });
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDblClick);
      el.removeEventListener("contextmenu", ctx);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      v.setPickingEnabled(true);
      v.setRotateEnabled(true);
      v.setPanEnabled(true);
    });
  });

  // --- Rendering------------------------------------------------------------------------------------------

  const path = (pts: S2[]) => (pts.length ? "M" + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L") : "");
  const px = () => (viewVersion(), v.pixelSize());

  /** Local grid of the work plane, centred on the targeted point. */
  const grid = createMemo(() => {
    const pl = currentPlane(from());
    if (!drawing()) return null;
    const center = s3.cursor?.p ?? from() ?? pl.p;
    // Plane frame: two orthonormal axes (principal axes for a principal plane).
    const n = unit(pl.n);
    const ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = unit(cross(n, cross(ref, n)));
    const w = cross(n, u);
    const half = 140 * px();
    const step = isInch() ? niceStep(half / 4 / MM_PER_INCH) * MM_PER_INCH : niceStep(half / 4);
    // Centre projected onto the plane, snapped to the grid.
    const c0 = sub(center, scale(n, dot(sub(center, pl.p), n)));
    const cu = Math.round(dot(sub(c0, pl.p), u) / step) * step;
    const cw = Math.round(dot(sub(c0, pl.p), w) / step) * step;
    const at = (a: number, b: number) => toScreen(add(pl.p, add(scale(u, a), scale(w, b))));
    const k = Math.ceil(half / step);
    const lines: string[] = [];
    for (let i = -k; i <= k; i++) {
      lines.push(path([at(cu + i * step, cw - k * step), at(cu + i * step, cw + k * step)]));
      lines.push(path([at(cu - k * step, cw + i * step), at(cu + k * step, cw + i * step)]));
    }
    const axis: Axis3 = Math.abs(n[2]) > 0.9 ? "Z" : Math.abs(n[1]) > 0.9 ? "Y" : "X";
    return { d: lines.join(""), color: pl.fixed ? "var(--sk-sel)" : AXIS_COLOR[axis] };
  });

  /** Triad at the start point of the segment. */
  const triad = createMemo(() => {
    const f = from();
    if (!f || (s3.tool !== "line" && s3.tool !== "spline")) return [];
    const l = 50 * px();
    return (["X", "Y", "Z"] as Axis3[]).map((a) => ({ a, d: path([toScreen(f), toScreen(add(f, scale(AXIS_DIR[a], l)))]) }));
  });

  /** Guide of the inferred or locked axis (infinite line). */
  const axisGuide = createMemo(() => {
    const c = s3.cursor;
    const f = from();
    if (!c?.axis || !f) return null;
    const far = 1e4 * px();
    const u = AXIS_DIR[c.axis];
    return { d: path([toScreen(sub(f, scale(u, far))), toScreen(add(f, scale(u, far)))]), color: AXIS_COLOR[c.axis], locked: c.kind === "lock" };
  });

  const alignGuides = createMemo(() => {
    const c = s3.cursor;
    if (!c) return [];
    return c.align.map((g) => ({ d: path([toScreen(g.from), toScreen(c.p)]), color: AXIS_COLOR[g.axis] }));
  });

  const rubber = createMemo(() => {
    const c = s3.cursor;
    const f = from();
    return c && f && (s3.tool === "line" || s3.tool === "spline") ? path([toScreen(f), toScreen(c.p)]) : "";
  });

  /** Cursor tooltip: axis and length, or coordinates. */
  const tip = createMemo(() => {
    const c = s3.cursor;
    if (!c) return null;
    const s = toScreen(c.p);
    const f = from();
    const text = s3.typed
      ? s3.typed
      : f && s3.tool === "line"
        ? `${c.axis ? `${c.axis}  ` : ""}${fmtL(norm(sub(c.p, f)))}`
        : `${fmtL(c.p[0])} ; ${fmtL(c.p[1])} ; ${fmtL(c.p[2])}`;
    const snap = c.kind === "point" ? t("s3d.snapPoint") : c.kind === "vertex" ? t("s3d.snapVertex") : c.kind === "face" ? t("s3d.snapFace") : "";
    return { s, text, snap, kind: c.kind };
  });

  const badges = createMemo(() => {
    const sp = new Map(screenPoints().map((p) => [p.id, p.s]));
    const mid = new Map(screenLines().map((l) => [l.id, { x: (l.a.s.x + l.b.s.x) / 2, y: (l.a.s.y + l.b.s.y) / 2 }]));
    const count = new Map<string, number>();
    const out: { c: Sk3Constraint; x: number; y: number; text: string; color?: string }[] = [];
    for (const c of s3.data.constraints) {
      const target = c.type === "axis" ? c.line : c.type === "inPlane" ? c.target : c.type === "pointOnLine" || c.type === "fix" ? c.point : c.a;
      const a = mid.get(target) ?? sp.get(target);
      if (!a) continue;
      const n = count.get(target) ?? 0;
      count.set(target, n + 1);
      out.push({ c, x: a.x + 10 + n * 16, y: a.y - 14, text: c.type === "axis" ? c.axis : GLYPHS[c.type], color: c.type === "axis" ? AXIS_COLOR[c.axis] : undefined });
    }
    return out;
  });

  const dims = createMemo(() => {
    viewVersion();
    const sp = new Map(screenPoints().map((p) => [p.id, p.s]));
    const ends = (id: string) => {
      const l = screenLines().find((x) => x.id === id);
      return l ? [l.a.s, l.b.s] : null;
    };
    return s3.data.dimensions.flatMap((d) => {
      const m = measure3D(s3.data, d) ?? 0;
      let anchor: S2 | null = null;
      if (d.type === "length") {
        const e = ends(d.a);
        if (e) anchor = { x: (e[0]!.x + e[1]!.x) / 2, y: (e[0]!.y + e[1]!.y) / 2 };
      } else if (d.type === "distance") {
        const a = sp.get(d.a);
        const b = d.b ? sp.get(d.b) : undefined;
        if (a && b) anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      } else {
        const a = ends(d.a);
        const b = d.b ? ends(d.b) : null;
        if (a && b) anchor = { x: (a[0]!.x + a[1]!.x + b[0]!.x + b[1]!.x) / 4, y: (a[0]!.y + a[1]!.y + b[0]!.y + b[1]!.y) / 4 };
      }
      if (!anchor) return [];
      const value = d.type === "angle" ? `${fmt(m)}°` : fmtL(m);
      const text = !d.driving ? `(${value})` : isNumber(d.value) ? value : `${d.value} = ${value}`;
      return [{ d, L: { x: anchor.x - 14, y: anchor.y + 16 }, text, conflict: s3.conflicting.includes(d.id) }];
    });
  });

  const editing = () => dims().find((x) => x.d.id === s3.editingDim) ?? null;
  const sel = (id: string) => s3.selection.includes(id) || s3.picks.includes(id);
  const conflictOf = (lineId: string) =>
    s3.data.constraints.some((c) => s3.conflicting.includes(c.id) && ((c.type === "axis" && c.line === lineId) || ("a" in c && (c.a === lineId || c.b === lineId))));

  return (
    <>
      <svg class="sketch-overlay s3-overlay">
        <Show when={grid()}>{(g) => <path d={g().d} class="s3-grid" style={{ stroke: g().color }} />}</Show>
        <Show when={axisGuide()}>{(g) => <path d={g().d} class="s3-axis-guide" classList={{ locked: g().locked }} style={{ stroke: g().color }} />}</Show>
        <For each={alignGuides()}>{(g) => <path d={g.d} class="s3-align-guide" style={{ stroke: g.color }} />}</For>
        <For each={triad()}>{(x) => <path d={x.d} class="s3-triad" style={{ stroke: AXIS_COLOR[x.a] }} />}</For>
        <Index each={screenLines()}>
          {(l) => (
            <line
              x1={l().a.s.x}
              y1={l().a.s.y}
              x2={l().b.s.x}
              y2={l().b.s.y}
              class="sk-curve s3-line"
              classList={{
                construction: l().construction,
                full: s3.dof === 0 && s3.conflicting.length === 0,
                selected: sel(l().id),
                hover: s3.hover === l().id,
                conflict: conflictOf(l().id),
              }}
            />
          )}
        </Index>
        <Show when={rubber()}>
          <path d={rubber()} class="sk-preview" style={{ stroke: s3.cursor?.axis ? AXIS_COLOR[s3.cursor.axis] : undefined }} />
        </Show>
        <For each={dims()}>
          {(x) => (
            <g
              class="s3-ui sk-dim sk-dim-label"
              classList={{ reference: !x.d.driving, selected: sel(x.d.id), conflict: x.conflict }}
              transform={`translate(${x.L.x},${x.L.y})`}
              onPointerDown={(e) => {
                e.stopPropagation();
                select(x.d.id, e.shiftKey || e.ctrlKey);
              }}
              onDblClick={(e) => {
                e.stopPropagation();
                if (x.d.driving) setS3("editingDim", x.d.id);
              }}
            >
              <rect x={-(x.text.length * 3.6 + 6)} y={-10} width={x.text.length * 7.2 + 12} height={20} rx={4} />
              <text text-anchor="middle" dominant-baseline="central">
                {x.text}
              </text>
            </g>
          )}
        </For>
        <Index each={screenPoints()}>
          {(p) => (
            <circle
              cx={p().s.x}
              cy={p().s.y}
              r={3.5}
              class="sk-point"
              classList={{ full: s3.dof === 0 && s3.conflicting.length === 0, selected: sel(p().id), hover: s3.hover === p().id }}
            />
          )}
        </Index>
        <Index each={badges()}>
          {(b) => (
            <g
              class="s3-ui sk-badge"
              classList={{ conflict: s3.conflicting.includes(b().c.id), selected: sel(b().c.id) }}
              transform={`translate(${b().x},${b().y})`}
              onPointerDown={(e) => {
                e.stopPropagation();
                select(b().c.id, e.shiftKey || e.ctrlKey);
              }}
            >
              <rect x={-7} y={-7} width={14} height={14} rx={3} />
              <text text-anchor="middle" dominant-baseline="central" style={{ fill: b().color }}>
                {b().text}
              </text>
            </g>
          )}
        </Index>
        <Show when={tip()}>
          {(x) => (
            <g transform={`translate(${x().s.x},${x().s.y})`}>
              <Show when={x().kind === "point"}>
                <circle r={7} class="s3-snap" />
              </Show>
              <Show when={x().kind === "vertex"}>
                <rect x={-6} y={-6} width={12} height={12} class="s3-snap" />
              </Show>
              <Show when={x().kind === "face"}>
                <path d="M0,-7 L7,0 L0,7 L-7,0 Z" class="s3-snap" />
              </Show>
              <text x={14} y={22} class="s3-tip">
                {x().text}
                {x().snap ? `  · ${x().snap}` : ""}
              </text>
            </g>
          )}
        </Show>
      </svg>
      <Show when={editing()}>
        {(e) => {
          let input: HTMLInputElement | undefined;
          const isLen = () => e().d.type !== "angle";
          const shown = () => (isLen() ? decodeLen(e().d.value) : e().d.value);
          return (
            <div class="sk-dim-edit s3-ui" style={{ left: `${e().L.x - 50}px`, top: `${e().L.y - 14}px` }}>
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
                    setS3("editingDim", null);
                  } else if (ev.key === "Escape") setS3("editingDim", null);
                }}
                onBlur={() => setS3("editingDim", null)}
              />
              <Stepper
                get={() => input?.value ?? shown()}
                set={(v) => {
                  if (input) input.value = v;
                  setDimensionValue(e().d.id, v);
                }}
                step={isLen() ? lenStep() : 1}
                evalExpr={isLen() ? lenEvaluator(s3Scope) : undefined}
              />
            </div>
          );
        }}
      </Show>
      <div class="s3-hud s3-ui">
        <span class="s3-hud-plane">
          {t("s3d.workPlane")} : <b>{planeLabel()}</b>
        </span>
        <Show when={s3.lock ?? shift()}>
          {(a) => (
            <span class="s3-hud-lock" style={{ color: AXIS_COLOR[a()] }}>
              {t("s3d.locked")} {a()}
            </span>
          )}
        </Show>
        <Show when={s3.typed}>
          <span class="s3-hud-typed">⌨ {s3.typed}</span>
        </Show>
        <span class="s3-hud-help">{drawing() ? t("s3d.help") : s3.tool === "plane" ? t("s3d.helpPlane") : s3.tool === "dimension" ? t("s3d.helpDim") : t("s3d.helpSelect")}</span>
      </div>
    </>
  );
}
