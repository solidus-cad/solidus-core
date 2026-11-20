import { createSignal } from "solid-js";
import { docFs } from "./fs.ts";
import { basename, samePath } from "./path.ts";
import { storedThumbnail } from "./thumbnail.ts";

/**
 * Recently opened or saved files (File › Open recent), kept in this browser / on this computer (localStorage).
 * Web: paths are relative to the project folder, whose name is kept with each entry.
 */
export interface RecentFile {
  path: string;
  /** Project folder (web) the path is relative to; null on the desktop. */
  root: string | null;
  name: string;
  /** Last opening or save, in ms. */
  when: number;
  /** JPEG thumbnail as data URL (parts and assemblies). */
  thumb?: string;
}

const KEY = "cad.recentFiles";
const MAX = 12;

function load(): RecentFile[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((e): e is RecentFile => typeof e?.path === "string" && typeof e?.name === "string") : [];
  } catch {
    return [];
  }
}

const [recent, setRecent] = createSignal<RecentFile[]>(load());
export { recent as recentFiles };

function store(list: RecentFile[]): void {
  setRecent(list);
  // Full storage: thumbnails dropped first, then the oldest entries.
  for (const l of [list, list.map(({ thumb: _, ...e }) => e), list.slice(0, 4).map(({ thumb: _, ...e }) => e)]) {
    try {
      localStorage.setItem(KEY, JSON.stringify(l));
      return;
    } catch {
      // next attempt
    }
  }
}

const same = (e: RecentFile, path: string, root: string | null) => e.root === root && samePath(e.path, path);

function toDataUrl(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(s)}`;
}

/** Puts the file of document `id` at the top of the list (after an opening or a save). */
export function touchRecent(path: string, id: string, name: string): void {
  const root = docFs.rootName();
  const old = recent().find((e) => same(e, path, root));
  const t = storedThumbnail(id);
  const entry: RecentFile = { path, root, name: name || basename(path), when: Date.now(), thumb: t ? toDataUrl(t) : old?.thumb };
  store([entry, ...recent().filter((e) => e !== old)].slice(0, MAX));
}

export function forgetRecent(e: RecentFile): void {
  store(recent().filter((x) => x !== e));
}
