import { createSignal, For, Show } from "solid-js";
import { COUPLING_MATES, evaluate, type AssemblyComponent, type MateRef, type MateType } from "@solidus-cad/sdk";
import { planeFeature } from "@solidus-cad/bench-part";
import { DatumPanel } from "../components/DatumPanel.tsx";
import {
  asmDatums,
  asmDatumViews,
  asmPlanes,
  beginAsmPlane,
  cancelAsmPlane,
  confirmAsmPlane,
  deleteAsmPlane,
  editAsmPlane,
  editingAsmPlane,
  renameAsmPlane,
  selectAsmPlane,
  setAsmPlaneSlot,
  toggleAsmPlane,
  updateAsmPlane,
} from "./planes.ts";
import { t, type TKey } from "../i18n.ts";
import { openContextMenu } from "../components/ContextMenu.tsx";
import { unresolvedRefs } from "../docfiles/documents.ts";
import {
  cancelMate,
  deleteMate,
  setMateDraft,
  insertSkeleton,
  pickSkeletonForMate,
  mateAcceptsRef,
  pickDatumForMate,
  skeletonChoices,
  partPlaneChoices,
  setMateLock,
  toggleAssemblyPlane,
  updateMate,
  editPartInContext,
  insertPart,
  insertAssembly,
  insertableAssemblies,
  assemblyDoc,
  occurrenceLabel,
  partDoc,
  newPart,
  openParts,
  pickComponent,
  redesignMate,
  renameAssembly,
  renameGroup,
  setWs,
  ungroup,
  updateComponent,
  ws,
  hoverOccurrences,
  viewHovers,
} from "../workspace.ts";
import { startSketch3D } from "../sketch3d/session.ts";
import { checkpointMenu } from "../components/CheckpointDialog.tsx";
import { componentMenuItems } from "./componentMenu.ts";
import { stepLabel, stepsOf } from "./frameSteps.ts";
import { runModuleAction } from "../host.ts";
import { Stepper } from "../components/Stepper.tsx";
import { LengthInput } from "../components/LengthInput.tsx";
import { decodeLen, encodeLen, fmtVol, lenEvaluator, lenStep, withUnit } from "../units.ts";
import { parameterScope } from "../store.ts";

/** Label of the "value" field, depending on the constraint type. */
const mateValueLabel = (type: MateType) =>
  withUnit(t(type === "angle" ? "mate.valueDeg" : type === "rackpinion" ? "mate.valueRadius" : type === "gear" || type === "belt" ? "mate.valueRatio" : "mate.valueMm"));
/** Mates whose value is a length (distance, pinion radius): shown and typed in the display unit. */
const lengthMate = (type: MateType) => type === "distance" || type === "rackpinion";

/** 3D sketches of a skeleton part (refreshed on each change to an archived part). */
function sketches3d(c: AssemblyComponent): { id: string; name: string }[] | undefined {
  void ws.partRev;
  const list = partDoc(c.partId)?.features.filter((f) => f.type === "sketch3d").map((f) => ({ id: f.id, name: f.name })) ?? [];
  return list.length ? list : undefined;
}

/** Occurrence whose file (part or sub-assembly) cannot be found in the `owner` assembly. */
const refOf = (c: AssemblyComponent) => c.assemblyId ?? c.partId;
const lost = (owner: string, c: AssemblyComponent) => unresolvedRefs(owner).some((r) => r.id === refOf(c));
const missingTitle = (owner: string, c: AssemblyComponent) => {
  const r = unresolvedRefs(owner).find((x) => x.id === refOf(c));
  return t("miss.row").replace("{path}", r?.absolute ?? r?.path ?? "?");
};

/** Left panel of an assembly: occurrences (by group) and part insertion. */
export function AssemblyTree() {
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [refsOpen, setRefsOpen] = createSignal(false);
  const a = () => ws.asm!;
  const ungrouped = () => a().components.filter((c) => !c.group || !a().groups.some((g) => g.id === c.group));

  const menu = (ev: MouseEvent, c: AssemblyComponent) => openContextMenu(ev, componentMenuItems(c.id, () => setRenaming(c.id)));

  const Row = (p: { c: AssemblyComponent }) => (
    <>
    <div
      class="tree-row"
      classList={{ active: ws.selection.includes(p.c.id), hovered: viewHovers(p.c.id), suppressed: !!p.c.hidden, missing: lost(ws.activeId, p.c) }}
      title={lost(ws.activeId, p.c) ? missingTitle(ws.activeId, p.c) : undefined}
      onClick={(e) => pickComponent(p.c.id, e.ctrlKey || e.metaKey || e.shiftKey)}
      onDblClick={() => editPartInContext(p.c.id)}
      onContextMenu={(e) => menu(e, p.c)}
      onMouseEnter={() => hoverOccurrences([p.c.id])}
      onMouseLeave={() => hoverOccurrences([])}
    >
      <span class="asm-icon" title={p.c.skeleton ? t("asm.skeleton") : p.c.fixed ? t("asm.fixed") : ""}>
        {p.c.skeleton ? "⌗" : p.c.assemblyId ? "⧉" : p.c.fixed ? "📌" : "◇"}
      </span>
      <Show when={renaming() === p.c.id} fallback={<span class="name">{p.c.name}</span>}>
        <input
          class="rename"
          value={p.c.name}
          ref={(el) => queueMicrotask(() => el.select())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenaming(null);
          }}
          onBlur={(e) => {
            if (renaming() === p.c.id && e.currentTarget.value.trim()) updateComponent(p.c.id, { name: e.currentTarget.value.trim() });
            setRenaming(null);
          }}
        />
      </Show>
      <button
        class="icon-btn eye"
        title={p.c.hidden ? t("asm.show") : t("asm.hide")}
        onClick={(e) => {
          e.stopPropagation();
          updateComponent(p.c.id, { hidden: !p.c.hidden });
        }}
      >
        {p.c.hidden ? "◌" : "●"}
      </button>
      <Show when={p.c.assemblyId}>
        <span class="flex-badge" title={p.c.flexible ? t("asm.flexible") : t("asm.rigid")}>
          {p.c.flexible ? "⇄" : "▣"}
        </span>
      </Show>
    </div>
    <Show when={p.c.skeleton ? sketches3d(p.c) : undefined}>
      {(list) => (
        <div class="group-children sub-children">
          <For each={list()}>
            {(f) => (
              <div
                class="tree-row sub-row"
                title={t("s3d.editHint")}
                onDblClick={() => startSketch3D(f.id, p.c.id)}
                onContextMenu={(e) => openContextMenu(e, [{ label: t("s3d.edit"), run: () => startSketch3D(f.id, p.c.id) }])}
              >
                <span class="asm-icon">⟋</span>
                <span class="name">{f.name}</span>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
    <Show when={partDoc(p.c.partId)?.frameSource && stepsOf(partDoc(p.c.partId)).length ? stepsOf(partDoc(p.c.partId)) : undefined}>
      {(list) => (
        <div class="group-children sub-children">
          <For each={list()}>
            {(f) => (
              <div
                class="tree-row sub-row"
                classList={{ error: !!ws.featureErrors[p.c.partId]?.[f.id] }}
                title={ws.featureErrors[p.c.partId]?.[f.id] ?? t("frm.editHint")}
                onDblClick={() => runModuleAction("frame.start", p.c.id, f.id)}
                onContextMenu={(e) => openContextMenu(e, [{ label: t("frm.edit"), run: () => runModuleAction("frame.start", p.c.id, f.id) }])}
              >
                <span class="asm-icon">▭</span>
                <span class="name">{(void ws.partRev, stepLabel(f))}</span>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
    <Show when={p.c.assemblyId ? assemblyDoc(p.c.assemblyId) : undefined}>
      {(sub) => (
        <div class="group-children sub-children">
          <For each={sub().components.filter((x) => !x.skeleton)}>
            {(child) => {
              const key = () => (p.c.flexible ? `${p.c.id}/${child.id}` : p.c.id);
              return (
                <div
                  class="tree-row sub-row"
                  classList={{ active: ws.selection.includes(`${p.c.id}/${child.id}`), hovered: viewHovers(`${p.c.id}/${child.id}`), suppressed: !!child.hidden || !!p.c.hidden, missing: lost(p.c.assemblyId!, child) }}
                  title={lost(p.c.assemblyId!, child) ? missingTitle(p.c.assemblyId!, child) : undefined}
                  onClick={(e) => pickComponent(key(), e.ctrlKey || e.metaKey || e.shiftKey)}
                  onDblClick={() => editPartInContext(`${p.c.id}/${child.id}`)}
                  onMouseEnter={() => hoverOccurrences([`${p.c.id}/${child.id}`])}
                  onMouseLeave={() => hoverOccurrences([])}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    openContextMenu(e, componentMenuItems(`${p.c.id}/${child.id}`));
                  }}
                >
                  <span class="asm-icon">{child.assemblyId ? "⧉" : "◇"}</span>
                  <span class="name">{child.name}</span>
                </div>
              );
            }}
          </For>
        </div>
      )}
    </Show>
    </>
  );

  return (
    <div class="tree" onContextMenu={checkpointMenu}>
      <div class="tree-section">
        <input class="asm-name" value={a().name} onChange={(e) => renameAssembly(e.currentTarget.value)} aria-label={t("prop.name")} />
      </div>
      <Show when={editingAsmPlane()}>
        {(p) => (
          <DatumPanel
            icon={planeFeature.icon}
            name={p().name}
            onName={renameAsmPlane}
            def={p().def}
            error={asmDatums().get(p().id)?.error}
            slot={asmPlanes.slot}
            onSlot={setAsmPlaneSlot}
            onChange={updateAsmPlane}
            datums={(a().planes ?? []).slice(0, (a().planes ?? []).findIndex((x) => x.id === p().id)).map((x) => ({ id: x.id, name: x.name }))}
            componentName={occurrenceLabel}
            evalExpr={(e) => {
              try {
                return { value: evaluate(e, new Map()) };
              } catch (err) {
                return { error: (err as Error).message };
              }
            }}
            onOk={confirmAsmPlane}
            onCancel={cancelAsmPlane}
          />
        )}
      </Show>
      <Show when={ws.mateDraft}>
        {(d) => (
          <div class="tree-section insert-panel">
            <div class="tree-section-title static">
              {t("mate.new")} : {t(`mate.${d().type}` as TKey)}
            </div>
            <Show when={d().a}>
              {(r) => (
                <p class="empty">
                  {t("mate.first")} : {r().datum ? (a().planes?.find((p) => p.id === r().datum)?.name ?? "?") : occurrenceLabel(r().component)} ({t(`mate.kind.${r().kind}` as TKey)})
                </p>
              )}
            </Show>
            <p class="empty">{d().a ? t("mate.pickB") : t("mate.pickA")}</p>
            <Show when={d().type === "distance" || d().type === "angle" || COUPLING_MATES.includes(d().type)}>
              <label class="field">
                <span>{mateValueLabel(d().type)}</span>
                <Show when={lengthMate(d().type)} fallback={<input value={d().value} onInput={(e) => setMateDraft({ value: e.currentTarget.value })} />}>
                  <LengthInput value={d().value} onValue={(v) => setMateDraft({ value: v })} noStepper />
                </Show>
              </label>
            </Show>
            <label class="check">
              <input type="checkbox" checked={d().flip} onChange={(e) => setMateDraft({ flip: e.currentTarget.checked })} />
              {t("mate.flip")}
            </label>
            <Show when={d().type === "concentric" && d().a?.kind !== "point"}>
              <label class="check">
                <input type="checkbox" checked={d().lockRotation} onChange={(e) => setMateDraft({ lockRotation: e.currentTarget.checked })} />
                {t("mate.lockRotation")}
              </label>
            </Show>
            <Show when={partPlaneChoices().some((c) => mateAcceptsRef(c.component, "plane"))}>
              <label class="field">
                <span>{t("mate.partPlane")}</span>
                <select
                  value=""
                  onChange={(e) => {
                    const c = partPlaneChoices()[Number(e.currentTarget.value)];
                    if (c) pickSkeletonForMate(c.component, c.entity);
                    e.currentTarget.value = "";
                  }}
                >
                  <option value="">—</option>
                  <For each={partPlaneChoices()}>
                    {(c, i) => (
                      <Show when={mateAcceptsRef(c.component, "plane")}>
                        <option value={i()}>
                          {occurrenceLabel(c.component)} — {c.entity.label}
                        </option>
                      </Show>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={skeletonChoices().some((c) => mateAcceptsRef(c.component, c.entity.kind))}>
              <label class="field">
                <span>{t("mate.skeletonRef")}</span>
                <select
                  value=""
                  onChange={(e) => {
                    const c = skeletonChoices()[Number(e.currentTarget.value)];
                    if (c) pickSkeletonForMate(c.component, c.entity);
                    e.currentTarget.value = "";
                  }}
                >
                  <option value="">—</option>
                  <For each={skeletonChoices()}>
                    {(c, i) => (
                      <Show when={mateAcceptsRef(c.component, c.entity.kind)}>
                        <option value={i()}>{c.entity.label}</option>
                      </Show>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={asmDatumViews().length > 0 && mateAcceptsRef("", "plane") && !d().a?.datum}>
              <label class="field">
                <span>{t("datum.mateRef")}</span>
                <select
                  value=""
                  onChange={(e) => {
                    const v = asmDatumViews().find((x) => x.id === e.currentTarget.value);
                    if (v) pickDatumForMate(v.id, v.frame);
                    e.currentTarget.value = "";
                  }}
                >
                  <option value="">—</option>
                  <For each={asmDatumViews()}>{(v) => <option value={v.id}>{a().planes?.find((p) => p.id === v.id)?.name}</option>}</For>
                </select>
              </label>
            </Show>
            <div class="family-actions">
              <button class="link-btn" onClick={cancelMate}>
                {t("prop.cancel")}
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={ws.insertOpen}>
        <div class="tree-section insert-panel">
          <div class="tree-section-title static">{t("asm.insertTitle")}</div>
          <For each={openParts()} fallback={<p class="empty">{t("asm.noParts")}</p>}>
            {(p) => (
              <button class="tree-row insert-row" onClick={() => insertPart(p.id)}>
                <span class="asm-icon">◇</span>
                <span class="name">{p.name}</span>
              </button>
            )}
          </For>
          <Show when={insertableAssemblies().length > 0}>
            <div class="tree-section-title static">{t("asm.subAssemblies")}</div>
            <For each={insertableAssemblies()}>
              {(e) => (
                <button class="tree-row insert-row" onClick={() => insertAssembly(e.id)}>
                  <span class="asm-icon">⧉</span>
                  <span class="name">{e.name}</span>
                </button>
              )}
            </For>
          </Show>
          <div class="family-actions">
            <button class="link-btn" onClick={newPart}>
              + {t("asm.newPart")}
            </button>
            <button class="link-btn" onClick={insertSkeleton}>
              + {t("asm.newSkeleton")}
            </button>
            <button class="link-btn" onClick={() => setWs("insertOpen", false)}>
              {t("prop.cancel")}
            </button>
          </div>
        </div>
      </Show>
      <div class="tree-section">
        <div class="ref-head">
          <button class="tree-section-title" onClick={() => setRefsOpen(!refsOpen())}>
            <span class="chevron" classList={{ open: refsOpen() }}>
              ▸
            </span>
            {t("tree.references")}
          </button>
          {/* Collapsed: quick toggle of plane visibility. */}
          <Show when={!refsOpen()}>
            <For each={["XY", "XZ", "YZ"] as const}>
              {(p) => (
                <button
                  class="plane-toggle"
                  classList={{ on: !!a().display?.planes?.[p] }}
                  title={`${t(`sk.plane${p}` as TKey)} — ${a().display?.planes?.[p] ? t("asm.hide") : t("asm.show")}`}
                  onClick={() => toggleAssemblyPlane(p)}
                >
                  {p}
                </button>
              )}
            </For>
          </Show>
        </div>
        <Show when={refsOpen()}>
          <For each={["XY", "XZ", "YZ"] as const}>
            {(p) => (
              <div class="tree-row">
                <span class="asm-icon">▱</span>
                <span class="name">{t(`sk.plane${p}` as TKey)}</span>
                <button class="icon-btn eye" onClick={() => toggleAssemblyPlane(p)}>
                  {a().display?.planes?.[p] ? "●" : "◌"}
                </button>
              </div>
            )}
          </For>
          <For each={a().planes ?? []}>
            {(p) => {
              const error = () => asmDatums().get(p.id)?.error;
              return (
                <div
                  class="tree-row"
                  classList={{ active: asmPlanes.selected === p.id, editing: asmPlanes.edit?.id === p.id, error: !!error() }}
                  title={error() ?? t("datum.planeHint")}
                  onClick={() => selectAsmPlane(p.id)}
                  onDblClick={() => editAsmPlane(p.id)}
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      { label: t("tree.edit"), run: () => editAsmPlane(p.id) },
                      { label: t("tree.delete"), run: () => deleteAsmPlane(p.id), danger: true },
                    ])
                  }
                >
                  <span class="icon" innerHTML={planeFeature.icon} />
                  <span class="name">{p.name}</span>
                  <Show when={error()}>
                    <span class="badge-error" aria-label={error()!}>
                      !
                    </span>
                  </Show>
                  <button
                    class="icon-btn eye"
                    title={p.hidden ? t("asm.show") : t("asm.hide")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAsmPlane(p.id);
                    }}
                  >
                    {p.hidden ? "◌" : "●"}
                  </button>
                </div>
              );
            }}
          </For>
          <button class="link-btn" onClick={beginAsmPlane}>
            + {t("datum.new")}
          </button>
        </Show>
      </div>
      <div class="tree-section">
        <div class="tree-section-title static">
          {t("asm.components")}
          <span class="count">{a().components.length}</span>
        </div>
        <Show when={a().components.length === 0}>
          <p class="empty">{t("asm.empty")}</p>
        </Show>
        <For each={a().groups}>
          {(g) => (
            <div class="asm-group">
              <div
                class="tree-row group-row"
                onMouseEnter={() => hoverOccurrences(a().components.filter((c) => c.group === g.id).map((c) => c.id))}
                onMouseLeave={() => hoverOccurrences([])}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: t("tree.rename"), run: () => setRenaming(g.id) },
                    { label: t("asm.ungroup"), run: () => ungroup(g.id) },
                  ])
                }
              >
                <span class="asm-icon">▾</span>
                <Show when={renaming() === g.id} fallback={<span class="name">{g.name}</span>}>
                  <input
                    class="rename"
                    value={g.name}
                    ref={(el) => queueMicrotask(() => el.select())}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    onBlur={(e) => {
                      renameGroup(g.id, e.currentTarget.value);
                      setRenaming(null);
                    }}
                  />
                </Show>
              </div>
              <div class="group-children">
                <For each={a().components.filter((c) => c.group === g.id)}>{(c) => <Row c={c} />}</For>
              </div>
            </div>
          )}
        </For>
        <For each={ungrouped()}>{(c) => <Row c={c} />}</For>
      </div>
      <Show when={ws.interferences}>
        {(list) => (
          <div class="tree-section">
            <div class="tree-section-title static">
              {t("interf.title")}
              <span class="count">{list().length}</span>
            </div>
            <Show when={list().length > 0} fallback={<p class="empty">{t("interf.none")}</p>}>
              <For each={list()}>
                {(it) => {
                  const name = (id: string) => occurrenceLabel(id);
                  return (
                    <button class="tree-row interf-row" onClick={() => setWs("selection", [it.a, it.b])}>
                      <span class="asm-icon">⚠</span>
                      <span class="name">
                        {name(it.a)} ∩ {name(it.b)} : {fmtVol(it.volume, 3)}
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        )}
      </Show>
      <div class="tree-section">
        <div class="tree-section-title static">
          {t("mate.title")}
          <span class="count">{a().mates.length + a().components.filter((c) => c.fixed && !c.skeleton).length}</span>
        </div>
        <Show when={ws.dof >= 0 && a().mates.length > 0}>
          <p class="empty" classList={{ "mate-error": ws.failing.length > 0 }}>
            {ws.failing.length > 0 ? t("mate.failing") : `${ws.dof} ${t("sk.dof")}`}
          </p>
        </Show>
        {/* Fixed parts: "Fixed" constraint (part coordinate system locked to the assembly's). */}
        <For each={a().components.filter((c) => c.fixed && !c.skeleton)}>
          {(c) => (
            <div
              class="tree-row mate-row"
              title={`${t("mate.fixed")} · ${c.name}`}
              onClick={() => setWs("selection", [c.id])}
              onMouseEnter={() => hoverOccurrences([c.id])}
              onMouseLeave={() => hoverOccurrences([])}
              onContextMenu={(e) => openContextMenu(e, [{ label: t("asm.unfix"), run: () => updateComponent(c.id, { fixed: false }), danger: true }])}
            >
              <span class="asm-icon">📌</span>
              <span class="name">
                {t("mate.fixed")} · {c.name}
              </span>
            </div>
          )}
        </For>
        <For each={a().mates}>
          {(m) => {
            const refName = (r: MateRef) => (r.datum ? (a().planes?.find((p) => p.id === r.datum)?.name ?? "?") : occurrenceLabel(r.component));
            return (
              <div
                class="tree-row mate-row"
                classList={{ suppressed: !!m.suppressed, error: ws.failing.includes(m.id) || !!m.unresolved }}
                title={m.unresolved ? t("mate.unresolved") : `${refName(m.a)} ↔ ${refName(m.b)}`}
                onDblClick={() => m.unresolved && redesignMate(m.id)}
                onMouseEnter={() => hoverOccurrences([m.a.component, m.b.component].filter((x): x is string => !!x))}
                onMouseLeave={() => hoverOccurrences([])}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    ...(m.unresolved ? [{ label: t("mate.redesign"), run: () => redesignMate(m.id) }] : []),
                    { label: t("mate.flip"), run: () => updateMate(m.id, { flip: !m.flip }) },
                    ...(m.type === "concentric" && m.a.kind === "axis" && m.b.kind === "axis"
                      ? [{ label: m.lockRotation ? t("mate.unlockRotation") : t("mate.lockRotation"), run: () => setMateLock(m.id, !m.lockRotation) }]
                      : []),
                    { label: m.suppressed ? t("tree.unsuppress") : t("tree.suppress"), run: () => updateMate(m.id, { suppressed: !m.suppressed }) },
                    { label: t("tree.delete"), run: () => deleteMate(m.id), danger: true },
                  ])
                }
              >
                <span class="asm-icon">{m.unresolved ? "⚠" : "⇔"}</span>
                <span class="name">
                  {t(`mate.${m.type}` as TKey)}
                  {m.lockRotation ? " 🔒" : ""} · {refName(m.a)} / {refName(m.b)}
                </span>
                <Show when={m.type === "distance" || m.type === "angle" || COUPLING_MATES.includes(m.type)}>
                  <span class="with-stepper mate-stepper">
                    <Show
                      when={lengthMate(m.type)}
                      fallback={
                        <>
                          <input class="mate-value" value={m.value ?? ""} onChange={(e) => updateMate(m.id, { value: e.currentTarget.value })} aria-label={mateValueLabel(m.type)} />
                          <Stepper get={() => m.value || "0"} set={(v) => updateMate(m.id, { value: v })} />
                        </>
                      }
                    >
                      <input
                        class="mate-value"
                        value={decodeLen(m.value ?? "")}
                        onChange={(e) => updateMate(m.id, { value: encodeLen(e.currentTarget.value) })}
                        aria-label={mateValueLabel(m.type)}
                      />
                      <Stepper
                        get={() => decodeLen(m.value || "0")}
                        set={(v) => updateMate(m.id, { value: encodeLen(v) })}
                        step={lenStep()}
                        evalExpr={lenEvaluator(parameterScope)}
                      />
                    </Show>
                  </span>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
