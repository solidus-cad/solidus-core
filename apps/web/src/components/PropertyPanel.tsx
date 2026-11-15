import { For, Show } from "solid-js";
import { paramShown, SKETCH_AXIS_H, SKETCH_AXIS_V, sketchFits, type ParamSpec } from "@solidus-cad/sdk";
import { t, tx } from "../i18n.ts";
import {
  bodyKind,
  bodyName,
  cancelEdit,
  clearRefs,
  confirmEdit,
  definitionOf,
  setDatumSlot,
  setFeatureBody,
  setFeatureName,
  setFeatureParam,
  refTarget,
  setRefGroup,
  setRefChoice,
  setRefPreview,
  state,
  updateDatum,
} from "../store.ts";
import { DatumPanel } from "./DatumPanel.tsx";
import { Stepper } from "./Stepper.tsx";
import { LengthInput } from "./LengthInput.tsx";
import { decodeLen, fmtLen, lenDigits, unitLabel } from "../units.ts";
import { isPlainNumber } from "@solidus-cad/sdk";
import { preview } from "./FeatureTree.tsx";

const UNITS: Record<string, () => string> = { length: unitLabel, angle: () => "°", number: () => "" };

/** Features whose volume can be repeated (mirror, patterns). */
export const TOOL_FEATURES = new Set(["box", "cylinder", "extrude", "twistExtrude", "thinExtrude", "revolve", "sweep", "loft", "hole", "slot", "profile"]);

/** Properties panel of the feature being edited, with live preview. */
export function PropertyPanel() {
  const feature = () => state.doc.features.find((f) => f.id === state.editing?.featureId);
  const def = () => (feature() ? definitionOf(feature()!.type) : undefined);
  const error = () => (feature() ? state.statuses[feature()!.id] : null);
  // Bodies the feature can target: those before it in the tree (reported by the kernel), otherwise those of the part.
  const bodies = () => state.editBodies?.bodies ?? state.bodies;
  const activeBody = () => (state.editBodies ? state.editBodies.active : state.activeBody);
  // Proposed target bodies: solids for a volume operation, all bodies to move or delete, none
  // for a feature that creates its own body.
  const bodyTarget = () => def()?.bodyTarget ?? "solid";
  const targets = () => bodies().filter((b) => bodyTarget() === "any" || bodyKind(b) === "solid");

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.currentTarget as HTMLElement).blur();
      confirmEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  };

  /** Reference planes placed before the edited feature. */
  const datumsBefore = () => {
    const all = state.doc.features;
    const idx = all.findIndex((f) => f.id === feature()?.id);
    return all.slice(0, idx < 0 ? all.length : idx).filter((f) => f.type === "plane" && !f.suppressed);
  };

  const Field = (p: { spec: ParamSpec }) => {
    const value = () => feature()?.params[p.spec.key] ?? p.spec.default;
    if (p.spec.kind === "plane") {
      const spec = p.spec;
      return (
        <label class="field">
          <span>{tx(spec.label)}</span>
          <select value={value()} onChange={(e) => setFeatureParam(spec.key, e.currentTarget.value)} onKeyDown={keys}>
            <Show when={!["XY", "XZ", "YZ"].includes(value()) && !datumsBefore().some((f) => f.id === value())}>
              <option value={value()}>—</option>
            </Show>
            <option value="YZ">{t("sk.planeYZ")}</option>
            <option value="XZ">{t("sk.planeXZ")}</option>
            <option value="XY">{t("sk.planeXY")}</option>
            <For each={datumsBefore()}>{(f) => <option value={f.id}>{f.name}</option>}</For>
          </select>
        </label>
      );
    }
    if (p.spec.kind === "sketch") {
      const spec = p.spec;
      // Sketches placed before the edited feature.
      const sketches = () => {
        const all = state.doc.features;
        const idx = all.findIndex((f) => f.id === feature()?.id);
        return all.slice(0, idx < 0 ? all.length : idx).filter((f) => sketchFits(f.type, spec.space) && !f.suppressed);
      };
      return (
        <label class="field">
          <span>{tx(spec.label)}</span>
          <Show when={sketches().length > 0} fallback={<small class="field-error">{t("prop.noSketch")}</small>}>
            <select value={value()} onChange={(e) => setFeatureParam(spec.key, e.currentTarget.value)} onKeyDown={keys}>
              <Show when={!sketches().some((f) => f.id === value())}>
                <option value="">—</option>
              </Show>
              <For each={sketches()}>{(f) => <option value={f.id}>{f.name}</option>}</For>
            </select>
          </Show>
        </label>
      );
    }
    if (p.spec.kind === "sketches") {
      const spec = p.spec;
      // Ordered list: the chosen sketches (in their order, those deleted upstream stay listed so they can be removed),
      // then a list to add one of the others placed before the feature.
      const sketches = () => {
        const all = state.doc.features;
        const idx = all.findIndex((f) => f.id === feature()?.id);
        return all.slice(0, idx < 0 ? all.length : idx).filter((f) => sketchFits(f.type, spec.space) && !f.suppressed);
      };
      const chosen = () => value().split(",").filter(Boolean);
      const nameOf = (id: string) => state.doc.features.find((f) => f.id === id)?.name ?? "—";
      const set = (ids: string[]) => setFeatureParam(spec.key, ids.join(","));
      const move = (i: number, d: number) => {
        const ids = [...chosen()];
        const [x] = ids.splice(i, 1);
        ids.splice(i + d, 0, x!);
        set(ids);
      };
      const full = () => spec.max !== undefined && chosen().length >= spec.max;
      return (
        <div class="field">
          <span>{tx(spec.label)}</span>
          <For each={chosen()}>
            {(id, i) => (
              <div class="sketch-item">
                <span>{nameOf(id)}</span>
                <button type="button" class="icon-btn" title={t("prop.moveUp")} disabled={i() === 0} onClick={() => move(i(), -1)}>↑</button>
                <button type="button" class="icon-btn" title={t("prop.moveDown")} disabled={i() === chosen().length - 1} onClick={() => move(i(), 1)}>↓</button>
                <button type="button" class="icon-btn" title={t("prop.remove")} onClick={() => set(chosen().filter((_, k) => k !== i()))}>×</button>
              </div>
            )}
          </For>
          <Show when={!full()}>
            <Show when={sketches().some((f) => !chosen().includes(f.id))} fallback={<Show when={!chosen().length}><small class="field-error">{t("prop.noSketch")}</small></Show>}>
              <select
                value=""
                onChange={(e) => {
                  if (e.currentTarget.value) set([...chosen(), e.currentTarget.value]);
                  e.currentTarget.value = "";
                }}
                onKeyDown={keys}
              >
                <option value="">{t("prop.addSketch")}</option>
                <For each={sketches().filter((f) => !chosen().includes(f.id))}>{(f) => <option value={f.id}>{f.name}</option>}</For>
              </select>
            </Show>
          </Show>
        </div>
      );
    }
    if (p.spec.kind === "feature") {
      const spec = p.spec;
      // Features placed before, which add or remove a volume.
      const candidates = () => {
        const all = state.doc.features;
        const idx = all.findIndex((f) => f.id === feature()?.id);
        return all.slice(0, idx < 0 ? all.length : idx).filter((f) => !f.suppressed && TOOL_FEATURES.has(f.type));
      };
      return (
        <label class="field">
          <span>{tx(spec.label)}</span>
          <select value={value()} onChange={(e) => setFeatureParam(spec.key, e.currentTarget.value)} onKeyDown={keys}>
            <Show
              when={spec.allowBody}
              fallback={
                <Show when={!candidates().some((f) => f.id === value())}>
                  <option value="">—</option>
                </Show>
              }
            >
              <option value="">{t("prop.wholeBody")}</option>
            </Show>
            <For each={candidates()}>{(f) => <option value={f.id}>{f.name}</option>}</For>
          </select>
        </label>
      );
    }
    if (p.spec.kind === "sketchAxis") {
      const spec = p.spec;
      const lines = () => {
        const sk = state.doc.features.find((f) => f.id === feature()?.params.sketch)?.sketch;
        return (sk?.geometry ?? []).filter((g) => g.type === "line" && g.construction);
      };
      return (
        <label class="field">
          <span>{tx(spec.label)}</span>
          <select value={value()} onChange={(e) => setFeatureParam(spec.key, e.currentTarget.value)} onKeyDown={keys}>
            <option value={SKETCH_AXIS_H}>{t("prop.axisH")}</option>
            <option value={SKETCH_AXIS_V}>{t("prop.axisV")}</option>
            <For each={lines()}>{(l, i) => <option value={l.id}>{`${t("prop.lineN")} ${i() + 1}`}</option>}</For>
          </select>
        </label>
      );
    }
    if (p.spec.kind === "bodies") {
      const spec = p.spec;
      // Bodies before the feature other than its target body. Those already chosen stay proposed even if they no longer exist
      // (body deleted upstream), so they can be unchecked.
      // A feature without a target body (surfaces) may take any body, the active solid included.
      const target = () => (bodyTarget() === "none" ? undefined : (feature()?.body ?? activeBody()));
      const chosen = () => new Set(value().split(",").filter(Boolean));
      const others = () => [...new Set([...bodies().filter((b) => !spec.filter || bodyKind(b) === spec.filter), ...chosen()])].filter((b) => b !== target());
      const toggle = (id: string, on: boolean) => {
        const next = others().filter((b) => (b === id ? on : chosen().has(b)));
        setFeatureParam(spec.key, next.join(","));
      };
      return (
        <div class="field">
          <span>{tx(spec.label)}</span>
          <Show when={others().length > 0} fallback={<small class="field-error">{t("prop.noOtherBody")}</small>}>
            <For each={others()}>
              {(b) => (
                <label class="check">
                  <input type="checkbox" checked={chosen().has(b)} onChange={(e) => toggle(b, e.currentTarget.checked)} />
                  {bodyName(b)}
                </label>
              )}
            </For>
          </Show>
        </div>
      );
    }
    if (p.spec.kind === "enum") {
      const spec = p.spec;
      return (
        <label class="field">
          <span>{tx(spec.label)}</span>
          <select value={value()} onChange={(e) => setFeatureParam(spec.key, e.currentTarget.value)} onKeyDown={keys}>
            <For each={spec.options}>{(o) => <option value={o.value}>{tx(o.label)}</option>}</For>
          </select>
        </label>
      );
    }
    const evaluated = () => preview(value());
    const isLen = () => p.spec.kind === "length";
    const isExpr = () => !isPlainNumber(isLen() ? decodeLen(value()) : value());
    return (
      <label class="field">
        <span>{tx(p.spec.label)}</span>
        <div class="input-unit" classList={{ invalid: !!evaluated().error }}>
          <Show
            when={isLen()}
            fallback={
              <>
                <input value={value()} onInput={(e) => setFeatureParam(p.spec.key, e.currentTarget.value)} onKeyDown={keys} spellcheck={false} />
                <Stepper get={() => value()} set={(v) => setFeatureParam(p.spec.key, v)} />
              </>
            }
          >
            <LengthInput value={value()} onValue={(v) => setFeatureParam(p.spec.key, v)} onKeyDown={keys} />
          </Show>
          <span class="unit">{UNITS[p.spec.kind]?.()}</span>
        </div>
        <Show when={evaluated().error}>
          <small class="field-error">{evaluated().error}</small>
        </Show>
        <Show when={!evaluated().error && isExpr()}>
          <small class="field-hint">= {isLen() ? fmtLen(evaluated().value!, { digits: lenDigits() + 1 }) : Math.round(evaluated().value! * 1000) / 1000}</small>
        </Show>
      </label>
    );
  };

  return (
    <Show
      when={feature()?.type !== "plane" || !feature()?.datum}
      fallback={
        <DatumPanel
          icon={def()?.icon ?? ""}
          name={feature()!.name}
          onName={setFeatureName}
          def={feature()!.datum!}
          error={error()}
          slot={state.datumSlot}
          onSlot={setDatumSlot}
          onChange={updateDatum}
          datums={datumsBefore().map((f) => ({ id: f.id, name: f.name }))}
          evalExpr={preview}
          onOk={confirmEdit}
          onCancel={cancelEdit}
        />
      }
    >
    <Show when={feature() && def()}>
      <div class="property-panel">
        <div class="panel-header">
          <span class="icon" innerHTML={def()!.icon} />
          <h2>{tx(def()!.label)}</h2>
        </div>
        <div class="panel-actions">
          <button class="btn primary" onClick={confirmEdit}>
            ✓ {t("prop.ok")}
          </button>
          <button class="btn" onClick={cancelEdit}>
            ✕ {t("prop.cancel")}
          </button>
        </div>
        <Show when={error()}>
          <div class="panel-error" role="alert">
            {error()}
          </div>
        </Show>
        <label class="field">
          <span>{t("prop.name")}</span>
          <input value={feature()!.name} onChange={(e) => setFeatureName(e.currentTarget.value)} onKeyDown={keys} />
        </label>
        <Show when={bodyTarget() !== "none" && (targets().length > 1 || feature()!.body)}>
          <label class="field">
            <span>{t("prop.body")}</span>
            <select value={feature()!.body ?? ""} onChange={(e) => setFeatureBody(e.currentTarget.value)} onKeyDown={keys}>
              <option value="">{t("prop.activeBody")}</option>
              <Show when={feature()!.body && !targets().includes(feature()!.body!)}>
                <option value={feature()!.body!}>{bodyName(feature()!.body!)}</option>
              </Show>
              <For each={targets()}>{(b) => <option value={b}>{bodyName(b)}</option>}</For>
            </select>
          </label>
        </Show>
        <Show when={def()!.refs}>
          {(refs) => (
            <div class="field refs">
              <span>{tx(refs().label)}</span>
              <div class="refs-box">
                <strong>{feature()!.refs?.length ?? 0}</strong> {refs().kind === "edge" ? t("prop.edgesSel") : t("prop.facesSel")}
                <Show when={(feature()!.refs?.length ?? 0) > 0}>
                  <button class="link-btn" onClick={() => clearRefs()}>
                    {t("prop.clear")}
                  </button>
                </Show>
              </div>
              <small class="field-hint">{tx(refs().hint)}</small>
              <label class="check">
                <input type="checkbox" checked={state.refPreview} onChange={(e) => setRefPreview(e.currentTarget.checked)} />
                {t("prop.previewResult")}
              </label>
            </div>
          )}
        </Show>
        <Show when={def()!.refGroups?.length}>
          <div class="field refs">
            {/* Several groups: a click on a group (title or box) makes it active; clicks in the view fill it. */}
            <For each={def()!.refGroups!.filter((g) => paramShown(g, feature()!.params, def()!.params))}>
              {(g) => {
                const count = () => (feature()!.refs ?? []).filter((r) => r.group === g.key).length;
                const active = () => refTarget(feature()!)?.group === g.key;
                const short = () => (g.min !== undefined && count() < g.min) || (g.max !== undefined && count() > g.max);
                return (
                  <div class="refs-group" classList={{ active: active() }} onClick={() => setRefGroup(g.key)}>
                    <button class="refs-group-title" aria-pressed={active()} onClick={() => setRefGroup(g.key)}>
                      {tx(g.label)}
                    </button>
                    <div class="refs-box" classList={{ "field-error": short() }}>
                      <strong>{count()}</strong> {g.kind === "edge" ? t("prop.edgesSel") : t("prop.facesSel")}
                      <Show when={g.min !== undefined || g.max !== undefined}>
                        <span class="refs-bounds">{g.min === g.max ? `(${g.min})` : `(${g.min ?? 0}–${g.max ?? "∞"})`}</span>
                      </Show>
                      <Show when={count() > 0}>
                        <button class="link-btn" onClick={() => clearRefs(g.key)}>
                          {t("prop.clear")}
                        </button>
                      </Show>
                    </div>
                    <Show when={g.choice}>
                      {(choice) => (
                        <For each={(feature()!.refs ?? []).filter((r) => r.group === g.key)}>
                          {(r, i) => (
                            <label class="field ref-choice">
                              <span>
                                {g.kind === "edge" ? t("prop.edgeN") : t("prop.faceN")} {i() + 1} · {tx(choice().label)}
                              </span>
                              <select value={r.choice ?? choice().default} onChange={(e) => setRefChoice(g.key, i(), e.currentTarget.value)} onKeyDown={keys}>
                                <For each={choice().options}>{(o) => <option value={o.value}>{tx(o.label)}</option>}</For>
                              </select>
                            </label>
                          )}
                        </For>
                      )}
                    </Show>
                    <Show when={active()}>
                      <small class="field-hint">{tx(g.hint)}</small>
                    </Show>
                  </div>
                );
              }}
            </For>
            <label class="check">
              <input type="checkbox" checked={state.refPreview} onChange={(e) => setRefPreview(e.currentTarget.checked)} />
              {t("prop.previewResult")}
            </label>
          </div>
        </Show>
        <For each={def()!.params}>
          {(spec) => (
            <Show when={paramShown(spec, feature()!.params, def()!.params)}>
              <Field spec={spec} />
            </Show>
          )}
        </For>
      </div>
    </Show>
    </Show>
  );
}
