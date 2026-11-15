import * as THREE from "three";
import type { GeomRef, MeshPayload } from "@solidus-cad/sdk";
import { edgeRef, faceOfTriangle, faceRef, pickEdge, planarFace } from "./refpick.ts";
import { edgePoints } from "./mate-pick.ts";

/**
 * Ghosts of the in-place edit: the other parts of the assembly, translucent, in the coordinate system of the edited part.
 * Their edges and faces can be picked (projection, dimension, sketch plane); references are
 * expressed in the coordinate system of the source part, positions in that of the edited part.
 */

export interface GhostItem {
  /** Occurrence (path in the context assembly). */
  key: string;
  mesh: MeshPayload;
  /** Matrix of the source part in the coordinate system of the edited part (column-major). */
  matrix: number[];
}

type V3 = [number, number, number];

/** Edge of a ghost: reference (source coordinate system) and polyline (edited part coordinate system). */
export interface GhostEdge {
  key: string;
  ref: GeomRef;
  points: V3[];
}

/** Planar face of a ghost: reference (source coordinate system) and plane (edited part coordinate system). */
export interface GhostFace {
  key: string;
  ref: GeomRef;
  plane: { p: V3; n: V3 } | null;
}

interface Entry {
  item: GhostItem;
  matrix: THREE.Matrix4;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
}

const GHOST_COLOR = 0x9aa4b2;
const GHOST_EDGE = 0x5d6878;
const SELECT_COLOR = 0x3b82f6;

export class GhostLayer {
  readonly group = new THREE.Group();
  private entries: Entry[] = [];
  private selection: THREE.Mesh | null = null;
  private readonly material = new THREE.MeshStandardMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
  private readonly edgeMaterial = new THREE.LineBasicMaterial({ color: GHOST_EDGE, transparent: true, opacity: 0.6 });

  get active(): boolean {
    return this.entries.length > 0;
  }

  setItems(items: GhostItem[] | null): void {
    // Geometries are reused when the mesh of an occurrence has not changed (only its position moves).
    const old = new Map(this.entries.map((e) => [e.item.key, e]));
    const next: Entry[] = [];
    for (const item of items ?? []) {
      const prev = old.get(item.key);
      const matrix = new THREE.Matrix4().fromArray(item.matrix);
      if (prev && prev.item.mesh === item.mesh) {
        old.delete(item.key);
        prev.item = item;
        prev.matrix = matrix;
        for (const o of [prev.mesh, prev.edges]) {
          o.matrix.copy(matrix);
          o.matrixWorldNeedsUpdate = true;
        }
        next.push(prev);
        continue;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(item.mesh.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(item.mesh.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(item.mesh.indices, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.renderOrder = 2;
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(item.mesh.edges, 3));
      const edges = new THREE.LineSegments(eg, this.edgeMaterial);
      edges.renderOrder = 2;
      for (const o of [mesh, edges]) {
        o.matrixAutoUpdate = false;
        o.matrix.copy(matrix);
        this.group.add(o);
      }
      next.push({ item, matrix, mesh, edges });
    }
    for (const e of old.values()) this.dispose(e);
    this.entries = next;
    this.select(null);
  }

  private dispose(e: Entry): void {
    this.group.remove(e.mesh, e.edges);
    e.mesh.geometry.dispose();
    e.edges.geometry.dispose();
  }

  /** Face of a ghost under the ray (closest), with the hit distance. */
  faceAt(raycaster: THREE.Raycaster): (GhostFace & { distance: number }) | null {
    if (!this.entries.length) return null;
    const hit = raycaster.intersectObjects(this.entries.map((e) => e.mesh), false)[0];
    const entry = hit && this.entries.find((e) => e.mesh === hit.object);
    if (!hit || !entry || hit.faceIndex == null) return null;
    const m = entry.item.mesh;
    const face = faceOfTriangle(m, hit.faceIndex);
    const pl = planarFace(m, face);
    const plane = pl ? { p: this.point(entry, pl.p), n: this.dir(entry, pl.n) } : null;
    return { key: entry.item.key, ref: faceRef(m, face), plane, distance: hit.distance };
  }

  /** Edge of a ghost closest to the pointer (px), or null beyond `tolPx`. */
  edgeAt(camera: THREE.Camera, width: number, height: number, sx: number, sy: number, tolPx: number, occlusion?: { ray: THREE.Ray; maxDist: number }): GhostEdge | null {
    let best: { entry: Entry; e: number; d: number } | null = null;
    for (const entry of this.entries) {
      // Projection of the source part points: a camera whose view includes the ghost matrix.
      const cam = camera.clone();
      cam.matrixWorldInverse.copy(camera.matrixWorldInverse).multiply(entry.matrix);
      const local = new THREE.Matrix4().copy(entry.matrix).invert();
      const occ = occlusion ? { ray: occlusion.ray.clone().applyMatrix4(local), maxDist: occlusion.maxDist } : undefined;
      const e = pickEdge(entry.item.mesh, cam, width, height, sx, sy, best ? best.d : tolPx, occ);
      if (e >= 0) best = { entry, e, d: screenDistance(entry.item.mesh, e, cam, width, height, sx, sy) };
    }
    if (!best) return null;
    const m = best.entry.item.mesh;
    return { key: best.entry.item.key, ref: edgeRef(m, best.e), points: edgePoints(m, best.e).map((p) => this.point(best!.entry, [p.x, p.y, p.z])) };
  }

  /** Selected face of a ghost, highlighted (null: none). */
  select(face: { key: string; ref: GeomRef } | null): void {
    if (this.selection) {
      this.group.remove(this.selection);
      this.selection.geometry.dispose();
      (this.selection.material as THREE.Material).dispose();
      this.selection = null;
    }
    const entry = face ? this.entries.find((e) => e.item.key === face.key) : undefined;
    if (!face || !entry) return;
    const m = entry.item.mesh;
    let idx = -1;
    let bestD = Infinity;
    for (let f = 0; f < m.faceGroups.length / 3; f++) {
      const r = faceRef(m, f);
      const d = Math.hypot(r.p[0] - face.ref.p[0], r.p[1] - face.ref.p[1], r.p[2] - face.ref.p[2]);
      if (d < bestD) {
        bestD = d;
        idx = f;
      }
    }
    if (idx < 0) return;
    const start = m.faceGroups[idx * 3]!;
    const count = m.faceGroups[idx * 3 + 1]!;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(m.indices.slice(start, start + count), 1));
    const mat = new THREE.MeshBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const sel = new THREE.Mesh(geo, mat);
    sel.matrixAutoUpdate = false;
    sel.matrix.copy(entry.matrix);
    sel.renderOrder = 3;
    this.selection = sel;
    this.group.add(sel);
  }

  private point(e: Entry, p: V3): V3 {
    const v = new THREE.Vector3(...p).applyMatrix4(e.matrix);
    return [v.x, v.y, v.z];
  }

  private dir(e: Entry, d: V3): V3 {
    const v = new THREE.Vector3(...d).transformDirection(e.matrix);
    return [v.x, v.y, v.z];
  }
}

/** Distance (px) from the pointer to edge `e` projected on screen. */
function screenDistance(m: MeshPayload, e: number, camera: THREE.Camera, width: number, height: number, sx: number, sy: number): number {
  const pts = edgePoints(m, e).map((p) => {
    const v = p.clone().project(camera);
    return new THREE.Vector2(((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height);
  });
  const q = new THREE.Vector2(sx, sy);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const ab = pts[i + 1]!.clone().sub(a);
    const t = Math.max(0, Math.min(1, q.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
    best = Math.min(best, a.clone().add(ab.multiplyScalar(t)).distanceTo(q));
  }
  return best;
}
