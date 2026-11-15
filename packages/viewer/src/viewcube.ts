import * as THREE from "three";

export interface ViewCubeLabels {
  front: string;
  back: string;
  top: string;
  bottom: string;
  left: string;
  right: string;
}

const SIZE = 128;
const MARGIN = 8;
/** Half-width of the framing: leaves room for the triad that extends beyond the cube. */
const FRAME = 2.5;
/** Thickness of the highlight of the hovered face. */
const HIGHLIGHT = 0.06;
/** Axis colors (CAD convention: X red, Y green, Z blue). */
const AXES: [string, THREE.Vector3, string][] = [
  ["X", new THREE.Vector3(1, 0, 0), "#e5484d"],
  ["Y", new THREE.Vector3(0, 1, 0), "#30a46c"],
  ["Z", new THREE.Vector3(0, 0, 1), "#3e63dd"],
];

/** "Up" vector of a view oriented along `zone`: Y for top / bottom, otherwise Z vertical. */
export function viewUp(zone: THREE.Vector3): THREE.Vector3 {
  return zone.x === 0 && zone.y === 0 ? new THREE.Vector3(0, zone.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
}

/** Face under a point of the cube (half-side = 1): the dominant axis, whatever the distance to an edge or a corner. */
export function faceZone(p: THREE.Vector3): THREE.Vector3 {
  const abs = [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)];
  const axis = abs.indexOf(Math.max(...abs));
  return new THREE.Vector3().setComponent(axis, p.getComponent(axis) < 0 ? -1 : 1);
}

/**
 * Orientation cube drawn in the upper right corner; clicking a face orients the view.
 * The cube is built Y-up, then rotated 90° around X for the Z-up coordinate system.
 *
 * Design rule: only the faces are selectable. Edges and corners stay inert, on click, hover, drag and any other
 * input, and no widget surrounds the model or shrinks it when shown. Do not change this rule without the agreement of
 * the maintainers. The other views are in the flat list of `apps/web/src/components/ViewSelector.tsx`.
 */
export class ViewCube {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-FRAME, FRAME, FRAME, -FRAME, 0.1, 10);
  private readonly cube: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial[]>;
  private readonly triad = new THREE.Group();
  private readonly highlight = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x2f80ed, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  private hovered: string | null = null;
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    private readonly onPick: (dir: THREE.Vector3, up: THREE.Vector3) => void,
    labels: ViewCubeLabels = { front: "Avant", back: "Arrière", top: "Dessus", bottom: "Dessous", left: "Gauche", right: "Droite" },
  ) {
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), []);
    this.cube.rotation.x = Math.PI / 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x6b7686 }));
    this.cube.add(edges);
    this.scene.add(this.cube);
    this.buildTriad();
    this.scene.add(this.triad);
    this.highlight.visible = false;
    this.scene.add(this.highlight);
    this.setLabels(labels);
  }

  /** Triad placed on the (-1,-1,-1) corner of the cube: a colored arrow and a letter per axis, always visible. */
  private buildTriad(): void {
    const origin = new THREE.Vector3(-1, -1, -1);
    const length = 2.6;
    const head = 0.4;
    const shaft = new THREE.CylinderGeometry(0.045, 0.045, length - head, 8);
    const cone = new THREE.ConeGeometry(0.13, head, 12);
    for (const [name, dir, color] of AXES) {
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
      const arrow = new THREE.Group();
      const s = new THREE.Mesh(shaft, mat);
      s.position.y = (length - head) / 2;
      const c = new THREE.Mesh(cone, mat);
      c.position.y = length - head / 2;
      arrow.add(s, c);
      // three.js cylinders are oriented along +Y.
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      arrow.position.copy(origin);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.letter(name, color), depthTest: false }));
      label.scale.setScalar(0.6);
      label.position.copy(origin).addScaledVector(dir, length + 0.3);
      for (const o of [s, c, label]) o.renderOrder = 10;
      this.triad.add(arrow, label);
    }
  }

  setLabels(l: ViewCubeLabels): void {
    for (const m of this.cube.material) {
      m.map?.dispose();
      m.dispose();
    }
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z (before rotation).
    this.cube.material = [l.right, l.left, l.top, l.bottom, l.front, l.back].map(
      (text) => new THREE.MeshBasicMaterial({ map: this.texture(text) }),
    );
  }

  render(renderer: THREE.WebGLRenderer, main: THREE.Camera, width: number, height: number): void {
    this.camera.quaternion.copy(main.quaternion);
    this.camera.position.set(0, 0, 4).applyQuaternion(main.quaternion);
    const x = width - SIZE - MARGIN;
    const y = height - SIZE - MARGIN;
    renderer.setViewport(x, y, SIZE, SIZE);
    renderer.setScissor(x, y, SIZE, SIZE);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }

  /** True if the pointer is in the cube area (the viewer must then not handle the event). */
  contains(ev: PointerEvent, canvas: HTMLCanvasElement): boolean {
    return this.local(ev, canvas) !== null;
  }

  /** Updates the highlight of the hovered zone; returns true if a new render is needed. */
  hover(ev: PointerEvent | null, canvas: HTMLCanvasElement): boolean {
    const zone = ev ? this.zoneAt(ev, canvas) : null;
    const key = zone ? zone.toArray().join(",") : null;
    if (key === this.hovered) return false;
    this.hovered = key;
    this.highlight.visible = zone !== null;
    if (zone) {
      // Plate covering the whole face.
      const comp = (v: number) => (v === 0 ? [0, 2] : [v, HIGHLIGHT]) as [number, number];
      const [cx, sx] = comp(zone.x);
      const [cy, sy] = comp(zone.y);
      const [cz, sz] = comp(zone.z);
      this.highlight.position.set(cx, cy, cz);
      this.highlight.scale.set(sx, sy, sz);
    }
    return true;
  }

  /** Returns true if the click concerned the cube. */
  click(ev: PointerEvent, canvas: HTMLCanvasElement): boolean {
    if (!this.local(ev, canvas)) return false;
    const zone = this.zoneAt(ev, canvas);
    if (!zone) return true;
    this.onPick(zone.clone().normalize(), viewUp(zone));
    return true;
  }

  private local(ev: PointerEvent, canvas: HTMLCanvasElement): THREE.Vector2 | null {
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left - (rect.width - SIZE - MARGIN);
    const py = ev.clientY - rect.top - MARGIN;
    if (px < 0 || py < 0 || px > SIZE || py > SIZE) return null;
    return new THREE.Vector2((px / SIZE) * 2 - 1, -(py / SIZE) * 2 + 1);
  }

  /** Targeted face, in Z-up coordinates: one component is -1 or 1, the others are 0. */
  private zoneAt(ev: PointerEvent, canvas: HTMLCanvasElement): THREE.Vector3 | null {
    const ndc = this.local(ev, canvas);
    if (!ndc) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    return faceZone(hit.point);
  }

  dispose(): void {
    for (const m of this.cube.material) {
      m.map?.dispose();
      m.dispose();
    }
    this.cube.geometry.dispose();
    this.highlight.geometry.dispose();
    this.highlight.material.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    this.triad.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        (o.material as THREE.Material).dispose();
      } else if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    for (const g of geometries) g.dispose();
  }

  private letter(text: string, color: string): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.font = "700 46px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 6;
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.strokeText(text, 32, 34);
    g.fillStyle = color;
    g.fillText(text, 32, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private texture(text: string): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = "#eef1f5";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#2b3442";
    g.font = `600 ${text.length > 6 ? 24 : 28}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
}
