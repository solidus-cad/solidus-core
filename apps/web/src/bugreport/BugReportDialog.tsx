import { createSignal, For, Show } from "solid-js";
import { strToU8 } from "fflate";
import { t, tx, type TKey } from "../i18n.ts";
import { saveBlob } from "../files.ts";
import { buildReport, hasPreviousSession, journal, reportActions, reportToText, type BugReportAction } from "./bugreport.ts";
import { formatTime, type JournalEvent } from "./journal.ts";

const [open, setOpen] = createSignal(false);
const [description, setDescription] = createSignal("");
const [includeDocument, setIncludeDocument] = createSignal(true);
const [includePrevious, setIncludePrevious] = createSignal(true);
const [events, setEvents] = createSignal<JournalEvent[]>([]);
const [copied, setCopied] = createSignal(false);
const [actionError, setActionError] = createSignal("");
const [running, setRunning] = createSignal(false);

export function openBugReport(): void {
  // Snapshot: the log keeps advancing while the dialog is open (clicks inside the dialog).
  setEvents(journal.events.map((e) => ({ ...e })));
  setCopied(false);
  setActionError("");
  setOpen(true);
}

const report = () => {
  const r = buildReport({ description: description(), includeDocument: includeDocument(), includePrevious: includePrevious() });
  r.events = events();
  return r;
};

const finish = () => {
  journal.markReported();
  setDescription("");
  setOpen(false);
};

/** Bug report: description, timeline of recent actions, JSON or text export. */
export function BugReportDialog() {
  const close = () => setOpen(false);
  const download = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      await saveBlob(strToU8(JSON.stringify(report(), null, 2)), `rapport-bug-${stamp}.json`, "application/json", ".json");
      finish();
    } catch {
      /* cancelled */
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportToText(report()));
      setCopied(true);
      journal.markReported();
    } catch {
      setCopied(false);
    }
  };
  /** Action from an extension (e.g. sending to support): the dialog closes if it succeeds. */
  const runAction = async (a: BugReportAction) => {
    setRunning(true);
    setActionError("");
    try {
      await a.run(report());
      finish();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <Show when={open()}>
      <div class="dialog-backdrop" onClick={close}>
        <div
          class="dialog wide bug-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t("bug.title")}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
          }}
        >
          <h2>{t("bug.title")}</h2>
          <label class="field">
            <span>{t("bug.description")}</span>
            <textarea rows={4} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} placeholder={t("bug.placeholder")} autofocus />
          </label>
          <div class="bug-timeline-head">
            <span>{t("bug.timeline")}</span>
            <span class="muted">{t("bug.count").replace("{n}", String(events().length))}</span>
          </div>
          <ol class="bug-timeline" ref={(el) => queueMicrotask(() => (el.scrollTop = el.scrollHeight))}>
            <For each={events()} fallback={<li class="muted">{t("bug.empty")}</li>}>
              {(e) => (
                <li class={`k-${e.kind}`} title={e.detail}>
                  <time>{formatTime(e.t)}</time>
                  <span class="tag">{t(`bug.kind.${e.kind}` as TKey)}</span>
                  <span class="txt">{e.text}</span>
                </li>
              )}
            </For>
          </ol>
          <label class="check">
            <input type="checkbox" checked={includeDocument()} onChange={(e) => setIncludeDocument(e.currentTarget.checked)} />
            {t("bug.includeDoc")}
          </label>
          <Show when={hasPreviousSession()}>
            <label class="check">
              <input type="checkbox" checked={includePrevious()} onChange={(e) => setIncludePrevious(e.currentTarget.checked)} />
              {t("bug.includePrev")}
            </label>
          </Show>
          <p class="bug-privacy">{t("bug.privacy")}</p>
          <Show when={actionError()}>
            <p class="field-error">{actionError()}</p>
          </Show>
          <div class="dialog-actions">
            <button class="btn" onClick={close}>
              {t("prop.cancel")}
            </button>
            <button class="btn" onClick={() => void copy()}>
              {copied() ? t("bug.copied") : t("bug.copy")}
            </button>
            <button class="btn" classList={{ primary: reportActions().length === 0 }} onClick={() => void download()}>
              {t("bug.download")}
            </button>
            <For each={reportActions()}>
              {(a) => (
                <button class="btn primary" disabled={running()} onClick={() => void runAction(a)}>
                  {tx(a.label)}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
