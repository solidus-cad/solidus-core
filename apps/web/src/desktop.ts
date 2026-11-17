
/**
 * Integration with the desktop application (apps/desktop, Tauri).
 *
 * At startup, the desktop app reads `cad.config.toml` (root of the install folder) and injects it before the
 * page loads into `window.__CAD_CONFIG__`. In the browser the object is absent: each setting
 * falls back to its web value (VITE_* variables, browser language…).
 */

export interface RuntimeConfig {
  /** Present only in the desktop application. */
  desktop?: { version: string; /** Computer name (shown to other machines that share the licence). */ hostname?: string };
  library?: { url?: string; id?: string; retries?: number; /** Authentication service (GoTrue). */ authUrl?: string };
  ui?: { language?: "auto" | "fr" | "en" | "zh" | "ja" | "pt" | "de" | "es" | "it" | "pl" | "ru" | "ar" | "ko" | "tr" | "zh-TW" | "cs" };
  updates?: { enabled?: boolean; checkOnStartup?: boolean };
}

type TauriWindow = {
  __CAD_CONFIG__?: RuntimeConfig;
  /** Desktop: label of the window ("main", then "w-2", "w-3"… for Window › New window). */
  __CAD_WINDOW__?: string;
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<unknown> };
};

const w = globalThis as TauriWindow;

export const runtimeConfig: RuntimeConfig = w.__CAD_CONFIG__ ?? {};
export const isDesktop = runtimeConfig.desktop !== undefined;

/** URL parameter of the additional windows opened in the browser. */
const WINDOW_PARAM = "window";

/**
 * Additional window (View › New window), as opposed to the main window. Each window has its own documents;
 * only the main one keeps the autosave of the active part (a single slot shared by all the windows of the origin),
 * so that a new window starts empty and two windows never overwrite each other's recovery.
 */
export const isSecondaryWindow: boolean = (() => {
  if (w.__CAD_WINDOW__) return w.__CAD_WINDOW__ !== "main";
  try {
    return new URLSearchParams(location.search).has(WINDOW_PARAM);
  } catch {
    return false;
  }
})();

/** Opens another application window, to be placed on another screen (desktop: native window with its own kernel). */
export function openNewWindow(): void {
  if (isDesktop) {
    invokeDesktop("window_new").catch((e) => console.warn("nouvelle fenêtre :", e));
    return;
  }
  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.set(WINDOW_PARAM, String(Date.now()));
  window.open(url.href, "_blank", "popup,noopener");
}

/** Opens a web page outside the application: default browser (desktop, see links.rs), otherwise a new tab. */
export function openExternal(url: string): void {
  if (isDesktop) {
    invokeDesktop("open_external", { url }).catch((e) => console.warn("lien externe :", e));
    return;
  }
  window.open(url, "_blank", "noopener");
}

// Desktop: the webview opens no window of its own, and must never navigate away from the application. `window.open`
// and the links to another origin (customer area, payment, licence texts…) go to the default browser.
if (isDesktop && typeof window !== "undefined") {
  const nativeOpen = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string): Window | null => {
    if (url === undefined || String(url) === "") return null;
    const href = new URL(String(url), location.href);
    if (href.origin === location.origin) return nativeOpen(url, target, features);
    openExternal(href.href);
    return null;
  };
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!a || e.defaultPrevented || a.hasAttribute("download")) return;
    if (!/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
    e.preventDefault();
    openExternal(a.href);
  });
}

/** Calls a command of the desktop backend (rejects outside the desktop app). Binary `args`: raw body, parameters in headers. */
export function invokeDesktop<T = unknown>(cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }): Promise<T> {
  const tauri = w.__TAURI_INTERNALS__;
  return tauri ? (tauri.invoke(cmd, args, options) as Promise<T>) : Promise.reject(new Error("desktop only"));
}
