import { For, Show } from "solid-js";
import { t } from "../i18n.ts";
import { cancelSketch3D, finishSketch3D, s3, s3Scope, select, setDimensionValue, setS3, toggleDriving } from "./session.ts";
import { Stepper } from "../components/Stepper.tsx";
import { decodeLen, lenEvaluator, lenStep } from "../units.ts";
import type { Sk3Dimension } from "@solidus-cad/sdk";

/** Left panel while editing a 3D sketch: name, constraint state, dimensions, help. */
export function Sketch3DPanel() {
  const status = () => {
    if (s3.conflicting.length) return { cls: "error", text: t("sk.overConstrained") };
    if (s3.data.geometry.length && s3.dof === 0) return { cls: "ok", text: t("sk.fully") };
    return { cls: "free", text: `${s3.dof} ${t("sk.dof")}` };
  };
  const shown = (d: Sk3Dimension) => (d.type === "angle" ? d.value : decodeLen(d.value));
  const label = (type: string) => (type === "length" ? t("s3d.dimLength") : type === "distance" ? t("s3d.dimDistance") : t("s3d.dimAngle"));

  return (
    <div class="property-panel">
      <div class="panel-header">
        <h2>{t("s3d.title")}</h2>
      </div>
      <div class="panel-actions">
        <button class="btn primary" onClick={finishSketch3D}>
          ✓ {t("s3d.finish")}
        </button>
        <button class="btn" onClick={cancelSketch3D}>
          ✕ {t("prop.cancel")}
        </button>
      </div>
      <label class="field">
        <span>{t("prop.name")}</span>
        <input value={s3.name} onChange={(e) => setS3("name", e.currentTarget.value.trim() || s3.name)} />
      </label>
      <div class={`sk-status ${status().cls}`} role="status">
        {status().text}
      </div>
      <Show when={s3.data.dimensions.length > 0}>
        <div class="tree-section-title static">{t("s3d.dimensions")}</div>
        <For each={s3.data.dimensions}>
          {(d) => (
            <div class="s3-dim-row" classList={{ active: s3.selection.includes(d.id), conflict: s3.conflicting.includes(d.id) }} onClick={() => select(d.id, false)}>
              <span>{label(d.type)}</span>
              <span class="with-stepper">
                <input value={shown(d)} disabled={!d.driving} onChange={(e) => setDimensionValue(d.id, e.currentTarget.value)} aria-label={label(d.type)} />
                <Stepper
                  get={() => shown(d)}
                  set={(v) => setDimensionValue(d.id, v)}
                  disabled={!d.driving}
                  step={d.type === "angle" ? 1 : lenStep()}
                  evalExpr={d.type === "angle" ? undefined : lenEvaluator(s3Scope)}
                />
              </span>
              <button class="icon-btn" title={d.driving ? t("s3d.makeDriven") : t("s3d.makeDriving")} onClick={() => toggleDriving(d.id)}>
                {d.driving ? "⇥" : "( )"}
              </button>
            </div>
          )}
        </For>
      </Show>
      <div class="s3-keys">
        <div class="tree-section-title static">{t("s3d.keysTitle")}</div>
        <p>{t("s3d.keys")}</p>
      </div>
    </div>
  );
}
