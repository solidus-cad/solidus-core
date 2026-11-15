import { createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import { evaluate, isPlainNumber, paramShown, splitUnitNumber, sketchFrame, sketchToWorld, type Feature, type Vec3 } from "@solidus-cad/sdk";
import { pointMap } from "@solidus-cad/sketch";
import type { Viewer } from "@solidus-cad/viewer";
import { t, tx } from "../i18n.ts";
import { activeDatums, definitionOf, parameterScope, setParamValue, setSketchDimension, showFeatureDims, state } from "../store.ts";
import { dimensionGraphic } from "../sketch/dimGraphics.ts";
import { Stepper } from "./Stepper.tsx";
import { decodeLen, encodeLen, fmtLen, lenEvaluator, lenStep } from "../units.ts";

type S = { x: number; y: number };
type Frame = ReturnType<typeof sketchFrame>;

/** Editable label: sketch dimension or feature parameter. */
interface Label {
  id: string;
  at: S;
  text: string;
  expr: string;
  /** Length (shown and typed in the display unit). */
  len: boolean;
  /** Dimension lines (screen). */
  segs: (readonly [S, S])[];
  arc?: S[];
  arrows: boolean;
  reference: boolean;
  apply: (value: string) => void;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);
const isNumber = (s: string) => isPlainNumber(s) || splitUnitNumber(s) !== null;
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });

/** Sketches used by a feature (itself if it is a sketch). */
function sketchesOf(f: Feature): Feature[] {
  const ids = f.type === "sketch" ? [f.id] : (definitionOf(f.type)?.params ?? []).filter((p) => p.kind === "sketch").map((p) => f.params[p.key]);
  return ids.flatMap((id) => state.doc.features.filter((g) => g.id === id && g.type === "sketch" && g.sketch));
}

export function frameOf(sk: Feature): Frame {
  let offset = 0;
  try {
    offset = evaluate(sk.sketch!.plane.offset, parameterScope());
  } catch {
    /* invalid offset: plane at the origin */
  }
  const datums = activeDatums();
  return sketchFrame(sk.sketch!.plane, offset, (id) => datums.get(id)?.frame);
}

/** Centre of the bounding box of the solved sketch, in the sketch's coordinate system. */
export function sketchCenter(sk: Feature): S | null {
  const g = state.sketchInfos[sk.id]?.geometry ?? [];
  const at = pointMap(g);
  const pts = g.flatMap((x): S[] => {
    if (x.type === "point") return [x];
    const c = x.type === "circle" ? at.get(x.c) : undefined;
    return c && x.type === "circle" ? [{ x: c.x - x.r, y: c.y - x.r }, { x: c.x + x.r, y: c.y + x.r }] : [];
  });
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/**
 * Dimensions of a feature shown in the view without entering the feature: driving dimensions of its sketches
 * (drawn on their plane) and numeric parameters. Clicking a value edits it (undoable, triggers a recalculation).
 */
export function FeatureDims(props: { viewer: Viewer }) {
  const v = props.viewer;
  const [viewVersion, setViewVersion] = createSignal(0);
  const [editing, setEditing] = createSignal<string | null>(null);

  onMount(() => onCleanup(v.onViewChange(() => setViewVersion((n) => n + 1))));

  const feature = () => state.doc.features.find((f) => f.id === state.dimsFeature);

  const labels = createMemo((): Label[] => {
    viewVersion();
    const f = feature();
    if (!f) return [];
    const scr = (p: Vec3) => v.worldToScreen(p);
    const px = v.pixelSize();
    const out: Label[] = [];

    // Sketch dimensions, on the geometry solved by the kernel.
    for (const sk of sketchesOf(f)) {
      const g = state.sketchInfos[sk.id]?.geometry;
      if (!g) continue;
      const frame = frameOf(sk);
      const toS = (p: S) => scr(sketchToWorld(frame, p.x, p.y));
      for (const d of sk.sketch!.dimensions) {
        const x = dimensionGraphic(d, unwrap(g), px);
        if (!x) continue;
        out.push({
          id: `${sk.id}/${d.id}`,
          at: toS(x.L),
          text: x.text,
          expr: d.value,
          len: d.type !== "angle",
          segs: x.segs.map(([a, b]) => [toS(a), toS(b)] as const),
          arc: x.arc?.map(toS),
          arrows: x.arrows,
          reference: !d.driving,
          apply: (value) => setSketchDimension(sk.id, d.id, d.type === "angle" ? value : encodeLen(value)),
        });
      }
    }

    // Numeric parameters of the feature.
    const def = definitionOf(f.type);
    if (!def) return out;
    const scope = parameterScope();
    const sk = sketchesOf(f)[0];
    const frame = sk ? frameOf(sk) : null;
    const c2 = sk ? sketchCenter(sk) : null;
    const center = frame && c2 ? sketchToWorld(frame, c2.x, c2.y) : null;
    const pos: Vec3 = { x: num(f.params.x), y: num(f.params.y), z: num(f.params.z) };
    // Label anchor without a dimension line: first picked edge/face, sketch centre, position, centroid.
    const m = state.mass?.center;
    const anchor = f.refs?.[0] ? { x: f.refs[0].p[0], y: f.refs[0].p[1], z: f.refs[0].p[2] } : (center ?? (f.params.x !== undefined ? pos : m ? { x: m[0], y: m[1], z: m[2] } : null));
    let stacked = 0;

    function num(expr: string | undefined): number {
      try {
        return expr === undefined ? 0 : evaluate(expr, scope);
      } catch {
        return 0;
      }
    }

    /** 3D dimension line `a` → `b`, or label placed at the anchor (stacked). */
    const along = (key: string, a?: Vec3, b?: Vec3) => {
      const spec = def.params.find((p) => p.key === key)!;
      const expr = f.params[key] ?? spec.default;
      let value: number | undefined;
      try {
        value = evaluate(expr, scope);
      } catch {
        /* expression invalide */
      }
      const len = spec.kind === "length";
      const shown = value === undefined ? "⚠" : len ? fmtLen(value) : `${fmt(value)}${spec.kind === "angle" ? "°" : ""}`;
      const text = isNumber(expr) ? shown : `${expr} = ${shown}`;
      const common = { id: `${f.id}:${key}`, expr, len, reference: false, apply: (val: string) => setParamValue(f.id, key, len ? encodeLen(val) : val) };
      if (a && b) {
        const sa = scr(a);
        const sb = scr(b);
        out.push({ ...common, at: { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 }, text, segs: [[sa, sb]], arrows: true });
      } else if (anchor) {
        const s = scr(anchor);
        out.push({ ...common, at: { x: s.x + 70, y: s.y - 20 + 26 * stacked++ }, text: `${tx(spec.label)} : ${text}`, segs: [], arrows: false });
      }
    };

    const visible = def.params.filter((p) => (p.kind === "length" || p.kind === "angle" || p.kind === "number") && paramShown(p, f.params, def.params));
    for (const p of visible) {
      const len = num(f.params[p.key]);
      if (p.key === "depth" && frame && center && (f.type === "extrude" || f.type === "twistExtrude" || f.type === "thinExtrude")) {
        if (f.params.mode === "throughAll") continue;
        const n = frame.normal;
        const sign = f.params.reverse === "yes" ? -1 : 1;
        const start = f.params.mode === "symmetric" ? add(center, n, (-sign * len) / 2) : center;
        along(p.key, start, add(start, n, sign * len));
      } else if (f.type === "box" && (p.key === "width" || p.key === "depth" || p.key === "height")) {
        const dir = p.key === "width" ? { x: 1, y: 0, z: 0 } : p.key === "depth" ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
        along(p.key, pos, add(pos, dir, len));
      } else if (f.type === "cylinder" && p.key === "height") {
        const a = f.params.axis ?? "z";
        along(p.key, pos, add(pos, { x: a === "x" ? 1 : 0, y: a === "y" ? 1 : 0, z: a === "z" ? 1 : 0 }, len));
      } else along(p.key);
    }
    return out;
  });

  const current = () => labels().find((l) => l.id === editing()) ?? null;

  return (
    <>
      <svg class="sketch-overlay feature-dims">
        <defs>
          <marker id="fd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" class="sk-arrowhead" />
          </marker>
        </defs>
        <For each={labels()}>
          {(l) => (
            <g class="sk-dim" classList={{ reference: l.reference, selected: editing() === l.id }}>
              <For each={l.segs}>
                {([a, b], i) => (
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    marker-end={l.arrows && i() === l.segs.length - 1 ? "url(#fd-arrow)" : undefined}
                    marker-start={l.arrows && i() === l.segs.length - 1 ? "url(#fd-arrow)" : undefined}
                  />
                )}
              </For>
              <Show when={l.arc}>
                {(arc) => <path d={"M" + arc().map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")} marker-start="url(#fd-arrow)" marker-end="url(#fd-arrow)" />}
              </Show>
              <g
                class="sk-dim-label"
                classList={{ "sk-ui": !l.reference }}
                transform={`translate(${l.at.x},${l.at.y})`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => !l.reference && setEditing(l.id)}
              >
                <title>{l.reference ? t("fdim.reference") : t("fdim.edit")}</title>
                <rect x={-(l.text.length * 3.6 + 6)} y={-10} width={l.text.length * 7.2 + 12} height={20} rx={4} />
                <text text-anchor="middle" dominant-baseline="central">
                  {l.text}
                </text>
              </g>
            </g>
          )}
        </For>
      </svg>
      <Show when={current()}>
        {(l) => {
          let input: HTMLInputElement | undefined;
          const shown = () => (l().len ? decodeLen(l().expr) : l().expr);
          return (
            <div class="sk-dim-edit" style={{ left: `${l().at.x - 50}px`, top: `${l().at.y - 14}px` }}>
              <input
                class="sk-dim-input"
                aria-label={t("fdim.edit")}
                // Initial value only: the field must not be rewritten while typing.
                value={untrack(shown)}
                ref={(el) => {
                  input = el;
                  queueMicrotask(() => (el.focus(), el.select()));
                }}
                onKeyDown={(ev) => {
                  ev.stopPropagation();
                  if (ev.key === "Enter") {
                    l().apply(ev.currentTarget.value);
                    setEditing(null);
                  } else if (ev.key === "Escape") setEditing(null);
                }}
                onBlur={() => setEditing(null)}
              />
              <Stepper
                get={() => input?.value ?? shown()}
                set={(v) => {
                  if (input) input.value = v;
                  l().apply(v);
                }}
                step={l().len ? lenStep() : 1}
                evalExpr={l().len ? lenEvaluator(parameterScope) : undefined}
              />
            </div>
          );
        }}
      </Show>
      <Show when={feature()}>
        {(f) => (
          <div class="dims-chip">
            <span>
              {t("fdim.title")} : <b>{f().name}</b>
            </span>
            <button class="icon-btn" title={t("fdim.hide")} aria-label={t("fdim.hide")} onClick={() => showFeatureDims(null)}>
              ×
            </button>
          </div>
        )}
      </Show>
    </>
  );
}
