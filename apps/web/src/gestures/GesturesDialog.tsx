import { createMemo, createSignal, For, Show } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import { ask } from "../components/Dialog.tsx";
import { actionById, actionsOfScope, SCOPES } from "../keymap/registry.ts";
import { scopeLabel } from "../keymap/ShortcutsDialog.tsx";
import { activeContext } from "../keymap/scopes.ts";
import {
  actionsForContext,
  CARDINALS,
  GESTURE_CONTEXTS,
  gestureCount,
  gesturesEnabled,
  isCustomized,
  resetContext,
  resetGestures,
  setGestureCount,
  setGesturesEnabled,
  setSlot,
  slotsFor,
  toGestureContext,
  type GestureContext,
} from "./gestures.ts";

const [open, setOpen] = createSignal(false);

/** Opens the gesture menu settings, on the active workspace. */
export function openGesturesDialog(): void {
  setOpen(true);
}

const CONTEXT_LABEL: Record<GestureContext, TKey> = {
  part: "keys.scope.part",
  sketch: "keys.scope.sketch",
  sketch3d: "keys.scope.sketch3d",
  assembly: "keys.scope.assembly",
  frame: "keys.scope.frame",
  analysis: "keys.scope.analysis",
  drawing: "keys.scope.drawing",
  cam: "keys.scope.cam",
  quote: "keys.scope.quote",
};

/** Slot → cell of the 3×3 grid (row, column), the center remaining free. */
const CELL: [number, number][] = [
  [1, 2],
  [1, 3],
  [2, 3],
  [3, 3],
  [3, 2],
  [3, 1],
  [2, 1],
  [1, 1],
];
const DIRECTION: TKey[] = [
  "gest.n",
  "gest.ne",
  "gest.e",
  "gest.se",
  "gest.s",
  "gest.sw",
  "gest.w",
  "gest.nw",
];

export function GesturesDialog() {
  return (
    <Show when={open()}>
      <GesturesDialogBody />
    </Show>
  );
}

function GesturesDialogBody() {
  const [ctx, setCtx] = createSignal<GestureContext>(
    toGestureContext(activeContext()),
  );
  const close = () => setOpen(false);

  /** Offered commands, grouped by workspace (scope). */
  const groups = createMemo(() => {
    const list = actionsForContext(ctx());
    return SCOPES.map((s) => ({
      scope: s,
      list: list.filter((a) => a.scope === s),
    })).filter((g) => g.list.length);
  });
  const slots = () =>
    gestureCount() === 4 ? CARDINALS : [0, 1, 2, 3, 4, 5, 6, 7];

  async function confirmReset(): Promise<void> {
    const choice = await ask(
      t("gest.resetAll"),
      t("gest.resetAllConfirm"),
      [{ id: "reset", label: t("gest.resetAll"), primary: true }],
      "cancel",
    );
    if (choice === "reset") resetGestures();
  }

  return (
    <div class="dialog-backdrop" onClick={close}>
      <div
        class="dialog keys-dialog gest-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("gest.title")}
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === "Escape") close();
        }}
      >
        <div class="keys-head">
          <h2>{t("gest.title")}</h2>
          <label class="gest-check">
            <input
              type="checkbox"
              checked={gesturesEnabled()}
              onChange={(ev) => setGesturesEnabled(ev.currentTarget.checked)}
            />
            <span>{t("gest.enable")}</span>
          </label>
          <label class="keys-preset">
            <span>{t("gest.count")}</span>
            <select
              value={gestureCount()}
              disabled={!gesturesEnabled()}
              onChange={(ev) =>
                setGestureCount(ev.currentTarget.value === "4" ? 4 : 8)
              }
            >
              <option value="4">4</option>
              <option value="8">8</option>
            </select>
          </label>
        </div>
        <div class="keys-main">
          <nav class="keys-scopes">
            {/* Workspaces present in this build (those of absent modules have no action). */}
            <For each={GESTURE_CONTEXTS.filter((c) => actionsOfScope(c).length > 0)}>
              {(c) => (
                <button
                  classList={{ active: ctx() === c }}
                  onClick={() => setCtx(c)}
                >
                  {t(CONTEXT_LABEL[c])}
                  <Show when={isCustomized(c)}> •</Show>
                </button>
              )}
            </For>
          </nav>
          <div class="keys-list">
            <p class="keys-hint">{t("gest.hint")}</p>
            <div class="gest-grid" classList={{ off: !gesturesEnabled() }}>
              <div
                class="gest-center"
                style={{ "grid-row": 2, "grid-column": 2 }}
              >
                {t(CONTEXT_LABEL[ctx()])}
              </div>
              <For each={slots()}>
                {(slot) => {
                  /** Command of the slot ("" if empty or unknown). */
                  const current = () => {
                    const id = slotsFor(ctx())[slot] ?? "";
                    return actionById(id) ? id : "";
                  };
                  // Option marked `selected` (and not the select's `value`): the option list changes with the workspace.
                  return (
                    <label
                      class="gest-cell"
                      style={{
                        "grid-row": CELL[slot]![0],
                        "grid-column": CELL[slot]![1],
                      }}
                    >
                      <small>{t(DIRECTION[slot]!)}</small>
                      <span class="gest-pick">
                        <span
                          class="icon"
                          innerHTML={actionById(current())?.icon ?? ""}
                        />
                        <select
                          onChange={(ev) =>
                            setSlot(ctx(), slot, ev.currentTarget.value)
                          }
                        >
                          <option value="" selected={!current()}>
                            {t("gest.empty")}
                          </option>
                          <For each={groups()}>
                            {(g) => (
                              <optgroup label={scopeLabel(g.scope)}>
                                <For each={g.list}>
                                  {(a) => (
                                    <option
                                      value={a.id}
                                      selected={current() === a.id}
                                    >
                                      {a.label()}
                                    </option>
                                  )}
                                </For>
                              </optgroup>
                            )}
                          </For>
                        </select>
                      </span>
                    </label>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
        <small class="field-hint keys-mouse">{t("gest.mouse")}</small>
        <div class="dialog-actions">
          <button class="btn" onClick={() => void confirmReset()}>
            {t("gest.resetAll")}
          </button>
          <button
            class="btn"
            disabled={!isCustomized(ctx())}
            onClick={() => resetContext(ctx())}
          >
            {t("gest.resetContext")}
          </button>
          <span class="spacer" />
          <button class="btn primary" onClick={close}>
            {t("lib.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
