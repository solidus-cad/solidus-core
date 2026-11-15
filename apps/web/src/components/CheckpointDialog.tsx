import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { t } from "../i18n.ts";
import { openContextMenu } from "./ContextMenu.tsx";
import { checkpointsOf, deleteCheckpoint, nextNumber } from "../checkpoints.ts";
import {
  activate,
  checkpointItems,
  createCheckpoint,
  hasUnversionedChanges,
  openCheckpointCopy,
  previewCheckpoint,
  previewSource,
  restoreCheckpoint,
  ws,
  type CheckpointItem,
} from "../workspace.ts";

type View = { mode: "create"; id: string } | { mode: "restore"; id: string; n: number };

const [view, setView] = createSignal<View | null>(null);
const restoreView = (v: View) => (v.mode === "restore" ? v : null);

const versionable = (id: string) => ws.entries.some((e) => e.id === id && e.kind !== "drawing");

/** Opens the entry form for a new checkpoint of the document. */
export function openCheckpointCreate(id: string = ws.activeId): void {
  if (versionable(id)) setView({ mode: "create", id });
}

/** "Versions" section of the left panel: collapsed by default. */
const [versionsOpen, setVersionsOpen] = createSignal(false);
let versionsEl: HTMLElement | undefined;

/** Expands the document's versions in the left panel (it becomes the active document, so the restored state is visible). */
export function openCheckpointList(id: string = ws.activeId): void {
  if (!versionable(id)) return;
  activate(id);
  setVersionsOpen(true);
  queueMicrotask(() => versionsEl?.scrollIntoView({ block: "nearest" }));
}

/** Right-click on the empty area of a tree: checkpoints of the active document (rows have their own menu). */
export function checkpointMenu(ev: MouseEvent): void {
  if (ev.defaultPrevented || (ev.target as HTMLElement).closest("input, textarea, select")) return;
  openContextMenu(ev, [
    { label: t("ckpt.createMenu"), run: () => openCheckpointCreate() },
    { label: t("ckpt.versionsMenu"), run: () => openCheckpointList() },
  ]);
}

const KIND_ICON = { part: "◇", assembly: "⧉" } as const;
const docName = (id: string) => ws.entries.find((e) => e.id === id)?.name ?? "";
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** Checkpoints of parts and assemblies: creation with a comment, history, revert to a version. */
export function CheckpointDialog() {
  const close = () => setView(null);
  return (
    <Show when={view()}>
      {(v) => (
        <div class="dialog-backdrop" onClick={close}>
          <div
            class="dialog checkpoint-dialog"
            classList={{ wide: v().mode === "restore" }}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
            }}
          >
            <Switch>
              <Match when={v().mode === "create"}>
                <CreateView id={v().id} />
              </Match>
              <Match when={restoreView(v())}>{(r) => <RestoreView id={r().id} n={r().n} />}</Match>
            </Switch>
          </div>
        </div>
      )}
    </Show>
  );
}

function CreateView(p: { id: string }) {
  const [comment, setComment] = createSignal("");
  const n = nextNumber(p.id);
  const head = checkpointsOf(p.id).head;
  const create = () => {
    if (!comment().trim()) return;
    createCheckpoint(p.id, comment());
    setView(null);
  };
  return (
    <>
      <h2>
        {t("ckpt.createTitle").replace("{n}", String(n))} — {docName(p.id)}
      </h2>
      <Show when={head !== null && head !== n - 1}>
        <p class="checkpoint-branch">{t("ckpt.basedOn").replace("{n}", String(head))}</p>
      </Show>
      <label class="field checkpoint-comment">
        <span>{t("ckpt.comment")}</span>
        <textarea
          rows={4}
          value={comment()}
          placeholder={t("ckpt.commentHint")}
          onInput={(e) => setComment(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && create()}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
      </label>
      <div class="dialog-actions">
        <button class="btn" onClick={() => setView(null)}>
          {t("ws.cancel")}
        </button>
        <button class="btn primary" disabled={!comment().trim()} onClick={create}>
          {t("ckpt.create")}
        </button>
      </div>
    </>
  );
}

/**
 * Versions of the active document, at the bottom of the left panel: click = preview, right-click = actions.
 * In a preview tab, these are the versions of the previewed document (the copy has none of its own).
 */
export function VersionPanel() {
  const preview = () => previewSource(ws.activeId);
  const id = () => preview()?.source ?? ws.activeId;
  const log = () => checkpointsOf(id());
  const sorted = () => [...log().list].sort((a, b) => b.number - a.number);
  const unversioned = createMemo(() => log().list.length > 0 && hasUnversionedChanges(id()));
  const isAssembly = () => ws.entries.find((e) => e.id === id())?.kind === "assembly";
  const restore = (n: number) => (isAssembly() ? setView({ mode: "restore", id: id(), n }) : restoreCheckpoint(id(), n));
  /** Version whose deletion awaits confirmation. */
  const [confirming, setConfirming] = createSignal<number | null>(null);
  const rowMenu = (ev: MouseEvent, n: number) => {
    ev.preventDefault();
    openContextMenu(ev, [
      { label: t("ckpt.preview"), run: () => void previewCheckpoint(id(), n) },
      { label: t("ckpt.restore"), run: () => restore(n) },
      { label: t("ckpt.openCopy"), run: () => openCheckpointCopy(id(), n) },
      { label: t("ckpt.delete"), run: () => setConfirming(n) },
    ]);
  };

  return (
    <Show when={versionable(id())}>
      <div class="tree-section version-panel" ref={(el) => (versionsEl = el)} onContextMenu={(e) => e.stopPropagation()}>
        <div class="version-head">
          <button class="tree-section-title" aria-expanded={versionsOpen()} onClick={() => setVersionsOpen(!versionsOpen())}>
            <span class="chevron" classList={{ open: versionsOpen() }}>
              ▸
            </span>
            {t("ckpt.versions")}
            <Show when={unversioned()}>
              <span class="version-dirty" title={t("ckpt.unversioned")}>
                ●
              </span>
            </Show>
            <span class="count">{log().head !== null ? `v${log().head}` : log().list.length}</span>
          </button>
          <button class="icon-btn" title={t("ckpt.new")} aria-label={t("ckpt.new")} onClick={() => openCheckpointCreate(id())}>
            +
          </button>
        </div>
        <Show when={versionsOpen()}>
          <Show when={log().list.length > 0} fallback={<p class="version-empty">{t("ckpt.none")}</p>}>
            <Show when={preview()}>
              {(p) => <p class="version-empty">{t("ckpt.previewing").replace("{n}", String(p().number)).replace("{name}", docName(p().source))}</p>}
            </Show>
            <Show when={unversioned()}>
              <p class="version-empty">{t("ckpt.unversioned")}</p>
            </Show>
            <ul class="version-list">
              <For each={sorted()}>
                {(c) => (
                  <li
                    classList={{ head: c.number === log().head, previewing: c.number === preview()?.number }}
                    title={`${c.comment}
${t("ckpt.previewHint")}`}
                    onClick={(e) => !(e.target as HTMLElement).closest("button") && void previewCheckpoint(id(), c.number)}
                    onContextMenu={(e) => rowMenu(e, c.number)}
                  >
                    <span class="checkpoint-num" title={c.number === log().head ? t("ckpt.current") : undefined}>
                      <Show when={c.number === log().head}>● </Show>v{c.number}
                    </span>
                    <Show
                      when={confirming() === c.number}
                      fallback={
                        <>
                          <div class="checkpoint-body">
                            <div class="version-comment">{c.comment}</div>
                            <div class="checkpoint-meta">
                              {fmtDate(c.date)}
                              <Show when={c.author}> · {c.author}</Show>
                              <Show when={c.parent !== null && c.parent !== c.number - 1}>
                                {" "}
                                · <span class="checkpoint-parent">{t("ckpt.from").replace("{n}", String(c.parent))}</span>
                              </Show>
                            </div>
                          </div>
                          <button class="icon-btn version-restore" title={t("ckpt.restore")} aria-label={`${t("ckpt.restore")} v${c.number}`} onClick={() => restore(c.number)}>
                            ↺
                          </button>
                        </>
                      }
                    >
                      <span class="checkpoint-confirm checkpoint-body">{t("ckpt.deleteConfirm").replace("{n}", String(c.number))}</span>
                      <button
                        class="btn danger"
                        onClick={() => {
                          deleteCheckpoint(id(), c.number);
                          setConfirming(null);
                        }}
                      >
                        {t("ckpt.delete")}
                      </button>
                      <button class="btn" onClick={() => setConfirming(null)}>
                        {t("ws.cancel")}
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

/** Assembly: choice of the documents that revert to the version. */
function RestoreView(p: { id: string; n: number }) {
  const items = checkpointItems(p.id, p.n);
  const [sel, setSel] = createSignal(new Set(items.filter((i) => i.changed).map((i) => i.id)));
  const rootOn = () => sel().has(p.id);
  // A document that is no longer open must come back with the restored assembly (it is referenced there).
  const forced = (i: CheckpointItem) => !i.root && !i.open && rootOn();
  const checked = (i: CheckpointItem) => sel().has(i.id) || forced(i);
  const toggle = (id: string, on: boolean) =>
    setSel((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const chosen = () => items.filter(checked).map((i) => i.id);
  const apply = () => {
    restoreCheckpoint(p.id, p.n, chosen());
    setView(null);
  };

  return (
    <>
      <h2>
        {t("ckpt.restoreTitle").replace("{n}", String(p.n))} — {docName(p.id)}
      </h2>
      <p>{t("ckpt.restoreText")}</p>
      <ul class="checkpoint-items">
        <For each={items}>
          {(i) => (
            <li classList={{ root: i.root }}>
              <label>
                <input type="checkbox" checked={checked(i)} disabled={forced(i)} onChange={(e) => toggle(i.id, e.currentTarget.checked)} />
                <span class="doc-kind">{KIND_ICON[i.kind]}</span>
                <span class="checkpoint-item-name">{i.name}</span>
                <span class="checkpoint-badge" classList={{ changed: i.changed }}>
                  {!i.open ? t("ckpt.closed") : i.changed ? t("ckpt.changed") : t("ckpt.same")}
                </span>
              </label>
            </li>
          )}
        </For>
      </ul>
      <div class="dialog-actions">
        <button class="btn" onClick={() => setView(null)}>
          {t("ws.cancel")}
        </button>
        <button class="btn primary" disabled={chosen().length === 0} onClick={apply}>
          {t("ckpt.restore")}
        </button>
      </div>
    </>
  );
}
