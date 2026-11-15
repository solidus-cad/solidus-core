import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { lang, t, type TKey } from "../i18n.ts";
import { ask } from "../components/Dialog.tsx";
import { browserBlocked, eventToCombo, formatCombo, isReserved, SEQUENCE_MS } from "./keys.ts";
import { actionsOfScope, membersOf, parentOf, SCOPES, type Scope, type ShortcutAction } from "./registry.ts";
import { PRESET_IDS, type PresetId } from "./presets.ts";
import {
  conflicts,
  importShortcuts,
  isInherited,
  isModified,
  preset,
  resetAll,
  serializeShortcuts,
  setCapturing,
  setOverride,
  setPreset,
  shortcutsFor,
} from "./keymap.ts";
import { activeScopes } from "./scopes.ts";

const [open, setOpen] = createSignal(false);

/** Opens the shortcut settings window, on the active workbench. */
export function openShortcutsDialog(): void {
  setOpen(true);
}

const SCOPE_LABEL: Record<Scope, TKey> = {
  common: "keys.scope.common",
  global: "keys.scope.global",
  view: "keys.scope.view",
  part: "keys.scope.part",
  sheetmetal: "keys.scope.sheetmetal",
  sketch: "keys.scope.sketch",
  sketch3d: "keys.scope.sketch3d",
  assembly: "keys.scope.assembly",
  frame: "keys.scope.frame",
  analysis: "keys.scope.analysis",
  drawing: "keys.scope.drawing",
  cam: "keys.scope.cam",
  quote: "keys.scope.quote",
  motion: "keys.scope.motion",
};

const PRESET_LABEL: Record<PresetId, TKey> = {
  cad: "keys.preset.cad",
  solidworks: "keys.preset.solidworks",
  fusion: "keys.preset.fusion",
  freecad: "keys.preset.freecad",
};

export const scopeLabel = (s: Scope): string => t(SCOPE_LABEL[s]);

const normalize = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Blocking conflict awaiting confirmation ("Replace"). */
interface Pending {
  id: string;
  combo: string;
  blocking: ShortcutAction[];
}

/** Label of an action with its workbench: "Line (Sketch)". */
const withScope = (a: ShortcutAction): string => `${a.label()} (${scopeLabel(a.scope)})`;

export function ShortcutsDialog() {
  return (
    <Show when={open()}>
      <ShortcutsDialogBody />
    </Show>
  );
}

function ShortcutsDialogBody() {
  // Window open: the dispatcher is suspended (no command is sent during settings).
  setCapturing(true);
  onCleanup(() => setCapturing(false));

  const [scope, setScope] = createSignal<Scope>(activeScopes()[0] ?? "common");
  const [query, setQuery] = createSignal("");
  /** Action being captured and first key of a possible sequence. */
  const [capture, setCapture] = createSignal<{ id: string; first?: string } | null>(null);
  const [pending, setPending] = createSignal<Pending | null>(null);
  const [notice, setNotice] = createSignal<{ kind: "error" | "warn"; text: string } | null>(null);
  let seqTimer: ReturnType<typeof setTimeout> | undefined;
  let fileInput!: HTMLInputElement;

  const close = () => {
    stopCapture();
    setOpen(false);
  };

  /** Displayed actions: the chosen workbench, or all those matching the search. */
  const visible = createMemo((): { scope: Scope; list: ShortcutAction[] }[] => {
    const q = normalize(query().trim());
    if (!q) return [{ scope: scope(), list: actionsOfScope(scope()) }];
    return SCOPES.map((s) => ({
      scope: s,
      list: actionsOfScope(s).filter(
        (a) => normalize(a.label()).includes(q) || shortcutsFor(a.id).some((c) => normalize(formatCombo(c, lang())).includes(q) || normalize(c).includes(q)),
      ),
    })).filter((g) => g.list.length);
  });

  // --- Key capture -------------------------------------------------------------------

  const onCaptureKey = (ev: KeyboardEvent) => {
    const c = capture();
    if (!c) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === "Escape" && !c.first) return stopCapture();
    const combo = eventToCombo(ev);
    if (!combo) return;
    clearTimeout(seqTimer);
    if (c.first) return commit(c.id, `${c.first} ${combo}`);
    // With Ctrl/Alt: immediate combination; single key: waits for a 2nd key (sequence "V F").
    if (/(^|\+)(Ctrl|Alt)\+/.test(combo)) return commit(c.id, combo);
    setCapture({ id: c.id, first: combo });
    seqTimer = setTimeout(() => commit(c.id, combo), SEQUENCE_MS);
  };

  function startCapture(id: string): void {
    stopCapture();
    setNotice(null);
    setPending(null);
    setCapture({ id });
    window.addEventListener("keydown", onCaptureKey, true);
  }

  function stopCapture(): void {
    clearTimeout(seqTimer);
    window.removeEventListener("keydown", onCaptureKey, true);
    setCapture(null);
  }
  onCleanup(stopCapture);

  /** Adds `combo` to the action, after checking reservations and conflicts. */
  function commit(id: string, combo: string): void {
    stopCapture();
    if (isReserved(combo)) {
      setNotice({ kind: "error", text: `${formatCombo(combo, lang())} : ${t("keys.reserved")}` });
      return;
    }
    if (shortcutsFor(id).includes(combo)) return;
    const { blocking, shadowed } = conflicts(id, combo);
    if (blocking.length) {
      setPending({ id, combo, blocking });
      return;
    }
    add(id, combo);
    const warn: string[] = [];
    if (shadowed.length) warn.push(`${formatCombo(combo, lang())} — ${t("keys.shadow")} ${shadowed.map(withScope).join(", ")}`);
    if (browserBlocked(combo)) warn.push(t("keys.browserBlocked"));
    if (warn.length) setNotice({ kind: "warn", text: warn.join("\n") });
  }

  const add = (id: string, combo: string) => setOverride(id, [...shortcutsFor(id), combo]);
  const remove = (id: string, combo: string) => setOverride(id, shortcutsFor(id).filter((c) => c !== combo));

  /** Removes the combination from the conflicting actions, then adds it to the target action. */
  function replace(): void {
    const p = pending();
    if (!p) return;
    for (const b of p.blocking) remove(b.id, p.combo);
    add(p.id, p.combo);
    setPending(null);
  }

  // --- File, profile, reset ------------------------------------------------------

  function exportFile(): void {
    const url = URL.createObjectURL(new Blob([serializeShortcuts()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "shortcuts.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importFile(file: File | undefined): Promise<void> {
    if (!file) return;
    const ok = importShortcuts(await file.text());
    setNotice(ok ? null : { kind: "error", text: t("keys.importError") });
  }

  async function confirmReset(): Promise<void> {
    const choice = await ask(t("keys.resetAll"), t("keys.resetAllConfirm"), [{ id: "reset", label: t("keys.resetAll"), primary: true }], "cancel");
    if (choice === "reset") resetAll();
  }

  // --- Rendering ----------------------------------------------------------------------------------

  const Row = (props: { a: ShortcutAction }) => {
    const a = props.a;
    const parent = () => parentOf(a.id);
    const capturing = () => capture()?.id === a.id;
    return (
      <li class="keys-row" classList={{ locked: !!a.locked, modified: !a.locked && isModified(a.id) }}>
        <span class="keys-label">
          <span class="icon" innerHTML={a.icon ?? ""} />
          <span>{a.label()}</span>
          <Show when={a.scope === "common"}>
            <small class="keys-used">
              {t("keys.usedIn")} {[...new Set(membersOf(a.id).map((m) => scopeLabel(m.scope)))].join(", ")}
            </small>
          </Show>
        </span>
        <span class="keys-combos">
          <Show when={parent() && isInherited(a.id)}>
            <button class="keys-badge" title={t("keys.inheritedHint")} onClick={() => (setQuery(""), setScope("common"))}>
              {t("keys.inherited")}
            </button>
          </Show>
          <For each={shortcutsFor(a.id)}>
            {(c) => (
              <span class="keys-chip" classList={{ blocked: browserBlocked(c) }} title={browserBlocked(c) ? t("keys.browserBlocked") : undefined}>
                <kbd>{formatCombo(c, lang())}</kbd>
                <Show when={!a.locked}>
                  <button class="keys-x" title={t("keys.remove")} aria-label={t("keys.remove")} onClick={() => remove(a.id, c)}>
                    ×
                  </button>
                </Show>
              </span>
            )}
          </For>
          <Show when={capturing()}>
            <span class="keys-chip capturing">
              <kbd>{capture()?.first ? `${formatCombo(capture()!.first!, lang())} …` : t("keys.press")}</kbd>
            </span>
          </Show>
        </span>
        <span class="keys-tools">
          <Show
            when={!a.locked}
            fallback={
              <span class="keys-lock" title={t("keys.locked")}>
                🔒
              </span>
            }
          >
            <button class="keys-tool" title={t("keys.add")} aria-label={t("keys.add")} onClick={() => (capturing() ? stopCapture() : startCapture(a.id))}>
              +
            </button>
            <button
              class="keys-tool"
              title={parent() ? t("keys.followCommon") : t("keys.reset")}
              aria-label={parent() ? t("keys.followCommon") : t("keys.reset")}
              disabled={!isModified(a.id)}
              onClick={() => setOverride(a.id, undefined)}
            >
              ↺
            </button>
          </Show>
        </span>
      </li>
    );
  };

  return (
    <div class="dialog-backdrop" onClick={close}>
      <div
        class="dialog keys-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("keys.title")}
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === "Escape" && !capture()) close();
        }}
      >
        <div class="keys-head">
          <h2>{t("keys.title")}</h2>
          <label class="keys-preset">
            <span>{t("keys.preset")}</span>
            <select value={preset()} onChange={(ev) => setPreset(ev.currentTarget.value as PresetId)}>
              <For each={PRESET_IDS}>{(p) => <option value={p}>{t(PRESET_LABEL[p])}</option>}</For>
            </select>
          </label>
          <input class="keys-search" type="search" placeholder={t("keys.search")} value={query()} onInput={(ev) => setQuery(ev.currentTarget.value)} />
        </div>
        <div class="keys-main">
          <nav class="keys-scopes">
            <For each={SCOPES.filter((s) => actionsOfScope(s).length)}>
              {(s) => (
                <button classList={{ active: !query().trim() && scope() === s, common: s === "common" }} onClick={() => (setQuery(""), setScope(s))}>
                  {scopeLabel(s)}
                </button>
              )}
            </For>
          </nav>
          <div class="keys-list">
            <Show when={!query().trim() && scope() === "common"}>
              <p class="keys-hint">{t("keys.commonHint")}</p>
            </Show>
            <Show when={pending()}>
              {(p) => (
                <div class="keys-notice error" role="alert">
                  <span>
                    <kbd>{formatCombo(p().combo, lang())}</kbd> {t("keys.conflict")} {p().blocking.map(withScope).join(", ")}
                  </span>
                  <span class="spacer" />
                  <button class="btn" onClick={() => setPending(null)}>
                    {t("prop.cancel")}
                  </button>
                  <button class="btn primary" onClick={replace}>
                    {t("keys.replace")}
                  </button>
                </div>
              )}
            </Show>
            <Show when={notice()}>
              {(n) => (
                <div class="keys-notice" classList={{ error: n().kind === "error", warn: n().kind === "warn" }} role="status">
                  <span>{n().text}</span>
                  <span class="spacer" />
                  <button class="keys-x" aria-label={t("lib.close")} onClick={() => setNotice(null)}>
                    ×
                  </button>
                </div>
              )}
            </Show>
            <For each={visible()} fallback={<p class="keys-hint">{t("keys.empty")}</p>}>
              {(g) => (
                <section>
                  <Show when={query().trim()}>
                    <h3>{scopeLabel(g.scope)}</h3>
                  </Show>
                  <ul>
                    <For each={g.list}>{(a) => <Row a={a} />}</For>
                  </ul>
                </section>
              )}
            </For>
          </div>
        </div>
        <small class="field-hint keys-mouse">{t("keys.mouse")}</small>
        <div class="dialog-actions">
          <button class="btn" onClick={() => void confirmReset()}>
            {t("keys.resetAll")}
          </button>
          <button class="btn" onClick={() => fileInput.click()}>
            {t("keys.import")}
          </button>
          <button class="btn" onClick={exportFile}>
            {t("keys.export")}
          </button>
          <span class="spacer" />
          <button class="btn primary" onClick={close}>
            {t("lib.close")}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(ev) => {
              void importFile(ev.currentTarget.files?.[0]);
              ev.currentTarget.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}
