/**
 * Per-machine user data (custom materials...), kept across sessions.
 *
 * Web: files in the OPFS (the origin's private storage, on the machine's disk), with a request for
 * persistent storage so the browser does not clear them on its own; falls back to localStorage if the OPFS
 * is unavailable. Desktop (Tauri): the same interface writes to the user folder.
 */

const LOCAL_PREFIX = "cad.userdata.";

type WritableFile = FileSystemFileHandle & { createWritable?: () => Promise<FileSystemWritableFileStream> };

async function opfs(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await navigator.storage?.getDirectory?.()) ?? null;
  } catch {
    return null;
  }
}

let persistRequested = false;

/** Asks the browser not to evict site data (granted automatically for an installed PWA or a frequently visited site). */
async function requestPersistence(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* no effect: the data stays stored, without a guarantee against eviction */
  }
}

function readLocal(name: string): string | null {
  try {
    return localStorage.getItem(LOCAL_PREFIX + name);
  } catch {
    return null;
  }
}

function writeLocal(name: string, text: string): void {
  try {
    localStorage.setItem(LOCAL_PREFIX + name, text);
  } catch {
    /* storage full or unavailable */
  }
}

/** Content of the file `name`, or null if it does not exist. */
export async function readUserFile(name: string): Promise<string | null> {
  const dir = await opfs();
  if (dir) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return await file.text();
    } catch {
      /* absent from the OPFS: possibly written by the fallback */
    }
  }
  return readLocal(name);
}

/** Writes the file `name` (full replacement, atomic in the OPFS). */
export async function writeUserFile(name: string, text: string): Promise<void> {
  void requestPersistence();
  const dir = await opfs();
  if (dir) {
    try {
      const handle = (await dir.getFileHandle(name, { create: true })) as WritableFile;
      if (handle.createWritable) {
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        // The fallback must not hide a newer version when reading without the OPFS.
        try {
          localStorage.removeItem(LOCAL_PREFIX + name);
        } catch {
          /* ignored */
        }
        return;
      }
    } catch {
      /* fallback below */
    }
  }
  writeLocal(name, text);
}
