import { setMessage } from "../store.ts";
import { t } from "../i18n.ts";
import { isDesktop } from "../desktop.ts";
import { openFile } from "./documents.ts";
import { basename } from "./path.ts";

/**
 * Desktop: documents opened from the file manager (double-click, "Open with Solidus"). The application passes them on
 * its command line (file associations of apps/desktop/src-tauri/tauri.conf.json): `window.__CAD_OPEN__` for the
 * window that starts, and `window.__cadOpenFiles([...])` when Solidus is already running (single instance,
 * windows.rs `forward`). Paths are absolute, with forward slashes, like those of the file dialogs.
 */
type LaunchWindow = { __CAD_OPEN__?: string[]; __cadOpenFiles?: (paths: string[]) => void };

async function openAll(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      if (!(await openFile(path))) setMessage(`${t("status.openError")} : ${basename(path)}`);
    } catch {
      setMessage(`${t("status.openError")} : ${basename(path)}`);
    }
  }
}

/** Called once the interface is rendered (main.tsx). */
export function installLaunchFiles(): void {
  if (!isDesktop) return;
  const w = globalThis as LaunchWindow;
  const pending = w.__CAD_OPEN__ ?? [];
  delete w.__CAD_OPEN__;
  w.__cadOpenFiles = (paths) => void openAll(paths);
  if (pending.length) void openAll(pending);
}
