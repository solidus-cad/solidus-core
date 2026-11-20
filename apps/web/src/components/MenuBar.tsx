import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { commandById, commands, menuItems, menus, runCommand } from "../commands.ts";
import { formatShortcuts } from "../keymap/keymap.ts";
import { t } from "../i18n.ts";
import { state } from "../store.ts";
import { isDirty, ws } from "../workspace.ts";
import { errorCount } from "../bugreport/bugreport.ts";
import { emit } from "../events.ts";
import { openBugReport } from "../bugreport/BugReportDialog.tsx";
import { activeMember } from "../keymap/scopes.ts";
import { actionById } from "../keymap/registry.ts";
import { Dynamic } from "solid-js/web";
import { contributions } from "../host.ts";
import { productName } from "../edition.ts";
import { titleBar } from "../desktop.ts";
import { useWindowFocus, WindowControls } from "./TitleBar.tsx";

/** Undo/redo of the active workbench (part, sketch, drawing, assembly…): common keymap actions. */
const HISTORY = [
  { id: "common.undo", icon: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>' },
  { id: "common.redo", icon: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>' },
];

const enabled = (id: string) => commandById.get(id)!.enabled?.() ?? true;

/** Menu entry of a command; `short`: submenu label ("STEP" under "Export as"). */
function CommandButton(props: { id: string; run: (id: string) => void; short?: boolean }) {
  const c = () => commandById.get(props.id)!;
  return (
    <button disabled={!enabled(props.id)} onClick={() => props.run(props.id)}>
      <span>{(props.short && c().menuLabel?.()) || c().label()}</span>
      <kbd>{formatShortcuts(props.id)}</kbd>
    </button>
  );
}

export function MenuBar(props: { searchRef: (el: HTMLInputElement) => void }) {
  /** Open menu: index in `menus`, or identifier of a menu contributed by a module. */
  const [open, setOpen] = createSignal<number | string | null>(null);
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  let root!: HTMLElement;
  const focused = titleBar ? useWindowFocus() : () => true;

  onMount(() => {
    const close = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) {
        setOpen(null);
        abandonSearch();
      }
    };
    window.addEventListener("pointerdown", close);
    onCleanup(() => window.removeEventListener("pointerdown", close));
  });

  const normalize = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const results = createMemo(() => {
    const q = normalize(query().trim());
    if (!q) return [];
    return commands().filter((c) => normalize(c.label()).includes(q)).slice(0, 10);
  });

  /** Search abandoned without choosing a command (non-empty query). */
  const abandonSearch = () => {
    if (query().trim()) emit({ type: "search", query: query().trim().slice(0, 60), results: results().length });
    setQuery("");
  };

  const run = (id: string) => {
    if (query().trim()) emit({ type: "search", query: query().trim().slice(0, 60), results: results().length, chosen: id });
    setOpen(null);
    setQuery("");
    runCommand(id);
  };

  return (
    // Desktop with the integrated title bar: the menu bar is the title bar of the window (TitleBar.tsx). Its empty
    // parts move the window ("deep": buttons and fields stay clickable); the menus and the search never do.
    <header
      class="menubar"
      classList={{ titlebar: !!titleBar, [`tb-${titleBar}`]: !!titleBar, "tb-inactive": !focused() }}
      ref={root}
      data-tauri-drag-region={titleBar ? "deep" : undefined}
    >
      <span class="brand">
        {productName()}
        <small class="brand-beta">beta</small>
      </span>
      <nav class="menus" data-tauri-drag-region="false">
        <For each={contributions("menuBarMenus")}>
          {(m) => (
            <Dynamic
              component={m.component}
              open={open() === m.id}
              toggle={() => setOpen(open() === m.id ? null : m.id)}
              hover={() => open() !== null && setOpen(m.id)}
              close={() => setOpen(null)}
            />
          )}
        </For>
        <For each={menus}>
          {(menu, i) => (
            <div class="menu">
              <button
                classList={{ active: open() === i() }}
                onClick={() => setOpen(open() === i() ? null : i())}
                onPointerEnter={() => open() !== null && setOpen(i())}
              >
                {t(menu.label)}
              </button>
              <Show when={open() === i()}>
                <ul class="menu-popup">
                  <For each={menuItems(menu)}>
                    {(entry) =>
                      entry === "-" ? (
                        <li class="sep" />
                      ) : typeof entry === "string" ? (
                        <li>
                          <CommandButton id={entry} run={run} />
                        </li>
                      ) : (
                        // Submenu: opens on hover or focus (keyboard, touch), to the right of the entry.
                        <li class="has-sub">
                          <button aria-haspopup="menu" disabled={!entry.items.some(enabled)}>
                            <span>{t(entry.label)}</span>
                            <span class="sub-arrow" aria-hidden="true">
                              ▸
                            </span>
                          </button>
                          <ul class="menu-popup submenu">
                            <For each={entry.items}>
                              {(id) => (
                                <li>
                                  <CommandButton id={id} run={run} short />
                                </li>
                              )}
                            </For>
                          </ul>
                        </li>
                      )
                    }
                  </For>
                </ul>
              </Show>
            </div>
          )}
        </For>
        <div class="menu">
          <button onClick={() => { setOpen(null); runCommand("settings.plugins"); }}>{t("cmd.pluginsMenu")}</button>
        </div>
      </nav>
      <div class="history-btns">
        <button
          class="icon-btn"
          title={[t("cmd.save"), formatShortcuts("file.save")].filter(Boolean).join("  ")}
          aria-label={t("cmd.save")}
          onClick={() => {
            setOpen(null);
            runCommand("file.save");
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 3h11l3 3v15H5z" />
            <path d="M8 3v6h8V3M8 21v-7h8v7" />
          </svg>
        </button>
        <For each={HISTORY}>
          {(h) => {
            const action = () => activeMember(h.id);
            const label = () => actionById(h.id)?.label() ?? "";
            return (
              <button
                class="icon-btn"
                disabled={!(action()?.enabled?.() ?? !!action())}
                title={[label(), formatShortcuts(h.id)].filter(Boolean).join("  ")}
                aria-label={label()}
                onClick={() => {
                  const a = action();
                  if (!a || !(a.enabled?.() ?? true)) return;
                  setOpen(null);
                  emit({ type: "command", id: a.id, label: a.label(), via: "ui" });
                  a.run();
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" innerHTML={h.icon} />
              </button>
            );
          }}
        </For>
      </div>
      <span class="doc-title">
        {ws.entries.find((e) => e.id === ws.activeId)?.name ?? state.doc.name}
        <Show when={isDirty(ws.activeId)}>
          <span class="dirty" title={t("ws.modified")}>
            •
          </span>
        </Show>
      </span>
      <div class="search" data-tauri-drag-region="false">
        <input
          ref={props.searchRef}
          type="search"
          placeholder={t("menu.search") + "  " + formatShortcuts("app.search")}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            const list = results();
            if (e.key === "ArrowDown") setHighlight((h) => Math.min(h + 1, list.length - 1));
            else if (e.key === "ArrowUp") setHighlight((h) => Math.max(h - 1, 0));
            else if (e.key === "Enter" && list[highlight()]) run(list[highlight()]!.id);
            else if (e.key === "Escape") {
              abandonSearch();
              e.currentTarget.blur();
            }
          }}
        />
        <Show when={results().length > 0}>
          <ul class="menu-popup search-results">
            <For each={results()}>
              {(c, i) => (
                <li>
                  <button classList={{ hl: i() === highlight() }} onClick={() => run(c.id)}>
                    <span>{c.label()}</span>
                    <kbd>{formatShortcuts(c.id)}</kbd>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <button
        class="bug-btn"
        classList={{ alert: errorCount() > 0 }}
        title={errorCount() > 0 ? t("bug.errors").replace("{n}", String(errorCount())) : t("bug.button")}
        aria-label={t("bug.button")}
        onClick={openBugReport}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0z" />
          <path d="M9.5 5.5 8 4M14.5 5.5 16 4M12 9v9M8 12H4M20 12h-4M8 16.5l-3 2M16 16.5l3 2M8 8.5 5 6.5M16 8.5l3-2" />
        </svg>
        <Show when={errorCount() > 0}>
          <span class="badge">{errorCount() > 9 ? "9+" : errorCount()}</span>
        </Show>
      </button>
      <Show when={titleBar && titleBar !== "macos"}>
        <WindowControls />
      </Show>
    </header>
  );
}
