import { createSignal, For, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../i18n.ts";
import { contributions } from "../host.ts";
import { getViewer, state } from "../store.ts";
import { activeKind, ws } from "../workspace.ts";
import { fmtArea, fmtLen, fmtVol, toggleLengthUnit, unitLabel } from "../units.ts";

const n = (v: number, digits = 2) => v.toLocaleString(undefined, { maximumFractionDigits: digits });

export function StatusBar() {
  const errors = () => Object.values(state.statuses).filter(Boolean).length;
  // Render cost (large assemblies): sampled periodically, the view does not publish an event per frame.
  const [render, setRender] = createSignal(getViewer()?.renderStats() ?? null);
  const timer = setInterval(() => activeKind() === "assembly" && setRender(getViewer()?.renderStats() ?? null), 1000);
  onCleanup(() => clearInterval(timer));
  const kernelLabel = () =>
    ({ loading: t("status.loading"), ready: t("status.ready"), busy: t("status.busy"), error: "⚠" })[state.kernel];

  return (
    <footer class="statusbar">
      <span class={`kernel ${state.kernel}`}>
        <span class="dot" />
        {kernelLabel()}
        <Show when={state.kernel === "ready" && state.lastMs > 0}>
          <span class="muted"> · {n(state.lastMs, 0)} ms</span>
        </Show>
      </span>
      <Show when={errors() > 0}>
        <span class="error-count">
          {errors()} {t("status.errors")}
        </span>
      </Show>
      <span class="message">{state.message}</span>
      <span class="spacer" />
      <Show when={state.selection.length > 0} fallback={<Show when={state.hover}>{(h) => <span>{t("status.face")} {h().index + 1}</span>}</Show>}>
        <span>
          {state.selection.length} {t("status.face").toLowerCase()} {t("status.selected")}
        </span>
      </Show>
      <Show when={activeKind() === "part" && state.mass}>
        {(m) => (
          <>
            <span>
              {t("status.volume")} {fmtVol(m().volume)}
            </span>
            <Show when={state.doc.material}>
              {(mat) => (
                <span title={mat().name}>
                  {t("status.mass")} {n((m().volume / 1000) * mat().density / 1000, 3)} kg
                </span>
              )}
            </Show>
            <span>
              {t("status.area")} {fmtArea(m().area)}
            </span>
            <span>
              {t("status.cog")} ({m().center.map((c) => fmtLen(c, { digits: 1, locale: true, fractions: false })).join("; ")})
            </span>
          </>
        )}
      </Show>
      <Show when={activeKind() === "assembly" && ws.asm}>
        <span>
          {ws.asm!.components.length} {t("asm.occurrences")}
          {ws.selection.length > 0 ? ` · ${ws.selection.length} ${t("status.selected")}` : ""}
        </span>
      </Show>
      <Show when={activeKind() === "assembly" && render()}>
        {(r) => (
          <span class="muted" title={`${t("status.renderTip")} ${r().alone}`}>
            {r().calls} {t("status.drawCalls")} · {n(r().triangles / 1000, 1)} k {t("status.triangles")}
          </span>
        )}
      </Show>
      <For each={contributions("statusFlags")}>{(f) => <Dynamic component={f.component} />}</For>
      <button type="button" class="units" title={t("units.toggleTip")} onClick={toggleLengthUnit}>
        {unitLabel()}
      </button>
    </footer>
  );
}
