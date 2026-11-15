import { createEffect, createRoot, on } from "solid-js";
import { emit } from "./events.ts";
import { state } from "./store.ts";
import { activeKind, ws } from "./workspace.ts";

/**
 * Global captures published on the event bus: errors, console, clicks, state changes.
 * Events tied to a specific action (command, feature validation, recompute, library)
 * are published where the action takes place.
 */

let installed = false;

const stackOf = (e: unknown): string | undefined => (e instanceof Error ? e.stack : undefined);
const textOf = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "string" ? e : safeJson(e));
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Readable label of the clicked element (never the content of an input field). */
function describeTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLCanvasElement) return "vue 3D";
  if (target.closest("svg.drawing-sheet, .drawing-sheet")) return "feuille de mise en plan";
  const el = target.closest("button, [role=tab], [role=menuitem], [role=treeitem], a, summary, label, select, input, li");
  if (!el) return null;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const label = el.getAttribute("aria-label") ?? el.closest("label")?.querySelector("span")?.textContent ?? el.name ?? el.type;
    return `champ « ${label?.trim()} »`;
  }
  const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!label) return null;
  // Context: dialog that contains the element.
  const box = el.closest("[role=dialog]")?.getAttribute("aria-label");
  return box ? `${label}  (${box})` : label;
}

const featureOf = (id: string) => {
  const f = state.doc.features.find((x) => x.id === id);
  return { featureType: f?.type ?? "?", name: f?.name ?? id };
};

/** Installs the global captures. Idempotent. */
export function installInstrumentation(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (e) =>
    emit({ type: "error", source: "error", message: e.message || textOf(e.error), stack: stackOf(e.error) ?? `${e.filename}:${e.lineno}:${e.colno}` }),
  );
  window.addEventListener("unhandledrejection", (e) => emit({ type: "error", source: "rejection", message: textOf(e.reason), stack: stackOf(e.reason) }));

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    emit({ type: "error", source: "console", message: args.map(textOf).join(" "), stack: args.map(stackOf).find(Boolean) });
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    emit({ type: "warn", message: args.map(textOf).join(" ") });
    origWarn(...args);
  };

  // Clicks: capture phase, to also see those whose propagation is stopped.
  const click = (button: "left" | "right") => (e: MouseEvent) => {
    const label = describeTarget(e.target);
    if (label) emit({ type: "ui.click", label, button });
  };
  window.addEventListener("click", click("left"), true);
  window.addEventListener("contextmenu", click("right"), true);

  createRoot(() => {
    createEffect(on(() => ws.activeId, () => emit({ type: "doc.activate", kind: activeKind(), name: ws.entries.find((e) => e.id === ws.activeId)?.name ?? state.doc.name })));
    createEffect(
      on(
        () => state.editing?.featureId,
        (id) => id && emit({ type: "feature.edit", ...featureOf(id), isNew: !!state.editing?.isNew }),
        { defer: true },
      ),
    );
    createEffect(on(() => state.message, (text) => text && emit({ type: "message", text }), { defer: true }));
    // Features failing after a recompute (only the new errors).
    let failing = new Map<string, string>();
    createEffect(() => {
      const now = new Map(Object.entries(state.statuses).filter((e): e is [string, string] => !!e[1]));
      for (const [id, error] of now) if (failing.get(id) !== error) emit({ type: "feature.fail", ...featureOf(id), error });
      failing = now;
    });
  });
}
