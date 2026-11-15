import { unwrap } from "solid-js/store";
import { createImportedPart, type PartDocument } from "@solidus-cad/sdk";
import { exportPlaced, exportShape, setMessage, state } from "./store.ts";
import { activeKind, asmLeaves, partDoc, openPartDocument, ws } from "./workspace.ts";
import { ASSEMBLY_FILTER, importNative, isFileDoc, isNativeFile, nameOf, nativeFilters, openFile, PART_FILTER, saveDoc } from "./docfiles/documents.ts";
import { docFs } from "./docfiles/fs.ts";
import { buildPack, openPack } from "./docfiles/pack.ts";
import { docKind, docKinds } from "./host.ts";
import { t } from "./i18n.ts";
import { extname, safeFileName } from "./docfiles/path.ts";
import { editBlocked } from "./edition.ts";

/** Native formats (.vpart, .vasm, .vdrw): see docfiles/documents.ts. */

type Picker = (opts: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

export async function saveBlob(data: Uint8Array, name: string, mime: string, ext: string): Promise<void> {
  const blob = new Blob([data as BlobPart], { type: mime });
  const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description: ext, accept: { [mime]: [ext] } }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (e) {
      if ((e as DOMException).name === "AbortError") throw e;
      // otherwise: fall back to the download
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Saves the active document to its file (asks where the first time); false if the user cancelled. */
export function saveActive(): Promise<boolean> {
  if (editBlocked()) return Promise.resolve(false);
  const kind = activeKind();
  const module = kind !== "part" && kind !== "assembly" ? docKind(kind) : undefined;
  return module ? module.save() : saveDoc(ws.activeId);
}

/** Saves the active document to a new file; open assemblies and drawings then reference it there. */
export function saveActiveAs(): Promise<boolean> {
  if (editBlocked()) return Promise.resolve(false);
  return isFileDoc(ws.activeId) ? saveDoc(ws.activeId, { as: true }) : saveActive();
}

/** Opens a part, an assembly, a drawing or a module document (and the documents it references). */
export async function openDocument(): Promise<void> {
  const path = await docFs.pickOpen(nativeFilters());
  if (path) await openFile(path);
}

/**
 * Imports a file, from anywhere: STEP, module documents, or a native document outside the project folder
 * (examples, old files with embedded parts). It is not linked to its file: saving it asks where.
 * A pack (.zip) is extracted, its files stay linked: see docfiles/pack.ts.
 */
export function importDocument(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = [".step", ".stp", ".zip", ...nativeFilters()[0]!.exts.map((e) => `.${e}`), ...docKinds().flatMap((k) => k.files?.map((f) => f.ext) ?? [])].join(",");
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (file.name.toLowerCase().endsWith(".zip")) return void (await openPack(file.name, data));
      if (isNativeFile(file.name)) return void (await importNative(file.name.toLowerCase(), data));
      const byModule = docKinds().flatMap((k) => k.files ?? []).find((f) => file.name.toLowerCase().endsWith(f.ext));
      if (byModule) return byModule.load(data);
      openPartDocument(createImportedPart(file.name, data));
    } catch {
      setMessage(t("status.openError"));
    }
  };
  input.click();
}

/** Pack & Export: zip of the active document and of everything it references (see docfiles/pack.ts). */
export async function packActive(): Promise<void> {
  try {
    const pack = buildPack(ws.activeId);
    if (!pack) return;
    const name = `${safeFileName(nameOf(ws.activeId))}.zip`;
    if (docFs.kind === "desktop") {
      const path = await docFs.pickSave(name, { name: "Zip", exts: ["zip"] });
      if (!path) return;
      await docFs.write(extname(path) === ".zip" ? path : `${path}.zip`, pack.data);
    } else await saveBlob(pack.data, name, "application/zip", ".zip");
    setMessage(t("pack.done").replace("{n}", String(pack.count)));
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") setMessage(`${t("file.writeError")} ${(e as Error).message ?? ""}`.trim());
  }
}

/**
 * Picks a part or an assembly from disk (replacing an instance): the document is added
 * to the open documents without being activated. Null if the user cancels or if the file is unreadable.
 */
export async function pickDocumentFile(): Promise<{ kind: "part" | "assembly"; id: string } | null> {
  const path = await docFs.pickOpen([{ name: "Solidus", exts: ["vpart", "vasm"] }, PART_FILTER, ASSEMBLY_FILTER]);
  const id = path ? await openFile(path, { activate: false }) : null;
  const kind = id ? ws.entries.find((e) => e.id === id)?.kind : undefined;
  return id && (kind === "part" || kind === "assembly") ? { kind, id } : null;
}

/** Exports the active assembly; `visibleOnly` excludes hidden parts. Skeletons are never exported. */
export async function exportAssemblyAs(format: "step" | "stl" | "obj" | "3mf", visibleOnly: boolean): Promise<void> {
  try {
    const placed = asmLeaves()
      .filter((l) => !l.skeleton && !(visibleOnly && l.hidden))
      .flatMap((l) => {
        const d = partDoc(l.partId);
        return d ? [{ key: l.key, doc: JSON.parse(JSON.stringify(unwrap(d))) as PartDocument, matrix: [...l.matrix] }] : [];
      });
    const name = ws.entries.find((e) => e.id === ws.activeId)?.name ?? "assemblage";
    const data = await exportPlaced(format, placed, name);
    await saveBlob(data, name + `.${format}`, `model/${format}`, `.${format}`);
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") setMessage((e as Error).message);
  }
}

export async function exportAs(format: "step" | "stl" | "obj" | "3mf"): Promise<void> {
  try {
    const data = await exportShape(format);
    const ext = `.${format}`;
    await saveBlob(data, state.doc.name + ext, `model/${format}`, ext);
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") setMessage((e as Error).message);
  }
}
