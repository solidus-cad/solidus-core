import { createSignal, For, Show } from "solid-js";
import { setMessage } from "../store.ts";
import { t, uiLang } from "../i18n.ts";
import { openDocument } from "../files.ts";
import { openFile } from "./documents.ts";
import { docFs } from "./fs.ts";
import { basename, dirname } from "./path.ts";
import { forgetRecent, recentFiles, type RecentFile } from "./recent.ts";

/** File › Open recent: cards with the thumbnail of the recent files. */
const [open, setOpen] = createSignal(false);
export const openRecentDialog = () => setOpen(true);

function ago(when: number): string {
  const s = (when - Date.now()) / 1000;
  const fmt = new Intl.RelativeTimeFormat(uiLang(), { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Infinity],
  ];
  let v = s;
  for (const [unit, n] of steps) {
    if (Math.abs(v) < n) return fmt.format(Math.round(v), unit);
    v /= n;
  }
  return "";
}

/** Web: entry from another project folder than the current one (its path does not resolve here). */
const elsewhere = (e: RecentFile) => docFs.kind !== "desktop" && docFs.rootName() !== null && e.root !== docFs.rootName();

export function RecentDialog() {
  const close = () => setOpen(false);
  const pick = async (e: RecentFile) => {
    if (elsewhere(e)) return;
    if (!(await docFs.ensureRoot())) return;
    if (docFs.kind !== "desktop" && e.root !== docFs.rootName()) return setMessage(t("recent.otherFolder").replace("{name}", e.root ?? ""));
    if (!(await docFs.exists(e.path))) {
      forgetRecent(e);
      return setMessage(t("recent.missing").replace("{name}", basename(e.path)));
    }
    close();
    await openFile(e.path);
  };
  return (
    <Show when={open()}>
      <div class="dialog-backdrop" onClick={close}>
        <div
          class="dialog wide recent-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recent-title"
          onClick={(ev) => ev.stopPropagation()}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === "Escape") close();
          }}
          tabIndex={-1}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <h2 id="recent-title">{t("recent.title")}</h2>
          <Show when={recentFiles().length} fallback={<p>{t("recent.empty")}</p>}>
            <ul class="recent-grid">
              <For each={recentFiles()}>
                {(e) => (
                  <li class="recent-card" classList={{ disabled: elsewhere(e) }}>
                    <button class="recent-open" disabled={elsewhere(e)} title={e.path} onClick={() => void pick(e)}>
                      <span class="recent-thumb">
                        <Show when={e.thumb} fallback={<span class="recent-ext">{e.path.slice(e.path.lastIndexOf(".") + 1)}</span>}>
                          <img src={e.thumb} alt="" draggable={false} />
                        </Show>
                      </span>
                      <span class="recent-name">{e.name}</span>
                      <span class="recent-meta">
                        {elsewhere(e) ? t("recent.otherFolder").replace("{name}", e.root ?? "") : (dirname(e.path) || e.root || "") + " · " + ago(e.when)}
                      </span>
                    </button>
                    <button class="recent-remove" title={t("recent.remove")} aria-label={t("recent.remove")} onClick={() => forgetRecent(e)}>
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <div class="dialog-actions">
            <button
              class="btn"
              onClick={() => {
                close();
                void openDocument();
              }}
            >
              {t("recent.browse")}
            </button>
            <button class="btn primary" onClick={close}>
              {t("plg.close")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
