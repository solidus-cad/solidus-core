import { readUserFile, writeUserFile } from "../userdata.ts";
import { loadState, parseShortcutsFile, serializeShortcuts, setSaver } from "./keymap.ts";

/** Device shortcut file (chosen profile + overrides), in the user data. */
export const SHORTCUTS_FILE = "shortcuts.json";

/**
 * Loads `shortcuts.json` at startup, writes it on each change and syncs the other
 * tabs. Returns the stop function.
 */
export function initKeymapPersistence(): () => void {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("cad.shortcuts") : null;
  let disposed = false;
  /** Modified before loading finished: the file read (older) must not overwrite it. */
  let touched = false;
  // Serialized writes: the last change is always the one left on disk.
  let writing: Promise<void> = Promise.resolve();

  const reload = async (): Promise<void> => {
    const text = await readUserFile(SHORTCUTS_FILE);
    if (disposed || touched) return;
    const { preset, overrides } = parseShortcutsFile(text);
    loadState(preset, overrides);
  };

  setSaver(() => {
    touched = true;
    const text = serializeShortcuts();
    writing = writing.then(() => writeUserFile(SHORTCUTS_FILE, text)).then(() => channel?.postMessage("saved"));
  });

  const onMessage = () => {
    touched = false; // another tab wrote a more recent version
    void reload();
  };
  channel?.addEventListener("message", onMessage);
  void reload();

  return () => {
    disposed = true;
    setSaver(() => {});
    channel?.removeEventListener("message", onMessage);
    channel?.close();
  };
}
