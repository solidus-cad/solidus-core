import { For, Show } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import { activeSection, closeSectionPanel, modelSize, sectionRange, setSectionPlane, toggleCut, updateSection, type SectionMode, type SectionPlane } from "../section.ts";
import { activeKind, ws } from "../workspace.ts";
import { fromUnit, isInch, MM_PER_INCH, toUnit, withUnit } from "../units.ts";

/** Slider step for a length range (mm): about 1/200 of the range, rounded to a power of ten. */
const stepFor = (span: number) => Math.max(10 ** Math.floor(Math.log10(Math.max(span, 1) / 200)), 0.01);

/** Length in the current unit: number field and slider (values in mm). */
function LengthField(props: { label: TKey; class: string; value: number; min: number; max: number; set: (mm: number) => void }) {
  const label = () => withUnit(t(props.label));
  const step = () => stepFor(props.max - props.min);
  return (
    <>
      <label class="field">
        <span>{label()}</span>
        <input
          type="number"
          class={props.class}
          step={isInch() ? Math.max(Math.round((step() / MM_PER_INCH) * 1000) / 1000, 0.001) : step()}
          value={Math.round(toUnit(props.value) * 1e4) / 1e4}
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            if (Number.isFinite(v)) props.set(fromUnit(v));
          }}
        />
      </label>
      <input
        type="range"
        class="section-slider"
        aria-label={label()}
        min={props.min}
        max={props.max}
        step={step()}
        value={props.value}
        onInput={(e) => props.set(Number(e.currentTarget.value))}
      />
    </>
  );
}

/** Floating panel of the section view (part and assembly): plane section or section lamp. */
export function SectionPanel() {
  const shown = () => {
    const s = activeSection();
    return s && !s.panelClosed ? s : undefined;
  };
  return (
    <Show when={shown()}>
      {(s) => {
        const range = () => sectionRange(s().plane);
        const size = () => modelSize();
        return (
          <div class="section-panel" role="dialog" aria-label={t("sec.title")}>
            <div class="section-head">
              <span>{t("sec.title")}</span>
              <button class="icon-btn" title={t("ws.close")} aria-label={t("ws.close")} onClick={closeSectionPanel}>
                ×
              </button>
            </div>
            <div class="seg" role="group" aria-label={t("sec.mode")}>
              <For each={["plane", "lamp"] as SectionMode[]}>
                {(m) => (
                  <button classList={{ active: s().mode === m }} aria-pressed={s().mode === m} onClick={() => updateSection({ mode: m })}>
                    {t(m === "plane" ? "sec.plane" : "sec.lamp")}
                  </button>
                )}
              </For>
            </div>
            <Show
              when={s().mode === "lamp"}
              fallback={
                <>
                  <div class="seg">
                    <For each={["XY", "XZ", "YZ"] as SectionPlane[]}>
                      {(p) => (
                        <button classList={{ active: s().plane === p }} onClick={() => setSectionPlane(p)}>
                          {t(`sk.plane${p}` as TKey)}
                        </button>
                      )}
                    </For>
                  </div>
                  <LengthField label="sec.position" class="section-offset" value={s().offset} min={range().min} max={range().max} set={(offset) => updateSection({ offset })} />
                  <label class="check">
                    <input type="checkbox" checked={s().flip} onChange={(e) => updateSection({ flip: e.currentTarget.checked })} />
                    {t("sec.flip")}
                  </label>
                </>
              }
            >
              <div class="section-hint">{t("sec.lampHint")}</div>
              <LengthField
                label="sec.radius"
                class="section-radius"
                value={s().radius}
                min={size() / 200}
                max={size() / 2}
                set={(radius) => radius > 0 && updateSection({ radius })}
              />
              <LengthField label="sec.depth" class="section-depth" value={s().depth} min={0} max={size()} set={(depth) => depth >= 0 && updateSection({ depth })} />
              <label class="check">
                <input type="checkbox" checked={s().follow} onChange={(e) => updateSection({ follow: e.currentTarget.checked })} />
                {t("sec.follow")}
              </label>
            </Show>
            <label class="check">
              <input type="checkbox" checked={s().cap} onChange={(e) => updateSection({ cap: e.currentTarget.checked })} />
              {t("sec.cap")}
            </label>
            <Show when={activeKind() === "assembly" && ws.asm && ws.asm.components.length > 0}>
              <div class="section-subtitle">{t("sec.components")}</div>
              <div class="section-list">
                <For each={ws.asm!.components.filter((c) => !c.skeleton)}>
                  {(c) => (
                    <label class="check">
                      <input type="checkbox" checked={!s().excluded.includes(c.id)} onChange={() => toggleCut(c.id)} />
                      {c.name}
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
