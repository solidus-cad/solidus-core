import { createSignal } from "solid-js";
import { strFromU8, unzipSync } from "fflate";
import type { TKey } from "../i18n.ts";
import { t } from "../i18n.ts";
import { setMessage } from "../store.ts";
import { ws } from "../workspace.ts";
import { openFile } from "./documents.ts";
import { docFile, dropMemoryFiles, forgetDocFile, putMemoryFile } from "./fs.ts";
import { isSafeEntry, join } from "./path.ts";

/**
 * Example assemblies, opened in one click from the tips pane and the end of the guided tour.
 * Each one is a pack (File › Pack & Export zip) served with the application in `public/examples/`.
 * It is read in memory, without a project folder: only the assembly gets a tab, its parts are loaded with it and
 * open on their own from the assembly tree. Once open, the documents are detached from the example's files: they
 * behave like new documents, and the first save asks where to write them (parts alongside the assembly).
 */

export interface Example {
  id: string;
  /** Pack, relative to the site root. */
  pack: string;
  /** Card (tips pane, end of the guided tour): title and thumbnail. Without it, the example opens only from a deep link. */
  card?: { title: TKey; thumb: string };
}

export const EXAMPLES: Example[] = [
  { id: "cardan", pack: "examples/cardan-double.zip", card: { title: "ex.cardan", thumb: "examples/cardan-double.webp" } },
  { id: "press", pack: "examples/presse-excentrique.zip", card: { title: "ex.press", thumb: "examples/presse-excentrique.webp" } },
  { id: "geneva", pack: "examples/croix-de-malte.zip", card: { title: "ex.geneva", thumb: "examples/croix-de-malte.webp" } },
  // Excavator arm, English part names: deep link only (README of solidus-core, film on the site).
  { id: "excavator", pack: "examples/excavator-arm.zip" },
];

/**
 * Deep link: `?exemple=pelleteuse` or `?example=excavator` opens that example at startup (French or English name,
 * or the file name of its pack). The parameter is then removed from the address: a reload does not open it again.
 */
const DEEP_LINK_PARAMS = ["exemple", "example"];
const ALIASES: Record<string, string> = {
  "cardan-double": "cardan",
  presse: "press",
  "presse-excentrique": "press",
  "croix-de-malte": "geneva",
  pelleteuse: "excavator",
  "bras-de-pelleteuse": "excavator",
  "excavator-arm": "excavator",
};

export function exampleByName(name: string): Example | undefined {
  const n = name.trim().toLowerCase();
  const id = ALIASES[n] ?? n;
  return EXAMPLES.find((e) => e.id === id);
}

export async function openExampleFromUrl(): Promise<void> {
  const url = new URL(location.href);
  const name = DEEP_LINK_PARAMS.map((k) => url.searchParams.get(k)).find((v) => v);
  if (!name) return;
  for (const k of DEEP_LINK_PARAMS) url.searchParams.delete(k);
  history.replaceState(history.state, "", url);
  const ex = exampleByName(name);
  if (ex) await openExample(ex);
}

export const exampleUrl = (path: string): string => `${import.meta.env.BASE_URL}${path}`;

/** Example being opened (button disabled meanwhile). */
const [busy, setBusy] = createSignal<string | null>(null);
export { busy as exampleBusy };

let seq = 0;

export async function openExample(ex: Example): Promise<string | null> {
  if (busy()) return null;
  setBusy(ex.id);
  // Paths that no project folder can contain: never confused with the user's files.
  const base = `§examples/${ex.id}-${++seq}`;
  try {
    const res = await fetch(exampleUrl(ex.pack));
    if (!res.ok) throw new Error(String(res.status));
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(zip["pack.json"]!)) as { format: string; root: string };
    if (manifest.format !== "cad.pack" || !zip[manifest.root]) throw new Error("pack");
    for (const [p, data] of Object.entries(zip)) if (p !== "pack.json" && isSafeEntry(p)) putMemoryFile(join(base, p), data);
    const id = await openFile(join(base, manifest.root));
    // Detached from the example's files: a save asks where to write, nothing points into memory any more.
    for (const e of ws.entries) if (docFile(e.id)?.startsWith(base)) forgetDocFile(e.id);
    if (!id) setMessage(t("ex.error"));
    return id;
  } catch {
    setMessage(t("ex.error"));
    return null;
  } finally {
    dropMemoryFiles(base);
    setBusy(null);
  }
}
