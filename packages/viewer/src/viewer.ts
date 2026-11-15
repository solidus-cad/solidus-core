import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { DatumRef, DatumRole, Finish, GeomRef, MateRefKind, MeshPayload, PlaneFrame } from "@solidus-cad/sdk";
import { pickDatumRef } from "./datum-pick.ts";
import { acceptsRef, edgeRef, faceRef, matchRef, pickEdge, planarFace, type RefFilter } from "./refpick.ts";
import { disposePaint, paintMesh, tintBackFaces } from "./paint.ts";
import { createFinishMaterial, disposeFinishTextures } from "./finish.ts";
import { freeEdgeLines } from "./bodies.ts";
import { ViewCube, type ViewCubeLabels } from "./viewcube.ts";
import { AssemblyLayer, type AsmItem } from "./assembly-layer.ts";
import { GhostLayer, type GhostFace, type GhostItem } from "./ghost-layer.ts";
import { inLamp, isExcluded, LAMP_SIDES, lampPlanes, SectionCaps, sectionPlane, type SectionSettings } from "./section.ts";
import { circleAt, circlePoints, snapAt, type CirclePick, type SnapPoint, type SnapTarget } from "./snap.ts";
import { edgePoints, mateEntityAt, type MatePick } from "./mate-pick.ts";
import { buildAnalysis, disposeObject, moveParticles, type AnalysisOverlay } from "./analysis-layer.ts";
import { analysisMaterial, applyValues, type ShadingAnalysis } from "./shading-analysis.ts";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Realistic rendering: environment intensity, share kept from the ambient and camera lights. */
const ENV_INTENSITY = 0.45;
const REAL_HEMI = 0.6;
const REAL_HEAD = 1;

export type DisplayMode = "shaded" | "shadedEdges" | "wireframe" | "hiddenLines";
export type StandardView = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso";

/** View state: position, target, up vector and zoom (orthographic camera). */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  zoom?: number;
}

/** Camera direction toward the target (Z-up coordinate system). */
const VIEW_DIRS: Record<StandardView, [number, number, number]> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  iso: [1, -1, 1],
};

export interface FacePick {
  /** Index of the face in the current mesh. */
  index: number;
  /** Identifier provided by the kernel. */
  id: number;
}

export interface ViewerEvents {
  hover?(face: FacePick | null): void;
  select?(faces: FacePick[]): void;
  /** Click on a reference plane (when no face is under the pointer). */
  planePick?(plane: string): void;
  /** Assembly: click on an occurrence (null: click on empty space). */
  componentPick?(key: string | null, additive: boolean, hit: { faceIndex: number; point: [number, number, number] } | null): void;
  /** Assembly: occurrence moved with the gizmo (`final` on release). */
  componentMoved?(key: string, matrix: number[], final: boolean): void;
  /** In-place edit: face of another part (ghost) clicked, or null when it is deselected. */
  ghostPick?(face: GhostFace | null): void;
}

const EDGE_COLOR = 0x1d2430;
const HOVER_COLOR = 0xf2a33a;

type V3 = { x: number; y: number; z: number };

/** Closed region of a sketch: outline and holes in the plane coordinate system. */
/** Displayed reference plane: identifier (reported by `planePick`), coordinate system and center of the drawing. */
export interface DatumPlaneView {
  id: string;
  frame: PlaneFrame;
  center: V3;
}

export interface SketchRegion {
  frame: { origin: V3; xDir: V3; yDir: V3 };
  outer: { x: number; y: number }[];
  holes: { x: number; y: number }[][];
  /** Selected sketch: highlight color. */
  active?: boolean;
}
const SELECT_COLOR = 0x2f80ed;
const MEASURE_COLOR = 0xd6336c;
const SNAP_COLOR = 0x2f9e5b;

/**
 * 3D view: rendering on demand (nothing is drawn while nothing moves), picking accelerated by BVH.
 */
export class Viewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  private readonly grid = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly viewCube: ViewCube;
  private readonly resizeObserver: ResizeObserver;

  private mesh: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;
  private hiddenEdges: THREE.LineSegments | null = null;
  /** Free edges of surfaces, underlined. */
  private freeEdges: THREE.LineSegments | null = null;
  private hoverMesh: THREE.Mesh | null = null;
  private selectMesh: THREE.Mesh | null = null;
  /** Faces with their own color (color per face or per feature), laid over the body. */
  private paint: THREE.Mesh | null = null;
  private faceColors: (string | null)[] = [];
  private faceStarts: Int32Array = new Int32Array(0);
  private payload: MeshPayload | null = null;
  private mode: DisplayMode = "shadedEdges";
  private hovered: number | null = null;
  private selected: number[] = [];
  private needsRender = true;
  /** Video capture in progress: zoom factor (video height / view height) and pixel density to restore. */
  private capture: { scale: number; ratio: number } | null = null;
  /** Draw calls and triangles of the last scene render (excluding the view cube). */
  private lastRender = { calls: 0, triangles: 0 };
  private frame = 0;
  private animation: { from: THREE.Vector3; to: THREE.Vector3; up0: THREE.Vector3; up1: THREE.Vector3; t0: number } | null = null;
  private down: { x: number; y: number } | null = null;
  private pickingEnabled = true;
  private readonly planes = new THREE.Group();
  private planeState: Partial<Record<"XY" | "XZ" | "YZ", boolean>> = {};
  private selectedPlane: string | null = null;
  private bodyVisible = true;
  private readonly assembly: AssemblyLayer;
  /** Other parts of the assembly during the in-place edit of a part. */
  private readonly ghosts = new GhostLayer();
  private ghostSelected = false;
  /** Picking of edges or faces for a feature (fillet, shell…). */
  private refMode: { kind: "edge" | "face"; onPick: (ref: GeomRef) => void; filter?: RefFilter } | null = null;
  private markedRefs: GeomRef[] = [];
  private hoverEdge = -1;
  private edgeOverlay: THREE.LineSegments | null = null;
  private markOverlay: THREE.Object3D | null = null;
  private sketchLines: THREE.LineSegments | null = null;
  private sketchRegions: THREE.Group | null = null;
  private readonly viewListeners = new Set<() => void>();
  /** Section plane (null: no section). */
  private section: SectionSettings | null = null;
  private readonly clipPlane = new THREE.Plane();
  /** Stable arrays: a material changes program only when the section is enabled or removed. */
  private readonly clipOn: THREE.Plane[] = [this.clipPlane];
  private readonly clipOff: THREE.Plane[] = [];
  private readonly caps = new SectionCaps();
  private sectionDirty = false;
  /** Section lamp: point aimed at (null: not placed), planes (sides, then bottom) and center of the bottom. */
  private lampCenter: THREE.Vector3 | null = null;
  private readonly lampOn: THREE.Plane[] = Array.from({ length: LAMP_SIDES + 1 }, () => new THREE.Plane());
  private readonly lampBottom = new THREE.Vector3();
  /** Aiming the lamp: hits ignore the hole (otherwise it would dig deeper at each move). */
  private lampProbe = false;
  /** Hatching pitch of the section fill (mm). */
  private hatchPitch = 1;
  /** Measurement: clicks pick snapped points instead of selecting. */
  private pointPick: ((p: SnapPoint) => void) | null = null;
  /** Diameter / radius measurement: clicks pick a circular edge or a cylindrical face. */
  private circlePick: ((c: CirclePick) => void) | null = null;
  private circlePreview: THREE.Group | null = null;
  private datumPlanes: DatumPlaneView[] = [];
  private datumPick: { role: DatumRole; onPick: (ref: DatumRef) => void } | null = null;
  private datumMarks: THREE.Object3D | null = null;
  /** Assembly constraint in progress: pickable elements, hovered element and elements already chosen. */
  private matePick: { accept: (key: string, kind: MateRefKind) => boolean; onPick: (p: MatePick) => void } | null = null;
  private mateHover: { pick: MatePick; obj: THREE.Object3D } | null = null;
  private mateMarks: MatePick[] = [];
  private mateMarkObj: THREE.Object3D | null = null;
  private snapMarker: THREE.Points | null = null;
  private measureOverlay: THREE.Group | null = null;
  private readonly dotTextures = new Map<number, THREE.Texture>();
  /** Center of gravity / center of volume (mass measurement). */
  private massMarkers: THREE.Group | null = null;
  private readonly symbolTextures = new Map<"cog" | "cov", THREE.Texture>();
  /** Structures and FEM workbenches: model, loads and displayed results. */
  private readonly analysisLayers = new Map<string, THREE.Group>();
  /** Structures and FEM workbenches: clicks (and hovers) pick nodes or bars, identified by the caller. */
  private analysisPick: { click: (x: number, y: number) => void; move?: (x: number, y: number) => void } | null = null;

  /** Dark theme: parts lightened, edges and grid adapted to the background. */
  private dark = false;
  /** Realistic rendering: reflections from an environment (lit room), ambient light reduced accordingly. */
  private realistic = false;
  /** Prefiltered environment for realistic rendering, computed on first use. */
  private envMap: THREE.Texture | null = null;
  /** Rendered material of the part (replaces its color), with its own reflections even without realistic rendering. */
  private finish: { kind: Finish; material: THREE.MeshStandardMaterial } | null = null;
  private gridSize = 200;
  /** Surface analysis shown instead of the material of the part (zebra, draft, curvature), and its material. */
  private shading: { analysis: ShadingAnalysis; material: THREE.ShaderMaterial } | null = null;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xaab2be, 2.2);
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.6);

  private readonly material = new THREE.MeshStandardMaterial({
    color: 0x8fa8c8,
    metalness: 0.15,
    roughness: 0.55,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: THREE.DoubleSide,
  });

  /** Plain white faces of the "hidden lines" mode. */
  private readonly flatMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: THREE.DoubleSide,
  });

  constructor(
    private readonly container: HTMLElement,
    private readonly events: ViewerEvents = {},
  ) {
    // Stencil: section fill of the cut parts.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: "high-performance" });
    this.renderer.localClippingEnabled = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(200, -200, 200);

    tintBackFaces(this.material);
    this.scene.add(this.hemi);
    const headlight = this.headlight;
    headlight.position.set(0.4, 0.8, 2);
    this.camera.add(headlight);
    this.scene.add(this.camera, this.root, this.grid, this.planes, this.caps.group);
    this.root.add(this.ghosts.group);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    // Left drag = pan (a click without moving stays a selection), middle = rotate.
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("change", () => this.requestRender());

    this.viewCube = new ViewCube((dir, up) => this.animateTo(dir, up));
    this.assembly = new AssemblyLayer(this.scene, this.camera, this.renderer.domElement, this.controls, () => this.requestRender(), (k, m, final) =>
      this.events.componentMoved?.(k, m, final),
    );
    this.assembly.hitFilter = (key, p) => this.keeps(key, p);
    this.assembly.finishMaterial = (kind, color) => this.finishMaterial(kind, color);

    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", () => {
      if (this.viewCube.hover(null, el)) this.requestRender();
      this.setHover(null);
    });


    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.buildGrid(200);
    this.loop();
  }

  setMesh(payload: MeshPayload | null): void {
    const first = !this.payload && payload;
    this.clearMesh();
    this.payload = payload;
    if (!payload || payload.indices.length === 0) {
      this.requestRender();
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(payload.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(payload.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(payload.indices, 1));
    // "indirect": the BVH does not reorder the index, on which the triangle → face mapping depends.
    geo.computeBoundsTree({ indirect: true });
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, this.bodyMaterial());

    const starts = new Int32Array(payload.faceGroups.length / 3);
    for (let i = 0; i < starts.length; i++) starts[i] = payload.faceGroups[i * 3]!;
    this.faceStarts = starts;

    const egeo = new THREE.BufferGeometry();
    egeo.setAttribute("position", new THREE.BufferAttribute(payload.edges, 3));
    this.edges = new THREE.LineSegments(egeo, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
    this.hiddenEdges = new THREE.LineSegments(
      egeo,
      new THREE.LineDashedMaterial({ color: EDGE_COLOR, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 0.45, depthFunc: THREE.GreaterDepth }),
    );
    this.hiddenEdges.computeLineDistances();

    this.freeEdges = freeEdgeLines(payload);
    this.root.add(this.mesh, this.edges, this.hiddenEdges);
    if (this.freeEdges) this.root.add(this.freeEdges);
    // Face indices change on every recompute: the selection is no longer valid.
    if (this.selected.length) {
      this.selected = [];
      this.events.select?.([]);
    }
    this.applyMode();
    this.refreshMarks();
    this.buildGrid(geo.boundingSphere!.radius * 2);
    if (first) this.setView("iso", false);
    this.sectionDirty = true;
    this.requestRender();
  }

  /** 3D segments of the visible sketches (pairs of points), or null. */
  setSketchLines(segments: Float32Array | null, highlighted?: Float32Array | null): void {
    if (this.sketchLines) {
      this.scene.remove(this.sketchLines);
      for (const c of this.sketchLines.children as THREE.LineSegments[]) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
      this.sketchLines.geometry.dispose();
      (this.sketchLines.material as THREE.Material).dispose();
      this.sketchLines = null;
    }
    // The selected sketch may be the only visible one: `segments` is then empty.
    if (segments?.length || highlighted?.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(segments ?? new Float32Array(), 3));
      this.sketchLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2f6fd6 }));
      this.sketchLines.renderOrder = 2;
      if (highlighted?.length) {
        const hg = new THREE.BufferGeometry();
        hg.setAttribute("position", new THREE.BufferAttribute(highlighted, 3));
        this.sketchLines.add(new THREE.LineSegments(hg, new THREE.LineBasicMaterial({ color: HOVER_COLOR, depthTest: false })));
      }
      this.scene.add(this.sketchLines);
    }
    this.requestRender();
  }

  /** Closed regions of the visible sketches, filled with a transparent tint. */
  setSketchRegions(regions: SketchRegion[]): void {
    if (this.sketchRegions) {
      this.scene.remove(this.sketchRegions);
      for (const m of this.sketchRegions.children as THREE.Mesh[]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      this.sketchRegions = null;
    }
    const normal: number[] = [];
    const active: number[] = [];
    for (const r of regions) {
      const contour = r.outer.map((p) => new THREE.Vector2(p.x, p.y));
      const holes = r.holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
      // triangulateShape reorders the contours in place: vertices are read after the call.
      const triangles = THREE.ShapeUtils.triangulateShape(contour, holes);
      const all = [...contour, ...holes.flat()];
      const { origin: o, xDir: x, yDir: y } = r.frame;
      const out = r.active ? active : normal;
      for (const tri of triangles) {
        for (const i of tri) {
          const p = all[i]!;
          out.push(o.x + p.x * x.x + p.y * y.x, o.y + p.x * x.y + p.y * y.y, o.z + p.x * x.z + p.y * y.z);
        }
      }
    }
    if (normal.length || active.length) {
      this.sketchRegions = new THREE.Group();
      for (const [positions, color] of [
        [normal, 0x2f6fd6],
        [active, HOVER_COLOR],
      ] as const) {
        if (!positions.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        const material = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
          // In front of a coplanar body face: no flickering.
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const mesh = new THREE.Mesh(g, material);
        mesh.renderOrder = 1;
        this.sketchRegions.add(mesh);
      }
      this.scene.add(this.sketchRegions);
    }
    this.requestRender();
  }

  /** Orients the camera: `dir` goes from the target to the camera. */
  lookAlong(dir: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }, animate = true): void {
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    const u = new THREE.Vector3(up.x, up.y, up.z).normalize();
    if (animate) this.animateTo(d, u);
    else {
      this.placeCamera(d, u);
      this.requestRender();
    }
  }

  /** True during a camera animation (view change). */
  get animating(): boolean {
    return this.animation !== null;
  }

  setRotateEnabled(enabled: boolean): void {
    this.controls.enableRotate = enabled;
  }

  setPanEnabled(enabled: boolean): void {
    this.controls.enablePan = enabled;
  }

  /**
   * Left drag = pan (default), or pan only with Shift / Ctrl / Cmd held (sketch editing: a plain left drag is left
   * to the editor to move points). OrbitControls swaps PAN and ROTATE when a modifier is held, so LEFT = ROTATE
   * with rotation disabled gives exactly "modifier + drag = pan, plain drag = nothing".
   */
  setLeftDragPan(always: boolean): void {
    this.controls.mouseButtons = { ...this.controls.mouseButtons, LEFT: always ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE };
  }

  /** Right drag = pan (default), or nothing (the drag is then left to the gesture menu). */
  setRightDragPan(enabled: boolean): void {
    this.controls.mouseButtons = { ...this.controls.mouseButtons, RIGHT: enabled ? THREE.MOUSE.PAN : (-1 as THREE.MOUSE) };
  }

  /** Enables or disables face preselection and selection (disabled during sketch editing). */
  setPickingEnabled(enabled: boolean): void {
    this.pickingEnabled = enabled;
    if (!enabled) this.setHover(null);
  }

  /** Displayed reference planes (and selected plane, highlighted). */
  setReferencePlanes(state: Partial<Record<"XY" | "XZ" | "YZ", boolean>>, selected: string | null = null): void {
    this.planeState = { ...state };
    this.selectedPlane = selected;
    this.buildPlanes();
  }

  /** Shows or hides the body (to see only the sketches and the planes). */
  setBodyVisible(visible: boolean): void {
    this.bodyVisible = visible;
    this.applyMode();
  }

  private buildPlanes(): void {
    for (const c of [...this.planes.children]) {
      this.planes.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    }
    // Planes centered on the origin and symmetric: they cover the part on both sides, wherever it is.
    const sphere = this.assembly.boundingSphere() ?? this.mesh?.geometry.boundingSphere ?? null;
    const reach = sphere ? sphere.center.length() + sphere.radius : 50;
    const size = Math.max(reach * 2.3, 40);
    const defs: { name: "XY" | "XZ" | "YZ"; rot: [number, number, number] }[] = [
      { name: "XY", rot: [0, 0, 0] },
      { name: "XZ", rot: [Math.PI / 2, 0, 0] },
      { name: "YZ", rot: [0, -Math.PI / 2, 0] },
    ];
    for (const d of defs) {
      if (!this.planeState[d.name]) continue;
      const selected = this.selectedPlane === d.name;
      const g = new THREE.Group();
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: selected ? 0xf2a33a : 0x7aa3e0, transparent: true, opacity: selected ? 0.22 : 0.1, side: THREE.DoubleSide, depthWrite: false }),
      );
      quad.userData.plane = d.name;
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry), new THREE.LineBasicMaterial({ color: selected ? 0xe8891c : 0x4f7ec9 }));
      g.add(quad, border);
      g.rotation.set(...d.rot);
      quad.renderOrder = 1;
      this.planes.add(g);
    }
    // Reference planes: smaller, centered near the elements that define them.
    const dsize = Math.max(reach * 1.1, 30);
    for (const d of this.datumPlanes) {
      const selected = this.selectedPlane === d.id;
      const g = new THREE.Group();
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(dsize, dsize),
        new THREE.MeshBasicMaterial({ color: selected ? 0xf2a33a : 0x9b7ae0, transparent: true, opacity: selected ? 0.22 : 0.1, side: THREE.DoubleSide, depthWrite: false }),
      );
      quad.userData.plane = d.id;
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(quad.geometry), new THREE.LineBasicMaterial({ color: selected ? 0xe8891c : 0x7552c9 }));
      g.add(quad, border);
      const V = (a: { x: number; y: number; z: number }) => new THREE.Vector3(a.x, a.y, a.z);
      g.matrix.makeBasis(V(d.frame.xDir), V(d.frame.yDir), V(d.frame.normal)).setPosition(V(d.center));
      g.matrixAutoUpdate = false;
      quad.renderOrder = 1;
      this.planes.add(g);
    }
    this.requestRender();
  }

  /** Displayed reference planes (coordinate system, center); the selected plane is the one of `setReferencePlanes`. */
  setDatumPlanes(planes: DatumPlaneView[]): void {
    this.datumPlanes = planes.map((p) => ({ ...p }));
    this.buildPlanes();
  }

  /**
   * Picking of a construction element of a plane (planar face, axis, point, cylindrical face);
   * with the "plane" role, a click on a displayed plane (base or reference) also picks it. null: exits the mode.
   */
  setDatumPicking(role: DatumRole | null, onPick?: (ref: DatumRef) => void): void {
    this.datumPick = role && onPick ? { role, onPick } : null;
    this.setSnapMarker(null);
    this.setHover(null);
    this.assembly.setHover(null);
  }

  /**
   * Picking of the elements of an assembly constraint (vertex, edge, face): only those accepted by `accept`
   * are highlighted on hover and pickable. null: exits the mode.
   */
  setMatePicking(accept: ((key: string, kind: MateRefKind) => boolean) | null, onPick?: (p: MatePick) => void): void {
    this.matePick = accept && onPick ? { accept, onPick } : null;
    this.setMateHover(null);
    this.assembly.setHover(null);
  }

  /** Elements already chosen for the constraint in progress (highlighted in the selection color). */
  setMateMarks(marks: MatePick[]): void {
    this.mateMarks = marks;
    this.refreshMateMarks();
  }

  private refreshMateMarks(): void {
    this.disposeSceneObject(this.mateMarkObj);
    this.mateMarkObj = null;
    if (this.mateMarks.length) {
      const g = new THREE.Group();
      for (const m of this.mateMarks) {
        const o = this.mateOverlay(m, SELECT_COLOR);
        if (o) g.add(o);
      }
      this.mateMarkObj = g;
      this.scene.add(g);
    }
    this.requestRender();
  }

  private setMateHover(p: MatePick | null): void {
    const same = (a: MatePick, b: MatePick) => a.key === b.key && a.element === b.element && a.index === b.index && a.geom.p.join() === b.geom.p.join();
    if (p && this.mateHover && same(p, this.mateHover.pick)) return;
    if (!p && !this.mateHover) return;
    this.disposeSceneObject(this.mateHover?.obj ?? null);
    this.mateHover = null;
    const obj = p ? this.mateOverlay(p, HOVER_COLOR) : null;
    if (p && obj) {
      this.mateHover = { pick: p, obj };
      this.scene.add(obj);
    }
    this.renderer.domElement.style.cursor = p ? "crosshair" : "";
    this.requestRender();
  }

  /** Highlight of an occurrence element (world coordinates): tinted face, thickened edge or dot. */
  private mateOverlay(p: MatePick, color: number): THREE.Object3D | null {
    const t = this.assembly.snapTargets().find((x) => x.key === p.key);
    if (!t) return null;
    const m = t.payload;
    if (p.element === "vertex") return this.dots([new THREE.Vector3(...p.geom.p).applyMatrix4(t.matrix).toArray() as [number, number, number]], color);
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    g.matrix.copy(t.matrix);
    if (p.element === "face") {
      const start = m.faceGroups[p.index * 3]!;
      const count = m.faceGroups[p.index * 3 + 1]!;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices.slice(start, start + count), 1));
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 3;
      mesh.raycast = () => {};
      g.add(mesh);
    } else {
      const pts = edgePoints(m, p.index);
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
      line.renderOrder = 4;
      line.raycast = () => {};
      g.add(line);
      // Circular edge: its center (constraint point) is marked.
      if (p.geom.kind === "point") g.add(this.dots([p.geom.p], color));
    }
    return g;
  }

  private disposeSceneObject(o: THREE.Object3D | null): void {
    if (!o) return;
    this.scene.remove(o);
    o.traverse((c) => {
      const x = c as THREE.Mesh;
      // The face positions are shared with the mesh of the part: only the geometry of the object is released.
      x.geometry?.dispose();
      (x.material as THREE.Material | undefined)?.dispose();
    });
  }

  /** Constraint element under the pointer. */
  private mateEv(ev: { clientX: number; clientY: number }): MatePick | null {
    const c = this.matePick ? this.measureContext(ev) : null;
    if (!c || !this.matePick) return null;
    const targets = c.targets.filter((t): t is SnapTarget & { key: string } => t.key !== null);
    const hit = c.hit && c.hit.key !== null ? { key: c.hit.key, point: c.hit.point, triangle: c.hit.triangle } : null;
    return mateEntityAt(targets, this.camera, c.width, c.height, c.sx, c.sy, this.raycaster.ray, hit, c.slack, this.matePick.accept);
  }

  /** Structures and FEM workbenches: replaces the display of the analysis (null: nothing). */
  setAnalysis(o: AnalysisOverlay | null): void {
    this.setAnalysisLayer("default", o);
  }

  /** Replaces one named analysis display (null: removes it); layers are independent of each other. */
  setAnalysisLayer(key: string, o: AnalysisOverlay | null): void {
    const old = this.analysisLayers.get(key);
    if (old) {
      this.scene.remove(old);
      disposeObject(old);
      this.analysisLayers.delete(key);
    }
    if (o) {
      const g = buildAnalysis(o, (pts, color, size) => this.dots(pts, color, size));
      this.analysisLayers.set(key, g);
      this.scene.add(g);
    }
    this.requestRender();
  }

  /** Moves the particles of a layer in place (same count as when the layer was set). */
  moveAnalysisParticles(key: string, positions: Float32Array): void {
    const g = this.analysisLayers.get(key);
    if (g && moveParticles(g, positions)) this.requestRender();
  }

  /** Structures and FEM workbenches: clicks and hovers forwarded to the caller (CSS px relative to the container); null: exits the mode. */
  setAnalysisPicking(pick: { click: (x: number, y: number) => void; move?: (x: number, y: number) => void } | null): void {
    this.analysisPick = pick;
    this.setHover(null);
    this.assembly.setHover(null);
  }

  /** Elements already picked for the plane being edited: points and segments (world coordinates). */
  setDatumMarks(points: [number, number, number][], segments: [[number, number, number], [number, number, number]][]): void {
    if (this.datumMarks) {
      this.scene.remove(this.datumMarks);
      this.datumMarks.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      this.datumMarks = null;
    }
    if (points.length || segments.length) {
      const g = new THREE.Group();
      if (segments.length) {
        const lg = new THREE.BufferGeometry();
        lg.setAttribute("position", new THREE.Float32BufferAttribute(segments.flat(2), 3));
        const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x7552c9, depthTest: false }));
        line.renderOrder = 5;
        g.add(line);
      }
      if (points.length) g.add(this.dots(points, 0x7552c9));
      this.datumMarks = g;
      this.scene.add(g);
    }
    this.requestRender();
  }

  /** Plane construction element under the pointer (null: nothing compatible). */
  private datumEv(ev: { clientX: number; clientY: number }, role: DatumRole): DatumRef | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const targets: (SnapTarget & { mesh: THREE.Mesh })[] = this.assembly.active
      ? this.assembly.snapTargets()
      : this.mesh?.visible && this.payload
        ? [{ key: null, mesh: this.mesh, payload: this.payload, matrix: new THREE.Matrix4() }]
        : [];
    this.raycaster.setFromCamera(new THREE.Vector2((sx / rect.width) * 2 - 1, -(sy / rect.height) * 2 + 1), this.camera);
    this.raycaster.firstHitOnly = false;
    const byMesh = new Map(targets.map((t) => [t.mesh as THREE.Object3D, t.key]));
    const h = targets.length
      ? this.raycaster.intersectObjects(targets.map((t) => t.mesh), false).find((x) => byMesh.has(x.object) && this.keeps(byMesh.get(x.object)!, x.point))
      : undefined;
    const hit = h && h.faceIndex != null ? { key: byMesh.get(h.object)!, point: h.point, triangle: h.faceIndex } : null;
    const sphere = this.assembly.boundingSphere() ?? this.mesh?.geometry.boundingSphere;
    const slack = Math.max((sphere?.radius ?? 100) * 2e-3, 1e-3) + 3 * this.pixelSize();
    const ref = pickDatumRef(role, { targets, camera: this.camera, width: rect.width, height: rect.height, sx, sy, ray: this.raycaster.ray.clone(), hit, slack });
    if (ref || role !== "plane") return ref;
    // No planar face: a displayed plane?
    const q = this.raycaster.intersectObjects(this.planes.children, true).find((x) => x.object.userData.plane);
    const name = q?.object.userData.plane as string | undefined;
    if (!name) return null;
    return name === "XY" || name === "XZ" || name === "YZ" ? { kind: "base", name } : { kind: "datum", id: name };
  }

  /**
   * Picking mode: clicks produce edge or face references instead of selecting. `filter` limits
   * the pickable elements (solid bodies, surfaces, free edges).
   */
  setRefPicking(kind: "edge" | "face" | null, onPick?: (ref: GeomRef) => void, filter?: RefFilter): void {
    this.refMode = kind && onPick ? { kind, onPick, ...(filter ? { filter } : {}) } : null;
    this.hoverEdge = -1;
    this.setHover(null);
    this.refreshEdgeOverlay();
  }

  /** Measurement mode: each click picks a snapped point (vertex, circle center, edge, face); null: exits the mode. */
  setPointPicking(onPick: ((p: SnapPoint) => void) | null): void {
    this.pointPick = onPick;
    this.setSnapMarker(null);
    this.setHover(null);
    this.assembly.setHover(null);
  }

  /** Symbols of the center of gravity (quartered circle) and of the center of volume (crossed circle), always visible. */
  setMassMarkers(markers: { point: [number, number, number]; kind: "cog" | "cov" }[]): void {
    if (this.massMarkers) {
      this.scene.remove(this.massMarkers);
      this.massMarkers.traverse((o) => {
        const m = o as THREE.Points;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      this.massMarkers = null;
    }
    if (markers.length) {
      const g = new THREE.Group();
      for (const mk of markers) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(mk.point, 3));
        const mat = new THREE.PointsMaterial({ size: 22, sizeAttenuation: false, map: this.symbol(mk.kind), transparent: true, alphaTest: 0.1, depthTest: false });
        const pts = new THREE.Points(geo, mat);
        pts.renderOrder = mk.kind === "cog" ? 8 : 7;
        pts.raycast = () => {};
        g.add(pts);
      }
      this.massMarkers = g;
      this.scene.add(g);
    }
    this.requestRender();
  }

  private symbol(kind: "cog" | "cov"): THREE.Texture {
    let tex = this.symbolTextures.get(kind);
    if (tex) return tex;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    const r = 26;
    ctx.translate(32, 32);
    ctx.lineWidth = 4;
    if (kind === "cog") {
      // Standard symbol: alternating black / white quarters.
      for (let q = 0; q < 4; q++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, (q * Math.PI) / 2, ((q + 1) * Math.PI) / 2);
        ctx.closePath();
        ctx.fillStyle = q % 2 ? "#ffffff" : "#1d2430";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = "#1d2430";
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, r - 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fill();
      ctx.strokeStyle = "#2f6fd6";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.moveTo(0, -r);
      ctx.lineTo(0, r);
      ctx.stroke();
    }
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.symbolTextures.set(kind, tex);
    return tex;
  }

  /** Diameter / radius measurement mode: each click picks a circle (edge or cylindrical face); null: exits the mode. */
  setCirclePicking(onPick: ((c: CirclePick) => void) | null): void {
    this.circlePick = onPick;
    this.setCirclePreview(null);
    this.setHover(null);
    this.assembly.setHover(null);
  }

  /** Measurement points, segments and polylines displayed over the model (world coordinates); `colored`: segments with their own color. */
  setMeasureGraphics(
    points: [number, number, number][],
    segments: [[number, number, number], [number, number, number]][],
    polylines: [number, number, number][][] = [],
    colored: { a: [number, number, number]; b: [number, number, number]; color: string }[] = [],
  ): void {
    if (this.measureOverlay) {
      this.scene.remove(this.measureOverlay);
      this.measureOverlay.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      this.measureOverlay = null;
    }
    if (points.length || segments.length || polylines.length || colored.length) {
      const g = new THREE.Group();
      for (const pl of polylines) g.add(this.polyline(pl, MEASURE_COLOR));
      if (segments.length) {
        const lg = new THREE.BufferGeometry();
        lg.setAttribute("position", new THREE.Float32BufferAttribute(segments.flat(2), 3));
        const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false }));
        line.renderOrder = 5;
        g.add(line);
      }
      for (const s of colored) {
        const lg = new THREE.BufferGeometry();
        lg.setAttribute("position", new THREE.Float32BufferAttribute([...s.a, ...s.b], 3));
        const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: s.color, depthTest: false }));
        line.renderOrder = 5;
        g.add(line);
      }
      if (points.length) g.add(this.dots(points, MEASURE_COLOR));
      this.measureOverlay = g;
      this.scene.add(g);
    }
    this.requestRender();
  }

  /** Cost of the last render and split of the assembly occurrences (instanced or drawn alone). */
  renderStats(): { calls: number; triangles: number; occurrences: number; parts: number; alone: number } {
    return { ...this.lastRender, ...this.assembly.stats() };
  }

  /** Shows an assembly (part occurrences); null returns to the display of a single part. */
  setAssembly(items: AsmItem[] | null): void {
    this.sectionDirty = true;
    const first = !this.assembly.active && !!items?.length;
    this.assembly.setItems(items);
    // The occurrences may have moved: the highlighted elements follow.
    this.setMateHover(null);
    if (this.mateMarks.length) this.refreshMateMarks();
    if (first) this.setView("iso", false);
  }

  /** Ghost parts (in-place edit), in the coordinate system of the displayed part; null removes them. */
  setGhosts(items: GhostItem[] | null): void {
    this.ghosts.setItems(items);
    if (this.ghostSelected) {
      this.ghostSelected = false;
      this.events.ghostPick?.(null);
    }
    this.requestRender();
  }

  /** Moves the displayed occurrences (animation) without rebuilding the assembly. */
  setAssemblyMatrices(matrices: Record<string, number[]>): void {
    this.sectionDirty = true;
    this.assembly.setMatrices(matrices);
  }

  /** Current view state (orthographic camera: the zoom is part of the framing). */
  cameraState(): CameraState {
    const v = (p: THREE.Vector3) => p.toArray() as [number, number, number];
    return { position: v(this.camera.position), target: v(this.controls.target), up: v(this.camera.up), zoom: this.camera.zoom };
  }

  /** Places the camera (without animation). */
  setCameraState(s: CameraState): void {
    this.animation = null;
    this.camera.up.set(...s.up);
    this.camera.position.set(...s.position);
    this.controls.target.set(...s.target);
    if (s.zoom !== undefined) this.camera.zoom = s.zoom;
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /**
   * Video capture: renders at `width` × `height` px (vertical framing of the view kept), outside the display loop.
   * Each `captureFrame()` draws the scene (without the view cube) and returns the canvas, valid until the next return
   * to the event loop; `endCapture()` restores the view.
   */
  beginCapture(width: number, height: number): HTMLCanvasElement {
    const { height: h } = this.size();
    this.capture = { scale: height / h, ratio: this.renderer.getPixelRatio() };
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    return this.renderer.domElement;
  }

  captureFrame(): HTMLCanvasElement {
    const c = this.capture;
    const zoom = this.camera.zoom;
    if (c) this.camera.zoom = zoom * c.scale;
    this.camera.updateProjectionMatrix();
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.renderFrame(false, { width: size.x, height: size.y });
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
    return this.renderer.domElement;
  }

  endCapture(): void {
    if (!this.capture) return;
    this.renderer.setPixelRatio(this.capture.ratio);
    this.capture = null;
    this.resize();
  }

  /** Gizmo on an assembly occurrence. */
  attachGizmo(key: string | null, mode: "translate" | "rotate" = "translate"): void {
    this.assembly.attach(key, mode);
  }

  /** Plane of the selected face (index in the current mesh), or null if it is not planar. */
  planeOfFace(index: number): { p: [number, number, number]; n: [number, number, number] } | null {
    return this.payload ? planarFace(this.payload, index) : null;
  }

  /** Elements to highlight (references of the feature being edited). */
  setMarkedRefs(refs: GeomRef[]): void {
    this.markedRefs = refs;
    this.refreshMarks();
  }

  /** Subscribes to view changes (overlaid 2D layers). */
  onViewChange(cb: () => void): () => void {
    this.viewListeners.add(cb);
    return () => this.viewListeners.delete(cb);
  }

  /** Screen coordinates (CSS px, relative to the container) of a 3D point. */
  worldToScreen(p: { x: number; y: number; z: number }): { x: number; y: number } {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    const { width, height } = this.size();
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  }

  /** Intersection of the ray under the pointer (CSS px relative to the container) with a plane. */
  screenToPlane(
    x: number,
    y: number,
    origin: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } | null {
    const { width, height } = this.size();
    this.raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera);
    const n = new THREE.Vector3(normal.x, normal.y, normal.z);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(origin.x, origin.y, origin.z));
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
  }

  /** Ray under the pointer (CSS px relative to the container), in world coordinates. */
  rayAt(x: number, y: number): { origin: [number, number, number]; dir: [number, number, number] } {
    const { width, height } = this.size();
    this.raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
  }

  /** Assembly occurrence under the pointer (CSS px relative to the container): key, hit point (world), triangle. */
  pickAssemblyAt(x: number, y: number): { key: string; point: [number, number, number]; faceIndex: number } | null {
    const { width, height } = this.size();
    const hit = this.assembly.pick(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1));
    return hit ? { key: hit.key, point: hit.point.toArray() as [number, number, number], faceIndex: hit.faceIndex } : null;
  }

  /** Size of one screen pixel in millimeters. */
  pixelSize(): number {
    return 1 / this.camera.zoom;
  }

  get element(): HTMLElement {
    return this.container;
  }

  setColor(color: string): void {
    this.material.color.set(color);
    this.finish?.material.color.set(color);
    this.sectionDirty = true;
    this.requestRender();
  }

  /** Own color of each face of the current mesh (index k into `faceGroups`), null: color of the part. */
  setFaceColors(colors: (string | null)[]): void {
    if (colors.length === this.faceColors.length && colors.every((c, i) => c === this.faceColors[i])) return;
    disposePaint(this.paint);
    this.paint = null;
    this.faceColors = colors;
    if (this.mesh && this.payload && colors.length === this.payload.faceGroups.length / 3) {
      this.paint = paintMesh(this.mesh.geometry, this.payload, colors);
      if (this.paint) this.root.add(this.paint);
    }
    this.applyMode();
    this.requestRender();
  }

  /** Geometric reference of a face of the current mesh (to find it again after a recompute). */
  faceRefOf(index: number): GeomRef | null {
    return this.payload && index >= 0 && index < this.payload.faceGroups.length / 3 ? faceRef(this.payload, index) : null;
  }

  setDisplayMode(mode: DisplayMode): void {
    this.mode = mode;
    this.applyMode();
  }

  setViewCubeLabels(labels: ViewCubeLabels): void {
    this.viewCube.setLabels(labels);
    this.requestRender();
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.requestRender();
  }

  setView(view: StandardView, animate = true): void {
    const dir = new THREE.Vector3(...VIEW_DIRS[view]).normalize();
    const up = view === "top" ? new THREE.Vector3(0, 1, 0) : view === "bottom" ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, 1);
    if (animate) this.animateTo(dir, up);
    else {
      this.placeCamera(dir, up);
      this.fit();
    }
  }

  /** Frames the whole part in the view ("Zoom to fit"). */
  /** Sets, changes or removes (null) the section plane. */
  setSection(s: SectionSettings | null): void {
    const lampBefore = !!this.section?.lamp;
    this.section = s ? { ...s, normal: [...s.normal], excluded: s.excluded ? [...s.excluded] : undefined, lamp: s.lamp ? { ...s.lamp } : undefined } : null;
    if (this.section) sectionPlane(this.section, this.clipPlane);
    if (!this.section?.lamp) this.lampCenter = null;
    else if (!lampBefore || !this.lampCenter) {
      // Lamp turned on: aimed at the center of the model until the pointer moves over it.
      const sphere = this.assembly.boundingSphere() ?? this.mesh?.geometry.boundingSphere;
      this.lampCenter = sphere ? sphere.center.clone() : null;
    }
    this.updateLamp();
    this.sectionDirty = true;
    this.requestRender();
  }

  /** Point aimed at by the section lamp (null: no lamp or not placed). */
  lampTarget(): [number, number, number] | null {
    return this.section?.lamp && this.lampCenter ? (this.lampCenter.toArray() as [number, number, number]) : null;
  }

  /** Direction from the target to the camera (unit). */
  viewDirection(): [number, number, number] {
    return this.camera.position.clone().sub(this.controls.target).normalize().toArray() as [number, number, number];
  }

  /** Extent of the scene along a direction (to bound the position of the section plane). */
  extentAlong(normal: [number, number, number]): { min: number; max: number } | null {
    const box = new THREE.Box3();
    if (this.assembly.active) box.setFromObject(this.assembly.root);
    else if (this.mesh) box.setFromObject(this.mesh);
    if (box.isEmpty()) return null;
    const n = new THREE.Vector3(...normal).normalize();
    let min = Infinity;
    let max = -Infinity;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const d = n.x * x + n.y * y + n.z * z;
          min = Math.min(min, d);
          max = Math.max(max, d);
        }
    return { min, max };
  }

  /** True if the point (world coordinates) is not removed by the section, for the occurrence `key` (single part: null). */
  private keeps(key: string | null, p: THREE.Vector3): boolean {
    if (!this.section || (key !== null && isExcluded(this.section, key))) return true;
    if (this.section.lamp) return this.lampProbe || !this.lampCenter || !inLamp(this.lampOn, p);
    return this.clipPlane.distanceToPoint(p) >= -1e-6;
  }

  /** Planes of the lamp for the current camera (the hole stays along the view when it turns). */
  private updateLamp(): void {
    const lamp = this.section?.lamp;
    if (!lamp || !this.lampCenter) return;
    const { right, up, back } = this.cameraAxes();
    lampPlanes(this.lampCenter, right, up, back, lamp, this.lampOn, this.lampBottom);
  }

  private cameraAxes(): { right: THREE.Vector3; up: THREE.Vector3; back: THREE.Vector3 } {
    const q = this.camera.quaternion;
    return {
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
      back: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    };
  }

  /** Aims the lamp at the model under the pointer; off the model, it follows the pointer at the same depth. */
  private aimLamp(ev: PointerEvent): void {
    const ndc = this.ndc(ev);
    let hit: THREE.Vector3 | null = null;
    this.lampProbe = true;
    try {
      if (this.assembly.active) hit = this.assembly.pick(ndc)?.point ?? null;
      else if (this.mesh?.visible) {
        this.raycaster.setFromCamera(ndc, this.camera);
        this.raycaster.firstHitOnly = true;
        hit = this.raycaster.intersectObject(this.mesh)[0]?.point ?? null;
      }
    } finally {
      this.lampProbe = false;
    }
    if (!hit) {
      if (!this.lampCenter) return;
      this.raycaster.setFromCamera(ndc, this.camera);
      const depth = new THREE.Plane().setFromNormalAndCoplanarPoint(this.cameraAxes().back, this.lampCenter);
      hit = this.raycaster.ray.intersectPlane(depth, new THREE.Vector3());
      if (!hit) return;
    }
    this.lampCenter = hit.clone();
    this.updateLamp();
    this.requestRender();
  }

  fit(): void {
    const sphere = this.assembly.boundingSphere() ?? this.mesh?.geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 100);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, sphere.radius * 4);
    const { width, height } = this.size();
    const r = Math.max(sphere.radius, 1e-3) * 1.15;
    this.camera.zoom = Math.min(width, height) / (2 * r);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  clearSelection(): void {
    this.selected = [];
    this.refreshSelection();
    if (this.ghostSelected) {
      this.ghosts.select(null);
      this.ghostSelected = false;
      this.events.ghostPick?.(null);
    }
    this.events.select?.([]);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.clearMesh();
    this.material.dispose();
    this.flatMaterial.dispose();
    this.finish?.material.dispose();
    disposeFinishTextures();
    this.envMap?.dispose();
    this.controls.dispose();
    this.viewCube.dispose();
    this.setSnapMarker(null);
    this.setCirclePreview(null);
    this.setMeasureGraphics([], []);
    this.setMassMarkers([]);
    for (const tex of this.dotTextures.values()) tex.dispose();
    for (const tex of this.symbolTextures.values()) tex.dispose();
    this.assembly.dispose();
    this.setSketchLines(null);
    this.setSketchRegions([]);
    this.caps.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // --- Internal -------------------------------------------------------------

  private requestRender(): void {
    this.needsRender = true;
  }

  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop);
    // Video capture in progress: the view is not redrawn (size and framing are those of the video).
    if (this.capture) return;
    if (this.animation) this.stepAnimation();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderFrame();
    for (const cb of this.viewListeners) cb();
  };

  private renderFrame(withViewCube = true, { width, height } = this.size()): void {
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.applyClipping();
    this.renderer.render(this.scene, this.camera);
    this.lastRender = { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
    if (withViewCube) this.viewCube.render(this.renderer, this.camera, width, height);
  }

  /**
   * View image (JPEG as data URL, white background, without the view cube), longest side limited to `maxSize` pixels.
   * Rendered on demand: the WebGL buffer is only readable right after rendering.
   */
  snapshot(maxSize = 1024): string {
    // Camera animation in progress: its final position.
    if (this.animation) {
      this.animation.t0 = -Infinity;
      this.stepAnimation();
    }
    this.renderFrame(false);
    const src = this.renderer.domElement;
    const k = Math.min(1, maxSize / Math.max(src.width, src.height, 1));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(src.width * k));
    out.height = Math.max(1, Math.round(src.height * k));
    const g = out.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(src, 0, 0, out.width, out.height);
    this.needsRender = true;
    return out.toDataURL("image/jpeg", 0.85);
  }

  /** Section planes of the materials (part, non-excluded occurrences) and section fill. */
  private applyClipping(): void {
    const lamp = this.section?.lamp ? (this.lampCenter ? this.section.lamp : null) : null;
    if (lamp) this.updateLamp();
    // Lamp not placed yet: nothing is cut.
    const on = !this.section || (this.section.lamp && !lamp) ? this.clipOff : lamp ? this.lampOn : this.clipOn;
    const set = (o: THREE.Object3D, planes: THREE.Plane[]): void => {
      if (o.userData.sectionStencil) return;
      if (typeof o.userData.asmKey === "string") planes = this.section && !isExcluded(this.section, o.userData.asmKey) ? on : this.clipOff;
      const mat = (o as THREE.Mesh).material;
      if (mat) {
        // The lamp removes the intersection of the negative sides of its planes.
        const intersect = planes === this.lampOn;
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          if (m.clippingPlanes === planes && m.clipIntersection === intersect) continue;
          m.clippingPlanes = planes;
          m.clipIntersection = intersect;
          m.needsUpdate = true;
        }
      }
      for (const c of o.children) set(c, planes);
    };
    // Occurrences excluded from the section: outside the batch, their section planes differ from those of their part.
    const section = this.section;
    this.assembly.setSolo(section ? (k) => isExcluded(section, k) : null);
    set(this.root, on);
    set(this.assembly.root, on);
    if (this.sectionDirty) {
      this.sectionDirty = false;
      if (!this.section || (this.section.lamp && !lamp)) {
        this.caps.clear();
        return;
      }
      const sphere = this.assembly.boundingSphere() ?? this.mesh?.geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 100);
      // Hatching pitch: about 1/15 of the scene radius.
      this.hatchPitch = Math.max(sphere.radius / 15, 0.5);
      const targets: { mesh: THREE.Mesh; color: THREE.Color }[] = [];
      if (this.assembly.active) {
        for (const t of this.assembly.solids()) if (!isExcluded(this.section, t.key)) targets.push(t);
      } else if (this.mesh?.visible) {
        targets.push({ mesh: this.mesh, color: this.bodyMaterial().color });
      }
      this.caps.build(lamp ? this.lampOn : this.clipOn, targets, this.section.cap !== false, !!lamp);
      if (!lamp) this.caps.placePlane(this.clipPlane, sphere.center, Math.max(sphere.radius, 1) * 2.4, this.hatchPitch);
    }
    // The lamp moves with the pointer and the camera: its caps are placed at each frame.
    if (lamp) {
      const { right, up, back } = this.cameraAxes();
      this.caps.placeLamp(this.lampBottom, right, up, back, lamp.radius, this.hatchPitch);
    }
  }

  private size(): { width: number; height: number } {
    return { width: Math.max(this.container.clientWidth, 1), height: Math.max(this.container.clientHeight, 1) };
  }

  private resize(): void {
    const { width, height } = this.size();
    this.renderer.setSize(width, height);
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private placeCamera(dir: THREE.Vector3, up: THREE.Vector3): void {
    const dist = this.camera.position.distanceTo(this.controls.target) || 1000;
    this.camera.up.copy(up);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  private animateTo(dir: THREE.Vector3, up: THREE.Vector3): void {
    const from = this.camera.position.clone().sub(this.controls.target).normalize();
    this.animation = { from, to: dir.clone().normalize(), up0: this.camera.up.clone(), up1: up.clone(), t0: performance.now() };
  }

  private stepAnimation(): void {
    const a = this.animation!;
    const t = Math.min((performance.now() - a.t0) / 250, 1);
    const k = t * t * (3 - 2 * t);
    const dir = a.from.clone().lerp(a.to, k);
    if (dir.lengthSq() < 1e-6) dir.copy(a.to); // opposite views
    this.placeCamera(dir.normalize(), a.up0.clone().lerp(a.up1, k).normalize());
    if (t >= 1) {
      this.animation = null;
      this.fit();
    }
    this.requestRender();
  }

  /**
   * Surface analysis of the part (zebra, draft, curvature values per vertex), drawn instead of its material and of
   * its painted faces; null: normal display. Scalar values must have one value per vertex of the current mesh
   * (otherwise gray: set them again after each recompute).
   */
  setShadingAnalysis(analysis: ShadingAnalysis | null): void {
    this.shading?.material.dispose();
    this.shading = analysis && { analysis, material: analysisMaterial(analysis) };
    this.applyMode();
  }

  private applyMode(): void {
    if (!this.mesh || !this.edges || !this.hiddenEdges) return;
    const m = this.mode;
    this.mesh.visible = m !== "wireframe" && this.bodyVisible;
    this.edges.visible = this.bodyVisible;
    const shaded = this.shading && m !== "hiddenLines";
    if (shaded) applyValues(this.mesh.geometry, this.shading!.analysis);
    this.mesh.material = m === "hiddenLines" ? this.flatMaterial : shaded ? this.shading!.material : this.bodyMaterial();
    // Dark theme: dark edges on light parts, light edges on the dark faces of the "hidden lines" mode.
    const edgeColor = this.dark ? (m === "hiddenLines" ? 0xc9d1de : 0x0c0f14) : EDGE_COLOR;
    (this.edges.material as THREE.LineBasicMaterial).color.set(edgeColor);
    (this.hiddenEdges.material as THREE.LineDashedMaterial).color.set(edgeColor);
    this.edges.visible = this.bodyVisible && m !== "shaded";
    (this.edges.material as THREE.LineBasicMaterial).depthTest = m !== "wireframe";
    this.hiddenEdges.visible = this.bodyVisible && m === "hiddenLines";
    if (this.freeEdges) this.freeEdges.visible = this.bodyVisible;
    if (this.paint) this.paint.visible = this.mesh.visible && m !== "hiddenLines" && !shaded;
    this.sectionDirty = true;
    this.requestRender();
  }

  /** Switches the lighting, edges and grid to the dark (or light) theme. */
  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    this.hemi.groundColor.set(dark ? 0xc4cbd6 : 0xaab2be);
    this.flatMaterial.color.set(dark ? 0x232932 : 0xffffff);
    this.applyLights();
    this.buildGrid(this.gridSize);
    this.applyMode();
  }

  /** Realistic rendering: the environment lights and is reflected on all parts (ambient light reduced). */
  setRealistic(realistic: boolean): void {
    if (realistic === this.realistic) return;
    this.realistic = realistic;
    this.scene.environment = realistic ? this.environment() : null;
    this.scene.environmentIntensity = ENV_INTENSITY;
    this.applyLights();
    this.requestRender();
  }

  /** Finish of the part (null: color only). Painted faces keep their color. */
  setFinish(kind: Finish | null): void {
    if (kind === (this.finish?.kind ?? null)) return;
    this.finish?.material.dispose();
    const material = kind && this.finishMaterial(kind, this.material.color);
    this.finish = kind && material ? { kind, material } : null;
    this.applyMode();
  }

  private finishMaterial(kind: Finish, color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
    return createFinishMaterial(kind, color, this.environment(), this.renderer.capabilities.getMaxAnisotropy());
  }

  private bodyMaterial(): THREE.MeshStandardMaterial {
    return this.finish?.material ?? this.material;
  }

  /** Prefiltered environment (reflections), computed on first use. */
  private environment(): THREE.Texture {
    if (!this.envMap) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      // The three.js room has Y up, the scene is Z-up: it is rotated so that the ceiling lights shine from above.
      const room = new RoomEnvironment();
      room.rotation.x = Math.PI / 2;
      room.updateMatrixWorld(true);
      this.envMap = pmrem.fromScene(room, 0.04).texture;
      room.dispose();
      pmrem.dispose();
    }
    return this.envMap;
  }

  private applyLights(): void {
    // The environment already provides the ambient light: the ambient light fades, the camera light keeps the modeling.
    this.hemi.intensity = (this.dark ? 3.1 : 2.2) * (this.realistic ? REAL_HEMI : 1);
    this.headlight.intensity = (this.dark ? 2.1 : 1.6) * (this.realistic ? REAL_HEAD : 1);
  }

  private buildGrid(size: number): void {
    this.gridSize = size;
    this.grid.clear();
    const step = 10 ** Math.floor(Math.log10(Math.max(size, 1) / 2));
    const extent = Math.ceil(size / step) * step;
    const g = new THREE.GridHelper(extent * 2, Math.round((extent * 2) / step), this.dark ? 0x59616e : 0xb8c0cc, this.dark ? 0x333a45 : 0xdde2e8);
    g.rotation.x = Math.PI / 2;
    (g.material as THREE.Material).transparent = true;
    (g.material as THREE.Material).opacity = 0.6;
    this.grid.add(g, new THREE.AxesHelper(step * 2));
  }

  private clearMesh(): void {
    disposePaint(this.paint);
    this.paint = null;
    this.faceColors = [];
    this.disposeObject(this.freeEdges);
    this.freeEdges = null;
    for (const obj of [this.mesh, this.edges, this.hiddenEdges, this.hoverMesh, this.selectMesh]) {
      if (!obj) continue;
      this.root.remove(obj);
      if (obj !== this.mesh) (obj.material as THREE.Material).dispose();
    }
    this.mesh?.geometry.disposeBoundsTree();
    this.mesh?.geometry.dispose();
    this.edges?.geometry.dispose();
    this.hoverMesh?.geometry.dispose();
    this.selectMesh?.geometry.dispose();
    this.mesh = this.edges = this.hiddenEdges = this.hoverMesh = this.selectMesh = null;
    this.hovered = null;
    this.hoverEdge = -1;
    this.refreshEdgeOverlay();
    this.disposeObject(this.markOverlay);
    this.markOverlay = null;
  }

  private disposeObject(o: THREE.Object3D | null): void {
    if (!o) return;
    this.root.remove(o);
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }

  /** Segments of a set of mesh edges. */
  private edgeLines(edges: number[], color: number): THREE.LineSegments | null {
    const p = this.payload;
    if (!p || edges.length === 0) return null;
    const parts = edges.map((e) => p.edges.subarray(p.edgeGroups[e * 3]! * 3, (p.edgeGroups[e * 3]! + p.edgeGroups[e * 3 + 1]!) * 3));
    const arr = new Float32Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of parts) {
      arr.set(x, o);
      o += x.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 3;
    return l;
  }

  private refreshEdgeOverlay(): void {
    this.disposeObject(this.edgeOverlay);
    this.edgeOverlay = this.hoverEdge >= 0 ? this.edgeLines([this.hoverEdge], HOVER_COLOR) : null;
    if (this.edgeOverlay) this.root.add(this.edgeOverlay);
    this.requestRender();
  }

  private refTolerance(): number {
    const r = this.mesh?.geometry.boundingSphere?.radius ?? 100;
    return Math.max(r * 4e-3, 1e-3);
  }

  private refreshMarks(): void {
    this.disposeObject(this.markOverlay);
    this.markOverlay = null;
    const p = this.payload;
    if (!p || this.markedRefs.length === 0) return this.requestRender();
    const tol = this.refTolerance();
    const group = new THREE.Group();
    const edges = this.markedRefs.filter((r) => r.kind === "edge").map((r) => matchRef(p, r, tol)).filter((i) => i >= 0);
    const faces = this.markedRefs.filter((r) => r.kind === "face").map((r) => matchRef(p, r, tol)).filter((i) => i >= 0);
    const lines = this.edgeLines(edges, SELECT_COLOR);
    if (lines) group.add(lines);
    const f = this.faceOverlay(faces, SELECT_COLOR, -0.5);
    if (f) {
      this.root.remove(f);
      group.add(f);
    }
    this.markOverlay = group;
    this.root.add(group);
    this.requestRender();
  }

  /** Body edge under the pointer: reference and 3D polyline (edge projection into a sketch). */
  edgeAt(clientX: number, clientY: number): { ref: GeomRef; points: [number, number, number][]; ghost?: string } | null {
    const p = this.payload;
    const e = p ? this.pickEdgeAt({ clientX, clientY }) : -1;
    // Edge of another part (in-place edit): `ref` in the coordinate system of the source part, points in that of the edited part.
    if (e < 0) return this.ghostEdgeAt(clientX, clientY);
    if (!p) return null;
    const start = p.edgeGroups[e * 3]!;
    const count = p.edgeGroups[e * 3 + 1]!;
    const points: [number, number, number][] = [];
    for (let k = start; k < start + count; k += 2) points.push([p.edges[k * 3]!, p.edges[k * 3 + 1]!, p.edges[k * 3 + 2]!]);
    const last = start + count - 1;
    points.push([p.edges[last * 3]!, p.edges[last * 3 + 1]!, p.edges[last * 3 + 2]!]);
    return { ref: edgeRef(p, e), points };
  }

  private ghostEdgeAt(clientX: number, clientY: number): { ref: GeomRef; points: [number, number, number][]; ghost: string } | null {
    if (!this.ghosts.active) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    this.raycaster.setFromCamera(new THREE.Vector2((sx / rect.width) * 2 - 1, -(sy / rect.height) * 2 + 1), this.camera);
    // Edges hidden by the part itself are ignored (the translucent ghosts hide nothing).
    const own = this.mesh?.visible ? this.raycaster.intersectObject(this.mesh)[0] : undefined;
    const occlusion = own ? { ray: this.raycaster.ray.clone(), maxDist: own.distance + this.refTolerance() * 5 } : undefined;
    const g = this.ghosts.edgeAt(this.camera, rect.width, rect.height, sx, sy, 7, occlusion);
    return g ? { ref: g.ref, points: g.points, ghost: g.key } : null;
  }

  /** Edge under the pointer (edge picking mode). */
  private pickEdgeAt(ev: { clientX: number; clientY: number }): number {
    if (!this.payload || !this.mesh) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    this.raycaster.setFromCamera(new THREE.Vector2((sx / rect.width) * 2 - 1, -(sy / rect.height) * 2 + 1), this.camera);
    this.raycaster.firstHitOnly = !this.section;
    const hit = this.mesh.visible ? this.raycaster.intersectObject(this.mesh).find((h) => this.keeps(null, h.point)) : undefined;
    const slack = this.refTolerance() * 5;
    const occlusion = hit ? { ray: this.raycaster.ray.clone(), maxDist: hit.distance + slack } : undefined;
    const m = this.payload;
    const filter = this.refMode?.filter;
    return pickEdge(m, this.camera, rect.width, rect.height, sx, sy, 7, occlusion, filter ? (e) => acceptsRef(m, "edge", e, filter) : undefined);
  }

  /** Round dots (colored center, white rim) of fixed size on screen, always visible. */
  private dots(points: [number, number, number][], color: number, size = 12): THREE.Points {
    let tex = this.dotTextures.get(color);
    if (!tex) {
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      const ctx = c.getContext("2d")!;
      ctx.beginPath();
      ctx.arc(16, 16, 14, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(16, 16, 10, 0, Math.PI * 2);
      ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      ctx.fill();
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.dotTextures.set(color, tex);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
    const mat = new THREE.PointsMaterial({ size, sizeAttenuation: false, map: tex, transparent: true, alphaTest: 0.2, depthTest: false });
    const pts = new THREE.Points(g, mat);
    pts.renderOrder = 6;
    pts.raycast = () => {};
    return pts;
  }

  private setSnapMarker(p: SnapPoint | null): void {
    if (this.snapMarker) {
      this.scene.remove(this.snapMarker);
      this.snapMarker.geometry.dispose();
      (this.snapMarker.material as THREE.Material).dispose();
      this.snapMarker = null;
    }
    if (p) {
      this.snapMarker = this.dots([p.point], p.kind === "face" ? HOVER_COLOR : SNAP_COLOR);
      this.scene.add(this.snapMarker);
    }
    this.renderer.domElement.style.cursor = p ? "crosshair" : "";
    this.requestRender();
  }

  /** Polyline always visible (measurements). */
  private polyline(points: [number, number, number][], color: number): THREE.Line {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 5;
    line.raycast = () => {};
    return line;
  }

  /** Preview of the circle under the pointer (diameter / radius measurement). */
  private setCirclePreview(c: CirclePick | null): void {
    if (this.circlePreview) {
      this.scene.remove(this.circlePreview);
      this.circlePreview.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      this.circlePreview = null;
    }
    if (c) {
      const g = new THREE.Group();
      g.add(this.polyline(circlePoints(c.center, c.normal, c.radius), SNAP_COLOR), this.dots([c.center], SNAP_COLOR));
      this.circlePreview = g;
      this.scene.add(g);
    }
    this.renderer.domElement.style.cursor = c ? "crosshair" : "";
    this.requestRender();
  }

  /** Circle under the pointer: circular edge or cylindrical face. */
  private circleEv(ev: { clientX: number; clientY: number }): CirclePick | null {
    const m = this.measureContext(ev);
    return m ? circleAt(m.targets, this.camera, m.width, m.height, m.sx, m.sy, this.raycaster.ray, m.hit, m.slack) : null;
  }

  /** Snapped point under the pointer (single part or assembly occurrences). */
  private snapEv(ev: { clientX: number; clientY: number }): SnapPoint | null {
    const m = this.measureContext(ev);
    return m ? snapAt(m.targets, this.camera, m.width, m.height, m.sx, m.sy, this.raycaster.ray, m.hit, m.slack) : null;
  }

  /** Measurement targets (single part or visible occurrences) and ray hit under the pointer (the ray stays in `raycaster`). */
  private measureContext(ev: { clientX: number; clientY: number }): {
    targets: SnapTarget[];
    width: number;
    height: number;
    sx: number;
    sy: number;
    hit: { key: string | null; point: THREE.Vector3; triangle: number } | null;
    slack: number;
  } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const targets: (SnapTarget & { mesh: THREE.Mesh })[] = this.assembly.active
      ? this.assembly.snapTargets()
      : this.mesh?.visible && this.payload
        ? [{ key: null, mesh: this.mesh, payload: this.payload, matrix: new THREE.Matrix4() }]
        : [];
    if (!targets.length) return null;
    this.raycaster.setFromCamera(new THREE.Vector2((sx / rect.width) * 2 - 1, -(sy / rect.height) * 2 + 1), this.camera);
    this.raycaster.firstHitOnly = false;
    const byMesh = new Map(targets.map((t) => [t.mesh as THREE.Object3D, t.key]));
    const h = this.raycaster
      .intersectObjects(targets.map((t) => t.mesh), false)
      .find((x) => byMesh.has(x.object) && this.keeps(byMesh.get(x.object)!, x.point));
    const hit = h ? { key: byMesh.get(h.object)!, point: h.point, triangle: h.faceIndex ?? 0 } : null;
    const sphere = this.assembly.boundingSphere() ?? this.mesh?.geometry.boundingSphere;
    const slack = Math.max((sphere?.radius ?? 100) * 2e-3, 1e-3) + 3 * this.pixelSize();
    return { targets, width: rect.width, height: rect.height, sx, sy, hit, slack };
  }

  /** Face of the part under a screen point (client coordinates) and hit point, without selecting it. */
  faceAt(clientX: number, clientY: number): (FacePick & { point: [number, number, number] }) | null {
    if (!this.mesh?.visible || !this.payload) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.firstHitOnly = !this.section;
    const hit = this.raycaster.intersectObject(this.mesh).find((h) => this.keeps(null, h.point));
    if (hit?.faceIndex == null) return null;
    const idx = this.groupOf(hit.faceIndex * 3);
    return { index: idx, id: this.payload.faceGroups[idx * 3 + 2]!, point: [hit.point.x, hit.point.y, hit.point.z] };
  }

  private pick(ev: PointerEvent): FacePick | null {
    if (!this.pickingEnabled || !this.mesh?.visible || !this.payload) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.firstHitOnly = !this.section;
    const hit = this.raycaster.intersectObject(this.mesh).find((h) => this.keeps(null, h.point));
    if (hit?.faceIndex == null) return null;
    const idx = this.groupOf(hit.faceIndex * 3);
    return { index: idx, id: this.payload.faceGroups[idx * 3 + 2]! };
  }

  /** Binary search for the face containing the given triangle index. */
  private groupOf(indexOffset: number): number {
    let lo = 0;
    let hi = this.faceStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.faceStarts[mid]! <= indexOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private faceOverlay(faces: number[], color: number, offset: number): THREE.Mesh | null {
    if (!this.mesh || !this.payload || faces.length === 0) return null;
    const g = this.payload.faceGroups;
    const parts = faces.map((i) => this.payload!.indices.subarray(g[i * 3]!, g[i * 3]! + g[i * 3 + 1]!));
    const index = new Uint32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      index.set(p, o);
      o += p.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", this.mesh.geometry.getAttribute("position"));
    geo.setAttribute("normal", this.mesh.geometry.getAttribute("normal"));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.35,
      polygonOffset: true,
      polygonOffsetFactor: offset,
      polygonOffsetUnits: offset,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.raycast = () => {};
    this.root.add(m);
    return m;
  }

  private replaceOverlay(old: THREE.Mesh | null): void {
    if (!old) return;
    this.root.remove(old);
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();
  }

  private setHover(face: FacePick | null): void {
    const idx = face?.index ?? null;
    if (idx === this.hovered) return;
    this.hovered = idx;
    this.replaceOverlay(this.hoverMesh);
    this.hoverMesh = idx === null || this.selected.includes(idx) ? null : this.faceOverlay([idx], HOVER_COLOR, 0);
    this.events.hover?.(face);
    this.requestRender();
  }

  private refreshSelection(): void {
    this.replaceOverlay(this.selectMesh);
    this.selectMesh = this.faceOverlay(this.selected, SELECT_COLOR, -0.5);
    this.requestRender();
  }

  private ndc(ev: PointerEvent): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (ev.buttons !== 0) return;
    const el = this.renderer.domElement;
    if (this.viewCube.hover(ev, el)) this.requestRender();
    if (this.viewCube.contains(ev, el)) return;
    if (this.section?.lamp && this.section.lamp.follow !== false) this.aimLamp(ev);
    if (this.analysisPick) {
      const r = el.getBoundingClientRect();
      this.analysisPick.move?.(ev.clientX - r.left, ev.clientY - r.top);
      return;
    }
    if (this.datumPick) {
      // Visual feedback: snapped point (role "point") or point picked on the compatible element.
      const p = this.datumPick.role === "point" ? this.snapEv(ev) : null;
      const ok = p ? true : !!this.datumEv(ev, this.datumPick.role);
      this.setSnapMarker(p);
      this.renderer.domElement.style.cursor = ok ? "crosshair" : "";
      return;
    }
    if (this.pointPick) {
      this.setSnapMarker(this.snapEv(ev));
      return;
    }
    if (this.circlePick) {
      this.setCirclePreview(this.circleEv(ev));
      return;
    }
    if (this.assembly.active && this.matePick) {
      this.setMateHover(this.mateEv(ev));
      return;
    }
    if (this.assembly.active) {
      this.assembly.setHover(this.assembly.dragging ? null : (this.assembly.pick(this.ndc(ev))?.key ?? null));
      return;
    }
    if (this.refMode?.kind === "edge") {
      const e = this.pickEdgeAt(ev);
      if (e !== this.hoverEdge) {
        this.hoverEdge = e;
        this.refreshEdgeOverlay();
      }
      return;
    }
    const hover = this.pick(ev);
    // Filtered face picking: no preselection on a face that cannot be picked.
    const refused = this.refMode?.filter && hover && this.payload && !acceptsRef(this.payload, "face", hover.index, this.refMode.filter);
    this.setHover(refused ? null : hover);
  };

  private onPointerDown = (ev: PointerEvent): void => {
    this.down = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerUp = (ev: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) return;
    if (ev.button !== 0) return;
    if (this.viewCube.click(ev, this.renderer.domElement)) return;
    if (this.analysisPick) {
      const r = this.renderer.domElement.getBoundingClientRect();
      this.analysisPick.click(ev.clientX - r.left, ev.clientY - r.top);
      return;
    }
    if (this.datumPick) {
      const ref = this.datumEv(ev, this.datumPick.role);
      if (ref) this.datumPick.onPick(ref);
      return;
    }
    if (this.pointPick) {
      const p = this.snapEv(ev);
      if (p) this.pointPick(p);
      return;
    }
    if (this.circlePick) {
      const c = this.circleEv(ev);
      if (c) this.circlePick(c);
      return;
    }
    if (this.assembly.active && this.matePick) {
      const p = this.mateEv(ev);
      if (p) this.matePick.onPick(p);
      return;
    }
    if (this.assembly.active) {
      if (this.assembly.dragging) return;
      const hit = this.assembly.pick(this.ndc(ev));
      if (!hit && this.planes.children.length) {
        // Click on empty space over a displayed plane (base or reference): selects the plane.
        this.raycaster.setFromCamera(this.ndc(ev), this.camera);
        const q = this.raycaster.intersectObjects(this.planes.children, true).find((h) => h.object.userData.plane);
        if (q) {
          this.events.planePick?.(q.object.userData.plane as string);
          return;
        }
      }
      this.events.componentPick?.(hit?.key ?? null, ev.ctrlKey || ev.metaKey || ev.shiftKey, hit ? { faceIndex: hit.faceIndex, point: hit.point.toArray() as [number, number, number] } : null);
      return;
    }
    if (this.refMode && this.payload) {
      if (this.refMode.kind === "edge") {
        const e = this.pickEdgeAt(ev);
        if (e >= 0) this.refMode.onPick(edgeRef(this.payload, e));
      } else {
        const f = this.pick(ev);
        if (f && acceptsRef(this.payload, "face", f.index, this.refMode.filter)) this.refMode.onPick(faceRef(this.payload, f.index));
      }
      return;
    }
    if (!this.pickingEnabled) return;
    const face = this.pick(ev);
    // In-place edit: face of another part (linked sketch plane).
    if (!face && this.ghosts.active) {
      this.raycaster.setFromCamera(this.ndc(ev), this.camera);
      const g = this.ghosts.faceAt(this.raycaster);
      if (g) {
        this.ghosts.select(g);
        this.ghostSelected = true;
        this.selected = [];
        this.refreshSelection();
        this.events.select?.([]);
        this.events.ghostPick?.(g);
        this.requestRender();
        return;
      }
    }
    if (this.ghostSelected) {
      this.ghosts.select(null);
      this.ghostSelected = false;
      this.events.ghostPick?.(null);
      this.requestRender();
    }
    if (!face && this.planes.children.length) {
      // No face under the pointer: a reference plane?
      this.raycaster.setFromCamera(this.ndc(ev), this.camera);
      const hit = this.raycaster.intersectObjects(this.planes.children, true).find((h) => h.object.userData.plane);
      if (hit) {
        this.events.planePick?.(hit.object.userData.plane as string);
        return;
      }
    }
    const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (!face) {
      if (!multi) this.selected = [];
    } else if (multi) {
      this.selected = this.selected.includes(face.index)
        ? this.selected.filter((i) => i !== face.index)
        : [...this.selected, face.index];
    } else {
      this.selected = [face.index];
    }
    this.replaceOverlay(this.hoverMesh);
    this.hoverMesh = null;
    this.hovered = null;
    this.refreshSelection();
    const g = this.payload?.faceGroups;
    this.events.select?.(this.selected.map((index) => ({ index, id: g ? g[index * 3 + 2]! : 0 })));
  };
}
