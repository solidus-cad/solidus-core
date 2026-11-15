/**
 * Opens the system colour picker near point (x, y); `onPick` receives the confirmed colour.
 * A single hidden field, reused: a picker closed without a choice leaves nothing behind.
 */
let input: HTMLInputElement | null = null;
let pending: ((color: string) => void) | null = null;

export function pickColor(x: number, y: number, initial: string, onPick: (color: string) => void): void {
  if (!input) {
    input = document.createElement("input");
    input.type = "color";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    // Rendered (not display: none): the browser places the picker next to the field.
    Object.assign(input.style, { position: "fixed", width: "1px", height: "1px", opacity: "0", pointerEvents: "none", border: "0", padding: "0" });
    input.addEventListener("change", () => {
      const cb = pending;
      pending = null;
      if (cb && input) cb(input.value);
    });
    document.body.appendChild(input);
  }
  input.style.left = `${x}px`;
  input.style.top = `${y}px`;
  input.value = initial;
  pending = onPick;
  try {
    input.showPicker();
  } catch {
    input.click();
  }
}
