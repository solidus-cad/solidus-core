import * as THREE from "three";

/** Section plane of the 3D view. */
export interface SectionSettings {
  /** Normal of the plane (unit), model coordinates. */
  normal: [number, number, number];
  /** Position of the plane along the normal (mm). */
  offset: number;
  /** Inverts the kept side (default: the material on the side opposite the normal). */
  flip?: boolean;
  /** Fills the section (hatching); otherwise the interior of the parts is visible. */
  cap?: boolean;
  /** Assembly occurrences that are not cut: keys, or key prefixes ("subassembly/part"). */
  excluded?: string[];
  /** Section lamp instead of the plane: `normal`, `offset` and `flip` are then ignored. */
  lamp?: SectionLamp;
}

/**
 * Section lamp: a hole along the view direction, around the point of the model under the pointer,
 * down to a depth beyond that point. The hole follows the camera when the view turns.
 */
export interface SectionLamp {
  /** Radius of the hole (mm). */
  radius: number;
  /** Depth of the cut beyond the surface aimed at (mm). */
  depth: number;
  /** The lamp follows the pointer (default); otherwise it stays on the last point aimed at. */
  follow?: boolean;
}

/** Sides of the polygon that approximates the hole of the lamp (the circle of the radius is inscribed in it). */
export const LAMP_SIDES = 24;

/**
 * Clipping planes of the lamp, written into `out` (LAMP_SIDES + 1 planes): the sides of a prism along the view, then its bottom.
 * The material removed is the intersection of their negative sides (`clipIntersection`).
 * `right`, `up`, `back`: camera axes (unit); `center`: point aimed at; `bottom` receives the center of the bottom.
 */
export function lampPlanes(
  center: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  back: THREE.Vector3,
  lamp: SectionLamp,
  out: THREE.Plane[],
  bottom = new THREE.Vector3(),
): THREE.Vector3 {
  const n = new THREE.Vector3();
  for (let i = 0; i < LAMP_SIDES; i++) {
    const a = ((i + 0.5) * 2 * Math.PI) / LAMP_SIDES;
    n.copy(right).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
    // Outward normal at the distance of the radius from the axis: negative inside the prism.
    out[i]!.set(n, -n.dot(center) - lamp.radius);
  }
  bottom.copy(center).addScaledVector(back, -Math.max(lamp.depth, 0));
  // Bottom: normal towards the inside of the model, negative on the camera side.
  n.copy(back).negate();
  out[LAMP_SIDES]!.set(n, -n.dot(bottom));
  return bottom;
}

/** True if the point is removed by the lamp (inside the prism, on the camera side of the bottom). */
export function inLamp(planes: THREE.Plane[], p: THREE.Vector3): boolean {
  return planes.every((pl) => pl.distanceToPoint(p) < -1e-6);
}

/** three.js plane: the material on the negative side is removed. */
export function sectionPlane(s: SectionSettings, out = new THREE.Plane()): THREE.Plane {
  const n = new THREE.Vector3(...s.normal).normalize();
  // Without inversion: normal·p ≤ offset is kept, so the three.js plane has the opposite normal.
  return s.flip ? out.set(n, -s.offset) : out.set(n.negate(), s.offset);
}

export function isExcluded(s: SectionSettings | null, key: string): boolean {
  return !!s?.excluded?.some((e) => key === e || key.startsWith(`${e}/`));
}

let hatch: THREE.CanvasTexture | null = null;

/** 45° hatching pattern (shared). */
function hatchTexture(): THREE.CanvasTexture | null {
  if (hatch) return hatch;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 32, 32);
  g.strokeStyle = "#2a3140";
  g.lineWidth = 2.2;
  for (const o of [-32, 0, 32]) {
    g.beginPath();
    g.moveTo(o, 32);
    g.lineTo(o + 32, 0);
    g.stroke();
  }
  hatch = new THREE.CanvasTexture(c);
  hatch.wrapS = hatch.wrapT = THREE.RepeatWrapping;
  hatch.colorSpace = THREE.SRGBColorSpace;
  hatch.anisotropy = 4;
  return hatch;
}

const noRaycast = () => {};

/** Points of the outline: unit square (plane) or unit circle (lamp). */
function outline(disk: boolean): THREE.Vector3[] {
  if (!disk) return [new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)];
  return Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i * Math.PI) / 32), Math.sin((i * Math.PI) / 32), 0));
}

/**
 * Section fill using the stencil technique: for each body, the back faces (+1) and front faces (−1)
 * remaining after the cut mark the interior; a colored plate is drawn only where the mark is non-zero.
 * The outline and the plates are unit sized, then placed by `placePlane` or `placeLamp` (the lamp moves without rebuilding).
 */
export class SectionCaps {
  readonly group = new THREE.Group();
  private stencils: THREE.Mesh[] = [];
  private plates: THREE.Mesh[] = [];
  private border: THREE.LineLoop | null = null;
  private readonly materials: THREE.Material[] = [];

  /**
   * `disk`: lamp, whose planes remove the intersection of their negative sides; its outline is drawn over the model
   * and its plate is the polygon of the hole. Otherwise a square plane section.
   */
  build(clip: THREE.Plane[], targets: { mesh: THREE.Mesh; color: THREE.Color }[], cap: boolean, disk = false): void {
    this.clear();
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(outline(disk)),
      this.track(new THREE.LineBasicMaterial({ color: 0xe8891c, transparent: true, opacity: disk ? 0.9 : 0.7, depthTest: !disk })),
    );
    if (disk) border.renderOrder = 10;
    border.raycast = noRaycast;
    this.group.add(border);
    this.border = border;
    if (!cap) return;

    const tex = hatchTexture();
    // Lamp: polygon whose vertices are those of the prism (see lampPlanes).
    const plate = disk ? new THREE.CircleGeometry(1, LAMP_SIDES) : new THREE.PlaneGeometry(1, 1);
    targets.forEach((t, i) => {
      const order = 1 + i * 1e-4;
      for (const [side, op] of [
        [THREE.BackSide, THREE.IncrementWrapStencilOp],
        [THREE.FrontSide, THREE.DecrementWrapStencilOp],
      ] as const) {
        const m = this.track(
          new THREE.MeshBasicMaterial({
            side,
            colorWrite: false,
            depthWrite: false,
            depthTest: false,
            clippingPlanes: clip,
            clipIntersection: disk,
            stencilWrite: true,
            stencilFunc: THREE.AlwaysStencilFunc,
            stencilFail: op,
            stencilZFail: op,
            stencilZPass: op,
          }),
        );
        const s = new THREE.Mesh(t.mesh.geometry, m);
        s.renderOrder = order;
        s.raycast = noRaycast;
        s.userData.sectionStencil = true;
        t.mesh.add(s);
        this.stencils.push(s);
      }
      const color = t.color.clone().multiplyScalar(0.85);
      const mat = this.track(
        new THREE.MeshStandardMaterial({
          color,
          map: tex,
          metalness: 0,
          roughness: 0.9,
          side: THREE.DoubleSide,
          stencilWrite: true,
          stencilRef: 0,
          stencilFunc: THREE.NotEqualStencilFunc,
          stencilFail: THREE.ReplaceStencilOp,
          stencilZFail: THREE.ReplaceStencilOp,
          stencilZPass: THREE.ReplaceStencilOp,
        }),
      );
      const p = new THREE.Mesh(plate, mat);
      p.renderOrder = order + 5e-5;
      p.raycast = noRaycast;
      this.group.add(p);
      this.plates.push(p);
    });
  }

  /** Plane section: outline and plates of side `size` on `plane`, centered on the projection of `center`. */
  placePlane(plane: THREE.Plane, center: THREE.Vector3, size: number, pitch: number): void {
    const origin = plane.projectPoint(center, new THREE.Vector3());
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal.clone().negate());
    for (const o of [this.border, ...this.plates]) {
      if (!o) continue;
      o.position.copy(origin);
      o.quaternion.copy(quat);
      o.scale.setScalar(size);
    }
    hatchTexture()?.repeat.setScalar(size / pitch);
  }

  /** Lamp: outline of radius `radius` and plates (the polygon of the hole) at the bottom, facing the camera. */
  placeLamp(bottom: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, back: THREE.Vector3, radius: number, pitch: number): void {
    const basis = new THREE.Matrix4().makeBasis(right, up, back);
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    // Circumscribed polygon: its apothem is the radius.
    const outer = radius / Math.cos(Math.PI / LAMP_SIDES);
    for (const o of [this.border, ...this.plates]) {
      if (!o) continue;
      o.position.copy(bottom);
      o.quaternion.copy(quat);
      o.scale.setScalar(o === this.border ? radius : outer);
    }
    // UV of the polygon: 0 to 1 across its diameter.
    if (this.plates.length) hatchTexture()?.repeat.setScalar((2 * outer) / pitch);
  }

  clear(): void {
    for (const s of this.stencils) s.parent?.remove(s);
    this.stencils = [];
    this.plates = [];
    this.border = null;
    this.group.traverse((o) => {
      if (o !== this.group) (o as THREE.Mesh).geometry?.dispose();
    });
    this.group.clear();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }

  private track<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }
}
