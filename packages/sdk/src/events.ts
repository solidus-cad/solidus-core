import type { I18nText } from "./bench.ts";
import type { LicenseProvider } from "./license.ts";

/**
 * Application events: what happens in the interface and the kernel, in a structured form.
 *
 * The core publishes them without knowing who listens; it does not send anything over the network itself. Known subscribers:
 * the bug report log (local), and the extensions (`AppExtension`). No event contains the
 * content of a document or typed text, except `search`, which carries the query typed in the search field.
 */
export type AppEvent =
  | { type: "app.start"; version: string; desktop: boolean; lang: string }
  /** Kernel loaded (`ms`: time since startup) or failed. */
  | { type: "kernel.ready"; ms: number }
  | { type: "kernel.error"; message: string }
  /** Command run from a menu, the ribbon, the search (`via: "ui"`) or a shortcut (`via: "key"`). */
  | { type: "command"; id: string; label: string; via: "ui" | "key"; combo?: string }
  /** Feature search: query, number of results, chosen command (absent if abandoned). */
  | { type: "search"; query: string; results: number; chosen?: string }
  /** Click on a UI element (visible label, never the content of a field). */
  | { type: "ui.click"; label: string; button: "left" | "right" }
  | { type: "doc.activate"; kind: string; name: string }
  /** Feature opened for editing; `feature.end` on its confirmation or cancellation. */
  | { type: "feature.edit"; featureType: string; name: string; isNew: boolean }
  | { type: "feature.end"; featureType: string; name: string; outcome: "confirm" | "cancel" }
  /** Feature failing on recompute (new error only). */
  | { type: "feature.fail"; featureType: string; name: string; error: string }
  /** Recompute of the active part finished. */
  | { type: "recompute"; ms: number; features: number; failed: number }
  | { type: "undo" }
  | { type: "redo" }
  /** Status bar message. */
  | { type: "message"; text: string }
  | { type: "warn"; message: string }
  | { type: "error"; message: string; stack?: string; source: "error" | "rejection" | "console" }
  /** Request to the library server (path without parameters). */
  | { type: "library.request"; method: string; path: string; status: number; ms: number }
  | { type: "library.search"; query: string; kind?: string; category?: string; hits: number }
  /** Library component used: inserted into an assembly, opened, or picked for a replacement. */
  | { type: "library.use"; familyId: string; configurationId: string; kind: string; target: "assembly" | "open" | "pick" };

export type AppEventType = AppEvent["type"];

/** Timestamped event, as received by the subscribers. */
export type StampedEvent = AppEvent & { t: number };

/**
 * Application extension: module loaded at startup, with the application's rights (no sandbox).
 * Reserved for the builds that include it (`CAD_EXTENSIONS` at build time, see apps/web/vite.config.ts);
 * third-party plugins go through `definePlugin`.
 */
export interface AppExtension {
  /** Identifier in reverse DNS notation. */
  id: string;
  activate(ctx: AppExtensionContext): void | Promise<void>;
}

export interface AppExtensionContext {
  app: { version: string; desktop: boolean; lang: () => "fr" | "en" };
  /** Subscribes to events (the last startup events are replayed); returns the unsubscribe function. */
  onEvent(listener: (e: StampedEvent) => void): () => void;
  /** Configured library server, and the token of the signed-in user. */
  library: { url: string; accessToken: () => string | null };
  /** User's license rights: a paid module requests its rights here, never directly from a server. */
  license: LicenseProvider;
  /** User settings files (desktop user folder, or browser storage). */
  settings: { read(name: string): Promise<string | null>; write(name: string, text: string): Promise<void> };
  ui: {
    /** Choice dialog; returns the button identifier (`dismiss` if closed otherwise). */
    ask(title: string, text: string, buttons: { id: string; label: string; primary?: boolean }[], dismiss: string): Promise<string>;
    /** Adds a command to a menu (and to the feature search). */
    addMenuCommand(cmd: { id: string; menu: "settings" | "help"; label: I18nText; run(): void }): void;
    /** Additional action of the bug report dialog (e.g. sending to support), which receives the JSON report. */
    addBugReportAction(action: { id: string; label: I18nText; run(report: unknown): Promise<void> }): void;
  };
}

/** Typing helper for an extension. */
export const defineExtension = (e: AppExtension): AppExtension => e;
