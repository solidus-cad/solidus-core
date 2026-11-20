import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invokeDesktop, isDesktop } from "../desktop.ts";
import { basename, dirname, join, normalize, samePath } from "./path.ts";

/**
 * Document files (parts, assemblies, drawings). An assembly or a drawing references its parts
 * by their path: it must therefore read and write neighbouring files, which the browser only allows in
 * a folder chosen by the user.
 * - desktop: real paths, read and written by the Rust backend (apps/desktop/src-tauri/src/files.rs);
 * - web (Chrome, Edge): project folder opened with the File System Access API; paths relative to its root;
 * - web without this API (Firefox, Safari): project folder read in full at the user's choice (`webkitdirectory`);
 *   a save downloads the file, to be put back in the folder.
 */

export interface FileFilter {
  name: string;
  /** Extensions without the dot. */
  exts: string[];
}

export interface DocFs {
  kind: "desktop" | "folder" | "snapshot";
  /** Project folder name (web); null until one is chosen. Always null on the desktop. */
  rootName: () => string | null;
  /** Web: chooses (or re-authorises) the project folder; true if it is usable. Desktop: always true. */
  ensureRoot: (force?: boolean) => Promise<boolean>;
  pickOpen: (filters: FileFilter[]) => Promise<string | null>;
  pickSave: (suggestedName: string, filter: FileFilter, dir?: string) => Promise<string | null>;
  read: (path: string) => Promise<Uint8Array>;
  write: (path: string, data: Uint8Array) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  /** Folder where a pack is extracted ("": project folder root); null if the user cancels. `name`: name of the pack. */
  pickExtractDir: (name: string) => Promise<string | null>;
  /** Writes an extracted file: like `write`, but the snapshot keeps it without downloading it. */
  install: (path: string, data: Uint8Array) => Promise<void>;
}

// --- Bureau -------------------------------------------------------------------------------------------

const desktopFs: DocFs = {
  kind: "desktop",
  rootName: () => null,
  ensureRoot: async () => true,
  pickOpen: async (filters) => {
    const p = await invokeDesktop<string | null>("fs_pick_open", { filters });
    return p ? normalize(p) : null;
  },
  pickSave: async (suggestedName, filter, dir) => {
    const p = await invokeDesktop<string | null>("fs_pick_save", { name: suggestedName, dir: dir ?? null, filters: [filter] });
    return p ? normalize(p) : null;
  },
  read: async (path) => new Uint8Array(await invokeDesktop<ArrayBuffer>("fs_read", { path })),
  // Raw binary body (no JSON); the path is passed in a header.
  write: async (path, data) => void (await invokeDesktop("fs_write", data, { headers: { "x-path": encodeURIComponent(path) } })),
  exists: (path) => invokeDesktop<boolean>("fs_exists", { path }),
  pickExtractDir: async () => {
    const p = await invokeDesktop<string | null>("fs_pick_dir");
    return p ? normalize(p) : null;
  },
  install: (path, data) => desktopFs.write(path, data),
};

// --- Web : File System Access API ---------------------------------------------------------------------

type PermissionHandle = FileSystemHandle & {
  queryPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
};
type FsaWindow = {
  showDirectoryPicker?: (o?: { id?: string; mode?: "readwrite"; startIn?: FileSystemHandle }) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (o?: { startIn?: FileSystemHandle; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o?: { startIn?: FileSystemHandle; suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
};
const fsa = globalThis as unknown as FsaWindow;

const [rootLabel, setRootLabel] = createSignal<string | null>(null);

/** The project folder is kept from one session to the next (IndexedDB); permission is requested again on first access. */
const DB = "cad.project";
function idb<T>(op: (s: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        const req = op(open.result.transaction("kv", mode).objectStore("kv"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      };
    } catch {
      resolve(undefined);
    }
  });
}

let root: FileSystemDirectoryHandle | null = null;
let rootGranted = false;
const restored = idb<FileSystemDirectoryHandle>((s) => s.get("root") as IDBRequest<FileSystemDirectoryHandle>, "readonly").then((h) => {
  if (h && !root) {
    root = h;
    setRootLabel(h.name);
  }
});

const accept = (filters: FileFilter[]) => filters.map((f) => ({ description: f.name, accept: { "application/octet-stream": f.exts.map((e) => `.${e}`) } }));

async function dirHandle(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let d = root!;
  for (const seg of normalize(path).split("/").filter(Boolean)) {
    if (seg === "..") throw new Error("outside");
    d = await d.getDirectoryHandle(seg, { create });
  }
  return d;
}

async function fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const p = normalize(path);
  return (await dirHandle(dirname(p), create)).getFileHandle(basename(p), { create });
}

/** Path of a file picked in the picker, relative to the project folder; null if it is outside. */
async function inRoot(h: FileSystemHandle): Promise<string | null> {
  const segs = await root!.resolve(h);
  return segs ? segs.join("/") : null;
}

const [outside, setOutside] = createSignal(0);
/** Incremented when the user picks a file outside the project folder (message shown by the UI). */
export { outside as outsideProjectSignal };

const folderFs: DocFs = {
  kind: "folder",
  rootName: rootLabel,
  ensureRoot: async (force) => {
    await restored;
    if (root && !force) {
      if (rootGranted) return true;
      const h = root as unknown as PermissionHandle;
      if ((await h.queryPermission({ mode: "readwrite" })) === "granted" || (await h.requestPermission({ mode: "readwrite" })) === "granted") {
        rootGranted = true;
        return true;
      }
    }
    try {
      const h = await fsa.showDirectoryPicker!({ id: "cad-project", mode: "readwrite", startIn: root ?? undefined });
      root = h;
      rootGranted = true;
      setRootLabel(h.name);
      await idb((s) => s.put(h, "root"), "readwrite");
      return true;
    } catch {
      return false;
    }
  },
  pickOpen: async (filters) => {
    if (!(await folderFs.ensureRoot())) return null;
    try {
      const [h] = await fsa.showOpenFilePicker!({ startIn: root!, types: accept(filters) });
      const p = h ? await inRoot(h) : null;
      if (h && !p) setOutside((n) => n + 1);
      return p;
    } catch {
      return null;
    }
  },
  pickSave: async (suggestedName, filter, dir) => {
    if (!(await folderFs.ensureRoot())) return null;
    let startIn: FileSystemHandle = root!;
    try {
      if (dir) startIn = await dirHandle(dir, false);
    } catch {
      // folder gone: project root
    }
    try {
      const h = await fsa.showSaveFilePicker!({ startIn, suggestedName, types: accept([filter]) });
      const p = await inRoot(h);
      if (!p) setOutside((n) => n + 1);
      return p;
    } catch {
      return null;
    }
  },
  read: async (path) => new Uint8Array(await (await (await fileHandle(path, false)).getFile()).arrayBuffer()),
  write: async (path, data) => {
    const w = await (await fileHandle(path, true)).createWritable();
    await w.write(data as BlobPart);
    await w.close();
  },
  exists: async (path) => {
    try {
      await fileHandle(path, false);
      return true;
    } catch {
      return false;
    }
  },
  pickExtractDir: async () => ((await folderFs.ensureRoot()) ? "" : null),
  install: (path, data) => folderFs.write(path, data),
};

// --- Web without File System Access: snapshot of the folder ------------------------------------------------

/** Files of the project folder read at once (path relative to its root → content). Saves are recorded there. */
const snapshot = new Map<string, Blob>();

function pickFolder(): Promise<boolean> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return resolve(false);
      snapshot.clear();
      // webkitRelativePath starts with the name of the chosen folder: removed.
      for (const f of files) snapshot.set(normalize(f.webkitRelativePath.split("/").slice(1).join("/")), f);
      setRootLabel(files[0]!.webkitRelativePath.split("/")[0] ?? "");
      resolve(true);
    };
    input.oncancel = () => resolve(false);
    input.click();
  });
}

/** Choice of a file in the project folder (snapshot): provided by the UI (docfiles/SnapshotPicker.tsx). */
let listPicker: ((paths: string[], mode: "open" | "save", suggested?: string) => Promise<string | null>) | null = null;
export function setSnapshotPicker(fn: typeof listPicker): void {
  listPicker = fn;
}

function download(path: string, data: Uint8Array): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data as BlobPart]));
  a.download = basename(path);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const snapshotFs: DocFs = {
  kind: "snapshot",
  rootName: rootLabel,
  ensureRoot: async (force) => (!force && rootLabel() !== null) || pickFolder(),
  pickOpen: async (filters) => {
    if (!(await snapshotFs.ensureRoot())) return null;
    const exts = filters.flatMap((f) => f.exts.map((e) => `.${e}`));
    const paths = [...snapshot.keys()].filter((p) => exts.some((e) => p.toLowerCase().endsWith(e))).sort();
    return listPicker ? listPicker(paths, "open") : null;
  },
  pickSave: async (suggestedName, filter, dir) => {
    if (!(await snapshotFs.ensureRoot())) return null;
    const paths = [...snapshot.keys()].filter((p) => filter.exts.some((e) => p.toLowerCase().endsWith(`.${e}`))).sort();
    return listPicker ? listPicker(paths, "save", join(dir ?? "", suggestedName)) : join(dir ?? "", suggestedName);
  },
  read: async (path) => {
    const key = [...snapshot.keys()].find((k) => samePath(k, path));
    if (!key) throw new Error("introuvable");
    return new Uint8Array(await snapshot.get(key)!.arrayBuffer());
  },
  write: async (path, data) => {
    snapshot.set(normalize(path), new Blob([data as BlobPart]));
    download(path, data);
  },
  exists: async (path) => [...snapshot.keys()].some((k) => samePath(k, path)),
  pickExtractDir: async (name) => {
    if (rootLabel() === null) setRootLabel(name);
    return "";
  },
  install: async (path, data) => void snapshot.set(normalize(path), new Blob([data as BlobPart])),
};

const platformFs: DocFs = isDesktop ? desktopFs : fsa.showDirectoryPicker ? folderFs : snapshotFs;

// --- Files held in memory (example assemblies) -----------------------------------------------------------

/**
 * Files read before the platform's: an example opens from here without a project folder, then its documents are
 * detached from these paths (see docfiles/examples.ts), so nothing is ever written to them.
 */
const memory = new Map<string, Uint8Array>();
const inMemory = (path: string) => [...memory.keys()].find((k) => samePath(k, path));

export function putMemoryFile(path: string, data: Uint8Array): void {
  memory.set(normalize(path), data);
}

export function dropMemoryFiles(prefix: string): void {
  for (const k of [...memory.keys()]) if (k.startsWith(normalize(prefix))) memory.delete(k);
}

export const docFs: DocFs = {
  ...platformFs,
  read: (path) => {
    const k = inMemory(path);
    return k ? Promise.resolve(memory.get(k)!) : platformFs.read(path);
  },
  exists: (path) => (inMemory(path) ? Promise.resolve(true) : platformFs.exists(path)),
};

// --- File of each open document ----------------------------------------------------------------------

const [files, setFiles] = createStore<Record<string, string>>({});

/** File of an open document (path), or undefined if it has never been saved or opened from a file. */
export const docFile = (id: string): string | undefined => files[id];

export function setDocFile(id: string, path: string): void {
  setFiles(id, normalize(path));
}

export function forgetDocFile(id: string): void {
  setFiles(produce((f) => void delete f[id]));
}

/** Document opened from this file, if any. */
export function docAtPath(path: string): string | undefined {
  return Object.entries(files).find(([, p]) => samePath(p, path))?.[0];
}
