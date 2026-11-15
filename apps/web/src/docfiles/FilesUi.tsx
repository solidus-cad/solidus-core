import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { t } from "../i18n.ts";
import { setMessage } from "../store.ts";
import { activate, assemblyDoc, ws } from "../workspace.ts";
import { pickDocumentFile } from "../files.ts";
import { openReplaceDialog, replaceDialogOpen } from "../assembly/ReplaceDialog.tsx";
import { docFs, outsideProjectSignal, setSnapshotPicker } from "./fs.ts";
import { remapRef, unresolvedRefs } from "./documents.ts";
import { missingToReview, setMissingToReview, type DocReference } from "./missing.ts";

// --- Choosing a file in the project folder (browsers without File System Access) --------------------------

const [pick, setPick] = createSignal<{ paths: string[]; mode: "open" | "save"; name: string; done: (p: string | null) => void } | null>(null);

setSnapshotPicker(
  (paths, mode, suggested) =>
    new Promise((resolve) => setPick({ paths, mode, name: suggested ?? "", done: (p) => (setPick(null), resolve(p)) })),
);

function SnapshotPicker() {
  return (
    <Show when={pick()}>
      {(p) => (
        <div class="dialog-backdrop" onClick={() => p().done(null)}>
          <div class="dialog wide" role="dialog" aria-modal="true" aria-label={t("file.pickTitle")} onClick={(e) => e.stopPropagation()}>
            <h2>
              {t("file.pickTitle")} : {docFs.rootName()}
            </h2>
            <div class="replace-list">
              <For each={p().paths} fallback={<p class="field-hint">{t("file.pickEmpty")}</p>}>
                {(path) => (
                  <div
                    class="tree-row"
                    classList={{ active: p().name === path }}
                    onClick={() => setPick({ ...p(), name: path })}
                    onDblClick={() => p().done(path)}
                  >
                    <span class="name">{path}</span>
                  </div>
                )}
              </For>
            </div>
            <Show when={p().mode === "save"}>
              <label class="field">
                <span>{t("file.pickName")}</span>
                <input value={p().name} onInput={(e) => setPick({ ...p(), name: e.currentTarget.value })} />
              </label>
              <p class="field-hint">{t("file.downloadHint")}</p>
            </Show>
            <div class="dialog-actions">
              <button
                class="btn"
                // New folder read: the choice must be made again (the list comes from the old one).
                onClick={async () => {
                  const cur = p();
                  await docFs.ensureRoot(true);
                  cur.done(null);
                }}
              >
                {t("file.pickChange")}
              </button>
              <button class="btn" onClick={() => p().done(null)}>
                {t("rep.cancel")}
              </button>
              <button class="btn primary" disabled={!p().name.trim()} onClick={() => p().done(p().name.trim())}>
                {p().mode === "open" ? t("file.pickOpen") : t("file.pickSave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

// --- Missing references ---------------------------------------------------------------------------------

const nameOf = (id: string) => ws.entries.find((e) => e.id === id)?.name ?? "?";

/** Missing references still in use (a replaced reference disappears from the list). */
function rows(): { owner: string; ref: DocReference }[] {
  return missingToReview().flatMap((owner) => {
    if (!ws.entries.some((e) => e.id === owner)) return [];
    return unresolvedRefs(owner).map((ref) => ({ owner, ref }));
  });
}

async function replace(owner: string, ref: DocReference): Promise<void> {
  const kind = ws.entries.find((e) => e.id === owner)?.kind;
  if (kind === "assembly") {
    activate(owner);
    const c = assemblyDoc(owner)?.components.find((x) => (ref.kind === "assembly" ? x.assemblyId === ref.id : !x.assemblyId && x.partId === ref.id));
    if (c) openReplaceDialog(c.id, { all: true });
  } else {
    // Drawing, module document: the chosen file takes the place of the reference.
    const r = await pickDocumentFile();
    if (r?.kind === ref.kind) remapRef(owner, ref.id, r.id);
  }
}

function MissingDialog() {
  const list = createMemo(rows);
  return (
    <Show when={list().length > 0 && !replaceDialogOpen()}>
      <div class="dialog-backdrop">
        <div class="dialog wide" role="dialog" aria-modal="true" aria-label={t("miss.title")}>
          <h2>{t("miss.title")}</h2>
          <p class="field-hint">{t("miss.text")}</p>
          <div class="replace-list">
            <For each={list()}>
              {(r) => (
                <div class="tree-row missing-ref">
                  <span class="asm-icon">{r.ref.kind === "assembly" ? "⧉" : "◇"}</span>
                  <span class="name" title={r.ref.absolute ?? r.ref.path}>
                    {r.ref.name} — <span class="muted">{r.ref.path}</span> ({t("miss.in")} {nameOf(r.owner)})
                  </span>
                  <button class="btn" onClick={() => void replace(r.owner, r.ref)}>
                    {t("miss.replace")}
                  </button>
                </div>
              )}
            </For>
          </div>
          <div class="dialog-actions">
            <button class="btn" onClick={() => setMissingToReview([])}>
              {t("miss.later")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

export function FilesUi() {
  createEffect(on(outsideProjectSignal, (n) => n > 0 && setMessage(t("file.outside")), { defer: true }));
  return (
    <>
      <SnapshotPicker />
      <MissingDialog />
    </>
  );
}
