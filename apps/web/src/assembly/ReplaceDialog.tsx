import { createSignal, For, Show } from "solid-js";
import { t } from "../i18n.ts";
import { pickDocumentFile } from "../files.ts";
import { hasModuleAction, runModuleAction } from "../host.ts";
import { assemblyDoc, familyMember, insertableAssemblies, openParts, partDoc, replaceComponent, ws } from "../workspace.ts";

/**
 * Replacing an occurrence: another configuration of its family, or another part / sub-assembly
 * (open documents, file, library). The position and constraints are kept.
 */

/** Top-level occurrence to replace; null: dialog closed. */
const [target, setTarget] = createSignal<string | null>(null);
/** Current choice: family configuration, or document. */
type Choice = { kind: "family"; index: number } | { kind: "part"; id: string } | { kind: "assembly"; id: string };
const [choice, setChoice] = createSignal<Choice | null>(null);
const [all, setAll] = createSignal(false);
const [tab, setTab] = createSignal<"family" | "browse">("family");
const [busy, setBusy] = createSignal(false);

/** `all`: all occurrences of the same document checked from the start (reference not found). */
export function openReplaceDialog(componentId: string, opts: { all?: boolean } = {}): void {
  const c = ws.asm?.components.find((x) => x.id === componentId);
  if (!c) return;
  setTarget(componentId);
  setChoice(null);
  setAll(!!opts.all);
  setTab(c.partId && partDoc(c.partId)?.family?.rows.length ? "family" : "browse");
}

const close = () => setTarget(null);

export const replaceDialogOpen = () => target() !== null;

const comp = () => ws.asm?.components.find((x) => x.id === target());

/** Targeted occurrences: this one, or all those of the same document. */
function targets(): string[] {
  const c = comp();
  if (!c || !ws.asm) return [];
  if (!all()) return [c.id];
  return ws.asm.components.filter((x) => (c.assemblyId ? x.assemblyId === c.assemblyId : !x.assemblyId && x.partId === c.partId)).map((x) => x.id);
}

async function apply(ch: Choice | null = choice()): Promise<void> {
  const c = comp();
  if (!c || !ch) return;
  setBusy(true);
  try {
    if (ch.kind === "family") {
      const id = await familyMember(c.partId, ch.index);
      if (id) replaceComponent(targets(), { partId: id });
    } else if (ch.kind === "part") replaceComponent(targets(), { partId: ch.id });
    else replaceComponent(targets(), { assemblyId: ch.id });
    close();
  } finally {
    setBusy(false);
  }
}

async function browseFile(): Promise<void> {
  const r = await pickDocumentFile();
  if (r) setChoice({ kind: r.kind, id: r.id });
}

function browseLibrary(): void {
  const ids = targets();
  close();
  // The catalogue loads the chosen part, which immediately replaces the occurrences.
  runModuleAction("library.pick", (partId: string) => replaceComponent(ids, { partId }));
}

export function ReplaceDialog() {
  const family = () => {
    const c = comp();
    return c && !c.assemblyId ? partDoc(c.partId)?.family : undefined;
  };
  const sameDoc = () => {
    const c = comp();
    return c ? ws.asm!.components.filter((x) => (c.assemblyId ? x.assemblyId === c.assemblyId : !x.assemblyId && x.partId === c.partId)).length : 0;
  };
  const current = () => comp()?.assemblyId ?? comp()?.partId;
  const docs = () => [
    ...openParts().filter((e) => e.id !== current()).map((e) => ({ kind: "part" as const, id: e.id, name: e.name })),
    ...insertableAssemblies().filter((e) => e.id !== current()).map((e) => ({ kind: "assembly" as const, id: e.id, name: e.name })),
  ];
  const chosen = (k: Choice["kind"], v: string | number) => {
    const ch = choice();
    return !!ch && ch.kind === k && (ch.kind === "family" ? ch.index === v : ch.id === v);
  };
  const chosenName = () => {
    const ch = choice();
    if (!ch || ch.kind === "family") return "";
    return ch.kind === "part" ? (partDoc(ch.id)?.name ?? "?") : (assemblyDoc(ch.id)?.name ?? "?");
  };

  return (
    <Show when={comp()}>
      {(c) => (
        <div class="dialog-backdrop" onClick={close}>
          <div
            class="dialog wide replace-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("asm.replace")}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
            }}
          >
            <h2>
              {t("asm.replace")} : {c().name}
            </h2>
            <div class="segmented" role="tablist">
              <Show when={family()}>
                <button role="tab" aria-selected={tab() === "family"} classList={{ active: tab() === "family" }} onClick={() => setTab("family")}>
                  {t("rep.family")}
                </button>
              </Show>
              <button role="tab" aria-selected={tab() === "browse"} classList={{ active: tab() === "browse" }} onClick={() => setTab("browse")}>
                {t("rep.browse")}
              </button>
            </div>

            <Show when={tab() === "family" && family()}>
              {(f) => (
                <div class="family-table-wrap">
                  <table class="family-table">
                    <thead>
                      <tr>
                        <th>{t("fam.configuration")}</th>
                        <For each={f().columns}>{(col) => <th>{col}</th>}</For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={f().rows}>
                        {(row, i) => (
                          <tr
                            classList={{ active: chosen("family", i()), current: f().active === i() }}
                            title={f().active === i() ? t("rep.current") : undefined}
                            onClick={() => setChoice({ kind: "family", index: i() })}
                            onDblClick={() => void apply({ kind: "family", index: i() })}
                          >
                            <td>
                              {f().active === i() ? "● " : ""}
                              {row.name}
                            </td>
                            <For each={f().columns}>{(_, k) => <td>{row.values[k()] ?? ""}</td>}</For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              )}
            </Show>

            <Show when={tab() === "browse"}>
              <div class="machine-row">
                <button class="btn" onClick={() => void browseFile()}>
                  {t("rep.file")}…
                </button>
                <Show when={!c().assemblyId && hasModuleAction("library.pick")}>
                  <button class="btn" onClick={browseLibrary}>
                    {t("rep.library")}…
                  </button>
                </Show>
              </div>
              <p class="field-hint">{t("rep.openDocs")}</p>
              <div class="replace-list">
                <For each={docs()} fallback={<p class="field-hint">{t("rep.noDocs")}</p>}>
                  {(d) => (
                    <div
                      class="tree-row"
                      classList={{ active: chosen(d.kind, d.id) }}
                      onClick={() => setChoice({ kind: d.kind, id: d.id })}
                      onDblClick={() => void apply({ kind: d.kind, id: d.id })}
                    >
                      <span class="asm-icon">{d.kind === "assembly" ? "⧉" : "◇"}</span>
                      <span class="name">{d.name}</span>
                    </div>
                  )}
                </For>
              </div>
              <Show when={chosenName()}>
                <p class="field-hint">
                  {t("rep.chosen")} : {chosenName()}
                </p>
              </Show>
            </Show>

            <Show when={sameDoc() > 1}>
              <label class="check">
                <input type="checkbox" checked={all()} onChange={(e) => setAll(e.currentTarget.checked)} />
                {t("rep.all").replace("{n}", String(sameDoc()))}
              </label>
            </Show>
            <p class="field-hint">{t("rep.matesKept")}</p>
            <div class="dialog-actions">
              <button class="btn" onClick={close}>
                {t("rep.cancel")}
              </button>
              <button class="btn primary" disabled={!choice() || busy() || (choice()!.kind === "family" && family()?.active === (choice() as { index: number }).index)} onClick={() => void apply()}>
                {t("asm.replace")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
