import type { AppExtension, AppExtensionContext } from "@solidus-cad/sdk";
import extensions from "virtual:cad-extensions";
import { lang, tx } from "./i18n.ts";
import { runtimeConfig } from "./desktop.ts";
import { emit, onEvent } from "./events.ts";
import { addMenuCommand } from "./commands.ts";
import { ask } from "./components/Dialog.tsx";
import { addBugReportAction } from "./bugreport/bugreport.ts";
import { libraryAccess } from "./host.ts";
import { readUserFile, writeUserFile } from "./userdata.ts";
import { licenseProvider } from "./license.ts";

/**
 * Application extensions, selected at build time (`CAD_EXTENSIONS`, see vite.config.ts). The open source build
 * contains none; the official builds add their modules.
 */

const version = runtimeConfig.desktop?.version ?? "web";

function contextFor(ext: AppExtension): AppExtensionContext {
  return {
    app: { version, desktop: !!runtimeConfig.desktop, lang },
    onEvent: (listener) => onEvent(listener, { replay: true }),
    library: {
      get url() {
        return libraryAccess()?.url ?? "";
      },
      accessToken: () => libraryAccess()?.accessToken() ?? null,
    },
    license: licenseProvider,
    settings: { read: readUserFile, write: writeUserFile },
    ui: {
      ask,
      addMenuCommand: (c) => addMenuCommand(c.menu === "help" ? "menu.help" : "menu.settings", { id: `${ext.id}.${c.id}`, label: () => tx(c.label), run: c.run }),
      addBugReportAction: (a) => addBugReportAction({ id: `${ext.id}.${a.id}`, label: a.label, run: a.run }),
    },
  };
}

/** Activates the extensions without waiting for them to finish: a slow or failing extension does not block the application. */
export function activateExtensions(list: readonly AppExtension[] = extensions): void {
  for (const ext of list) {
    try {
      void Promise.resolve(ext.activate(contextFor(ext))).catch((e: unknown) => reportFailure(ext, e));
    } catch (e) {
      reportFailure(ext, e);
    }
  }
}

function reportFailure(ext: AppExtension, e: unknown): void {
  emit({ type: "error", source: "error", message: `Extension ${ext.id} : ${e instanceof Error ? e.message : String(e)}`, stack: e instanceof Error ? e.stack : undefined });
}

/** Announces the startup (after activation: the extensions receive this event). */
export function emitStart(): void {
  emit({ type: "app.start", version, desktop: !!runtimeConfig.desktop, lang: lang() });
}
