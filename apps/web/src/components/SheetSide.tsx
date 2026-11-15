import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { unwrap } from "solid-js/store";
import { sketchToWorld, type Vec3 } from "@solidus-cad/sdk";
import { analyzeProfiles, pointMap } from "@solidus-cad/sketch";
import type { Viewer } from "@solidus-cad/viewer";
import { t } from "../i18n.ts";
import { editingFeature, state } from "../store.ts";
import { frameOf, sketchCenter } from "./FeatureDims.tsx";

type S = { x: number; y: number };
interface Arrow {
  from: S;
  to: S;
  label: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const along = (a: Vec3, d: Vec3, k: number): Vec3 => ({ x: a.x + d.x * k, y: a.y + d.y * k, z: a.z + d.z * k });

/** Screen length of the arrows, in pixels. */
const ARROW_PX = 55;

/**
 * Base flange being edited: arrows from the sketch towards the material, so that "Flip material side" shows
 * which side of the sketch the sheet lies on. Closed contour: along the normal of the sketch (or against it);
 * open profile: across each segment, on the side given by the kernel (core/part/sheetmetal.cpp, `side`).
 */
export function SheetSide(props: { viewer: Viewer }) {
  const v = props.viewer;
  const [viewVersion, setViewVersion] = createSignal(0);
  onMount(() => onCleanup(v.onViewChange(() => setViewVersion((n) => n + 1))));

  const arrows = createMemo((): Arrow[] => {
    viewVersion();
    const f = editingFeature();
    const sk = f && state.doc.features.find((g) => g.id === f.params.sketch && g.type === "sketch" && g.sketch);
    const geometry = sk ? state.sketchInfos[sk.id]?.geometry : undefined;
    if (!f || !sk || !geometry) return [];
    const g = unwrap(geometry);
    const frame = frameOf(sk);
    const sign = f.params.reverse === "yes" ? -1 : 1;
    const len = ARROW_PX * v.pixelSize();
    const arrow = (p: Vec3, d: Vec3, label: boolean): Arrow => ({ from: v.worldToScreen(p), to: v.worldToScreen(along(p, d, len)), label });
    const analysis = analyzeProfiles(g);

    // Flat sheet: the thickness goes along the normal of the sketch (reverse: against it).
    if (analysis.regions.length > 0) {
      const c = sketchCenter(sk);
      return c ? [arrow(sketchToWorld(frame, c.x, c.y), along({ x: 0, y: 0, z: 0 }, frame.normal, sign), true)] : [];
    }

    // Open profile: material on the side n × d of each segment (same traversal order as the kernel).
    const chain = analysis.chains[0];
    if (!chain?.length) return [];
    const pts = pointMap(g);
    const out: Arrow[] = [];
    chain.forEach((c, i) => {
      if (c.curve.type !== "line") return;
      const [a, b] = c.reversed ? [c.curve.p2, c.curve.p1] : [c.curve.p1, c.curve.p2];
      const pa = pts.get(a);
      const pb = pts.get(b);
      if (!pa || !pb) return;
      const wa = sketchToWorld(frame, pa.x, pa.y);
      const wb = sketchToWorld(frame, pb.x, pb.y);
      const side = unit(cross(frame.normal, sub(wb, wa)));
      const mid = along(wa, sub(wb, wa), 0.5);
      out.push(arrow(mid, { x: side.x * sign, y: side.y * sign, z: side.z * sign }, i === 0));
    });
    return out;
  });

  return (
    <svg class="sketch-overlay sheet-side">
      <defs>
        <marker id="ss-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,1 L9,5 L0,9 z" class="ss-head" />
        </marker>
      </defs>
      <For each={arrows()}>
        {(a) => (
          <g>
            <line class="ss-shaft" x1={a.from.x} y1={a.from.y} x2={a.to.x} y2={a.to.y} marker-end="url(#ss-arrow)" />
            <circle class="ss-foot" cx={a.from.x} cy={a.from.y} r={3} />
            {a.label && (
              <text class="ss-label" x={a.to.x + (a.to.x - a.from.x) * 0.25} y={a.to.y + (a.to.y - a.from.y) * 0.25} text-anchor="middle" dominant-baseline="central">
                {t("sm.side.material")}
              </text>
            )}
          </g>
        )}
      </For>
    </svg>
  );
}
