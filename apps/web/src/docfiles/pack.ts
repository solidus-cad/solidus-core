import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { setMessage } from "../store.ts";
import { assemblyDoc, partDoc } from "../workspace.ts";
import { t } from "../i18n.ts";
import { directRefs, encodeDoc, extOf, isNativeFile, kindOf, nameOf, openFile, unresolvedRefs } from "./documents.ts";
import { docFile, docFs } from "./fs.ts";
import { basename, commonDir, dirname, isSafeEntry, join, relative, safeFileName } from "./path.ts";
import { setMissingToReview, type DocReference } from "./missing.ts";

/**
 * Pack & Export: a zip with a document and everything it references, in the folder tree they have on disk.
 * - Documents are written in their current state, including unsaved changes and documents without a file;
 *   nothing is saved or changed in the session.
 * - References keep only their relative path: the original absolute paths would leak the sender's disk, and
 *   could link an extracted pack back to the originals.
 * - `pack.json` names the head document, for File › Import. The zip can also be extracted by hand: the head
 *   document then opens with File › Open (on the web, the project folder must contain the extracted tree).
 */

const MANIFEST = "pack.json";

interface PackManifest {
  format: "cad.pack";
  version: 1;
  /** Head document, path in the zip. */
  root: string;
}

const loaded = (id: string) => !!partDoc(id) || !!assemblyDoc(id);

/** Path of a file in the zip, below `base`. Other drive: the drive letter becomes a folder. */
const inZip = (base: string, file: string) => relative(base, file) ?? file.replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, "");

/**
 * Zip of a document and of its references, ready to be written. Null (with a message) if a reference is missing:
 * the pack would not open complete.
 */
export function buildPack(head: string): { data: Uint8Array; count: number } | null {
  const parents = new Map<string, string | null>([[head, null]]);
  const lost = new Set<string>();
  const walk = (id: string) => {
    const unresolved = unresolvedRefs(id);
    for (const r of directRefs(id)) {
      if (!loaded(r.id)) lost.add(unresolved.find((m) => m.id === r.id)?.name ?? r.id);
      else if (!parents.has(r.id)) {
        parents.set(r.id, id);
        walk(r.id);
      }
    }
  };
  walk(head);
  if (lost.size) {
    setMissingToReview([...parents.keys()]);
    setMessage(t("pack.missing").replace("{names}", [...lost].join(", ")));
    return null;
  }

  // Paths in the zip: Windows extraction is case-insensitive, two names must differ by more than case.
  const paths = new Map<string, string>();
  const taken = new Set<string>();
  const place = (id: string, wanted: string) => {
    const dot = wanted.lastIndexOf(".");
    let p = wanted;
    for (let n = 2; taken.has(p.toLowerCase()); n++) p = `${wanted.slice(0, dot)} (${n})${wanted.slice(dot)}`;
    taken.add(p.toLowerCase());
    paths.set(id, p);
  };
  const ids = [...parents.keys()];
  const base = commonDir(ids.flatMap((id) => docFile(id) ?? []));
  for (const id of ids) {
    const file = docFile(id);
    if (file) place(id, inZip(base, file));
  }
  // Documents without a file: next to the document that uses them, as a save would do (parents come first).
  for (const id of ids) {
    if (paths.has(id)) continue;
    const parent = parents.get(id);
    place(id, join(parent ? dirname(paths.get(parent)!) : "", safeFileName(nameOf(id)) + extOf(kindOf(id)!)));
  }

  const files: Record<string, Uint8Array> = {};
  for (const id of ids) {
    const dir = dirname(paths.get(id)!);
    const refs: DocReference[] = directRefs(id).map((r) => ({ id: r.id, kind: r.kind, name: nameOf(r.id), path: relative(dir, paths.get(r.id)!)! }));
    files[paths.get(id)!] = encodeDoc(id, refs);
  }
  files[MANIFEST] = strToU8(JSON.stringify({ format: "cad.pack", version: 1, root: paths.get(head)! } satisfies PackManifest, null, 2));
  // Documents are already compressed archives.
  return { data: zipSync(files, { level: 0 }), count: ids.length };
}

/**
 * File › Import of a pack: extracts it in a new folder (the project folder on the web, a chosen one on the desktop)
 * and opens the head document from there, so that its files stay linked. Nothing existing is overwritten.
 */
export async function openPack(name: string, data: Uint8Array): Promise<void> {
  const zip = unzipSync(data);
  const manifest = readManifest(zip);
  const entries = Object.keys(zip).filter(isNativeFile);
  if (!manifest || !zip[manifest.root] || !entries.every(isSafeEntry)) return setMessage(t("pack.invalid"));

  const stem = safeFileName(basename(name).replace(/\.zip$/i, ""));
  const dir = await docFs.pickExtractDir(stem);
  if (dir === null) return docFs.kind === "folder" ? setMessage(t("pack.noFolder")) : undefined;
  let folder = "";
  for (let n = 1; ; n++) {
    folder = join(dir, n === 1 ? stem : `${stem} (${n})`);
    const here = folder;
    if (!(await Promise.all(entries.map((p) => docFs.exists(join(here, p))))).some(Boolean)) break;
  }
  for (const p of entries) await docFs.install(join(folder, p), zip[p]!);
  if (await openFile(join(folder, manifest.root))) setMessage(t("pack.opened").replace("{folder}", folder).replace("{n}", String(entries.length)));
}

function readManifest(zip: Record<string, Uint8Array>): PackManifest | null {
  const raw = zip[MANIFEST];
  if (!raw) return null;
  try {
    const m = JSON.parse(strFromU8(raw)) as PackManifest;
    return m.format === "cad.pack" && typeof m.root === "string" ? m : null;
  } catch {
    return null;
  }
}
