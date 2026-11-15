import { createSignal } from "solid-js";
import type { TitleBlock, TitleBlockTemplate } from "@solidus-cad/sdk";
import { readUserFile, writeUserFile } from "./userdata.ts";

/**
 * User profile, shared by all of the user's documents and kept on the device (see userdata.ts):
 * name (asked at first startup), title block settings reused by new drawings, template library.
 */

/** Title block settings kept from one drawing to the next. */
export type TitleBlockDefaults = Partial<Pick<TitleBlock, "company" | "logo" | "logoAspect" | "template" | "generalTolerance">>;

export interface Profile {
  userName: string;
  titleBlock: TitleBlockDefaults;
  /** Title block template library. */
  templates: TitleBlockTemplate[];
}

const FILE = "profile.json";
/** Legacy locations (localStorage) of the template library, imported once then removed. */
const LEGACY_TEMPLATES = "cad.drawing.templates";
const LEGACY_DEFAULT = "cad.drawing.defaultTemplate";

const EMPTY: Profile = { userName: "", titleBlock: {}, templates: [] };

function parse(text: string | null): Profile {
  try {
    const raw = JSON.parse(text ?? "{}") as Partial<Profile>;
    return {
      userName: typeof raw.userName === "string" ? raw.userName : "",
      titleBlock: raw.titleBlock && typeof raw.titleBlock === "object" ? raw.titleBlock : {},
      templates: Array.isArray(raw.templates) ? raw.templates.filter((x) => Array.isArray(x?.cells)) : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

const [profile, setProfile] = createSignal<Profile>({ ...EMPTY });
export { profile };
export const userName = (): string => profile().userName;

/** Other tabs reload the profile when one of them saves it. */
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("cad.profile") : null;
channel?.addEventListener("message", () => void readUserFile(FILE).then((t) => setProfile(parse(t))));

function takeLegacy(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) localStorage.removeItem(key);
    return v;
  } catch {
    return null;
  }
}

/** Loaded at startup, importing the browser's former template library. */
export const profileReady: Promise<void> = (async () => {
  const p = parse(await readUserFile(FILE));
  setProfile(p);
  const legacy = takeLegacy(LEGACY_TEMPLATES);
  const legacyDefault = takeLegacy(LEGACY_DEFAULT);
  if (legacy === null) return;
  try {
    const old = (JSON.parse(legacy) as TitleBlockTemplate[]).filter((x) => Array.isArray(x?.cells) && !p.templates.some((s) => s.name === x.name));
    const def = old.find((x) => x.name === legacyDefault);
    await save({ ...p, templates: [...p.templates, ...old], titleBlock: p.titleBlock.template || !def ? p.titleBlock : { ...p.titleBlock, template: def } });
  } catch {
    /* former library unreadable: ignored */
  }
})();

// Serialized writes: the last change is always the one left on disk.
let writing: Promise<void> = Promise.resolve();

function save(p: Profile): Promise<void> {
  setProfile(p);
  const text = JSON.stringify({ format: "cad.profile", formatVersion: 1, ...p }, null, 2);
  writing = writing.then(() => writeUserFile(FILE, text)).then(() => channel?.postMessage("saved"));
  return writing;
}

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function setUserName(name: string): Promise<void> {
  return save({ ...profile(), userName: name.trim() });
}

/** Remembers title block settings (an empty or absent value clears the setting). */
export function rememberTitleBlock(patch: TitleBlockDefaults): Promise<void> {
  const tb: Record<string, unknown> = { ...profile().titleBlock };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "") delete tb[k];
    else tb[k] = copy(v);
  }
  return save({ ...profile(), titleBlock: tb as TitleBlockDefaults });
}

export function saveTemplate(tpl: TitleBlockTemplate): Promise<void> {
  const templates = [...profile().templates.filter((x) => x.name !== tpl.name), copy(tpl)];
  return save({ ...profile(), templates });
}

export function deleteTemplate(name: string): Promise<void> {
  return save({ ...profile(), templates: profile().templates.filter((x) => x.name !== name) });
}
