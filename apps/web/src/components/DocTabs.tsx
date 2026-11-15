import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../i18n.ts";
import { activate, closeDocument, draggedDoc, isDirty, newAssembly, newPart, previewOf, ws } from "../workspace.ts";
import { moduleEnabled } from "../plugins/modules.ts";
import { docKind, docKinds } from "../host.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { requireFeature } from "../license.ts";
import { openCheckpointCreate, openCheckpointList } from "./CheckpointDialog.tsx";

const KIND_ICON: Record<string, string> = { part: "◇", assembly: "⧉" };
const KIND_LABEL = { part: "ws.part", assembly: "ws.assembly" } as const;
/** Icon and name of a document type (base types, then types provided by modules). */
const kindIcon = (k: string) => KIND_ICON[k] ?? docKind(k)?.icon ?? "▫";
const kindLabel = (k: string) => (k in KIND_LABEL ? t(KIND_LABEL[k as keyof typeof KIND_LABEL]) : (docKind(k)?.label() ?? k));

/** Tabs of open documents (parts, assemblies, module documents: drawings, CAM programs…): only one is active at a time. */
export function DocTabs() {
  const [menu, setMenu] = createSignal(false);
  let root!: HTMLElement;
  let strip!: HTMLDivElement;

  onMount(() => {
    const close = (e: PointerEvent) => !root.contains(e.target as Node) && setMenu(false);
    window.addEventListener("pointerdown", close);
    onCleanup(() => window.removeEventListener("pointerdown", close));
  });

  // The active tab stays visible when tabs overflow.
  createEffect(() => {
    const id = ws.activeId;
    void ws.entries.length;
    queueMicrotask(() => strip.querySelector<HTMLElement>(`[data-doc="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });

  const create = (fn: () => void) => {
    setMenu(false);
    fn();
  };

  return (
    <nav class="doc-tabs" ref={root} aria-label={t("right.documents")}>
      <div class="doc-tabs-strip" role="tablist" ref={strip} onWheel={(e) => e.deltaY && (strip.scrollLeft += e.deltaY)}>
        <For each={ws.entries.filter((e) => !e.background)}>
          {(e) => (
            <div
              class="doc-tab"
              classList={{ active: e.id === ws.activeId, preview: !!previewOf(e.id) }}
              data-doc={e.id}
              role="tab"
              aria-selected={e.id === ws.activeId}
              title={`${kindLabel(e.kind)} — ${e.name}${previewOf(e.id) ? ` — ${t("ckpt.previewTab")}` : ""}`}
              onClick={() => activate(e.id)}
              // Middle click: closes the tab, as in a browser.
              onAuxClick={(ev) => ev.button === 1 && void closeDocument(e.id)}
              onMouseDown={(ev) => ev.button === 1 && ev.preventDefault()}
              // Part or assembly dragged from the Documents panel onto a module document tab (drawing): a view of it.
              onDragOver={(ev) => {
                const id = draggedDoc();
                if (!id || !docKind(e.kind)?.acceptsDrop?.(id)) return;
                ev.preventDefault();
                ev.dataTransfer!.dropEffect = "copy";
              }}
              onDrop={(ev) => {
                const id = draggedDoc();
                const k = docKind(e.kind);
                if (!id || !k?.drop || !k.acceptsDrop?.(id)) return;
                ev.preventDefault();
                k.drop(e.id, id);
              }}
              onContextMenu={(ev) =>
                openContextMenu(ev, [
                  ...(e.kind === "part" || e.kind === "assembly"
                    ? docKinds()
                        .filter((k) => k.createFrom && (!k.module || moduleEnabled(k.module)))
                        .map((k) => ({ label: k.createFrom!.label(), run: () => (k.feature ? requireFeature(k.feature, () => k.createFrom!.run(e.id)) : k.createFrom!.run(e.id)) }))
                    : []),
                  ...(docKind(e.kind)?.noCheckpoints
                    ? []
                    : [
                        { label: t("ckpt.createMenu"), run: () => openCheckpointCreate(e.id) },
                        { label: t("ckpt.versionsMenu"), run: () => openCheckpointList(e.id) },
                      ]),
                  { label: t("ws.close"), run: () => void closeDocument(e.id) },
                ])
              }
            >
              <span class="doc-kind">{kindIcon(e.kind)}</span>
              <span class="doc-tab-name">{e.name}</span>
              <Show when={isDirty(e.id)}>
                <span class="dirty" title={t("ws.modified")}>
                  •
                </span>
              </Show>
              <button
                class="doc-tab-close"
                title={t("ws.close")}
                aria-label={`${t("ws.close")} ${e.name}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  void closeDocument(e.id);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      <div class="doc-tabs-new">
        <button class="doc-tab-add" title={t("ws.new")} aria-label={t("ws.new")} aria-expanded={menu()} onClick={() => setMenu(!menu())}>
          +
        </button>
        <Show when={menu()}>
          <ul class="menu-popup doc-tabs-menu">
            <li>
              <button onClick={() => create(newPart)}>
                <span>{KIND_ICON.part} {t("ws.newPart")}</span>
              </button>
            </li>
            <li>
              <button onClick={() => create(newAssembly)}>
                <span>{KIND_ICON.assembly} {t("ws.newAssembly")}</span>
              </button>
            </li>
            <For each={docKinds().filter((k) => k.create && (!k.module || moduleEnabled(k.module)))}>
              {(k) => (
                <li>
                  <button onClick={() => (k.feature ? requireFeature(k.feature, () => create(() => k.create!())) : create(() => k.create!()))}>
                    <span>{k.icon} {(k.newLabel ?? k.label)()}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </nav>
  );
}
