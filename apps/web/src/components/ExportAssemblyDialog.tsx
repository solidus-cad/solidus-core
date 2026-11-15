import { createSignal, Show } from "solid-js";
import { t } from "../i18n.ts";
import { exportAssemblyAs } from "../files.ts";

type Format = "step" | "stl" | "obj" | "3mf";

const [format, setFormat] = createSignal<Format | null>(null);
/** Remembered from one export to the next. */
const [visibleOnly, setVisibleOnly] = createSignal(true);

/** Asks which parts of the assembly to export. */
export function openAssemblyExport(f: Format): void {
  setFormat(f);
}

export function ExportAssemblyDialog() {
  const close = () => setFormat(null);
  return (
    <Show when={format()}>
      {(f) => (
        <div class="dialog-backdrop" onClick={close}>
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
            }}
          >
            <h2>{t("asm.exportTitle").replace("{f}", f().toUpperCase())}</h2>
            <label class="field">
              <input type="checkbox" checked={visibleOnly()} onChange={(e) => setVisibleOnly(e.currentTarget.checked)} />
              <span>{t("asm.exportVisibleOnly")}</span>
            </label>
            <div class="dialog-actions">
              <button class="btn" onClick={close}>
                {t("ws.cancel")}
              </button>
              <button
                class="btn primary"
                ref={(el) => queueMicrotask(() => el.focus())}
                onClick={() => {
                  // Read before closing: the accessor of <Show> is stale once unmounted.
                  const chosen = f();
                  close();
                  void exportAssemblyAs(chosen, visibleOnly());
                }}
              >
                {t("asm.exportDo")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
