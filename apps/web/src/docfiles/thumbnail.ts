import { getViewer } from "../store.ts";
import { activeKind, ws } from "../workspace.ts";

/**
 * Thumbnail of the .vpart / .vasm files: `thumbnail.jpg` at the archive root, JPEG, longest side 256 px, white
 * background. Taken from the 3D view when the document is saved while it is displayed; otherwise the image read
 * from its file (or taken during an earlier save) is written again unchanged.
 */
export const THUMBNAIL_FILE = "thumbnail.jpg";
const SIZE = 256;

const thumbs = new Map<string, Uint8Array>();

/** Keeps the thumbnail of an archive just opened as document `id`. */
export function readThumbnail(files: Record<string, Uint8Array>, id: string): void {
  const t = files[THUMBNAIL_FILE];
  if (t?.length) thumbs.set(id, t);
}

/** Current thumbnail of document `id`, refreshed from the 3D view when it is the displayed part or assembly. */
export function thumbnailOf(id: string): Uint8Array | undefined {
  const viewer = getViewer();
  const kind = activeKind();
  if (viewer && ws.activeId === id && (kind === "part" || kind === "assembly")) {
    try {
      const url = viewer.snapshot(SIZE, { grid: false });
      const bin = atob(url.slice(url.indexOf(",") + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      thumbs.set(id, bytes);
    } catch {
      // WebGL context lost or unreadable: the previous thumbnail is kept.
    }
  }
  return thumbs.get(id);
}

/** Thumbnail known for document `id` (read from its file or taken at its last save), without a new capture. */
export const storedThumbnail = (id: string): Uint8Array | undefined => thumbs.get(id);
