import * as THREE from "three";

/**
 * Display of an analysis (Structures and FEM workbenches), in world coordinates:
 * bars and diagrams (segments colored per vertex), nodes, load arrows, support symbols,
 * and, for finite elements, a colored surface (result map, possibly deformed).
 */

type V3 = [number, number, number];

export interface AnalysisLines {
  /** Pairs of points (x, y, z, x, y, z…). */
  positions: Float32Array;
  /** Color per vertex (r, g, b in [0, 1]); falls back to `color`. */
  colors?: Float32Array;
  color?: number;
  /** Drawn on top of the body (default: true). */
  onTop?: boolean;
  /** Dashed (undeformed bars under the deformed shape). */
  dashed?: boolean;
}

export interface AnalysisArrow {
  /** Arrow tip (point of application). */
  tip: V3;
  /** Load direction (unit or not). */
  dir: V3;
  length: number;
  color: number;
  /** Double head: moment. */
  moment?: boolean;
}

export type SupportKind = "fixed" | "pinned" | "roller" | "custom";

export interface AnalysisSupport {
  p: V3;
  kind: SupportKind;
  size: number;
  /** Blocked direction of a roller support (normal). */
  normal?: V3;
}

export interface AnalysisSurface {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
  /** Mesh edges (pairs of vertex indices), optional. */
  wire?: Uint32Array;
}

/** Point cloud moved frame by frame with `moveAnalysisParticles`, without rebuilding the layer. */
export interface AnalysisParticles {
  /** x, y, z of each particle. */
  positions: Float32Array;
  /** Color per particle (r, g, b in [0, 1]). */
  colors?: Float32Array;
  color?: number;
  /** Size in CSS pixels. */
  size?: number;
}

export interface AnalysisOverlay {
  lines?: AnalysisLines[];
  points?: { positions: V3[]; color: number; size?: number }[];
  arrows?: AnalysisArrow[];
  supports?: AnalysisSupport[];
  surface?: AnalysisSurface;
  particles?: AnalysisParticles;
}

const SUPPORT_COLOR = 0x2f9e44;

function lineObject(l: AnalysisLines): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(l.positions, 3));
  if (l.colors) g.setAttribute("color", new THREE.Float32BufferAttribute(l.colors, 3));
  const onTop = l.onTop ?? true;
  const mat = l.dashed
    ? new THREE.LineDashedMaterial({ color: l.color ?? 0x888888, dashSize: 4, gapSize: 3, depthTest: !onTop, transparent: true, opacity: 0.7 })
    : new THREE.LineBasicMaterial({ color: l.colors ? 0xffffff : (l.color ?? 0x333333), vertexColors: !!l.colors, depthTest: !onTop });
  const obj = new THREE.LineSegments(g, mat);
  if (l.dashed) obj.computeLineDistances();
  obj.renderOrder = 7;
  obj.raycast = () => {};
  return obj;
}

/** Arrow: shaft and cone, the tip on the point of application (cone doubled for a moment). */
function arrowObject(a: AnalysisArrow): THREE.Group {
  const g = new THREE.Group();
  const dir = new THREE.Vector3(...a.dir).normalize();
  const tip = new THREE.Vector3(...a.tip);
  const head = a.length * 0.28;
  const tail = tip.clone().addScaledVector(dir, -a.length);
  const lg = new THREE.BufferGeometry().setFromPoints([tail, tip.clone().addScaledVector(dir, -head * 0.5)]);
  const mat = new THREE.LineBasicMaterial({ color: a.color, depthTest: false });
  const shaft = new THREE.Line(lg, mat);
  shaft.renderOrder = 8;
  g.add(shaft);
  const cones = a.moment ? [0, head * 0.8] : [0];
  for (const off of cones) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(head * 0.35, head, 12), new THREE.MeshBasicMaterial({ color: a.color, depthTest: false }));
    cone.position.copy(tip).addScaledVector(dir, -head / 2 - off);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    cone.renderOrder = 8;
    g.add(cone);
  }
  return g;
}

/**
 * Support symbol below the node (toward −Z, or against `normal` for a roller support):
 * fixed = solid block, pinned = pyramid, roller = pyramid on a roller, other = diamond.
 */
function supportObject(s: AnalysisSupport): THREE.Object3D {
  const mat = new THREE.MeshBasicMaterial({ color: SUPPORT_COLOR, depthTest: false, transparent: true, opacity: 0.85 });
  const n = new THREE.Vector3(...(s.normal ?? [0, 0, 1])).normalize();
  const g = new THREE.Group();
  const h = s.size;
  let body: THREE.Mesh;
  if (s.kind === "fixed") {
    body = new THREE.Mesh(new THREE.BoxGeometry(h, h * 0.5, h), mat);
    body.position.set(0, -h * 0.25, 0);
  } else if (s.kind === "custom") {
    body = new THREE.Mesh(new THREE.OctahedronGeometry(h * 0.35), mat);
  } else {
    body = new THREE.Mesh(new THREE.ConeGeometry(h * 0.5, h * 0.7, 4), mat);
    body.position.set(0, -h * 0.35, 0);
    if (s.kind === "roller") {
      const roll = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.12, h * 0.12, h * 0.8, 12), mat);
      roll.rotation.z = Math.PI / 2;
      roll.position.set(0, -h * 0.85, 0);
      g.add(roll);
    }
  }
  g.add(body);
  g.position.set(...s.p);
  // The symbol is built along +Y: align it with the normal.
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  g.traverse((o) => {
    o.renderOrder = 6;
    o.raycast = () => {};
  });
  return g;
}

function surfaceObject(s: AnalysisSurface): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(s.positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(s.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(s.indices, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  );
  mesh.raycast = () => {};
  g.add(mesh);
  if (s.wire?.length) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", geo.getAttribute("position"));
    wg.setIndex(new THREE.BufferAttribute(s.wire, 1));
    const w = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.35 }));
    w.raycast = () => {};
    g.add(w);
  }
  return g;
}

function particlesObject(p: AnalysisParticles): THREE.Points {
  const g = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(p.positions, 3);
  position.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("position", position);
  if (p.colors) g.setAttribute("color", new THREE.Float32BufferAttribute(p.colors, 3));
  const mat = new THREE.PointsMaterial({ color: p.colors ? 0xffffff : (p.color ?? 0x333333), vertexColors: !!p.colors, size: p.size ?? 3, sizeAttenuation: false });
  const obj = new THREE.Points(g, mat);
  obj.frustumCulled = false; // the bounds change on every move
  obj.renderOrder = 7;
  obj.raycast = () => {};
  return obj;
}

/** Writes new positions in the particle cloud of an analysis, if it has one with the same number of particles. */
export function moveParticles(g: THREE.Group, positions: Float32Array): boolean {
  const cloud = g.children.find((c): c is THREE.Points => c.userData.particles === true);
  const attr = cloud?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!attr || attr.array.length !== positions.length) return false;
  (attr.array as Float32Array).set(positions);
  attr.needsUpdate = true;
  return true;
}

/** Builds the scene of an analysis; `dots` creates the nodes (same rendering as the other markers). */
export function buildAnalysis(o: AnalysisOverlay, dots: (points: V3[], color: number, size?: number) => THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  if (o.surface) g.add(surfaceObject(o.surface));
  for (const l of o.lines ?? []) if (l.positions.length) g.add(lineObject(l));
  for (const s of o.supports ?? []) g.add(supportObject(s));
  for (const a of o.arrows ?? []) g.add(arrowObject(a));
  for (const p of o.points ?? []) if (p.positions.length) g.add(dots(p.positions, p.color, p.size));
  if (o.particles?.positions.length) {
    const cloud = particlesObject(o.particles);
    cloud.userData.particles = true;
    g.add(cloud);
  }
  return g;
}

export function disposeObject(o: THREE.Object3D): void {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((y) => y.dispose());
    else mat?.dispose();
  });
}
