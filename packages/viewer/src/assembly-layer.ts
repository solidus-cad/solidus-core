import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Finish, MeshPayload } from "@solidus-cad/sdk";
import { disposePaint, paintMesh } from "./paint.ts";

/** Occurrence of a part in an assembly. */
export interface AsmItem {
  key: string;
  /** Mesh of the part (absent for a skeleton part without volume). */
  mesh: MeshPayload | null;
  /** 3D segments in the coordinate system of the part (sketches of a skeleton, toolpaths). */
  lines?: Float32Array;
  /** Color of the segments (purple for sketches by default). */
  lineColor?: string;
  /** 4×4 column-major matrix (three.js convention). */
  matrix: number[];
  color: string;
  /** Finish of the part (surface appearance), absent: color only. */
  finish?: Finish;
  /** Own color of each mesh face (see `faceColorsOf`), null: `color`. */
  faceColors?: (string | null)[];
  selected?: boolean;
  hidden?: boolean;
  fixed?: boolean;
  /** Opacity (< 1: transparent occurrence, drawn alone, outside the batch; stock of the CAM workbench). */
  opacity?: number;
}

interface Built {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  finish: Finish | null;
  mesh: THREE.Mesh | null;
  /** Edges of the occurrence itself (shown only when it is drawn alone). */
  edges: THREE.LineSegments | null;
  source: MeshPayload | null;
  lines?: Float32Array;
  selected: boolean;
  /** Drawn alone (selection, hover, gizmo, excluded from the section) rather than in the batch of its part. */
  alone: boolean;
  /** Faces with their own color, drawn over the occurrence (alone or in its batch), and their signature. */
  paint: THREE.Mesh | null;
  paintKey: string;
  opacity: number;
}

/** Regular occurrences of the same part, drawn in two calls (faces, edges). */
interface Batch {
  mesh: THREE.InstancedMesh;
  finish: Finish | null;
  lines: THREE.LineSegments;
  capacity: number;
}

interface Shared {
  geo: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
  users: number;
  batch: Batch | null;
}

const EDGE = 0x1d2430;
const SELECT = 0x2f80ed;
const HOVER = 0xf2a33a;

const faceMaterial = (color: THREE.ColorRepresentation) =>
  new THREE.MeshStandardMaterial({
    color,
    metalness: 0.15,
    roughness: 0.55,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: THREE.DoubleSide,
  });

/**
 * Assembly layer of the view: one geometry per part, shared by all its occurrences,
 * occurrence selection and translate / rotate gizmo.
 *
 * Instanced rendering: the regular occurrences of a part are drawn by a batch (InstancedMesh for the
 * faces, instanced edges), i.e. two calls per part rather than per occurrence. Each occurrence keeps its
 * own mesh (material invisible outside the batch) for picking, snapping, sectioning and framing.
 */
export class AssemblyLayer {
  readonly root = new THREE.Group();
  /** Geometries shared by the occurrences of a same part, released (GPU) when no occurrence uses them any more. */
  private readonly geometries = new Map<MeshPayload, Shared>();
  private readonly items = new Map<string, Built>();
  /** Parts whose batch must be rebuilt. */
  private readonly dirty = new Set<MeshPayload>();
  private readonly gizmo: TransformControls;
  private gizmoTarget: string | null = null;
  private hovered: string | null = null;
  /** Occurrences highlighted from outside the view (pointer over their node in the tree). */
  private marked = new Set<string>();
  /** Occurrences to draw alone (excluded from the section: their section planes differ from those of the batch). */
  private solo: ((key: string) => boolean) | null = null;
  private readonly raycaster = new THREE.Raycaster();
  /** Hit filter (section: removed material cannot be picked). */
  hitFilter: ((key: string, point: THREE.Vector3) => boolean) | null = null;
  /** Occurrence under the pointer changed (null: none). */
  onHover: ((key: string | null) => void) | null = null;
  /** Material of a finish (provided by the view: shared reflections and patterns); absent: color only. */
  finishMaterial: ((finish: Finish, color: THREE.ColorRepresentation) => THREE.MeshStandardMaterial) | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    dom: HTMLElement,
    orbit: OrbitControls,
    private readonly requestRender: () => void,
    private readonly onMoved: (key: string, matrix: number[], final: boolean) => void,
  ) {
    scene.add(this.root);
    this.gizmo = new TransformControls(camera, dom);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      orbit.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value && this.gizmoTarget) this.emit(true);
    });
    this.gizmo.addEventListener("objectChange", () => this.emit(false));
    this.gizmo.addEventListener("change", () => requestRender());
    scene.add(this.gizmo.getHelper());
  }

  get active(): boolean {
    return this.items.size > 0;
  }

  /** True during a manipulation (the click that ends it must not change the selection). */
  get dragging(): boolean {
    return this.gizmo.dragging;
  }

  /** Occurrences, distinct parts and occurrences drawn alone (status bar). */
  stats(): { occurrences: number; parts: number; alone: number } {
    let alone = 0;
    for (const b of this.items.values()) if (b.alone && b.mesh && b.group.visible) alone++;
    return { occurrences: this.items.size, parts: this.geometries.size, alone };
  }

  setItems(items: AsmItem[] | null): void {
    const keep = new Set((items ?? []).map((i) => i.key));
    for (const [k, b] of this.items) {
      if (keep.has(k)) continue;
      this.release(b);
      this.items.delete(k);
    }
    for (const it of items ?? []) {
      let b = this.items.get(it.key);
      if (b && (b.source !== it.mesh || b.lines !== it.lines)) {
        // Part recomputed: the occurrence is rebuilt with the new geometry.
        this.release(b);
        b = undefined;
      }
      if (!b) {
        b = this.build(it);
        this.items.set(it.key, b);
        this.root.add(b.group);
      }
      // During a manipulation, the occurrence takes the pose allowed by its constraints (the manipulator recomputes
      // its own from the start of the drag at each movement).
      const m = new THREE.Matrix4().fromArray(it.matrix);
      // An occurrence moved with the gizmo is driven by position/rotation; its matrix is kept in step (attach()
      // decomposes it again).
      if (b.group.matrixAutoUpdate) {
        m.decompose(b.group.position, b.group.quaternion, b.group.scale);
        b.group.updateMatrix();
      } else b.group.matrix.copy(m);
      b.group.visible = !it.hidden;
      b.selected = !!it.selected;
      if (b.finish !== (it.finish ?? null)) this.refinish(b, it.finish ?? null);
      b.material.color.set(it.color);
      b.opacity = it.opacity ?? 1;
      b.material.transparent = b.opacity < 1;
      b.material.opacity = b.opacity;
      b.material.depthWrite = b.opacity >= 1;
      this.repaint(b, it.faceColors);
      this.applyEmissive(it.key, b);
      this.updateAlone(it.key, b);
      // Position, color or visibility may have changed: the batch is copied.
      if (b.source) this.dirty.add(b.source);
    }
    if (this.gizmoTarget && !keep.has(this.gizmoTarget)) this.attach(null);
    this.flush();
    this.requestRender();
  }

  /** Moves occurrences already displayed (animation): matrices only, without rebuilding or repainting. */
  setMatrices(matrices: Record<string, number[]>): void {
    const m = new THREE.Matrix4();
    for (const [key, matrix] of Object.entries(matrices)) {
      const b = this.items.get(key);
      if (!b) continue;
      m.fromArray(matrix);
      if (b.group.matrixAutoUpdate) m.decompose(b.group.position, b.group.quaternion, b.group.scale);
      else b.group.matrix.copy(m);
      if (b.source) this.dirty.add(b.source);
    }
    this.flush();
    this.requestRender();
  }

  /** Attaches the gizmo to an occurrence (or detaches it). */
  attach(key: string | null, mode: "translate" | "rotate" = "translate"): void {
    const prev = this.gizmoTarget ? this.items.get(this.gizmoTarget) : undefined;
    this.gizmoTarget = key;
    if (prev) this.updateAlone(prev.group.userData.asmKey as string, prev);
    const b = key ? this.items.get(key) : undefined;
    if (b) {
      // TransformControls acts on position/quaternion: the occurrence matrix is decomposed.
      b.group.matrixAutoUpdate = true;
      b.group.matrix.decompose(b.group.position, b.group.quaternion, b.group.scale);
      this.updateAlone(key!, b);
      this.gizmo.attach(b.group);
      this.gizmo.setMode(mode);
    } else {
      this.gizmo.detach();
    }
    this.flush();
    this.requestRender();
  }

  setGizmoMode(mode: "translate" | "rotate"): void {
    this.gizmo.setMode(mode);
  }

  /** Occurrence under the pointer (normalized coordinates), with the hit point and the face hit. */
  pick(ndc: THREE.Vector2): { key: string; point: THREE.Vector3; faceIndex: number } | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    // A transparent occurrence (stock of the CAM workbench) lets clicks through to what it contains.
    const meshes = [...this.items.values()].filter((b) => b.group.visible && b.mesh && b.opacity >= 1).map((b) => b.mesh!);
    for (const hit of this.raycaster.intersectObjects(meshes, false)) {
      const key = hit.object.parent?.userData.asmKey as string | undefined;
      if (!key || hit.faceIndex == null) continue;
      if (this.hitFilter && !this.hitFilter(key, hit.point)) continue;
      return { key, point: hit.point, faceIndex: hit.faceIndex };
    }
    return null;
  }

  setHover(key: string | null): void {
    if (key === this.hovered) return;
    const prevKey = this.hovered;
    this.hovered = key;
    this.onHover?.(key);
    for (const k of [prevKey, key]) {
      const b = k ? this.items.get(k) : undefined;
      if (!b) continue;
      this.applyEmissive(k!, b);
      this.updateAlone(k!, b);
    }
    this.flush();
    this.requestRender();
  }

  /** Occurrences highlighted like the hovered one, without the pointer being over them (tree node hovered). */
  setMarked(keys: readonly string[]): void {
    const next = new Set(keys);
    if (next.size === this.marked.size && [...next].every((k) => this.marked.has(k))) return;
    const touched = new Set([...this.marked, ...next]);
    this.marked = next;
    for (const k of touched) {
      const b = this.items.get(k);
      if (!b) continue;
      this.applyEmissive(k, b);
      this.updateAlone(k, b);
    }
    this.flush();
    this.requestRender();
  }

  /**
   * Glow of an occurrence: selection first (stronger), then hover (pointer or tree). Applied to the body and to its
   * painted faces, which have their own material and would otherwise keep their color.
   */
  private applyEmissive(key: string, b: Built): void {
    const lit = this.hovered === key || this.marked.has(key);
    const hex = b.selected ? SELECT : lit ? HOVER : 0x000000;
    const intensity = b.selected ? 0.6 : 0.35;
    const paint = b.paint?.material as THREE.MeshStandardMaterial | undefined;
    for (const m of paint ? [b.material, paint] : [b.material]) {
      m.emissive.setHex(hex);
      m.emissiveIntensity = intensity;
    }
  }

  /** Occurrences to draw outside the batch (excluded from the section); called before each render. */
  setSolo(fn: ((key: string) => boolean) | null): void {
    this.solo = fn;
    for (const [key, b] of this.items) this.updateAlone(key, b);
    this.flush();
  }

  /** Visible bodies, with their color (section fill). */
  solids(): { key: string; mesh: THREE.Mesh; color: THREE.Color }[] {
    return [...this.items].filter(([, b]) => b.group.visible && b.mesh).map(([key, b]) => ({ key, mesh: b.mesh!, color: b.material.color }));
  }

  /** Visible parts with their source mesh and world matrix (snapping of measurement points). */
  snapTargets(): { key: string; mesh: THREE.Mesh; payload: MeshPayload; matrix: THREE.Matrix4 }[] {
    const out: { key: string; mesh: THREE.Mesh; payload: MeshPayload; matrix: THREE.Matrix4 }[] = [];
    for (const [key, b] of this.items) {
      if (!b.group.visible || !b.mesh || !b.source) continue;
      b.mesh.updateWorldMatrix(true, false);
      out.push({ key, mesh: b.mesh, payload: b.source, matrix: b.mesh.matrixWorld.clone() });
    }
    return out;
  }

  /** Bounding sphere of the whole assembly (for zoom to fit). */
  boundingSphere(): THREE.Sphere | null {
    if (this.items.size === 0) return null;
    const box = new THREE.Box3().setFromObject(this.root);
    return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
  }

  dispose(): void {
    this.setItems(null);
    this.gizmo.dispose();
  }

  private emit(final: boolean): void {
    const b = this.gizmoTarget ? this.items.get(this.gizmoTarget) : undefined;
    if (!b || !this.gizmoTarget) return;
    b.group.updateMatrix();
    this.onMoved(this.gizmoTarget, b.group.matrix.toArray(), final);
  }

  /** Switches the occurrence between its batch and its own drawing; the affected batch is marked for rebuild. */
  private updateAlone(key: string, b: Built): void {
    const alone = !!b.mesh && (b.selected || b.opacity < 1 || this.hovered === key || this.marked.has(key) || this.gizmoTarget === key || !!this.solo?.(key));
    if (alone === b.alone) return;
    b.alone = alone;
    b.material.visible = alone;
    if (b.edges) b.edges.visible = alone;
    if (b.source) this.dirty.add(b.source);
  }

  /** Copies matrices and colors of the regular occurrences into the batch of each marked part. */
  private flush(): void {
    if (this.dirty.size === 0) return;
    const members = new Map<MeshPayload, Built[]>();
    for (const src of this.dirty) members.set(src, []);
    for (const b of this.items.values()) {
      if (!b.source || b.alone || !b.group.visible) continue;
      members.get(b.source)?.push(b);
    }
    this.dirty.clear();
    for (const [src, list] of members) {
      const g = this.geometries.get(src);
      if (g) this.fillBatch(g, list);
    }
  }

  private fillBatch(g: Shared, list: Built[]): void {
    if (list.length === 0) {
      this.dropBatch(g);
      return;
    }
    // All occurrences of a part share its finish: the batch follows the first one.
    const finish = list[0]!.finish;
    if (!g.batch || g.batch.capacity < list.length || g.batch.finish !== finish) {
      const capacity = Math.max(list.length, g.batch && g.batch.finish === finish ? g.batch.capacity * 2 : 0);
      this.dropBatch(g);
      g.batch = this.makeBatch(g, capacity, finish);
    }
    const { mesh, lines } = g.batch;
    list.forEach((b, i) => {
      if (b.group.matrixAutoUpdate) b.group.updateMatrix();
      mesh.setMatrixAt(i, b.group.matrix);
      mesh.setColorAt(i, b.material.color);
    });
    mesh.count = list.length;
    (lines.geometry as THREE.InstancedBufferGeometry).instanceCount = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    // Bounds of the instances: framing (Box3.setFromObject) and off-screen culling.
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    lines.geometry.boundingBox = mesh.boundingBox!.clone();
    lines.geometry.boundingSphere = mesh.boundingSphere!.clone();
  }

  private makeBatch(g: Shared, capacity: number, finish: Finish | null): Batch {
    // White: the color of each occurrence comes from its instance.
    const mesh = new THREE.InstancedMesh(g.geo, this.materialOf(finish, 0xffffff), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(0xffffff));
    // Edges: instanced geometry that reads the matrices of the face batch (same attribute, uploaded once).
    // Position attribute distinct from that of the lone occurrences, so that the batch can be released without touching them.
    const lg = new THREE.InstancedBufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(g.edges.getAttribute("position").array, 3));
    lg.setAttribute("instanceMatrix", mesh.instanceMatrix);
    const lm = new THREE.LineBasicMaterial({ color: EDGE });
    // Enables the shader instancing block (normally reserved for InstancedMesh).
    lm.defines = { USE_INSTANCING: "" };
    const lines = new THREE.LineSegments(lg, lm);
    this.root.add(mesh, lines);
    return { mesh, lines, capacity, finish };
  }

  private dropBatch(g: Shared): void {
    const bt = g.batch;
    if (!bt) return;
    this.root.remove(bt.mesh, bt.lines);
    bt.mesh.dispose();
    (bt.mesh.material as THREE.Material).dispose();
    bt.lines.geometry.dispose();
    (bt.lines.material as THREE.Material).dispose();
    g.batch = null;
  }

  /** Removes an occurrence from the scene and releases what belongs to it (and the shared geometry, if it was the last user). */
  private release(b: Built): void {
    disposePaint(b.paint);
    this.root.remove(b.group);
    b.group.traverse((o) => {
      const line = o as THREE.LineSegments;
      if (!line.isLineSegments) return;
      (line.material as THREE.Material).dispose();
      if (b.lines && line.geometry.getAttribute("position")?.array === b.lines) line.geometry.dispose();
    });
    b.material.dispose();
    const g = b.source ? this.geometries.get(b.source) : undefined;
    if (!g) return;
    if (--g.users === 0) {
      this.dropBatch(g);
      g.geo.disposeBoundsTree?.();
      g.geo.dispose();
      g.edges.dispose();
      this.geometries.delete(b.source!);
      this.dirty.delete(b.source!);
    } else {
      this.dirty.add(b.source!);
    }
  }

  private shared(m: MeshPayload): Shared {
    let g = this.geometries.get(m);
    if (!g) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.computeBoundsTree({ indirect: true });
      geo.computeBoundingSphere();
      const edges = new THREE.BufferGeometry();
      edges.setAttribute("position", new THREE.BufferAttribute(m.edges, 3));
      g = { geo, edges, users: 0, batch: null };
      this.geometries.set(m, g);
    }
    g.users++;
    return g;
  }

  private build(it: AsmItem): Built {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.userData.asmKey = it.key;
    if (it.lines?.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(it.lines, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: it.lineColor ?? 0x8a4fc7 }));
      l.renderOrder = 2;
      group.add(l);
    }
    const finish = it.finish ?? null;
    const material = this.materialOf(finish, it.color);
    const base = { group, material, finish, source: it.mesh, lines: it.lines, selected: !!it.selected, alone: true, paint: null, paintKey: "", opacity: 1 };
    if (!it.mesh) return { ...base, mesh: null, edges: null };
    const { geo, edges } = this.shared(it.mesh);
    const mesh = new THREE.Mesh(geo, material);
    const edgeLines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: EDGE }));
    group.add(mesh, edgeLines);
    return { ...base, mesh, edges: edgeLines };
  }

  private materialOf(finish: Finish | null, color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
    return (finish && this.finishMaterial?.(finish, color)) || faceMaterial(color);
  }

  /** Changes the finish of an occurrence: new material (same visibility), batch of its part to rebuild. */
  private refinish(b: Built, finish: Finish | null): void {
    const material = this.materialOf(finish, b.material.color);
    material.visible = b.material.visible;
    b.material.dispose();
    b.material = material;
    b.finish = finish;
    if (b.mesh) b.mesh.material = material;
    if (b.source) this.dirty.add(b.source);
  }

  /** Recreates the paint layer of an occurrence if its face colors have changed. */
  private repaint(b: Built, colors: (string | null)[] | undefined): void {
    const key = colors?.some((c) => c) ? colors.join(",") : "";
    if (key === b.paintKey) return;
    disposePaint(b.paint);
    b.paint = b.mesh && b.source && key ? paintMesh(b.mesh.geometry, b.source, colors!) : null;
    if (b.paint) b.group.add(b.paint);
    b.paintKey = key;
    if (b.paint) this.applyEmissive(b.group.userData.asmKey as string, b);
  }
}
