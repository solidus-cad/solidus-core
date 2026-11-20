import { createEffect, createRoot, createSignal } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import { catalogSource } from "../plugins/settings.ts";
import { openContextMenu } from "./ContextMenu.tsx";

/**
 * Colour marks on the ribbon: right-click on a tab or a tool button to highlight it (tinted background)
 * or outline it (coloured lines). Kept per machine in localStorage, across restarts.
 * Reserved to signed-in accounts (account module of the official builds): signed out, the marks are hidden and the
 * menu offers to sign in. Without an account module (open-core build), there is no account and the marks are free.
 *
 * Applied by attributes (`data-mark`, `--mark`) set on the rendered buttons: the ribbon components are not
 * involved, a MutationObserver re-applies the marks when a workbench redraws its buttons.
 */

export type MarkStyle = "fill" | "line";
interface Mark {
  color: string;
  style: MarkStyle;
}

const KEY = "cad.ribbonMarks";

/** Signed-in account, or no account module at all (reactive). */
const allowed = (): boolean => {
  const src = catalogSource();
  return !src || src.signedIn();
};

export const MARK_COLORS: { color: string; name: TKey }[] = [
  { color: "#e5484d", name: "mark.red" },
  { color: "#f76b15", name: "mark.orange" },
  { color: "#ffc53d", name: "mark.yellow" },
  { color: "#30a46c", name: "mark.green" },
  { color: "#0090ff", name: "mark.blue" },
  { color: "#8e4ec6", name: "mark.violet" },
];

function load(): Record<string, Mark> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Mark>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const [marks, setMarks] = createSignal<Record<string, Mark>>(load());
export { marks };

function save(next: Record<string, Mark>): void {
  setMarks(next);
  try {
    if (Object.keys(next).length) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the mark lasts for the session */
  }
  applyAll();
}

export function setMark(key: string, mark: Mark | null): void {
  const next = { ...marks() };
  if (mark) next[key] = mark;
  else delete next[key];
  save(next);
}

/** Short stable hash (icon markup of the buttons that carry no identifier). */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const TARGETS = ".ribbon-tabs [role=tab], .ribbon-btn";

/** Language-independent identifier of a tab or a button: tab id, command, sketch action, otherwise its icon. */
export function markKey(el: Element): string | null {
  const d = (el as HTMLElement).dataset;
  if (el.getAttribute("role") === "tab") return d.tab ? `tab:${d.tab}` : null;
  if (d.cmd) return `cmd:${d.cmd}`;
  if (d.action) return `act:${d.action}`;
  const icon = el.querySelector(".icon")?.innerHTML;
  return icon ? `icon:${hash(icon)}` : null;
}

function apply(el: HTMLElement): void {
  const key = markKey(el);
  const m = key && allowed() ? marks()[key] : undefined;
  if (m) {
    if (el.dataset.mark !== m.style) el.dataset.mark = m.style;
    if (el.style.getPropertyValue("--mark") !== m.color) el.style.setProperty("--mark", m.color);
  } else if (el.dataset.mark) {
    delete el.dataset.mark;
    el.style.removeProperty("--mark");
  }
}

let root: Element | null = null;

function applyAll(): void {
  root?.querySelectorAll<HTMLElement>(TARGETS).forEach(apply);
}

function onContextMenu(ev: MouseEvent): void {
  const el = (ev.target as Element | null)?.closest?.(TARGETS);
  if (!el || !root?.contains(el)) return;
  const key = markKey(el);
  if (!key) return;
  if (!allowed()) {
    const src = catalogSource()!;
    openContextMenu(ev, [{ label: t("mark.signIn"), run: () => src.signIn(applyAll) }]);
    return;
  }
  const cur = marks()[key];
  const row = (style: MarkStyle) => ({
    label: t(style === "fill" ? "mark.fill" : "mark.line"),
    run: () => setMark(key, { color: cur?.color ?? MARK_COLORS[0].color, style }),
    swatches: MARK_COLORS.map((c) => ({
      color: c.color,
      title: t(c.name),
      active: cur?.style === style && cur.color === c.color,
      run: () => setMark(key, { color: c.color, style }),
    })),
  });
  openContextMenu(ev, [row("fill"), row("line"), ...(cur ? [{ label: t("mark.clear"), run: () => setMark(key, null) }] : [])]);
}

/** Watches the ribbon (called once it is mounted). */
export function installRibbonMarks(el: Element): () => void {
  root = el;
  applyAll();
  // Workbench switch, new buttons: the redrawn elements take their mark back.
  const obs = new MutationObserver(applyAll);
  obs.observe(el, { childList: true, subtree: true });
  // Sign-in / sign-out: the marks appear or disappear.
  const stop = createRoot((dispose) => {
    createEffect(() => {
      allowed();
      applyAll();
    });
    return dispose;
  });
  el.addEventListener("contextmenu", onContextMenu as EventListener);
  return () => {
    obs.disconnect();
    stop();
    el.removeEventListener("contextmenu", onContextMenu as EventListener);
    if (root === el) root = null;
  };
}
