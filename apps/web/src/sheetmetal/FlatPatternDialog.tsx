import { For, Show } from "solid-js";
import { lang, t } from "../i18n.ts";
import { bendLabel, exportFlatDxf, flatView, setFlatView } from "./flat.ts";
import { fmtLen, unitLabel } from "../units.ts";

const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
/** Length (mm) in the display unit, without the unit. */
const fl = (mm: number) => fmtLen(mm, { locale: true, fractions: false });

/** Preview of the sheet metal flat pattern (outline, bend lines) and DXF export. */
export function FlatPatternDialog() {
  return (
    <Show when={flatView()}>
      {(v) => {
        const f = () => v().pattern;
        const w = () => f().bounds[2] - f().bounds[0];
        const h = () => f().bounds[3] - f().bounds[1];
        const pad = () => Math.max(w(), h()) * 0.06 + 2;
        // SVG frame: y downwards, hence the inversion of the ordinates.
        const box = () => `${f().bounds[0] - pad()} ${-f().bounds[3] - pad()} ${w() + 2 * pad()} ${h() + 2 * pad()}`;
        const segs = () => {
          const o = f().outline;
          const out: [number, number, number, number][] = [];
          for (let i = 0; i + 3 < o.length; i += 4) out.push([o[i]!, -o[i + 1]!, o[i + 2]!, -o[i + 3]!]);
          return out;
        };
        const text = () => Math.max(w(), h()) / 45;
        return (
          <div class="dialog-backdrop" onClick={() => setFlatView(null)}>
            <div class="dialog wide" role="dialog" aria-modal="true" aria-label={t("sm.flatTitle")} onClick={(e) => e.stopPropagation()}>
              <h2>
                {t("sm.flatTitle")} — {v().name}
              </h2>
              <svg class="flat-preview" viewBox={box()} preserveAspectRatio="xMidYMid meet">
                <For each={segs()}>{(s) => <line x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} class="flat-outline" vector-effect="non-scaling-stroke" />}</For>
                <For each={f().bends}>
                  {(b) => (
                    <>
                      <line x1={b.x1} y1={-b.y1} x2={b.x2} y2={-b.y2} class="flat-bend" vector-effect="non-scaling-stroke" />
                      <text x={(b.x1 + b.x2) / 2} y={-(b.y1 + b.y2) / 2 - text() * 0.4} font-size={String(text())} text-anchor="middle" class="flat-label">
                        {bendLabel(b, lang())}
                      </text>
                    </>
                  )}
                </For>
              </svg>
              <dl class="flat-info">
                <dt>{t("sm.size")}</dt>
                <dd data-testid="flat-size">
                  {fl(w())} × {fl(h())} {unitLabel()}
                </dd>
                <dt>{t("sm.bends")}</dt>
                <dd data-testid="flat-bends">{f().bends.length}</dd>
                <dt>{t("sm.params")}</dt>
                <dd>
                  {fl(f().thickness)} {unitLabel()} · R {fl(f().radius)} {unitLabel()} · K {fmt(f().kFactor)}
                </dd>
              </dl>
              <div class="panel-actions">
                <button class="btn" onClick={() => void exportFlatDxf(f(), v().name)}>
                  ⇩ DXF
                </button>
                <button class="btn primary" onClick={() => setFlatView(null)}>
                  OK
                </button>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
