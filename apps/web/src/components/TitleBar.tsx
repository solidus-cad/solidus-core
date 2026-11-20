import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { invokeDesktop, titleBar } from "../desktop.ts";
import { t } from "../i18n.ts";

/**
 * Window buttons of the integrated title bar (desktop, Windows and Linux; macOS keeps its native traffic lights).
 * The window has no system frame (apps/desktop/src-tauri/src/windows.rs): the menu bar is dragged by its empty
 * parts (`data-tauri-drag-region="deep"`, double click maximizes) and these buttons call the window commands.
 * Windows 11: the snap-layout plugin lays a native zone over `#titlebar-maximize`, which shows the Snap Layouts on
 * hover and maximizes on click itself (the hover style then comes from its `.is-hovered` class).
 */
export function WindowControls() {
  const [maximized, setMaximized] = createSignal(false);
  const win = (cmd: string) => invokeDesktop(`plugin:window|${cmd}`);

  onMount(() => {
    const refresh = () => void win("is_maximized").then((m) => setMaximized(m === true), () => {});
    refresh();
    window.addEventListener("resize", refresh);
    onCleanup(() => window.removeEventListener("resize", refresh));
  });

  return (
    <div class="window-controls" classList={{ [`wc-${titleBar}`]: true }}>
      <button class="wc-btn" title={t("win.minimize")} aria-label={t("win.minimize")} onClick={() => void win("minimize")}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" />
        </svg>
      </button>
      <button id="titlebar-maximize" class="wc-btn" title={maximized() ? t("win.restore") : t("win.maximize")} aria-label={maximized() ? t("win.restore") : t("win.maximize")} onClick={() => void win("toggle_maximize")}>
        <Show
          when={maximized()}
          fallback={
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <rect x=".5" y=".5" width="9" height="9" />
            </svg>
          }
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x=".5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5V.5h7v7h-2" />
          </svg>
        </Show>
      </button>
      <button class="wc-btn wc-close" title={t("win.close")} aria-label={t("win.close")} onClick={() => void win("close")}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="m0 0 10 10M10 0 0 10" />
        </svg>
      </button>
    </div>
  );
}

/** Dimmed title bar while the window is in the background, as the system ones. */
export function useWindowFocus(): () => boolean {
  const [focused, setFocused] = createSignal(document.hasFocus());
  onMount(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    onCleanup(() => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    });
  });
  return focused;
}
