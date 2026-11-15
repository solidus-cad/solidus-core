/**
 * Activity log: rolling memory of the latest events (commands, clicks, shortcuts,
 * state changes, errors) to trace what led to a bug. No typed text
 * is recorded: only UI element labels and action identifiers.
 *
 * The log is copied (with a short delay) to local storage: after a crash followed by a
 * reload, the previous session remains available for the report.
 */

import type { StampedEvent } from "@solidus-cad/sdk";

export type JournalKind = "command" | "key" | "click" | "state" | "message" | "warn" | "error";

export interface JournalEvent {
  /** Timestamp (ms since the Unix epoch). */
  t: number;
  kind: JournalKind;
  text: string;
  /** Optional detail (call stack of an error…). */
  detail?: string;
}

export const MAX_EVENTS = 300;
const MAX_TEXT = 300;
const MAX_DETAIL = 2000;
const CURRENT_KEY = "cad.journal";
const PREVIOUS_KEY = "cad.journal.prev";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export class Journal {
  readonly events: JournalEvent[] = [];
  /** Errors recorded since the last report (button badge). */
  errorsSinceReport = 0;
  private listeners = new Set<() => void>();

  constructor(
    readonly max = MAX_EVENTS,
    private now: () => number = Date.now,
  ) {}

  record(kind: JournalKind, text: string, detail?: string): void {
    const last = this.events[this.events.length - 1];
    // Immediate repeats (same error in a loop, same click): a single event, counted.
    if (last && last.kind === kind && (last.text === text || last.text.startsWith(text + " ×"))) {
      const n = Number(/ ×(\d+)$/.exec(last.text)?.[1] ?? 1) + 1;
      last.text = text + " ×" + n;
      last.t = this.now();
    } else {
      const e: JournalEvent = { t: this.now(), kind, text: clip(text, MAX_TEXT) };
      if (detail) e.detail = clip(detail, MAX_DETAIL);
      this.events.push(e);
      if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    }
    if (kind === "error") this.errorsSinceReport++;
    for (const l of this.listeners) l();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  markReported(): void {
    this.errorsSinceReport = 0;
    for (const l of this.listeners) l();
  }
}

/** Minimal storage (localStorage or a test substitute). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parseEvents(raw: string | null): JournalEvent[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v.filter((e) => e && typeof e.t === "number" && typeof e.text === "string") as JournalEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * At startup: the log of the previous session (the one in progress) becomes "previous",
 * then the current log is copied to it on each change (at most once per `delayMs`).
 */
export function persistJournal(journal: Journal, store: KeyValueStore, delayMs = 1000): { previous: JournalEvent[] } {
  let previous: JournalEvent[] = [];
  try {
    previous = parseEvents(store.getItem(CURRENT_KEY));
    if (previous.length) store.setItem(PREVIOUS_KEY, JSON.stringify(previous));
    else previous = parseEvents(store.getItem(PREVIOUS_KEY));
    store.setItem(CURRENT_KEY, "[]");
  } catch {
    /* stockage indisponible */
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    try {
      store.setItem(CURRENT_KEY, JSON.stringify(journal.events));
    } catch {
      /* storage full or unavailable */
    }
  };
  journal.onChange(() => {
    // An error is written immediately: the crash that follows could prevent the deferred write.
    if (journal.events[journal.events.length - 1]?.kind === "error") flush();
    else timer ??= setTimeout(flush, delayMs);
  });
  return { previous };
}

/**
 * Log line for an application event; null for those that do not help trace a bug
 * (successful recalculations, successful requests) or that contain typed text (feature search).
 */
export function describeEvent(e: StampedEvent): { kind: JournalKind; text: string; detail?: string } | null {
  switch (e.type) {
    case "app.start":
      return { kind: "state", text: `Démarrage — version ${e.version}${e.desktop ? " (bureau)" : ""}, ${e.lang}` };
    case "kernel.ready":
      return { kind: "state", text: `Noyau prêt (${Math.round(e.ms)} ms)` };
    case "kernel.error":
      return { kind: "error", text: `Noyau en échec : ${e.message}` };
    case "command":
      return e.via === "key" ? { kind: "key", text: `${e.combo} → ${e.label} [${e.id}]` } : { kind: "command", text: `${e.label} [${e.id}]` };
    case "ui.click":
      return { kind: "click", text: e.button === "right" ? "clic droit : " + e.label : e.label };
    case "doc.activate":
      return { kind: "state", text: `Document actif : ${e.name} (${e.kind})` };
    case "feature.edit":
      return { kind: "state", text: `Édition de « ${e.name} » (${e.featureType})${e.isNew ? " (nouvelle)" : ""}` };
    case "feature.end":
      return { kind: "state", text: `${e.outcome === "confirm" ? "Validation" : "Annulation"} de « ${e.name} » (${e.featureType})` };
    case "feature.fail":
      return { kind: "warn", text: `Échec de « ${e.name} » (${e.featureType}) : ${e.error}` };
    case "message":
      return e.text ? { kind: "message", text: e.text } : null;
    case "warn":
      return { kind: "warn", text: e.message };
    case "error":
      return { kind: "error", text: e.source === "rejection" ? "Promesse rejetée : " + e.message : e.message, detail: e.stack };
    case "library.request":
      return e.status >= 400 || e.status === 0 ? { kind: "warn", text: `Bibliothèque : ${e.method} ${e.path} → ${e.status || "réseau"} (${Math.round(e.ms)} ms)` } : null;
    case "library.search":
      return { kind: "state", text: `Bibliothèque : recherche (${e.hits} résultat(s))` };
    case "library.use":
      return { kind: "state", text: `Bibliothèque : ${e.familyId} / ${e.configurationId} (${e.target})` };
    default:
      return null; // search, recompute, undo, redo
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const formatTime = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const TAGS: Record<JournalKind, string> = {
  command: "CMD",
  key: "KEY",
  click: "CLIC",
  state: "ÉTAT",
  message: "MSG",
  warn: "WARN",
  error: "ERR",
};

/** Readable timeline, one line per event (indented details). */
export function formatTimeline(events: readonly JournalEvent[]): string {
  return events
    .map((e) => {
      const line = `${formatTime(e.t)}  ${TAGS[e.kind].padEnd(4)}  ${e.text}`;
      return e.detail ? line + "\n" + e.detail.replace(/^/gm, "      ") : line;
    })
    .join("\n");
}
