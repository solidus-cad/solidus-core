import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { unwrap } from "solid-js/store";
import { newId, type AssemblyDocument, type PartDocument } from "@solidus-cad/sdk";
import { readMachineArchive } from "@solidus-cad/assembly";
import { setMessage } from "../store.ts";
import {
  activate,
  addPartDocument,
  assemblyDoc,
  canonical,
  hideTab,
  isDirty,
  markSaved,
  openAssemblyBundle,
  partDoc,
  remapAssemblyRef,
  replaceFromFile,
  ws,
} from "../workspace.ts";
import { readCheckpoints, writeCheckpoints } from "../checkpoints.ts";
import { t } from "../i18n.ts";
import { docAtPath, docFile, docFs, setDocFile, type FileFilter } from "./fs.ts";
import { basename, dirname, extname, join, relative, safeFileName } from "./path.ts";
import { missingRefs, setMissing, type DocReference } from "./missing.ts";
import { announceWrite, onFileWritten } from "./sync.ts";
import { readThumbnail, thumbnailOf, THUMBNAIL_FILE } from "./thumbnail.ts";
import { touchRecent } from "./recent.ts";

/**
 * Documents saved as separate files:
 * - `.vpart` : `document.json` (+ checkpoints) ;
 * - `.vasm`: `assembly.json` + `references.json` (parts and sub-assemblies, by path) + checkpoints;
 * - both: `thumbnail.jpg`, image of the 3D view at the last save (thumbnail.ts).
 * Modules add their own documents (drawing `.vdrw`, CAM program `.vcam`…) with `registerModuleDoc`.
 * A reference keeps its path relative to the file that contains it, and its absolute path as a fallback.
 * If neither is found, it is flagged (missing.ts) and the user replaces it.
 * Older files, which embedded their parts (`parts/`, `assemblies/`), still open; these parts
 * are written to their own files on the first save.
 */

export const PART_FILTER: FileFilter = { name: "Pièce Solidus", exts: ["vpart"] };
export const ASSEMBLY_FILTER: FileFilter = { name: "Assemblage Solidus", exts: ["vasm"] };

/**
 * Document of a module registered as an assembly: its content in the archive, and path references
 * (`references.json`) to the parts and assemblies it uses.
 */
export interface ModuleDocCodec {
  /** Kind of document (DocKind.kind). */
  kind: string;
  /** Picker filter; its first extension is that of the saved files. */
  filter: FileFilter;
  /** Parts and assemblies used directly. */
  refs(id: string): { id: string; kind: "part" | "assembly" }[];
  /** The document's own files in the archive (without the referenced documents). */
  write(id: string): Record<string, Uint8Array>;
  /**
   * Opens the document of an archive without activating it; `freeId` gives the identifier to assign to it (a new one if
   * is already taken). Returns this identifier. Older files may embed their documents: open them too.
   */
  read(files: Record<string, Uint8Array>, freeId: (id: string | undefined) => string): string;
  /** Re-designates a referenced document (file found under another identifier, or replaced). */
  remap(id: string, from: string, to: string): void;
}

let modules: ModuleDocCodec[] = [];

/** Like registerDocKind: a re-enabled module replaces its previous registration. */
export function registerModuleDoc(codec: ModuleDocCodec): void {
  modules = [...modules.filter((m) => m.kind !== codec.kind), codec];
}

const moduleOf = (kind: string | undefined) => modules.find((m) => m.kind === kind);

/** Formats opened by File › Open: application and module documents. */
export function nativeFilters(): FileFilter[] {
  const own = [PART_FILTER, ASSEMBLY_FILTER, ...modules.map((m) => m.filter)];
  return [{ name: "Solidus", exts: own.flatMap((f) => f.exts) }, ...own];
}

/** Is the file a native document (application or module)? */
export const isNativeFile = (name: string) => nativeFilters()[0]!.exts.some((e) => name.toLowerCase().endsWith(`.${e}`));

type Kind = string;
const BUILTIN: Record<string, FileFilter> = { part: PART_FILTER, assembly: ASSEMBLY_FILTER };
const filterOf = (kind: Kind): FileFilter => BUILTIN[kind] ?? moduleOf(kind)!.filter;
export const extOf = (kind: Kind) => `.${filterOf(kind).exts[0]}`;

export const kindOf = (id: string): Kind | undefined => {
  const k = ws.entries.find((e) => e.id === id)?.kind;
  return k && (BUILTIN[k] || moduleOf(k)) ? k : undefined;
};

/** Does the document save to its own file, with its references (saveDoc)? */
export const isFileDoc = (id: string) => !!kindOf(id);

/** Replaces, in a module document (drawing…), a missing referenced document. */
export function remapRef(owner: string, from: string, to: string): void {
  const k = kindOf(owner);
  if (k && !BUILTIN[k]) moduleOf(k)!.remap(owner, from, to);
}

export const nameOf = (id: string) => ws.entries.find((e) => e.id === id)?.name ?? "document";

interface ReferencesFile {
  format: "cad.references";
  references: DocReference[];
}

function readReferences(files: Record<string, Uint8Array>): DocReference[] {
  const raw = files["references.json"];
  if (!raw) return [];
  const r = JSON.parse(strFromU8(raw)) as ReferencesFile;
  return r.format === "cad.references" && Array.isArray(r.references) ? r.references : [];
}

/** Part of a .vpart archive. */
export function readPartArchive(data: Uint8Array): { doc: PartDocument; files: Record<string, Uint8Array> } {
  const files = unzipSync(data);
  const doc = JSON.parse(strFromU8(files["document.json"]!)) as PartDocument;
  if (doc.format !== "cad.part") throw new Error();
  return { doc, files };
}

/** Documents referenced directly by an assembly or a module document (drawing…). */
export function directRefs(id: string): { id: string; kind: "part" | "assembly" }[] {
  const out = new Map<string, "part" | "assembly">();
  const k = kindOf(id);
  if (k === "assembly") {
    for (const c of assemblyDoc(id)?.components ?? []) {
      if (c.assemblyId) out.set(c.assemblyId, "assembly");
      else if (c.partId) out.set(c.partId, "part");
    }
  } else if (k && k !== "part") {
    for (const r of moduleOf(k)!.refs(id)) out.set(r.id, r.kind);
  }
  return [...out].map(([id, kind]) => ({ id, kind }));
}

/**
 * Missing references of a document still to be resolved: still used, and whose document is not
 * loaded in the meantime (occurrence replaced, or chosen file that is this document, renamed).
 */
export function unresolvedRefs(owner: string): DocReference[] {
  const refs = missingRefs(owner);
  if (!refs.length) return refs;
  const used = new Set(directRefs(owner).map((r) => r.id));
  return refs.filter((r) => used.has(r.id) && !partDoc(r.id) && !assemblyDoc(r.id));
}

// --- Ouverture -------------------------------------------------------------------------------------------

/** Missing references at opening, per document containing them (shown to the user afterwards). */
const pendingMissing = new Map<string, DocReference[]>();

/**
 * Opens a document (and, recursively, those it references). Returns its identifier, null if it is unreadable.
 * Already open from this file: simply found again.
 */
export async function openFile(path: string, opts: { activate?: boolean } = {}): Promise<string | null> {
  const id = await opening(() => load(path, new Set()), opts);
  if (id && opts.activate !== false) touchRecent(path, id, nameOf(id));
  return id;
}

/**
 * Imports a native document read from outside the project folder (File › Import): it is not linked to a file, and
 * its path references cannot be followed (reported missing, except for documents already open).
 * Older files, which embed their parts, thus open in full.
 */
export function importNative(name: string, data: Uint8Array): Promise<string | null> {
  return opening(() => loadBytes(data, extname(name), null, new Set()), {});
}

async function opening(run: () => Promise<string | null>, opts: { activate?: boolean }): Promise<string | null> {
  pendingMissing.clear();
  try {
    const id = await run();
    if (id && opts.activate !== false) activate(id);
    return id;
  } catch {
    setMessage(t("status.openError"));
    return null;
  } finally {
    for (const [owner, refs] of pendingMissing) setMissing(owner, refs);
    pendingMissing.clear();
  }
}

/**
 * Free identifier for a document read: a document open elsewhere (file copy, version without a file)
 * may carry the same one; the file read then receives a new one.
 */
function freeId(id: string | undefined): string {
  return !id || ws.entries.some((e) => e.id === id) ? newId() : id;
}

async function load(path: string, visiting: Set<string>): Promise<string | null> {
  const open = docAtPath(path);
  if (open && ws.entries.some((e) => e.id === open)) return open;
  if (visiting.has(path)) return null; // circular reference
  visiting.add(path);
  return loadBytes(await docFs.read(path), extname(path), path, visiting);
}

/** Reads a document; `path` null: imported document, without a file. */
async function loadBytes(data: Uint8Array, ext: string, path: string | null, visiting: Set<string>): Promise<string | null> {
  if (ext === ".vpart") {
    const { doc, files } = readPartArchive(data);
    const fileId = doc.id;
    doc.id = freeId(doc.id);
    const fresh = !ws.entries.some((e) => e.id === doc.id);
    const id = addPartDocument(doc);
    // Copy of an already open file (new identifier): its checkpoints remain those of the original.
    if (fresh && fileId === id) readCheckpoints(files, id);
    readThumbnail(files, id);
    if (path) setDocFile(id, path);
    return id;
  }
  const files = unzipSync(data);
  const refs = readReferences(files);
  if (ext === ".vasm") {
    const b = readMachineArchive(data);
    const fileId = b.assembly.id;
    b.assembly.id = freeId(b.assembly.id);
    // Older files: embedded parts, opened without a file (written alongside on the next save).
    const fresh = [b.assembly, ...b.parts, ...b.assemblies].map((d) => d.id!).filter((x) => !ws.entries.some((e) => e.id === x));
    const id = openAssemblyBundle(b, { activate: false });
    for (const x of fresh) if (x !== id || id === fileId) readCheckpoints(files, x);
    readThumbnail(files, id);
    if (path) setDocFile(id, path);
    await resolveRefs(id, path, refs, visiting, (from, to) => remapAssemblyRef(id, from, to));
    return id;
  }
  const module = modules.find((m) => `.${m.filter.exts[0]}` === ext);
  if (module) {
    const id = module.read(files, freeId);
    if (path) setDocFile(id, path);
    await resolveRefs(id, path, refs, visiting, (from, to) => module.remap(id, from, to));
    return id;
  }
  throw new Error("format inconnu");
}

/** Opens the referenced documents; a document found under another identifier is re-designated in the owner. */
async function resolveRefs(owner: string, path: string | null, refs: DocReference[], visiting: Set<string>, remap: (from: string, to: string) => void): Promise<void> {
  const dir = path === null ? null : dirname(path);
  const missing: DocReference[] = [];
  for (const r of refs) {
    if (ws.entries.some((e) => e.id === r.id) && (partDoc(r.id) || assemblyDoc(r.id))) continue; // already open (other assembly)
    // Imported document: its folder is unknown, its relative paths point to nothing.
    const candidates = [...(dir === null ? [] : [join(dir, r.path)]), ...(r.absolute ? [r.absolute] : [])];
    const open = new Set(ws.entries.map((e) => e.id));
    let found: string | null = null;
    for (const c of candidates) {
      if (!(await docFs.exists(c))) continue;
      try {
        found = await load(c, visiting);
      } catch {
        found = null;
      }
      if (found) break;
    }
    if (found && kindOf(found) === r.kind) {
      if (!open.has(found) && kindOf(owner) === "assembly") hideTab(found);
      if (found !== r.id) remap(r.id, found);
    } else missing.push({ ...r, absolute: r.absolute ?? (dir === null ? undefined : join(dir, r.path)) });
  }
  if (missing.length) pendingMissing.set(owner, missing);
}

// --- Enregistrement ------------------------------------------------------------------------------------------

/**
 * Saves a document to its file; without a file (or `as`), asks where. An assembly or a module document saves
 * its modified parts and sub-assemblies first, and writes alongside it those that do not have a file yet.
 * False if the user cancels or if the write fails.
 */
export async function saveDoc(id: string, opts: { as?: boolean } = {}): Promise<boolean> {
  const kind = kindOf(id);
  if (!kind) return false;
  let path = docFile(id);
  if (!path || opts.as) {
    const chosen = await docFs.pickSave(safeFileName(nameOf(id)) + extOf(kind), filterOf(kind), path ? dirname(path) : undefined);
    if (!chosen) return false;
    path = extname(chosen) === extOf(kind) ? chosen : chosen + extOf(kind);
    const other = docAtPath(path);
    if (other && other !== id && ws.entries.some((e) => e.id === other)) {
      setMessage(t("file.openElsewhere").replace("{name}", basename(path)));
      return false;
    }
  }
  try {
    const written: string[] = [];
    await write(id, path, new Set(), written);
    touchRecent(path, id, nameOf(id));
    if (docFs.kind === "snapshot") setMessage(t("file.downloadHint"));
    else setMessage(written.length > 1 ? t("file.savedWithRefs").replace("{n}", String(written.length - 1)) : t("status.saved"));
    return true;
  } catch (e) {
    setMessage(`${t("file.writeError")} ${(e as Error).message ?? ""}`.trim());
    return false;
  }
}

/** Free path next to a document for a part without a file: "Name.vpart", otherwise "Name (2).vpart"… */
async function freePath(dir: string, name: string, ext: string, taken: Set<string>): Promise<string> {
  const base = safeFileName(name);
  for (let n = 1; ; n++) {
    const p = join(dir, n === 1 ? base + ext : `${base} (${n})${ext}`);
    if (!taken.has(p.toLowerCase()) && !docAtPath(p) && !(await docFs.exists(p))) return p;
  }
}

async function write(id: string, path: string, done: Set<string>, written: string[]): Promise<void> {
  done.add(id);
  const refs: DocReference[] = [];
  if (kindOf(id) !== "part") {
    const dir = dirname(path);
    const taken = new Set<string>();
    for (const r of directRefs(id)) {
      if (!partDoc(r.id) && !assemblyDoc(r.id)) continue; // not found: kept below
      let file = docFile(r.id);
      if (!done.has(r.id) && (!file || isDirty(r.id))) {
        file ??= await freePath(dir, nameOf(r.id), extOf(r.kind), taken);
        taken.add(file.toLowerCase());
        await write(r.id, file, done, written);
      }
      file = docFile(r.id) ?? file!;
      refs.push({ id: r.id, kind: r.kind, name: nameOf(r.id), path: relative(dir, file) ?? file, absolute: file });
    }
    for (const m of unresolvedRefs(id)) refs.push({ ...m, path: relative(dir, m.absolute ?? m.path) ?? m.path });
  }
  await docFs.write(path, encodeDoc(id, refs));
  setDocFile(id, path);
  markSaved([id]);
  written.push(id);
  announceWrite(path);
}

// --- Files saved by another window ---------------------------------------------------------------------------

/** Reloads one after the other, in the order of the writes (an assembly's parts before the assembly). */
let reloads = Promise.resolve();
onFileWritten((path) => {
  reloads = reloads.then(() => reloadFile(path)).catch((e) => console.warn("rechargement :", path, e));
});

/**
 * A file has been rewritten by another window: the document open from it here takes its new content, unless it has
 * unsaved changes (the user is warned instead). Parts and assemblies are reloaded in place, and an assembly's new
 * references are opened; the other documents (module documents: drawings…) are to be reopened.
 */
async function reloadFile(path: string): Promise<void> {
  const id = docAtPath(path);
  if (!id || !ws.entries.some((e) => e.id === id)) return;
  const kind = kindOf(id);
  const name = basename(path);
  if (isDirty(id)) return setMessage(t("file.changedElsewhere").replace("{name}", name));
  if (kind !== "part" && kind !== "assembly") return setMessage(t("file.reopenToUpdate").replace("{name}", name));
  const data = await docFs.read(path);
  const files = unzipSync(data);
  const doc = kind === "part" ? readPartArchive(data).doc : readMachineArchive(data).assembly;
  const current = kind === "part" ? partDoc(id) : assemblyDoc(id);
  if (current && canonical({ ...unwrap(current), id }) === canonical({ ...doc, id })) return; // already this content
  const fileId = doc.id;
  replaceFromFile(id, doc);
  if (fileId === id) readCheckpoints(files, id);
  if (kind === "assembly") {
    await opening(async () => {
      await resolveRefs(id, path, readReferences(files), new Set([path]), (from, to) => remapAssemblyRef(id, from, to));
      return id;
    }, { activate: false });
  }
  setMessage(t("file.reloaded").replace("{name}", name));
}

/** File content of a document, in its current state; `refs` is ignored for a part. */
export function encodeDoc(id: string, refs: DocReference[]): Uint8Array {
  const kind = kindOf(id)!;
  const files: Record<string, Uint8Array> = {};
  if (kind === "part") {
    files["document.json"] = strToU8(JSON.stringify(unwrap(partDoc(id)!), null, 2));
  } else {
    if (kind === "assembly") files["assembly.json"] = strToU8(JSON.stringify(unwrap(assemblyDoc(id)! as AssemblyDocument), null, 2));
    else Object.assign(files, moduleOf(kind)!.write(id));
    files["references.json"] = strToU8(JSON.stringify({ format: "cad.references", references: refs } satisfies ReferencesFile, null, 2));
  }
  writeCheckpoints(files, id);
  const thumb = kind === "part" || kind === "assembly" ? thumbnailOf(id) : undefined;
  // JPEG already compressed: stored as is.
  return zipSync(thumb ? { ...files, [THUMBNAIL_FILE]: [thumb, { level: 0 }] } : files, { level: 6 });
}
