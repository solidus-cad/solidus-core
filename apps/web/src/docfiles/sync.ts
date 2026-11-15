import { docFs } from "./fs.ts";
import { normalize } from "./path.ts";

/**
 * Several windows (desktop windows, browser tabs on the same project folder) share the document files: when
 * one writes a document, it says so to the others, which reload it if they have it open (documents.ts).
 * Snapshot mode (browsers without File System Access): a save is a download, there is nothing to share.
 */

interface FileWritten {
  type: "written";
  path: string;
  /** Project folder (web): two tabs on different folders do not share their relative paths. */
  root: string | null;
}

const channel = docFs.kind !== "snapshot" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("cad.files") : null;
const listeners = new Set<(path: string) => void>();

channel?.addEventListener("message", (e: MessageEvent<FileWritten>) => {
  const m = e.data;
  if (m?.type !== "written" || typeof m.path !== "string" || m.root !== docFs.rootName()) return;
  for (const fn of listeners) fn(m.path);
});

/** A document file has just been written by this window. */
export function announceWrite(path: string): void {
  channel?.postMessage({ type: "written", path: normalize(path), root: docFs.rootName() } satisfies FileWritten);
}

/** Called for each file written by another window; returns the unsubscription. */
export function onFileWritten(fn: (path: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
