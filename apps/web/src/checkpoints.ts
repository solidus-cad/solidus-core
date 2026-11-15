import { createSignal } from "solid-js";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { AssemblyBundle } from "@solidus-cad/assembly";
import type { PartDocument } from "@solidus-cad/sdk";

/**
 * Checkpoints of a document (part or assembly): numbered and commented versions, like git commits.
 * Each version keeps its parent: after reverting to v2, the next checkpoint (v5) starts from v2, and v3 and v4 remain available.
 * An assembly checkpoint freezes the assembly with all its parts and sub-assemblies.
 *
 * Module with no dependency on the workspace: the caller provides the snapshot (see workspace.ts).
 */

export interface Checkpoint {
  number: number;
  /** Version this one derives from (null: first version). */
  parent: number | null;
  comment: string;
  /** Date ISO. */
  date: string;
  author?: string;
}

export interface CheckpointLog {
  list: Checkpoint[];
  /** Version the document's current state derives from (null: none). */
  head: number | null;
  /** Next number: numbers of deleted versions are never reused. */
  next?: number;
}

export type Snapshot = PartDocument | AssemblyBundle;

interface Entry {
  log: CheckpointLog;
  /** Compressed snapshots (deflated JSON), per version number. */
  snaps: Map<number, Uint8Array>;
}

const entries = new Map<string, Entry>();
/** Documents whose checkpoints changed since the last save. */
const dirty = new Set<string>();
const [rev, setRev] = createSignal(0);
const bump = () => setRev((n) => n + 1);

const EMPTY: CheckpointLog = { list: [], head: null };

/** Versions of a document (reactive). */
export function checkpointsOf(id: string): CheckpointLog {
  void rev();
  return entries.get(id)?.log ?? EMPTY;
}

/** Number of the next version. */
export function nextNumber(id: string): number {
  const log = checkpointsOf(id);
  return Math.max(log.next ?? 1, ...log.list.map((c) => c.number + 1));
}

/** Adds a version (derived from the current version) and makes it the current version. */
export function addCheckpoint(id: string, snapshot: Snapshot, comment: string, author?: string, date = new Date()): Checkpoint {
  let e = entries.get(id);
  if (!e) entries.set(id, (e = { log: { list: [], head: null }, snaps: new Map() }));
  const c: Checkpoint = { number: nextNumber(id), parent: e.log.head, comment, date: date.toISOString(), ...(author ? { author } : {}) };
  e.snaps.set(c.number, deflateSync(strToU8(JSON.stringify(snapshot)), { level: 6 }));
  e.log = { list: [...e.log.list, c], head: c.number, next: c.number + 1 };
  dirty.add(id);
  bump();
  return c;
}

/** Snapshot of a version (new copy on each call). */
export function snapshotOf<T extends Snapshot = Snapshot>(id: string, n: number): T | undefined {
  const bytes = entries.get(id)?.snaps.get(n);
  return bytes ? (JSON.parse(strFromU8(inflateSync(bytes))) as T) : undefined;
}

/** Version the document now derives from (after a restore). */
export function setHead(id: string, n: number | null): void {
  const e = entries.get(id);
  if (!e || e.log.head === n) return;
  e.log = { ...e.log, head: n };
  dirty.add(id);
  bump();
}

/**
 * Deletes a version: those derived from it are attached to its parent;
 * if it was the current version, the document now derives from that parent.
 */
export function deleteCheckpoint(id: string, n: number): void {
  const e = entries.get(id);
  const gone = e?.log.list.find((c) => c.number === n);
  if (!e || !gone) return;
  e.snaps.delete(n);
  e.log = {
    list: e.log.list.filter((c) => c !== gone).map((c) => (c.parent === n ? { ...c, parent: gone.parent } : c)),
    head: e.log.head === n ? gone.parent : e.log.head,
    next: Math.max(e.log.next ?? 1, n + 1),
  };
  dirty.add(id);
  bump();
}

/** Have the checkpoints changed since the last save? Reactive. */
export function isCheckpointDirty(id: string): boolean {
  void rev();
  return dirty.has(id);
}

export function clearCheckpointDirty(ids: Iterable<string>): void {
  let changed = false;
  for (const id of ids) changed = dirty.delete(id) || changed;
  if (changed) bump();
}

export function forgetCheckpoints(id: string): void {
  if (entries.delete(id) || dirty.delete(id)) bump();
}

// --- Files: checkpoints/<id>/index.json and checkpoints/<id>/v<n>.json -----------------------------
// Outside parts/ and assemblies/: ignored by readMachineArchive and by earlier versions of the application.

const dir = (id: string) => `checkpoints/${id}/`;

/** Adds the document's checkpoints to an archive's files (nothing if it has none). */
export function writeCheckpoints(files: Record<string, Uint8Array>, id: string): void {
  const e = entries.get(id);
  if (!e || e.log.list.length === 0) return;
  files[dir(id) + "index.json"] = strToU8(JSON.stringify(e.log, null, 2));
  for (const [n, bytes] of e.snaps) files[`${dir(id)}v${n}.json`] = inflateSync(bytes);
}

/** Reads a document's checkpoints from an archive; false if there are none (or if they are unreadable). */
export function readCheckpoints(files: Record<string, Uint8Array>, id: string): boolean {
  const index = files[dir(id) + "index.json"];
  if (!index) return false;
  try {
    const log = JSON.parse(strFromU8(index)) as CheckpointLog;
    const snaps = new Map<number, Uint8Array>();
    for (const c of log.list) {
      const bytes = files[`${dir(id)}v${c.number}.json`];
      if (bytes) snaps.set(c.number, deflateSync(bytes, { level: 6 }));
    }
    const list = log.list.filter((c) => snaps.has(c.number));
    const head = list.some((c) => c.number === log.head) ? log.head : null;
    entries.set(id, { log: { list, head, next: Math.max(log.next ?? 1, ...list.map((c) => c.number + 1)) }, snaps });
    dirty.delete(id);
    bump();
    return true;
  } catch {
    return false;
  }
}
