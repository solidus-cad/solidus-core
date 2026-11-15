import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

/** Reference from an assembly or a drawing to a part or a sub-assembly (`references.json` file). */
export interface DocReference {
  /** Identifier of the referenced document (AssemblyComponent.partId / assemblyId, DrawingView.partId / assemblyId). */
  id: string;
  kind: "part" | "assembly";
  /** Name of the document at the last save (shown if the file is not found). */
  name: string;
  /** Path relative to the folder of the file that contains the reference. */
  path: string;
  /** Absolute path (desktop) or path relative to the project folder root (web): fallback. */
  absolute?: string;
}

/** Missing references, per document containing them. */
const [missing, setMissingStore] = createStore<Record<string, DocReference[]>>({});
/** Documents whose missing references must be shown (dialog opened after opening). */
const [toReview, setToReview] = createSignal<string[]>([]);
export { toReview as missingToReview, setToReview as setMissingToReview };

export function setMissing(owner: string, refs: DocReference[]): void {
  setMissingStore(owner, refs);
  setToReview((l) => [...new Set([...l, owner])]);
}

/** A reference is found again (document replaced or file reopened): it is no longer flagged. */
export function clearMissing(owner: string, id?: string): void {
  setMissingStore(
    produce((m) => {
      if (id === undefined) delete m[owner];
      else if (m[owner]) m[owner] = m[owner].filter((r) => r.id !== id);
    }),
  );
}

/** Missing references of a document (reactive). */
export const missingRefs = (owner: string): DocReference[] => missing[owner] ?? [];
