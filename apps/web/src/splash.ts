import { SPLASH_MECHANISMS, mountSplashMechanism, type SplashMechanism, type SplashMechanismHandle } from "@solidus-cad/viewer";

/**
 * "Solidus" splash screen: the HTML (index.html) shows it from the first byte, with the animated logo; once the script runs,
 * a 3D mechanism (Geneva drive, excavator, escapement, Jansen walker, in turn from a random start) fades in under the logo.
 * Modules may add content to it (sponsors of the account module); it is removed once the application is ready.
 */

/** Logo animation duration: the screen stays at least this long (a click or a key press shortens it). */
const MIN_MS = 2400;
const FADE_MS = 350;

const el = (): HTMLElement | null => document.getElementById("splash");
const started = performance.now();

let mechanism: SplashMechanismHandle | null = null;

/**
 * Mechanism of this launch: the four in turn (index kept in localStorage), so that each one shows up; a pure random draw
 * could miss one for many launches. Random start the first time, random draw when storage is unavailable.
 */
function nextMechanism(): SplashMechanism {
  const n = SPLASH_MECHANISMS.length, key = "solidus.splash.next";
  try {
    const saved = Number(localStorage.getItem(key));
    const i = localStorage.getItem(key) !== null && Number.isInteger(saved) ? ((saved % n) + n) % n : Math.floor(Math.random() * n);
    localStorage.setItem(key, String((i + 1) % n));
    return SPLASH_MECHANISMS[i]!;
  } catch {
    return SPLASH_MECHANISMS[Math.floor(Math.random() * n)]!;
  }
}

/** Call first: the splash screen of the HTML stays until `endSplash`. `?splash=<mechanism>` forces the mechanism. */
export function startSplash(): void {
  const splash = el();
  if (!splash || navigator.webdriver) return;
  const host = document.createElement("div");
  host.className = "mech";
  const logo = splash.querySelector(".card > svg");
  if (!logo) return;
  logo.after(host);
  const forced = new URLSearchParams(location.search).get("splash") as SplashMechanism | null;
  const kind = forced && SPLASH_MECHANISMS.includes(forced) ? forced : nextMechanism();
  // same theme as the splash CSS: explicit data-theme, otherwise the system
  const t = document.documentElement.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const accent = getComputedStyle(splash).getPropertyValue("--a").trim() || "#2f6fd6";
  mechanism = mountSplashMechanism(host, kind, { dark, accent, still: matchMedia("(prefers-reduced-motion: reduce)").matches });
  requestAnimationFrame(() => host.classList.add("on"));
}

/** Removes the splash screen once the application is shown (and the animation finished, unless a click or key press). */
export function endSplash(): void {
  const splash = el();
  if (!splash) return;
  if (navigator.webdriver) return splash.remove(); // automated tests (Playwright): do not hide the interface
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    removeEventListener("keydown", close);
    splash.removeEventListener("pointerdown", close);
    splash.classList.add("done");
    setTimeout(() => {
      mechanism?.stop();
      mechanism = null;
      splash.remove();
    }, FADE_MS + 50);
  };
  addEventListener("keydown", close);
  splash.addEventListener("pointerdown", close);
  setTimeout(close, Math.max(0, MIN_MS - (performance.now() - started)));
}
