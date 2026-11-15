import { createEffect, For, on, Show } from "solid-js";
import type { BasePlane } from "@solidus-cad/sdk";
import { t } from "../i18n.ts";
import { cancelEdit, confirmEdit, editingFeature, setFeatureName, state, updateSketch } from "../store.ts";
import { preview } from "../components/FeatureTree.tsx";
import { Stepper } from "../components/Stepper.tsx";
import { LengthInput } from "../components/LengthInput.tsx";
import { fromUnit, isInch, lenStep, unitLabel } from "../units.ts";
import { createSignal } from "solid-js";
import { closeContours, importSkeleton, insertText, offsetSelection, session, setSession, sketch, solveNow, startSession } from "./session.ts";

const PLANES: { value: BasePlane; key: "sk.planeXY" | "sk.planeXZ" | "sk.planeYZ" }[] = [
  { value: "XY", key: "sk.planeXY" },
  { value: "XZ", key: "sk.planeXZ" },
  { value: "YZ", key: "sk.planeYZ" },
];

/** Left panel while editing a sketch. */
export function SketchPanel() {
  const f = () => editingFeature()!;
  const sk = () => sketch()!;
  /** Reference planes placed before the sketch (possible planes for the sketch). */
  const datumsBefore = () => {
    const all = state.doc.features;
    const idx = all.findIndex((x) => x.id === f().id);
    return all.slice(0, idx < 0 ? all.length : idx).filter((x) => x.type === "plane" && !x.suppressed);
  };

  // New session for each sketch opened.
  createEffect(on(() => state.editing?.featureId, () => startSession()));

  const status = () => {
    if (!session.solved) return { cls: "error", text: t("sk.failed") };
    if (session.conflicting.length || session.redundant.length) return { cls: "error", text: t("sk.overConstrained") };
    if (session.dof === 0) return { cls: "ok", text: t("sk.fully") };
    return { cls: "free", text: `${session.dof} ${t("sk.dof")}` };
  };
  const profiles = () => session.profiles;
  const offsetEval = () => preview(sk().plane.offset);
  // Sketches placed before this one: possible skeletons.
  const previousSketches = () => {
    const all = state.doc.features;
    const i = all.findIndex((x) => x.id === f().id);
    return all.slice(0, i < 0 ? all.length : i).filter((x) => x.type === "sketch" && !x.suppressed);
  };
  const [skeleton, setSkeleton] = createSignal("");

  return (
    <div class="property-panel">
      <div class="panel-header">
        <h2>{t("sk.title")}</h2>
      </div>
      <div class="panel-actions">
        <button class="btn primary" onClick={confirmEdit}>
          ✓ {t("sk.finish")}
        </button>
        <button class="btn" onClick={cancelEdit}>
          ✕ {t("prop.cancel")}
        </button>
      </div>
      <div class={`sk-status ${status().cls}`} role="status">
        {status().text}
      </div>
      <Show when={session.offsetOpen}>
        {(() => {
          const [dist, setDist] = createSignal(isInch() ? "0.2" : "5");
          return (
            <div class="sk-offset">
              <label class="field">
                <span>{t("sk.offsetDist")}</span>
                <div class="input-unit">
                  <input value={dist()} onInput={(e) => setDist(e.currentTarget.value)} />
                  <Stepper get={() => dist()} set={setDist} step={lenStep()} />
                  <span class="unit">{unitLabel()}</span>
                </div>
              </label>
              <div class="panel-actions">
                <button class="btn primary" onClick={() => offsetSelection(fromUnit(Number(dist().replace(",", "."))) || 0)}>
                  {t("sk.offsetApply")}
                </button>
                <button class="btn" onClick={() => setSession("offsetOpen", false)}>
                  {t("prop.cancel")}
                </button>
              </div>
            </div>
          );
        })()}
      </Show>
      <Show when={session.textAt}>
        {(() => {
          const [txt, setTxt] = createSignal("");
          const [height, setHeight] = createSignal(isInch() ? "0.4" : "10");
          const [bold, setBold] = createSignal(false);
          const ok = () => txt().trim() !== "" && Number(height().replace(",", ".")) > 0;
          const apply = () => ok() && void insertText(txt(), { height: fromUnit(Number(height().replace(",", "."))), bold: bold() }, session.textAt!);
          return (
            <div class="sk-offset">
              <label class="field">
                <span>{t("sk.textContent")}</span>
                <textarea rows={3} value={txt()} onInput={(e) => setTxt(e.currentTarget.value)} ref={(el) => queueMicrotask(() => el.focus())} />
              </label>
              <label class="field">
                <span>{t("sk.textHeight")}</span>
                <div class="input-unit">
                  <input value={height()} onInput={(e) => setHeight(e.currentTarget.value)} />
                  <Stepper get={() => height()} set={setHeight} step={lenStep()} />
                  <span class="unit">{unitLabel()}</span>
                </div>
              </label>
              <label class="field">
                <span>{t("sk.textBold")}</span>
                <input type="checkbox" checked={bold()} onChange={(e) => setBold(e.currentTarget.checked)} />
              </label>
              <div class="panel-actions">
                <button class="btn primary" disabled={!ok()} onClick={apply}>
                  {t("sk.textInsert")}
                </button>
                <button class="btn" onClick={() => setSession("textAt", null)}>
                  {t("prop.cancel")}
                </button>
              </div>
            </div>
          );
        })()}
      </Show>
      <Show when={session.message}>
        <div class="sk-message">{session.message}</div>
      </Show>
      <label class="field">
        <span>{t("prop.name")}</span>
        <input value={f().name} onChange={(e) => setFeatureName(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>{t("sk.plane")}</span>
        <select
          value={sk().plane.datum ? `datum:${sk().plane.datum}` : sk().plane.face ? "face" : sk().plane.base}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === "face") return;
            updateSketch((s) => {
              delete s.plane.face;
              if (v.startsWith("datum:")) s.plane.datum = v.slice(6);
              else {
                s.plane.base = v as BasePlane;
                delete s.plane.datum;
              }
            });
          }}
        >
          <Show when={sk().plane.face && !sk().plane.datum}>
            <option value="face">{t("sk.planeFace")}</option>
          </Show>
          <For each={PLANES}>{(p) => <option value={p.value}>{t(p.key)}</option>}</For>
          <Show when={datumsBefore().length > 0}>
            <optgroup label={t("sk.planeDatum")}>
              <For each={datumsBefore()}>{(d) => <option value={`datum:${d.id}`}>{d.name}</option>}</For>
            </optgroup>
          </Show>
        </select>
      </label>
      <label class="field">
        <span>{t("sk.offset")}</span>
        <div class="input-unit" classList={{ invalid: !!offsetEval().error }}>
          <LengthInput
            value={sk().plane.offset}
            onValue={(v) => {
              updateSketch((s) => void (s.plane.offset = v));
              solveNow();
            }}
          />
          <span class="unit">{unitLabel()}</span>
        </div>
      </label>
      <Show when={previousSketches().length > 0}>
        <div class="field">
          <span class="sk-label">{t("sk.skeleton")}</span>
          <div class="field-row">
            <select value={skeleton()} onChange={(e) => setSkeleton(e.currentTarget.value)}>
              <For each={previousSketches()}>{(s) => <option value={s.id}>{s.name}</option>}</For>
            </select>
            <button class="btn" onClick={() => importSkeleton(skeleton() || previousSketches()[0]!.id)}>
              {t("sk.skeletonUse")}
            </button>
          </div>
        </div>
      </Show>
      <div class="sk-profiles">
        <Show when={profiles()}>
          {(p) => (
            <>
              <span>
                {p().regions.length} {t("sk.regions")}
              </span>
              <Show when={p().chains.length > 0}>
                <span>
                  {p().chains.length} {t("sk.openChains")}
                </span>
              </Show>
              <Show when={session.gaps.length > 0}>
                <span class="warn">
                  {session.gaps.length} {t("sk.gaps")}
                </span>
                <button class="btn" onClick={closeContours}>
                  {t("sk.closeGaps")}
                </button>
              </Show>
              <Show when={p().selfIntersecting}>
                <span class="warn">{t("sk.selfIntersect")}</span>
              </Show>
              <Show when={p().branchPoints.length > 0}>
                <span class="warn">{t("sk.branches")}</span>
              </Show>
            </>
          )}
        </Show>
      </div>
      <p class="sk-help">{t("sk.help")}</p>
    </div>
  );
}
