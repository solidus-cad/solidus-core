import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t, tx, type TKey } from "../i18n.ts";
import { FINISHES, type CustomProperty, type Finish, type TextProperty } from "@solidus-cad/sdk";
import { clearPartialColors, faceColorOf, setColor, setDocName, setFaceColor, setFeatureColor, setCustomProperties, setFinish, setProperty, state } from "../store.ts";
import { activate, activeKind, canDropInto, closeDocument, draggedDoc, dropInto, newAssembly, newPart, setDraggedDoc, ws } from "../workspace.ts";
import { moduleEnabled } from "../plugins/modules.ts";
import { requireFeature } from "../license.ts";
import { contributions, docKind, docKinds } from "../host.ts";
import { TipsPane } from "./TipsPane.tsx";
import { panels } from "./PanelToggle.tsx";

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

const TAB_ICONS: Record<string, string> = {
  "right.tips": icon('<path d="M9 18h6M10 21h4"/><path d="M12 3a6.5 6.5 0 0 0-4 11.6c.7.6 1 1.3 1 2.4h6c0-1.1.3-1.8 1-2.4A6.5 6.5 0 0 0 12 3z"/>'),
  "right.documents": icon('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'),
  "right.properties": icon('<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>'),
  "right.appearance": icon('<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2-.6-1.2.2-2.5 1.5-2.5H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'),
};

/** Built-in tabs and their position (`order` of the tabs contributed by modules: library 10, AI 50…). */
const CORE_TABS: [TKey, number][] = [
  ["right.tips", 0],
  ["right.documents", 20],
  ["right.properties", 30],
  ["right.appearance", 40],
];
const tabs = (): { id: string; icon: string; label: () => string }[] =>
  [
    ...CORE_TABS.map(([k, order]) => ({ id: k as string, icon: TAB_ICONS[k]!, label: () => t(k), order })),
    ...contributions("rightTabs").map((c) => ({ ...c, order: c.order ?? 100 })),
  ].sort((a, b) => a.order - b.order);
type Legend = { tab: string; icon: string; label: () => string; text: () => string };
const CORE_LEGEND: [TKey, TKey][] = [
  ["right.documents", "tip.legend.documents"],
  ["right.properties", "tip.legend.properties"],
  ["right.appearance", "tip.legend.appearance"],
];
const legends = (): Legend[] => [
  ...CORE_LEGEND.map(([k, text]) => ({ tab: k as string, icon: TAB_ICONS[k]!, label: () => t(k), text: () => t(text) })),
  ...contributions("rightTabs")
    .filter((c) => c.legend)
    .map((c) => ({ tab: c.id, icon: c.icon, label: c.label, text: c.legend! })),
];
const moduleTab = (id: string) => contributions("rightTabs").find((c) => c.id === id);
const PROPS: { key: TextProperty; label: TKey }[] = [
  { key: "reference", label: "doc.reference" },
  { key: "designation", label: "doc.designation" },
  { key: "author", label: "doc.author" },
  { key: "revision", label: "doc.revision" },
];

const swatches = ["#8fa8c8", "#c0c4ca", "#5a6270", "#d9b46a", "#c8743c", "#3f7f5f", "#3b6fb6", "#b23a3a", "#e8e2d4", "#2a2a2a"];

/** Features whose faces can have a colour: those producing a body (neither sketch nor plane). */
const NOT_COLORABLE = new Set(["sketch", "sketch3d", "plane"]);

/** Feature selected in the tree, if it creates faces. */
const coloredFeature = () => {
  const f = state.doc.features.find((x) => x.id === state.activeFeatureId);
  return f && !NOT_COLORABLE.has(f.type) ? f : undefined;
};

/** Swatches, free colour picker and, if applicable, reset to the part colour. */
function ColorChoice(props: { value: string; onPick: (color: string) => void; onReset?: () => void }) {
  return (
    <>
      <div class="swatches">
        <For each={swatches}>
          {(c) => <button class="swatch" classList={{ active: props.value === c }} style={{ background: c }} aria-label={c} onClick={() => props.onPick(c)} />}
        </For>
      </div>
      <input type="color" value={props.value} onChange={(e) => props.onPick(e.currentTarget.value)} />
      <Show when={props.onReset}>
        <button class="link-btn" onClick={() => props.onReset?.()}>
          {t("color.usePart")}
        </button>
      </Show>
    </>
  );
}

export function RightPanel() {
  const [tab, setTab] = createSignal<string>("right.tips");
  const draw = () => {
    const all = legends();
    return all[Math.floor(Math.random() * all.length)]!;
  };
  // Tab presented by the tips pane: a new one each time the pane opens.
  const [presented, setPresented] = createSignal(draw());
  const tabEls: Partial<Record<string, HTMLElement>> = {};
  const openTab = (k: string) => {
    if (k === "right.tips") setPresented(draw());
    setTab(k);
  };
  // The chat and the screenshots need room: panel widened while those tabs are open.
  createEffect(() => document.documentElement.style.setProperty("--right-w", moduleTab(tab())?.width ?? (tab() === "right.tips" ? "300px" : "250px")));
  onCleanup(() => document.documentElement.style.removeProperty("--right-w"));
  const [dropOver, setDropOver] = createSignal<string | null>(null);

  return (
    <aside class="side right" {...panels.right.hover}>
      <div class="side-tabs" role="tablist">
        <For each={tabs()}>
          {(entry) => {
            const k = entry.id;
            return (
            <button
              ref={(el) => (tabEls[k] = el)}
              role="tab"
              class="icon-tab"
              classList={{ active: tab() === k, presented: tab() === "right.tips" && presented().tab === k }}
              title={entry.label()}
              aria-label={entry.label()}
              onClick={() => openTab(k)}
            >
              <span class="tab-ico" innerHTML={entry.icon} />
              <Show when={tab() === k}>
                <span class="tab-label">{entry.label()}</span>
              </Show>
            </button>
            );
          }}
        </For>
      </div>
      <div class="side-body" classList={{ [moduleTab(tab())?.bodyClass ?? "module-tab-body"]: !!moduleTab(tab())?.bodyClass }}>
        <Switch>
          <Match when={tab() === "right.tips"}>
            <TipsPane legend={presented()} anchor={tabEls[presented().tab]!} onOpen={openTab} />
          </Match>
          <Match when={tab() === "right.documents"}>
            <ul class="doc-list">
              <For each={ws.entries}>
                {(e) => (
                  <li
                    classList={{ active: e.id === ws.activeId, "drop-target": dropOver() === e.id }}
                    onDragOver={(ev) => {
                      const dragged = draggedDoc();
                      const onModuleDoc = !!dragged && !!docKind(e.kind)?.acceptsDrop?.(dragged);
                      if (dragged === e.id || (!onModuleDoc && !canDropInto(dragged, e.id))) return;
                      ev.preventDefault();
                      ev.dataTransfer!.dropEffect = "copy";
                      setDropOver(e.id);
                    }}
                    onDragLeave={() => dropOver() === e.id && setDropOver(null)}
                    onDrop={(ev) => {
                      ev.preventDefault();
                      setDropOver(null);
                      const id = draggedDoc();
                      if (!id) return;
                      // On a module document (drawing): it receives the dragged document (a view of it).
                      const k = docKind(e.kind);
                      if (k?.drop && k.acceptsDrop?.(id)) k.drop(e.id, id);
                      else dropInto(id, e.id);
                    }}
                  >
                    <button
                      class="doc-entry"
                      onClick={() => activate(e.id)}
                      title={e.kind === "part" ? t("ws.part") : t("ws.assembly")}
                      draggable={e.kind === "part" || e.kind === "assembly"}
                      onDragStart={(ev) => {
                        ev.dataTransfer!.effectAllowed = "copy";
                        ev.dataTransfer!.setData("text/plain", e.name);
                        setDraggedDoc(e.id);
                      }}
                      onDragEnd={() => {
                        setDraggedDoc(null);
                        setDropOver(null);
                      }}
                    >
                      <span class="doc-kind">{e.kind === "part" ? "◇" : e.kind === "assembly" ? "⧉" : (docKind(e.kind)?.icon ?? "▭")}</span>
                      <span class="doc-name">{e.name}</span>
                    </button>
                    <button class="icon-btn" title={t("ws.close")} onClick={() => void closeDocument(e.id)}>
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <div class="family-actions">
              <button class="link-btn" onClick={newPart}>
                + {t("ws.part")}
              </button>
              <button class="link-btn" onClick={newAssembly}>
                + {t("ws.assembly")}
              </button>
              <For each={docKinds().filter((k) => k.create && k.module && moduleEnabled(k.module))}>
                {(k) => (
                  <button class="link-btn" onClick={() => (k.feature ? requireFeature(k.feature, () => k.create!()) : k.create!())}>
                    + {k.label()}
                  </button>
                )}
              </For>
            </div>
          </Match>
          <Match when={tab() === "right.properties"}>
            <Show when={activeKind() === "part"}>
            <label class="field doc-rename">
              <span>{t("prop.name")}</span>
              <input value={state.doc.name} onChange={(e) => setDocName(e.currentTarget.value)} />
            </label>
            <For each={PROPS}>
              {(p) => (
                <label class="field">
                  <span>{t(p.label)}</span>
                  <input value={state.doc.properties?.[p.key] ?? ""} onChange={(e) => setProperty(p.key, e.currentTarget.value.trim())} />
                </label>
              )}
            </For>
            <CustomProperties />
            </Show>
          </Match>
          <Match when={moduleTab(tab())}>{(m) => <Dynamic component={m().component} />}</Match>
          <Match when={tab() === "right.appearance"}>
            <div class="appearance">
              <span class="label">{t("right.color")}</span>
              <ColorChoice value={state.doc.appearance.color} onPick={setColor} />
              <Show when={activeKind() === "part"}>
                <span class="label">{t("right.finish")}</span>
                <select
                  aria-label={t("right.finish")}
                  value={state.doc.appearance.finish ?? ""}
                  onChange={(e) => setFinish((e.currentTarget.value || null) as Finish | null)}
                >
                  <option value="">{t("finish.none")}</option>
                  <For each={FINISHES}>{(f) => <option value={f.id}>{tx(f.label)}</option>}</For>
                </select>
                <Show
                  when={state.selection.length > 0 || coloredFeature()}
                  fallback={<p class="appearance-hint">{t("color.hint")}</p>}
                >
                  <Show when={state.selection.length > 0}>
                    <span class="label">{t("color.selFaces").replace("{n}", String(state.selection.length))}</span>
                    <ColorChoice
                      value={faceColorOf(state.selection[0]!.index) ?? state.doc.appearance.color}
                      onPick={(c) => setFaceColor(state.selection.map((f) => f.index), c)}
                      onReset={state.selection.some((f) => faceColorOf(f.index)) ? () => setFaceColor(state.selection.map((f) => f.index), null) : undefined}
                    />
                  </Show>
                  <Show when={coloredFeature()}>
                    {(f) => (
                      <>
                        <span class="label">{t("color.ofFeature").replace("{name}", f().name)}</span>
                        <ColorChoice
                          value={state.doc.appearance.features?.[f().id] ?? state.doc.appearance.color}
                          onPick={(c) => setFeatureColor(f().id, c)}
                          onReset={state.doc.appearance.features?.[f().id] ? () => setFeatureColor(f().id, null) : undefined}
                        />
                      </>
                    )}
                  </Show>
                </Show>
                <Show when={state.doc.appearance.faces?.length || Object.keys(state.doc.appearance.features ?? {}).length}>
                  <p class="appearance-hint">
                    {t("color.partial")
                      .replace("{faces}", String(state.doc.appearance.faces?.length ?? 0))
                      .replace("{features}", String(Object.keys(state.doc.appearance.features ?? {}).length))}
                  </p>
                  <button class="link-btn" onClick={clearPartialColors}>
                    {t("color.clearAll")}
                  </button>
                </Show>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </aside>
  );
}

/** Characteristics of the part: label / value pairs, editable (filled by the modules that generate the part). */
function CustomProperties() {
  const rows = (): CustomProperty[] => state.doc.properties?.custom ?? [];
  const change = (i: number, patch: Partial<CustomProperty>) => setCustomProperties(rows().map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const [draft, setDraft] = createSignal(false);
  return (
    <div class="custom-props" aria-label={t("doc.custom")}>
      <span class="label">{t("doc.custom")}</span>
      <For each={rows()}>
        {(r, i) => (
          <div class="custom-prop">
            <div class="custom-prop-head">
              <input class="custom-prop-label" aria-label={t("doc.customLabel")} value={r.label} onChange={(e) => change(i(), { label: e.currentTarget.value })} />
              <button class="icon-btn" title={t("doc.customRemove")} aria-label={t("doc.customRemove")} onClick={() => setCustomProperties(rows().filter((_, j) => j !== i()))}>
                ×
              </button>
            </div>
            <input aria-label={t("doc.customValue")} value={r.value} onChange={(e) => change(i(), { value: e.currentTarget.value })} />
          </div>
        )}
      </For>
      <Show
        when={draft()}
        fallback={
          <button class="link-btn" onClick={() => setDraft(true)}>
            {t("doc.customAdd")}
          </button>
        }
      >
        <div class="custom-props-new">
          <input
            aria-label={t("doc.customLabel")}
            placeholder={t("doc.customLabel")}
            ref={(el) => queueMicrotask(() => el.focus())}
            onChange={(e) => {
              const label = e.currentTarget.value.trim();
              setDraft(false);
              if (label) setCustomProperties([...rows(), { label, value: "" }]);
            }}
            onBlur={() => setDraft(false)}
          />
        </div>
      </Show>
    </div>
  );
}
