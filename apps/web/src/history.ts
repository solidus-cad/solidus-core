import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";

/**
 * Undo history of a document. That of an inactive document is compressed (`packed`):
 * hundreds of full snapshots of the document weigh tens of MB as JS objects, a few hundred KB when compressed.
 */
export interface History<T> {
  past: T[];
  future: T[];
  packed?: Uint8Array;
}

/** Compresses the history (nothing to do if it is empty or already compressed). */
export function packHistory<T>(h: History<T>): void {
  if (h.packed || (h.past.length === 0 && h.future.length === 0)) return;
  // Level 1: fast (tab switching), and the JSON already compresses very well.
  h.packed = deflateSync(strToU8(JSON.stringify({ past: h.past, future: h.future })), { level: 1 });
  h.past = [];
  h.future = [];
}

/** Decompresses the history before use; returns the same object. */
export function unpackHistory<T>(h: History<T>): History<T> {
  if (h.packed) {
    const v = JSON.parse(strFromU8(inflateSync(h.packed))) as { past: T[]; future: T[] };
    h.past = v.past;
    h.future = v.future;
    delete h.packed;
  }
  return h;
}

/** Runs `fn` when the browser is idle (after the activated tab has rendered). */
export function whenIdle(fn: () => void): void {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 2000 });
  else setTimeout(fn, 200);
}
