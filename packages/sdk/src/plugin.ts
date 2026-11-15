import type { I18nText, ParamSpec } from "./bench.ts";
import type { Feature, PartDocument } from "./document.ts";
import type { GeometryRecipe } from "./geometry.ts";

/**
 * Public API of plugins.
 *
 * A plugin is a `.vplug` package (zip): a `plugin.json` manifest and an ES module whose default export is
 * the result of `definePlugin`. The same code runs in both application hosts:
 * - **trusted** (verified publisher, reviewed package): module loaded into the application, direct calls;
 * - **sandbox** (unverified publisher): module loaded into a dedicated Web Worker, calls over RPC.
 * All the context methods are therefore asynchronous, and the exchanged data is serializable (structured clone).
 */

/** Plugin API version. A plugin declaring another one is not loaded. */
export const PLUGIN_SDK_VERSION = 1;

/**
 * Permissions requested by a plugin, approved by the user at installation.
 * `network:<domain>` allows requests to this domain (and its subdomains) via `ctx.fetch`.
 */
export type PluginPermission = "document.read" | "document.write" | "library" | `network:${string}`;

/** Document kinds on which a plugin tab is displayed. */
export type PluginDocKind = "part" | "assembly" | "drawing" | "cam" | "quote";

export interface PluginManifest {
  /** Unique identifier in reverse DNS notation ("com.publisher.gears"). */
  id: string;
  name: I18nText;
  /** Semver version ("1.2.0"). */
  version: string;
  description?: I18nText;
  /** Targeted plugin API version (PLUGIN_SDK_VERSION). */
  sdkVersion: number;
  /** Minimum application version (semver), optional. */
  minAppVersion?: string;
  /** Path of the ES module in the package ("index.js"). */
  entry: string;
  permissions: PluginPermission[];
}

export interface PluginCommand {
  /** Identifier local to the plugin; the application prefixes it with the plugin identifier. */
  id: string;
  label: I18nText;
  /** SVG content (24×24, stroke `currentColor`). */
  icon: string;
  run(): void | Promise<void>;
}

export interface PluginTab {
  /** Identifier local to the plugin. */
  id: string;
  label: I18nText;
  /** Documents on which the tab is displayed (default: part). */
  docKinds?: PluginDocKind[];
  /** Button groups: local identifiers of commands registered by the plugin. */
  groups: { label?: I18nText; commands: string[]; stacked?: boolean }[];
}

/**
 * Parametric feature of a plugin: parameters shown in the properties panel (lengths, angles, numbers,
 * lists), and construction of the geometric recipe (see geometry.ts) from their evaluated values.
 */
export interface PluginFeature {
  /** Identifier local to the plugin; the type stored in parts is "<plugin>/<type>". */
  type: string;
  label: I18nText;
  /** SVG content (24×24, stroke `currentColor`). */
  icon: string;
  params: Extract<ParamSpec, { kind: "length" | "angle" | "number" | "enum" }>[];
  /**
   * Recipe of the feature: numbers in mm or degrees, lists by their value. Called at each recompute where the
   * parameters changed; must be deterministic (same values → same recipe).
   */
  build(values: Record<string, number | string>): GeometryRecipe | Promise<GeometryRecipe>;
}

/** Plugin form field (rendered by the application components). */
export type FormField =
  | { key: string; label: I18nText; kind: "number" | "length" | "angle"; default?: number; min?: number; max?: number }
  | { key: string; label: I18nText; kind: "text"; default?: string }
  | { key: string; label: I18nText; kind: "enum"; options: { value: string; label: I18nText }[]; default?: string }
  | { key: string; label: I18nText; kind: "boolean"; default?: boolean };

export type FormValues = Record<string, number | string | boolean>;

/** Response to a plugin network request (text or binary body). */
export interface PluginResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}

/** What a plugin can do in the application. */
export interface PluginContext {
  readonly manifest: PluginManifest;
  /** UI language. */
  lang(): Promise<"fr" | "en">;
  commands: {
    register(command: PluginCommand): Promise<void>;
  };
  tabs: {
    register(tab: PluginTab): Promise<void>;
  };
  features: {
    /** Declares a parametric feature (`document.write` permission to create it with `document.beginFeature`). */
    define(feature: PluginFeature): Promise<void>;
  };
  document: {
    /** Kind of the active document. */
    kind(): Promise<PluginDocKind>;
    /** Active part (`document.read` permission), null if the active document is not a part. */
    part(): Promise<PartDocument | null>;
    /** Opens the feature creation panel: internal ("box") or declared by the plugin (`document.write` permission). */
    beginFeature(type: string): Promise<void>;
    /** Adds a feature at the end of the tree, with a history entry (`document.write` permission). */
    addFeature(feature: Omit<Feature, "id">): Promise<string>;
  };
  ui: {
    notify(text: string): Promise<void>;
    /** Modal form; null if the user cancels. */
    form(title: string, fields: FormField[]): Promise<FormValues | null>;
  };
  /** Key → value storage private to the plugin (preferences). */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** HTTP request to a domain declared in the permissions (`network:<domain>`). */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; binary?: boolean }): Promise<PluginResponse>;
}

export interface Plugin {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Declares a plugin (default export of the module). */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PERMISSIONS = new Set(["document.read", "document.write", "library"]);
const DOMAIN_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const isText = (v: unknown): v is I18nText =>
  !!v && typeof v === "object" && typeof (v as I18nText).fr === "string" && typeof (v as I18nText).en === "string";

/** Validates a manifest; returns the list of errors (empty if valid). */
export function validateManifest(m: unknown): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== "object") return ["manifest absent ou invalide"];
  const x = m as Record<string, unknown>;
  if (typeof x.id !== "string" || !ID_RE.test(x.id)) errors.push("id : notation DNS inversée attendue (« com.editeur.nom »)");
  if (!isText(x.name)) errors.push("name : { fr, en } attendu");
  if (typeof x.version !== "string" || !SEMVER_RE.test(x.version)) errors.push("version : semver attendu (« 1.0.0 »)");
  if (x.description !== undefined && !isText(x.description)) errors.push("description : { fr, en } attendu");
  if (x.sdkVersion !== PLUGIN_SDK_VERSION) errors.push(`sdkVersion : ${PLUGIN_SDK_VERSION} attendu`);
  if (x.minAppVersion !== undefined && (typeof x.minAppVersion !== "string" || !SEMVER_RE.test(x.minAppVersion))) errors.push("minAppVersion : semver attendu");
  if (typeof x.entry !== "string" || !/^[\w./-]+\.m?js$/.test(x.entry) || x.entry.includes("..")) errors.push("entry : chemin d'un module .js dans le paquet attendu");
  if (!Array.isArray(x.permissions)) errors.push("permissions : tableau attendu");
  else
    for (const p of x.permissions) {
      const ok = typeof p === "string" && (PERMISSIONS.has(p) || (p.startsWith("network:") && DOMAIN_RE.test(p.slice(8))));
      if (!ok) errors.push(`permission inconnue : ${String(p)}`);
    }
  return errors;
}

/** Compares two semver versions (without the pre-release part): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Is the domain of `url` allowed by the plugin's `network:` permissions? (HTTPS only) */
export function networkAllowed(permissions: readonly string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return permissions.some((p) => {
    if (!p.startsWith("network:")) return false;
    const d = p.slice(8);
    return d.startsWith("*.") ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d;
  });
}
