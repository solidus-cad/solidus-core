import { unwrap } from "solid-js/store";
import type { ExternalLink, ExternalRef, Feature, GeomRef, MeshPayload, PartDocument } from "@solidus-cad/sdk";
import { t } from "../i18n.ts";
import { edgePoints, edgeRef, faceRef, matchRef, planarFace } from "@solidus-cad/viewer";
import { state, updateLinked } from "../store.ts";
import { activeKind, assemblyDoc, asmLeaves, meshOf, mul4, occurrenceMatrix, partDoc, updatePartDoc, ws } from "../workspace.ts";
import { invRigid } from "./flex.ts";

/**
 * External references (in-place editing): edges and faces of other parts of an assembly, used by
 * the sketches of the edited part. The kernel recalculates one part at a time: the application keeps up to date
 * the linked geometry (edge polyline, face plane) in the edited part's coordinate system, as for frames.
 */

type V3 = [number, number, number];

/** Reference to an edge picked in the view: linked if it belongs to another part (ghost). */
export function linkedRef(hit: { ref: GeomRef; points: V3[]; ghost?: string }): GeomRef | ExternalRef {
  const ctx = ws.inPlace;
  if (!hit.ghost || !ctx) return hit.ref;
  return { kind: "external", asm: ctx.asmId, path: hit.ghost, target: ctx.path, ref: hit.ref, points: hit.points.map((p) => [...p] as V3) };
}

/** True if the part has (unbroken) links to other parts. */
export function hasLinks(doc: PartDocument): boolean {
  return doc.features.some((f) => !!f.sketch && (!!f.sketch.plane.external || f.sketch.geometry.some((g) => g.projected?.kind === "external")));
}

const apply = (m: number[], p: V3, w = 1): V3 => [0, 1, 2].map((i) => m[i]! * p[0] + m[4 + i]! * p[1] + m[8 + i]! * p[2] + m[12 + i]! * w) as V3;
const near = (a: V3[], b: V3[]) => a.length === b.length && a.every((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1], p[2] - b[i]![2]) < 1e-7);

/** Diagonal of a mesh bounding box (search tolerance). */
function diag(m: MeshPayload): number {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    lo = lo.map((v, k) => Math.min(v, m.positions[i + k]!));
    hi = hi.map((v, k) => Math.max(v, m.positions[i + k]!));
  }
  return Number.isFinite(lo[0]) ? Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) : 1;
}

interface Resolved {
  /** Matrix of the source part in the edited part's coordinate system. */
  rel: number[];
  mesh: MeshPayload;
}

/**
 * Source part of a link: mesh and relative position. `undefined`: context unavailable (assembly closed,
 * mesh being computed) — the geometry stays as is; `null`: occurrence gone (broken link).
 */
function resolve(link: ExternalLink, onReady: () => void): Resolved | null | undefined {
  const a = assemblyDoc(link.asm);
  if (!a) return undefined;
  const leaf = asmLeaves(a).find((l) => l.key === link.path);
  const src = occurrenceMatrix(link.asm, link.path);
  const dst = occurrenceMatrix(link.asm, link.target);
  if (!leaf || !src || !dst) return null;
  const mesh = meshOf(leaf.partId, onReady);
  if (!mesh) return undefined;
  return { rel: mul4(invRigid(dst), src), mesh };
}

/**
 * Realigns the linked sketches of a part to the current position of the source parts. Returns the number of links
 * broken. No history entry (a consequence of the assembly); modifies the part only if something has moved.
 */
export function syncExternalRefs(partId: string): number {
  const doc = partDoc(partId);
  if (!doc || !hasLinks(doc)) return 0;
  const snapshot = JSON.parse(JSON.stringify(unwrap(doc))) as PartDocument;
  let broken = 0;
  let changed = false;
  const retry = () => queueMicrotask(() => syncExternalRefs(partId));
  const setBroken = (l: ExternalLink, b: boolean) => {
    if (!!l.broken !== b) {
      changed = true;
      if (b) l.broken = true;
      else delete l.broken;
    }
    if (b) broken++;
  };
  for (const f of snapshot.features) {
    const sk = f.sketch;
    if (!sk) continue;
    const plane = sk.plane.external;
    if (plane && !plane.frozen) {
      const r = resolve(plane, retry);
      if (r === null) setBroken(plane, true);
      else if (r) {
        const idx = matchRef(r.mesh, plane.ref, 0.05 * diag(r.mesh));
        const pl = idx >= 0 ? planarFace(r.mesh, idx) : null;
        setBroken(plane, !pl);
        if (pl) {
          const face = { p: apply(r.rel, pl.p), n: apply(r.rel, pl.n, 0) };
          if (!sk.plane.face || !near([sk.plane.face.p, sk.plane.face.n], [face.p, face.n])) {
            sk.plane.face = face;
            plane.ref = faceRef(r.mesh, idx);
            changed = true;
          }
        }
      }
    }
    for (const g of sk.geometry) {
      const ref = g.projected;
      if (ref?.kind !== "external" || ref.frozen) continue;
      const r = resolve(ref, retry);
      if (r === null) {
        setBroken(ref, true);
        continue;
      }
      if (!r) continue;
      const e = matchRef(r.mesh, ref.ref, 0.05 * diag(r.mesh));
      setBroken(ref, e < 0);
      if (e < 0) continue;
      const pts = edgePoints(r.mesh, e).map((p) => apply(r.rel, [p.x, p.y, p.z]));
      if (!near(pts, ref.points)) {
        ref.points = pts;
        ref.ref = edgeRef(r.mesh, e);
        changed = true;
      }
    }
  }
  if (!changed) return broken;
  const write = (d: PartDocument) => {
    d.features = snapshot.features;
  };
  if (activeKind() === "part" && state.doc.id === partId) updateLinked(write);
  else updatePartDoc(partId, write, false);
  return broken;
}

/** Parts of the assembly linked to it (modified in place): realigned to the current position of the source parts. */
export function syncLinkedParts(asmId: string): void {
  const a = assemblyDoc(asmId);
  if (!a) return;
  const linksTo = (doc: PartDocument) =>
    doc.features.some((f) => !!f.sketch && (f.sketch.plane.external?.asm === asmId || f.sketch.geometry.some((g) => g.projected?.kind === "external" && g.projected.asm === asmId)));
  for (const id of new Set(asmLeaves(a).map((l) => l.partId))) {
    const doc = partDoc(id);
    if (doc && linksTo(doc)) syncExternalRefs(id);
  }
}

/** Links (unbroken) of a sketch feature to other parts. */
export function sketchLinks(f: Feature): ExternalLink[] {
  if (!f.sketch) return [];
  const out: ExternalLink[] = [];
  if (f.sketch.plane.external) out.push(f.sketch.plane.external);
  for (const g of f.sketch.geometry) if (g.projected?.kind === "external" && !g.projected.frozen) out.push(g.projected);
  return out;
}

/** Tooltip of a sketch's links: source parts (broken ones flagged). */
export function linkTitle(f: Feature): string {
  const names = new Set<string>();
  for (const l of sketchLinks(f)) {
    const a = assemblyDoc(l.asm);
    const leaf = a ? asmLeaves(a).find((x) => x.key === l.path) : undefined;
    names.add(`${leaf?.name ?? "?"}${l.broken ? ` (${t("link.broken")})` : ""}`);
  }
  return `${t("link.title")} : ${[...names].join(", ")}`;
}

/** Breaks the external links of a sketch (or of the whole part): the linked geometry stays frozen where it is. */
export function freezeLinks(doc: PartDocument, featureId?: string): void {
  for (const f of doc.features) {
    if (!f.sketch || (featureId && f.id !== featureId)) continue;
    // Plane: the frozen face remains (behaviour of a face of the part itself).
    delete f.sketch.plane.external;
    for (const g of f.sketch.geometry) if (g.projected?.kind === "external") g.projected.frozen = true;
  }
}
