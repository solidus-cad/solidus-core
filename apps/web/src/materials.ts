import { createSignal } from "solid-js";
import { MATERIALS, type Material } from "@solidus-cad/sdk";
import { readUserFile, writeUserFile } from "./userdata.ts";

/** User-defined materials: shared by all of the user's documents, stored on the device. */
const FILE = "materials.json";
/** Legacy location (localStorage), imported once then removed. */
const LEGACY_KEY = "cad.materials";

function parse(text: string | null): Material[] {
  try {
    const raw = JSON.parse(text ?? "[]") as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { materials?: unknown })?.materials;
    return Array.isArray(list) ? list.filter((m): m is Material => typeof m?.name === "string" && typeof m?.density === "number") : [];
  } catch {
    return [];
  }
}

const [custom, setCustom] = createSignal<Material[]>([]);
export const customMaterials = custom;

/** Other tabs reload the database when one of them saves it. */
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("cad.materials") : null;
channel?.addEventListener("message", () => void reload());

async function reload(): Promise<void> {
  setCustom(parse(await readUserFile(FILE)));
}

/** Loaded at startup, importing the materials saved in the legacy location. */
export const materialsReady: Promise<void> = (async () => {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_KEY);
  } catch {
    /* storage unavailable */
  }
  const stored = parse(await readUserFile(FILE));
  const old = parse(legacy).filter((m) => !stored.some((s) => s.name === m.name));
  setCustom(stored);
  if (old.length) await save([...stored, ...old]);
  if (legacy !== null) {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignored */
    }
  }
})();

/** Full database: built-in, then custom. */
export const allMaterials = (): Material[] => [...MATERIALS, ...custom()];

export const isCustomMaterial = (name: string): boolean => custom().some((m) => m.name === name);

/** Name already taken in the database (built-in or custom), excluding the `except` entry being edited. */
export const materialNameTaken = (name: string, except?: string): boolean =>
  name !== except && allMaterials().some((m) => m.name === name);

// Serialized writes: the last change is always the one left on disk.
let writing: Promise<void> = Promise.resolve();

function save(list: Material[]): Promise<void> {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  setCustom(sorted);
  const text = JSON.stringify({ format: "cad.materials", formatVersion: 1, materials: sorted }, null, 2);
  writing = writing.then(() => writeUserFile(FILE, text)).then(() => channel?.postMessage("saved"));
  return writing;
}

/** Adds a material, or replaces the entry `previous` (name before modification). */
export function saveCustomMaterial(m: Material, previous?: string): Promise<void> {
  return save([...custom().filter((x) => x.name !== (previous ?? m.name)), m]);
}

export function removeCustomMaterial(name: string): Promise<void> {
  return save(custom().filter((m) => m.name !== name));
}
