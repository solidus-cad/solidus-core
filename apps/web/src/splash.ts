/**
 * "Solidus" splash screen: the HTML (index.html) shows it from the first byte, with the animated logo.
 * Modules may add content to it (sponsors of the account module); it is removed once the application is ready.
 */

/** Logo animation duration: the screen stays at least this long (a click or a key press shortens it). */
const MIN_MS = 2400;
const FADE_MS = 350;

const el = (): HTMLElement | null => document.getElementById("splash");
const started = performance.now();

/** Call first: the splash screen of the HTML stays until `endSplash`. */
export function startSplash(): void {
  void started;
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
    setTimeout(() => splash.remove(), FADE_MS + 50);
  };
  addEventListener("keydown", close);
  splash.addEventListener("pointerdown", close);
  setTimeout(close, Math.max(0, MIN_MS - (performance.now() - started)));
}
