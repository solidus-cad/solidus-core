import { createSignal } from "solid-js";

/**
 * Product name and read-only state. The core is always "Solidus" and editable; a module (editions of the official
 * builds) may rename the product and make the application read-only (no license after a trial…).
 */

const [productName, setProductName] = createSignal("Solidus");
/** Product name (menu bar, dialogs). */
export { productName, setProductName };

let source: () => boolean = () => false;
let notify: () => void = () => undefined;

/** Plugged by a module: read-only state (reactive) and explanation shown when an edit is refused. */
export function setReadOnlySource(isReadOnly: () => boolean, onRefused: () => void): void {
  source = isReadOnly;
  notify = onRefused;
}

/** Read-only application (reactive). */
export const readOnly = (): boolean => source();

/**
 * Guard of the edit entry points (history commits, feature editing, saving): true, and the reason is shown, when the
 * application is read-only; the caller then does nothing.
 */
export function editBlocked(): boolean {
  if (!source()) return false;
  notify();
  return true;
}
