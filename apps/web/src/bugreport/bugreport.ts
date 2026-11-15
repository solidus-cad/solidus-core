import { createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import type { I18nText } from "@solidus-cad/sdk";
import { lang } from "../i18n.ts";
import { runtimeConfig } from "../desktop.ts";
import { onEvent } from "../events.ts";
import { state } from "../store.ts";
import { activeKind, ws } from "../workspace.ts";
import { describeEvent, formatTimeline, Journal, persistJournal, type JournalEvent } from "./journal.ts";

/** Application log: subscribed to the event bus as soon as `installBugReporting` runs. */
export const journal = new Journal();

/** Number of errors since the last report, reactive (button badge). */
const [errorCount, setErrorCount] = createSignal(0);
export { errorCount };
journal.onChange(() => setErrorCount(journal.errorsSinceReport));

/** Extra actions of the report dialog (provided by extensions, e.g. sending to support). */
export interface BugReportAction {
  id: string;
  label: I18nText;
  run(report: BugReport): Promise<void>;
}
const [reportActions, setReportActions] = createSignal<BugReportAction[]>([]);
export { reportActions };
export const addBugReportAction = (a: BugReportAction) => setReportActions((l) => [...l.filter((x) => x.id !== a.id), a]);

let previous: JournalEvent[] = [];
let installed = false;

/** Subscribes the log to the bus and retrieves the previous session. Idempotent. */
export function installBugReporting(): void {
  if (installed) return;
  installed = true;
  try {
    previous = persistJournal(journal, localStorage).previous;
  } catch {
    /* storage unavailable: no previous session */
  }
  onEvent((e) => {
    const line = describeEvent(e);
    if (line) journal.record(line.kind, line.text, line.detail);
  });
}

const activeName = () => ws.entries.find((e) => e.id === ws.activeId)?.name ?? state.doc.name;
const featureLabel = (id: string) => {
  const f = state.doc.features.find((x) => x.id === id);
  return f ? `« ${f.name} » (${f.type})` : id;
};

// --- Rapport ------------------------------------------------------------------------------------

export interface BugReport {
  format: "cad.bugreport";
  formatVersion: 1;
  createdAt: string;
  description: string;
  app: { version: string; desktop: boolean; mode: string; lang: string };
  env: { userAgent: string; platform: string; screen: string; viewport: string; devicePixelRatio: number; webgl: string | null };
  context: {
    activeDocument: string;
    activeKind: string;
    openDocuments: { name: string; kind: string }[];
    kernel: string;
    editing: string | null;
    features: { name: string; type: string; suppressed?: boolean; error?: string }[];
    lastMessage: string;
  };
  events: JournalEvent[];
  previousSession?: JournalEvent[];
  /** Active part (document.json), if the user attached it. */
  document?: unknown;
}

function webglRenderer(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return null;
  }
}

export const hasPreviousSession = () => previous.length > 0;

export function buildReport(opts: { description: string; includeDocument: boolean; includePrevious: boolean }): BugReport {
  const report: BugReport = {
    format: "cad.bugreport",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    description: opts.description.trim(),
    app: { version: runtimeConfig.desktop?.version ?? "web", desktop: !!runtimeConfig.desktop, mode: import.meta.env.MODE, lang: lang() },
    env: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      screen: `${screen.width}×${screen.height}`,
      viewport: `${innerWidth}×${innerHeight}`,
      devicePixelRatio,
      webgl: webglRenderer(),
    },
    context: {
      activeDocument: activeName(),
      activeKind: activeKind(),
      openDocuments: ws.entries.map((e) => ({ name: e.name, kind: e.kind })),
      kernel: state.kernel,
      editing: state.editing ? featureLabel(state.editing.featureId) : null,
      features: state.doc.features.map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.suppressed ? { suppressed: true } : {}),
        ...(state.statuses[f.id] ? { error: state.statuses[f.id]! } : {}),
      })),
      lastMessage: state.message,
    },
    events: journal.events.map((e) => ({ ...e })),
  };
  if (opts.includePrevious && previous.length) report.previousSession = previous;
  if (opts.includeDocument) report.document = JSON.parse(JSON.stringify(unwrap(state.doc)));
  return report;
}

/** Plain-text version of the report (clipboard, email, ticket). */
export function reportToText(r: BugReport): string {
  const lines = [
    `# Rapport de bug — ${r.createdAt}`,
    "",
    r.description || "(pas de description)",
    "",
    `Version : ${r.app.version}${r.app.desktop ? " (bureau)" : ""} · ${r.app.mode} · ${r.app.lang}`,
    `Navigateur : ${r.env.userAgent}`,
    `Écran : ${r.env.screen} (fenêtre ${r.env.viewport}, ×${r.env.devicePixelRatio}) · GPU : ${r.env.webgl ?? "?"}`,
    "",
    `Document actif : ${r.context.activeDocument} (${r.context.activeKind}) · noyau : ${r.context.kernel}${r.context.editing ? ` · édition : ${r.context.editing}` : ""}`,
    `Fonctions : ${r.context.features.map((f) => f.name + (f.error ? ` [ERREUR : ${f.error}]` : f.suppressed ? " [supprimée]" : "")).join(", ") || "aucune"}`,
    "",
    "## Chronologie",
    formatTimeline(r.events),
  ];
  if (r.previousSession) lines.push("", "## Session précédente", formatTimeline(r.previousSession));
  return lines.join("\n");
}
