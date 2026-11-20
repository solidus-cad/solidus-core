import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { evaluate, isValidName, MATERIAL_FAMILIES, materialSheet, MATERIALS, type Feature } from "@solidus-cad/sdk";
import { FamilyPanel } from "./FamilyPanel.tsx";
import { MATERIAL_FIELDS, openMaterialEditor } from "./MaterialDialog.tsx";
import { allMaterials, customMaterials, isCustomMaterial } from "../materials.ts";
import { t, tx, type TKey } from "../i18n.ts";
import {
  addParameter,
  definitionOf,
  deleteFeature,
  editFeature,
  moveFeature,
  parameterScope,
  selectPlane,
  setDisplay,
  setMaterial,
  togglePlane,
  toggleSketchVisibility,
  consumedSketches,
  sketchesUsedBy,
  skeletonSketches,
  assignSketch,
  canAssignSketch,
  toggleDatumVisibility,
  removeParameter,
  renameFeature,
  setRollback,
  setState,
  showFeatureDims,
  state,
  toggleSuppress,
  updateParameter,
  setFeatureColor,
  bodyHidden,
  bodyKind,
  bodyName,
  deleteBodyOf,
  toggleBodyHidden,
  setBodyDisplay,
  setTargetBody,
} from "../store.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { pickColor } from "./colorPick.ts";
import { checkpointMenu } from "./CheckpointDialog.tsx";
import { commit as commitDoc, hoverTreeNode } from "../store.ts";
import { freezeLinks, linkTitle, sketchLinks } from "../assembly/external.ts";
import { Stepper } from "./Stepper.tsx";
import { openFirstPartTour } from "../tour/FirstPartTour.tsx";

const FRAME_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 20V6h16v14"/><path d="M7 20V9h10v11"/></svg>';

const SKETCH3D_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M4 18 10 8l5 6 5-9"/><path d="M4 18h6M4 18v-6" stroke-dasharray="1.5 1.5"/></svg>';

const ROLLBACK = "rollback";

const PLANE_NAMES: { id: "XY" | "XZ" | "YZ"; label: TKey }[] = [
  { id: "XY", label: "sk.planeXY" },
  { id: "XZ", label: "sk.planeXZ" },
  { id: "YZ", label: "sk.planeYZ" },
];

const n = (v: number, digits = 4) => v.toLocaleString(undefined, { maximumSignificantDigits: digits });

/** Part material: choice from the database (by family, then custom materials), with the properties that follow. */
function MaterialSection() {
  const [open, setOpen] = createSignal(false);
  const sheet = () => materialSheet(state.doc.material, allMaterials());
  const mass = () => {
    const m = sheet();
    return m && state.mass ? (state.mass.volume / 1000) * m.density / 1000 : null;
  };
  const inBase = () => !state.doc.material || allMaterials().some((x) => x.name === state.doc.material!.name);
  const familyLabel = () => {
    const f = MATERIAL_FAMILIES.find((x) => x.id === sheet()?.family);
    return f ? tx(f.label) : null;
  };
  const create = () => {
    const m = sheet();
    openMaterialEditor(m ? { ...m, name: `${m.name} (${t("mat.copy")})` } : { name: "", family: "steel", density: 7.85 });
  };
  return (
    <div class="tree-section material-section">
      <div class="material-head">
        <button class="tree-section-title" onClick={() => setOpen(!open())} disabled={!sheet()}>
          <span class="chevron" classList={{ open: open() && !!sheet() }}>
            ▸
          </span>
          {t("doc.material")}
        </button>
        <select
          aria-label={t("doc.material")}
          value={state.doc.material?.name ?? ""}
          onChange={(e) => setMaterial(allMaterials().find((x) => x.name === e.currentTarget.value) ?? null)}
        >
          <option value="">{t("mat.none")}</option>
          <Show when={!inBase()}>
            <option value={state.doc.material!.name}>{state.doc.material!.name}</option>
          </Show>
          <Show when={customMaterials().length > 0}>
            <optgroup label={t("mat.custom")}>
              <For each={customMaterials()}>{(m) => <option value={m.name}>{m.name}</option>}</For>
            </optgroup>
          </Show>
          <For each={MATERIAL_FAMILIES}>
            {(f) => (
              <optgroup label={tx(f.label)}>
                <For each={MATERIALS.filter((m) => m.family === f.id)}>{(m) => <option value={m.name}>{m.name}</option>}</For>
              </optgroup>
            )}
          </For>
        </select>
        <Show when={state.doc.material && isCustomMaterial(state.doc.material.name)}>
          <button class="icon-btn" title={t("mat.edit")} onClick={() => openMaterialEditor(sheet()!, state.doc.material!.name)}>
            ✎
          </button>
        </Show>
        <button class="icon-btn" title={t("mat.new")} onClick={create}>
          +
        </button>
      </div>
      <Show when={open() && sheet()}>
        {(m) => (
          <dl class="material-props">
            <Show when={familyLabel()}>
              <dt>{t("mat.family")}</dt>
              <dd>{familyLabel()}</dd>
            </Show>
            <For each={MATERIAL_FIELDS.filter((p) => m()[p.key] !== undefined)}>
              {(p) => (
                <>
                  <dt>{t(p.label)}</dt>
                  <dd>
                    {n(m()[p.key]!)} {p.unit}
                  </dd>
                </>
              )}
            </For>
            <dt>{t("status.mass")}</dt>
            <dd>{mass() === null ? "—" : `${n(mass()!)} kg`}</dd>
          </dl>
        )}
      </Show>
    </div>
  );
}

/** Reference planes (display, selection for a sketch) and body visibility. */
function ReferencePlanes() {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="tree-section">
      <div class="ref-head">
        <button class="tree-section-title" onClick={() => setOpen(!open())}>
          <span class="chevron" classList={{ open: open() }}>
            ▸
          </span>
          {t("tree.references")}
        </button>
        {/* Collapsed: quick toggle of plane visibility. */}
        <Show when={!open()}>
          <For each={PLANE_NAMES}>
            {(p) => (
              <button
                class="plane-toggle"
                classList={{ on: !!state.doc.display?.planes?.[p.id] }}
                title={`${t(p.label)} — ${state.doc.display?.planes?.[p.id] ? t("asm.hide") : t("asm.show")}`}
                onClick={() => togglePlane(p.id)}
              >
                {p.id}
              </button>
            )}
          </For>
        </Show>
      </div>
      <Show when={open()}>
        <For each={PLANE_NAMES}>
          {(p) => (
            <div class="tree-row" classList={{ active: state.selectedPlane === p.id }} onClick={() => selectPlane(p.id)} title={t("tree.planeHint")}>
              <span class="asm-icon">▱</span>
              <span class="name">{t(p.label)}</span>
              <button
                class="icon-btn eye"
                title={state.doc.display?.planes?.[p.id] ? t("asm.hide") : t("asm.show")}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlane(p.id);
                }}
              >
                {state.doc.display?.planes?.[p.id] ? "●" : "◌"}
              </button>
            </div>
          )}
        </For>
        <div class="tree-row">
          <span class="asm-icon">◆</span>
          <span class="name">{t("tree.body")}</span>
          <button
            class="icon-btn eye"
            title={state.doc.display?.bodyHidden ? t("asm.show") : t("asm.hide")}
            onClick={() => setDisplay((d) => void (d.bodyHidden = !d.bodyHidden))}
          >
            {state.doc.display?.bodyHidden ? "◌" : "●"}
          </button>
        </div>
      </Show>
    </div>
  );
}

/**
 * Bodies of the part (multi-body): visibility, colour, and choice of the body targeted by the next features.
 * Shown when the part has several or has a surface; solids first, then surfaces.
 */
function Bodies() {
  const [open, setOpen] = createSignal(true);
  const target = () => state.targetBody ?? state.activeBody;
  const menu = (ev: MouseEvent, id: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    const color = state.doc.bodies?.[id]?.color;
    openContextMenu(ev, [
      { label: t("tree.bodyTarget"), run: () => setTargetBody(id) },
      { label: `${t("body.color")}…`, run: () => pickColor(ev.clientX, ev.clientY, color ?? state.doc.appearance.color, (c) => setBodyDisplay(id, (b) => void (b.color = c))) },
      ...(color ? [{ label: t("body.colorReset"), run: () => setBodyDisplay(id, (b) => void delete b.color) }] : []),
      { label: t("body.delete"), run: () => deleteBodyOf(id), danger: true },
    ]);
  };
  const solids = () => state.bodies.filter((id) => bodyKind(id) === "solid");
  const surfaces = () => state.bodies.filter((id) => bodyKind(id) === "surface");
  const row = (id: string) => {
    const hidden = () => bodyHidden(id);
    const surface = bodyKind(id) === "surface";
    return (
      <div class="tree-row" classList={{ active: target() === id, consumed: state.consumedBodies.includes(id) }} onClick={() => setTargetBody(id)} onContextMenu={(e) => menu(e, id)} onMouseEnter={() => hoverTreeNode({ body: id })} onMouseLeave={() => hoverTreeNode(null)} title={t("tree.bodyTarget")}>
        <span class="asm-icon" title={t(surface ? "body.surface" : "body.solid")}>
          {surface ? "◇" : "◆"}
        </span>
        <span class="name">{bodyName(id)}</span>
        <Show when={state.doc.bodies?.[id]?.color}>{(c) => <span class="tree-color" style={{ background: c() }} title={t("body.color")} />}</Show>
        <button
          class="icon-btn eye"
          title={hidden() ? t("asm.show") : t("asm.hide")}
          onClick={(e) => {
            e.stopPropagation();
            toggleBodyHidden(id);
          }}
        >
          {hidden() ? "◌" : "●"}
        </button>
      </div>
    );
  };
  return (
    <Show when={state.bodies.length > 1 || surfaces().length > 0}>
      <div class="tree-section">
        <button class="tree-section-title" onClick={() => setOpen(!open())}>
          <span class="chevron" classList={{ open: open() }}>
            ▸
          </span>
          {t("tree.bodies")}
          <span class="count">{state.bodies.length}</span>
        </button>
        <Show when={open()}>
          <For each={solids()}>{row}</For>
          <Show when={surfaces().length > 0}>
            <div class="tree-subtitle">{t("tree.surfaces")}</div>
            <For each={surfaces()}>{row}</For>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function Parameters() {
  const [open, setOpen] = createSignal(true);
  const values = () => parameterScope();
  // Parameters driven by the active configuration of the family.
  const driven = () => {
    const f = state.doc.family;
    const row = f?.rows[f.active];
    return new Set(f && row ? f.columns.filter((_, i) => (row.values[i] ?? "").trim() !== "") : []);
  };

  return (
    <div class="tree-section">
      <button class="tree-section-title" onClick={() => setOpen(!open())}>
        <span class="chevron" classList={{ open: open() }}>
          ▸
        </span>
        {t("tree.parameters")}
        <span class="count">{state.doc.parameters.length}</span>
      </button>
      <Show when={open()}>
        <For each={state.doc.parameters}>
          {(p, i) => {
            const error = () => state.parameterErrors[p.name];
            return (
              <div
                class="param-row"
                classList={{ error: !!error(), family: driven().has(p.name) }}
                title={error() ?? (driven().has(p.name) ? t("fam.driven") : "")}
              >
                <input
                  class="param-name"
                  value={p.name}
                  aria-label="Nom"
                  onChange={(e) => {
                    const name = e.currentTarget.value.trim();
                    if (isValidName(name) && !state.doc.parameters.some((q, j) => j !== i() && q.name === name)) updateParameter(i(), name, p.expr);
                    else e.currentTarget.value = p.name;
                  }}
                />
                <span>=</span>
                <span class="with-stepper">
                  <input class="param-expr" value={p.expr} aria-label="Expression" title={t("units.paramTip")} onChange={(e) => updateParameter(i(), p.name, e.currentTarget.value)} />
                  <Stepper get={() => p.expr} set={(v) => updateParameter(i(), p.name, v)} />
                </span>
                <span class="param-value">{error() ? "⚠" : fmt(values().get(p.name))}</span>
                <button class="icon-btn" title={t("tree.delete")} onClick={() => removeParameter(i())}>
                  ×
                </button>
              </div>
            );
          }}
        </For>
        <button class="link-btn" onClick={addParameter}>
          + {t("tree.addParameter")}
        </button>
      </Show>
    </div>
  );
}

function fmt(v: number | undefined): string {
  return v === undefined ? "" : String(Math.round(v * 1000) / 1000);
}

export function FeatureTree() {
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [dropAt, setDropAt] = createSignal<number | null>(null);
  const [dragging, setDragging] = createSignal<string | null>(null);

  const dropIndex = (ev: DragEvent, index: number) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return ev.clientY < r.top + r.height / 2 ? index : index + 1;
  };

  const onDragOver = (ev: DragEvent, index: number) => {
    if (!dragging()) return;
    ev.preventDefault();
    setDropAt(dropIndex(ev, index));
  };

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    const id = dragging();
    const at = dropAt();
    setDragging(null);
    setDropAt(null);
    if (id === null || at === null) return;
    if (id === ROLLBACK) setRollback(at);
    else moveFeature(id, at);
  };

  const startDrag = (ev: DragEvent, id: string) => {
    ev.dataTransfer!.effectAllowed = "move";
    ev.dataTransfer!.setData("text/plain", id);
    setDragging(id);
  };

  /** Plane sketches folded under the features that build on them (skeletons excepted), by feature. */
  const skeletons = createMemo(() => skeletonSketches(state.doc.features));
  const foldedBy = createMemo(() => {
    const sketches = new Set(state.doc.features.filter((f) => f.type === "sketch" && !skeletons().has(f.id)).map((f) => f.id));
    return new Map(state.doc.features.map((f) => [f.id, sketchesUsedBy(f).filter((id) => sketches.has(id))]));
  });
  const nestedSketches = createMemo(() => new Set([...foldedBy().values()].flat()));
  const [folds, setFolds] = createSignal<ReadonlySet<string>>(new Set());
  const setFold = (id: string, open: boolean) =>
    setFolds((s) => {
      const n = new Set(s);
      if (open) n.add(id);
      else n.delete(id);
      return n;
    });
  /** Sketch picked in a fold: the next feature clicked builds on it too. */
  const [picked, setPicked] = createSignal<string | null>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && picked()) setPicked(null);
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  /** Row of a feature; `parent`: the feature it is folded under (sketch shown in a fold). */
  const Row = (f: Feature, i: () => number, parent?: string) => {
    const def = () => definitionOf(f.type);
    const error = () => state.statuses[f.id];
    const after = () => i() >= state.doc.rollback;
    const folded = () => (parent ? [] : (foldedBy().get(f.id) ?? []));
    const isOpen = () => folds().has(f.id) && folded().length > 0;
    const assignable = () => !!picked() && !parent && canAssignSketch(picked()!, f.id);
    return (
    <div
      class="tree-row"
      classList={{
        nested: !!parent,
        assignable: assignable(),
        picked: picked() === f.id,
        active: state.activeFeatureId === f.id,
        editing: state.editing?.featureId === f.id,
        suppressed: !!f.suppressed,
        after: after(),
        error: !!error() && !after(),
        "drop-before": !parent && dropAt() === i(),
        "drop-after": !parent && dropAt() === i() + 1 && i() === state.doc.features.length - 1,
      }}
      draggable={!parent && renaming() !== f.id}
      onDragStart={(e) => startDrag(e, f.id)}
      onDragEnd={() => {
        setDragging(null);
        setDropAt(null);
      }}
      onDragOver={(e) => !parent && onDragOver(e, i())}
      onClick={() => {
        // Sketch picked in a fold: the clicked feature builds on it too.
        const p = picked();
        if (p && p !== f.id && assignable()) {
          const name = state.doc.features.find((x) => x.id === p)?.name ?? "";
          assignSketch(p, f.id);
          setPicked(null);
          setFold(f.id, true);
          setState("activeFeatureId", f.id);
          setState("message", t("tree.sketchAssigned").replace("{sketch}", name).replace("{feature}", f.name));
          return;
        }
        setPicked(parent && picked() !== f.id ? f.id : null);
        if (picked()) setState("message", t("tree.pickSketch"));
        setState("activeFeatureId", f.id);
        // Dimensions shown: they follow the selected feature.
        if (state.dimsFeature) showFeatureDims(f.id);
        // Reference plane: plane of the next sketch (or first element of the next plane).
        if (f.type === "plane") selectPlane(f.id);
      }}
      onDblClick={() => editFeature(f.id)}
      onContextMenu={(e) => menuFor(e, f.id, i())}
      onMouseEnter={() => hoverTreeNode({ feature: f.id })}
      onMouseLeave={() => hoverTreeNode(null)}
      title={error() ?? ""}
    >
      <Show when={!parent} fallback={<span class="fold-gap" />}>
        <button
          class="fold"
          classList={{ empty: !folded().length }}
          tabIndex={-1}
          aria-label={t("tree.foldSketches")}
          onClick={(e) => {
            e.stopPropagation();
            setFold(f.id, !isOpen());
          }}
          onDblClick={(e) => e.stopPropagation()}
        >
          <span class="chevron" classList={{ open: isOpen() }}>
            ▸
          </span>
        </button>
      </Show>
      <span class="icon" innerHTML={def()?.icon ?? (f.type === "sketch3d" ? SKETCH3D_ICON : f.type === "frameMembers" ? FRAME_ICON : "")} />
      <Show when={renaming() === f.id} fallback={<span class="name">{f.name}</span>}>
        <input
          class="rename"
          value={f.name}
          ref={(el) => queueMicrotask(() => el.select())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenaming(null);
          }}
          onBlur={(e) => {
            if (renaming() === f.id) renameFeature(f.id, e.currentTarget.value);
            setRenaming(null);
          }}
        />
      </Show>
      <Show when={sketchLinks(f).length}>
        <span class="link-badge" classList={{ broken: sketchLinks(f).some((l) => l.broken) }} title={linkTitle(f)}>
          {sketchLinks(f).some((l) => l.broken) ? "⚠" : "🔗"}
        </span>
      </Show>
      <Show when={state.doc.appearance.features?.[f.id]}>
        {(c) => <span class="tree-color" style={{ background: c() }} title={t("color.feature")} />}
      </Show>
      <Show when={error() && !after()}>
        <span class="badge-error" aria-label={error()!}>
          !
        </span>
      </Show>
      <Show when={f.type === "plane"}>
        <button
          class="icon-btn eye"
          classList={{ forced: state.selectedPlane === f.id }}
          title={state.doc.display?.hiddenDatums?.includes(f.id) ? t("asm.show") : t("asm.hide")}
          onClick={(e) => {
            e.stopPropagation();
            toggleDatumVisibility(f.id);
          }}
        >
          {state.doc.display?.hiddenDatums?.includes(f.id) ? "◌" : "●"}
        </button>
      </Show>
      <Show when={f.type === "sketch" || f.type === "sketch3d"}>
        {(() => {
          const consumed = () => consumedSketches(state.doc.features).has(f.id);
          const forced = () => state.doc.display?.sketches?.[f.id];
          const shown = () => forced() ?? !consumed();
          return (
            <button
              class="icon-btn eye"
              classList={{ forced: forced() !== undefined }}
              title={shown() ? t("asm.hide") : t("asm.show")}
              onClick={(e) => {
                e.stopPropagation();
                toggleSketchVisibility(f.id, consumed());
              }}
            >
              {shown() ? "●" : "◌"}
            </button>
          );
        })()}
      </Show>
    </div>
    );
  };

  const RollbackBar = () => (
    <div
      class="rollback-bar"
      draggable={true}
      title={t("tree.rollback")}
      onDragStart={(e) => startDrag(e, ROLLBACK)}
      onDragEnd={() => {
        setDragging(null);
        setDropAt(null);
      }}
    />
  );

  const menuFor = (ev: MouseEvent, id: string, index: number) => {
    const f = state.doc.features[index]!;
    openContextMenu(ev, [
      { label: t("tree.edit"), run: () => editFeature(id) },
      state.dimsFeature === id ? { label: t("fdim.hide"), run: () => showFeatureDims(null) } : { label: t("fdim.show"), run: () => showFeatureDims(id) },
      { label: t("tree.rename"), run: () => setRenaming(id) },
      { label: f.suppressed ? t("tree.unsuppress") : t("tree.suppress"), run: () => toggleSuppress(id) },
      ...(sketchLinks(f).length ? [{ label: t("link.break"), run: () => commitDoc((d) => freezeLinks(d, id)) }] : []),
      ...(["sketch", "sketch3d", "plane"].includes(f.type)
        ? []
        : [
            { label: `${t("color.feature")}…`, run: () => pickColor(ev.clientX, ev.clientY, state.doc.appearance.features?.[id] ?? state.doc.appearance.color, (c) => setFeatureColor(id, c)) },
            ...(state.doc.appearance.features?.[id] ? [{ label: t("color.featureReset"), run: () => setFeatureColor(id, null) }] : []),
          ]),
      index + 1 === state.doc.rollback ? { label: t("tree.rollToEnd"), run: () => setRollback(state.doc.features.length) } : { label: t("tree.rollbackHere"), run: () => setRollback(index + 1) },
      { label: t("tree.delete"), run: () => deleteFeature(id), danger: true },
    ]);
  };

  return (
    <div class="tree" onContextMenu={checkpointMenu}>
      <MaterialSection />
      <ReferencePlanes />
      <Bodies />
      <Parameters />
      <FamilyPanel />
      <div class="tree-section">
        <div class="tree-section-title static">{t("tree.title")}</div>
        <div class="tree-list" onDragOver={(e) => dragging() && e.preventDefault()} onDrop={onDrop}>
          <Show when={state.doc.features.length === 0}>
            <p class="empty">{t("tree.empty")}</p>
            <button class="link-btn tree-tour" onClick={openFirstPartTour}>
              {t("tour.treeLink")}
            </button>
          </Show>
          <For each={state.doc.features}>
            {(f, i) => (
              <>
                <Show when={i() === state.doc.rollback}>
                  <RollbackBar />
                </Show>
                <Show when={!nestedSketches().has(f.id)}>
                  {Row(f, i)}
                  <Show when={folds().has(f.id)}>
                    <For each={foldedBy().get(f.id) ?? []}>
                      {(id) => {
                        const index = () => state.doc.features.findIndex((x) => x.id === id);
                        return <Show when={state.doc.features[index()]}>{(sk) => Row(sk(), index, f.id)}</Show>;
                      }}
                    </For>
                  </Show>
                </Show>
              </>
            )}
          </For>
          <Show when={state.doc.features.length > 0 && state.doc.rollback === state.doc.features.length}>
            <RollbackBar />
          </Show>
        </div>
      </div>
    </div>
  );
}

/** Numeric value of an expression using the document parameters (or an error message). */
export function preview(expr: string): { value?: number; error?: string } {
  try {
    return { value: evaluate(expr, parameterScope()) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
