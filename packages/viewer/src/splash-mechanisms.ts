import * as THREE from "three";
import {
  DIG,
  ESC,
  GENEVA,
  JANSEN,
  JANSEN_EDGES,
  digPoints,
  digPose,
  bucketLink,
  escPallets,
  escPivot,
  escSimulate,
  escWheel,
  gearTeeth,
  genevaAt,
  genevaLock,
  genevaWheel,
  jansenLeg,
  meshPhase,
  polar,
  type P,
} from "./splash-kinematics.ts";

/**
 * 3D mechanisms of the splash screen (one drawn at random): Geneva drive, excavator, anchor escapement, Jansen walker.
 * Procedural three.js scenes, transparent background, colours from the splash theme (accent, light / dark).
 */

export type SplashMechanism = "geneva" | "excavator" | "escapement" | "jansen";
export const SPLASH_MECHANISMS: readonly SplashMechanism[] = ["geneva", "excavator", "escapement", "jansen"];

const TAU = Math.PI * 2;
type Mats = Record<"accent" | "steel" | "dark" | "brass" | "bronze" | "ruby" | "ground" | "line" | "dirt" | "chrome", THREE.MeshStandardMaterial>;

function materials(dark: boolean, accent: string): Mats {
  const c = dark
    ? { steel: 0x8e97a5, dark: 0x3a404c, brass: 0xd8b25c, bronze: 0xa07f45, ruby: 0xe0506a, ground: 0x2a2f38, line: 0x3a414e, dirt: 0x7d6446, chrome: 0xc8ced6 }
    : { steel: 0xa9b2bd, dark: 0x4b5361, brass: 0xc79d45, bronze: 0x8f7038, ruby: 0xc2334f, ground: 0xe4e8ee, line: 0xc7ced8, dirt: 0x9a7b55, chrome: 0xe2e6eb };
  const m = (color: THREE.ColorRepresentation, metalness: number, roughness: number) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
  return {
    accent: m(accent, 0.25, 0.45),
    steel: m(c.steel, 0.55, 0.4),
    dark: m(c.dark, 0.2, 0.6),
    brass: m(c.brass, 0.7, 0.32),
    bronze: m(c.bronze, 0.6, 0.45),
    ruby: m(c.ruby, 0.1, 0.25),
    ground: m(c.ground, 0, 0.95),
    line: m(c.line, 0, 0.95),
    dirt: m(c.dirt, 0, 0.95),
    chrome: m(c.chrome, 0.85, 0.22),
  };
}

// --- geometry helpers ---------------------------------------------------------------------------------------------

const BOX = new THREE.BoxGeometry(1, 1, 1);
/** Cylinder along Z. */
const zCyl = (r: number, h: number, seg = 28) => new THREE.CylinderGeometry(r, r, h, seg).rotateX(Math.PI / 2);
const shapeOf = (pts: readonly P[], holes: readonly (readonly P[])[] = []) => {
  const s = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  return s;
};
/** Extrusion along +Z from z0, small bevel. */
const extrude = (shape: THREE.Shape, depth: number, z0 = 0, bevel = 0.012) => {
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 32 });
  return g.translate(0, 0, z0 + bevel);
};
const circlePts = (r: number, n = 48, cx = 0, cy = 0): P[] => Array.from({ length: n }, (_, i) => { const q = polar(r, (i / n) * TAU); return [q[0] + cx, q[1] + cy]; });
/** Holes between spokes: annular sectors between r1 and r2. */
const spokeHoles = (spokes: number, r1: number, r2: number, width: number): P[][] =>
  Array.from({ length: spokes }, (_, k) => {
    const a0 = (k * TAU) / spokes + width / r2, a1 = ((k + 1) * TAU) / spokes - width / r2;
    const b0 = (k * TAU) / spokes + width / r1, b1 = ((k + 1) * TAU) / spokes - width / r1;
    const pts: P[] = [];
    for (let i = 0; i <= 16; i++) pts.push(polar(r2, a0 + ((a1 - a0) * i) / 16));
    for (let i = 16; i >= 0; i--) pts.push(polar(r1, b0 + ((b1 - b0) * i) / 16));
    return pts;
  });
/** Rounded plate (stadium) between two points. */
const stadium = (a: P, b: P, r: number): P[] => {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), pts: P[] = [];
  for (let i = 0; i <= 24; i++) { const t = ang + Math.PI / 2 + (Math.PI * i) / 24; pts.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]); }
  for (let i = 0; i <= 24; i++) { const t = ang - Math.PI / 2 + (Math.PI * i) / 24; pts.push([b[0] + r * Math.cos(t), b[1] + r * Math.sin(t)]); }
  return pts;
};
/** Sets the position (and scale) of an object, returns it. */
function place<T extends THREE.Object3D>(o: T, x: number, y: number, z: number, scale?: [number, number, number]): T {
  o.position.set(x, y, z);
  if (scale) o.scale.set(...scale);
  return o;
}
/** Bar of section w × t (unit box scaled) between two points of a plane z. */
function bar(mat: THREE.Material, w: number, t: number) {
  const m = new THREE.Mesh(BOX, mat);
  m.userData = { w, t };
  return m;
}
function setBar(m: THREE.Mesh, a: P, b: P, z: number) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z);
  m.rotation.z = Math.atan2(dy, dx);
  m.scale.set(Math.hypot(dx, dy), m.userData.w as number, m.userData.t as number);
}

/**
 * Ground fading out to transparent at its rim (radial alpha map), optionally with scrolling stripes across X (the walker's
 * ground): no hard edge in the card. Plain material without a DOM (tests).
 */
function softGround(M: Mats, w: number, d: number, stripes = 0) {
  const mat = new THREE.MeshStandardMaterial({ color: M.ground.color, roughness: 0.95, metalness: 0, transparent: true, depthWrite: false });
  let map: THREE.CanvasTexture | null = null;
  if (typeof document !== "undefined") {
    const a = document.createElement("canvas");
    a.width = a.height = 128;
    const g = a.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.55, "#fff");
    grad.addColorStop(1, "#000");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    mat.alphaMap = new THREE.CanvasTexture(a);
    if (stripes) {
      // stripes texture: ground colour, one line per period (left edge)
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 4;
      const h = c.getContext("2d")!;
      h.fillStyle = `#${M.ground.color.getHexString()}`;
      h.fillRect(0, 0, 64, 4);
      h.fillStyle = `#${M.line.color.getHexString()}`;
      h.fillRect(0, 0, 5, 4);
      map = new THREE.CanvasTexture(c);
      map.colorSpace = THREE.SRGBColorSpace;
      map.wrapS = THREE.RepeatWrapping;
      map.repeat.set(w / stripes, 1);
      mat.map = map;
      mat.color.set(0xffffff);
    }
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat);
  mesh.renderOrder = -1;
  mesh.userData.noFit = true;
  return { mesh, scroll: (dx: number) => { if (map) map.offset.x = -dx / stripes; } };
}

interface Built { cam: { pos: [number, number, number]; look: [number, number, number]; fov: number }; update(t: number): void }

// --- 1. Geneva drive ----------------------------------------------------------------------------------------------

function geneva(scene: THREE.Scene, M: Mats): Built {
  const { a, r, pinR, T } = GENEVA;
  const wheel = new THREE.Mesh(extrude(shapeOf(genevaWheel(), [circlePts(0.1, 32)]), 0.24), M.accent);
  scene.add(wheel);
  // one marker per index step, and the hub
  for (let k = 0; k < 4; k++) {
    const d = new THREE.Mesh(zCyl(0.065, 0.03), M.chrome);
    const q = polar(0.98, (k * Math.PI) / 2 + Math.PI / 4);
    d.position.set(q[0], q[1], 0.25);
    wheel.add(d);
  }
  wheel.add(place(new THREE.Mesh(zCyl(0.24, 0.1), M.steel), 0, 0, 0.29));
  const drive = new THREE.Group();
  drive.position.x = a;
  scene.add(drive);
  drive.add(new THREE.Mesh(extrude(shapeOf(genevaLock(), [circlePts(0.1, 32)]), 0.24), M.steel));
  // crank arm under the wheel plane, pin, hub
  drive.add(new THREE.Mesh(extrude(shapeOf(stadium([0, 0], [r, 0], 0.17)), 0.09, -0.15), M.dark));
  drive.add(place(new THREE.Mesh(zCyl(pinR, 0.42), M.chrome), r, 0, 0.09));
  drive.add(place(new THREE.Mesh(zCyl(0.13, 0.05), M.chrome), r, 0, 0.31));
  drive.add(place(new THREE.Mesh(zCyl(0.24, 0.1), M.steel), 0, 0, 0.29));
  // shafts, bearing blocks, base plate
  for (const x of [0, a]) {
    scene.add(place(new THREE.Mesh(zCyl(0.1, 0.9), M.chrome), x, 0, -0.2));
    scene.add(place(new THREE.Mesh(zCyl(0.22, 0.2), M.dark), x, 0, -0.42));
  }
  const base = stadium([-0.3, 0], [a + 0.3, 0], 1.75);
  scene.add(new THREE.Mesh(extrude(shapeOf(base), 0.12, -0.64, 0.03), M.dark));
  return {
    cam: { pos: [1.15, -3.7, 4.4], look: [1.0, -0.15, -0.1], fov: 34 },
    update(t) {
      const g = genevaAt((t / T) * TAU);
      wheel.rotation.z = g.wheel;
      drive.rotation.z = g.drive;
    },
  };
}

// --- 2. Excavator ---------------------------------------------------------------------------------------------------

/**
 * Layout across the arm plane (z, arm frame): boom ±0.2, boom cylinders at ±0.31 outside it; stick ±0.12 between the bucket
 * ears (±0.14…0.20); H-links ±0.235, side links ±0.29; stick and bucket cylinders on the mid-plane, their eyes in clevises.
 * In-plane clearances of the mid-plane parts: digClearances (test/splash-kinematics.test.ts).
 */
function excavator(scene: THREE.Scene, M: Mats): Built {
  const D = Math.PI / 180;
  scene.add(place(softGround(M, 11, 11).mesh, 1.5, 0, -1.5));
  const mound = (x: number, z: number, s: number) => {
    const m = place(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 14, 0, TAU, 0, Math.PI / 2), M.dirt), x, 0, z, [s, s * 0.42, s]);
    scene.add(m);
    return m;
  };
  mound(4.7, 0.25, 1.35);
  const dump = mound(0.75, -4.8, 0.9);
  // undercarriage: track frames, rollers, sprocket and idler, shoes
  for (const z of [-0.85, 0.85]) {
    const g = place(new THREE.Group(), 0, 0.32, z);
    scene.add(g);
    g.add(new THREE.Mesh(extrude(shapeOf(stadium([-1.3, 0], [1.3, 0], 0.3)), 0.46, -0.23, 0.03), M.dark));
    for (let i = -2; i <= 2; i++) g.add(place(new THREE.Mesh(zCyl(0.12, 0.5), M.steel), i * 0.52, -0.14, 0));
    for (const x of [-1.3, 1.3]) g.add(place(new THREE.Mesh(zCyl(0.22, 0.5), M.steel), x, 0, 0));
    for (let i = 0; i < 12; i++) for (const y of [-0.33, 0.33]) g.add(place(new THREE.Mesh(BOX, M.dark), -1.15 + i * 0.21, y, 0, [0.12, 0.06, 0.52]));
  }
  scene.add(place(new THREE.Mesh(BOX, M.dark), 0, 0.52, 0, [1.5, 0.22, 1.2]));
  // upper structure (turntable, house, counterweight, cab)
  const upper = place(new THREE.Group(), 0, 0.72, 0);
  scene.add(upper);
  const box = (mat: THREE.Material, s: [number, number, number], p: [number, number, number]) => upper.add(place(new THREE.Mesh(BOX, mat), ...p, s));
  upper.add(new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.1, 40), M.steel));
  box(M.accent, [2.3, 0.55, 1.8], [-0.4, 0.33, 0]);
  box(M.dark, [0.5, 0.62, 1.78], [-1.45, 0.4, 0]);
  box(M.accent, [0.95, 1.0, 0.8], [0.3, 1.1, 0.48]);
  box(M.dark, [0.04, 0.55, 0.66], [0.79, 1.18, 0.48]);
  box(M.dark, [0.6, 0.5, 0.04], [0.32, 1.2, 0.89]);
  box(M.dark, [0.08, 0.5, 0.08], [-0.9, 0.85, -0.5]);
  const arm = place(new THREE.Group(), 0, 0, -0.25);
  upper.add(arm);
  const [px, py] = DIG.P0;
  // boom foot brackets and the boom cylinders' mount block (their eyes outside it, at ±0.31)
  for (const z of [-0.24, 0.24]) arm.add(new THREE.Mesh(extrude(shapeOf(stadium([0.55, 0.15], [px, py], 0.2)), 0.08, z - 0.04), M.dark));
  arm.add(place(new THREE.Mesh(BOX, M.dark), 1.0, 0.24, 0, [0.5, 0.26, 0.4]));
  arm.add(place(new THREE.Mesh(zCyl(0.06, 0.74, 16), M.chrome), ...DIG.boomBase, 0));
  const boom = place(new THREE.Group(), px, py, 0);
  arm.add(boom);
  for (const [a, b, w] of DIG.boomBars) { const m = bar(M.accent, w, 0.4); setBar(m, a, b, 0); boom.add(m); }
  boom.add(place(new THREE.Mesh(zCyl(0.2, 0.4), M.accent), 1.6, 0.4, 0));
  boom.add(place(new THREE.Mesh(zCyl(0.2, 0.4), M.accent), 0, 0, 0));
  boom.add(place(new THREE.Mesh(zCyl(0.17, 0.36), M.accent), ...DIG.boomTip, 0));
  // lug under the boom for the boom cylinders' rod eyes (outside it), clevis on top for the stick cylinder
  boom.add(new THREE.Mesh(extrude(shapeOf(stadium([1.12, 0.22], DIG.boomEnd, 0.09)), 0.44, -0.22), M.accent));
  const clevis = (parent: THREE.Object3D, from: P, to: P, r: number, half: number) => {
    for (const s of [-1, 1]) parent.add(new THREE.Mesh(extrude(shapeOf(stadium(from, to, r)), 0.05, s * (half + 0.025) - 0.025), M.accent));
    parent.add(place(new THREE.Mesh(zCyl(0.045, 2 * half + 0.14, 16), M.chrome), ...to, 0));
  };
  const eyeHalf = (rb: number) => (rb * 1.3) / 2 + 0.008;
  clevis(boom, [1.48, 0.5], DIG.stickBase, 0.1, eyeHalf(DIG.rb.stick));
  boom.add(place(new THREE.Mesh(zCyl(0.06, 0.74, 16), M.chrome), ...DIG.boomEnd, 0));
  const stick = place(new THREE.Group(), ...DIG.boomTip, 0);
  boom.add(stick);
  { const m = bar(M.accent, DIG.stickW, 0.24); setBar(m, ...DIG.stickBar, 0); stick.add(m); }
  stick.add(place(new THREE.Mesh(zCyl(0.12, 0.24), M.accent), 0, 0, 0));
  clevis(stick, [-0.26, 0.06], DIG.stickEnd2, 0.085, eyeHalf(DIG.rb.stick));
  clevis(stick, [0.34, 0.12], DIG.Bc, 0.085, eyeHalf(DIG.rb.bucket));
  // side link pivot: two plates on the stick, between the cylinder (|z| ≤ 0.09) and the side links
  for (const s of [-1, 1]) stick.add(new THREE.Mesh(extrude(shapeOf(stadium([1.5, 0.06], DIG.Q, 0.075)), 0.05, s * 0.115 - 0.025), M.accent));
  stick.add(place(new THREE.Mesh(zCyl(0.045, 0.64, 16), M.chrome), ...DIG.Q, 0));
  stick.add(place(new THREE.Mesh(zCyl(0.06, 0.5, 16), M.chrome), 0, 0, 0));
  const bucket = place(new THREE.Group(), ...DIG.stickEnd, 0);
  stick.add(bucket);
  bucket.add(new THREE.Mesh(extrude(shapeOf(DIG.shell), 0.72, -0.36, 0.02), M.dark));
  const ear: P[] = [...Array.from({ length: 13 }, (_, i) => polar(0.13, Math.PI * 0.75 + (Math.PI * i) / 12)).map((q): P => [q[0], q[1]]), [0.24, 0.05], [0.2, 0.36], ...Array.from({ length: 9 }, (_, i): P => { const q = polar(0.1, Math.PI * 0.1 + (Math.PI * 0.9 * i) / 8); return [DIG.K[0] + q[0], DIG.K[1] + q[1]]; })];
  for (const s of [-1, 1]) bucket.add(new THREE.Mesh(extrude(shapeOf(ear), 0.06, s * 0.17 - 0.03), M.dark));
  bucket.add(place(new THREE.Mesh(zCyl(0.05, 0.56, 16), M.chrome), 0, 0, 0));
  bucket.add(place(new THREE.Mesh(zCyl(0.045, 0.56, 16), M.chrome), ...DIG.K, 0));
  for (let i = 0; i < 4; i++) {
    const tooth = place(new THREE.Mesh(BOX, M.steel), 1.15, -0.38, -0.27 + i * 0.18, [0.18, 0.08, 0.1]);
    tooth.rotation.z = -1.2;
    bucket.add(tooth);
  }
  const load = new THREE.Group();
  bucket.add(load);
  for (let i = 0; i < 6; i++) load.add(place(new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 0), M.dirt), 0.48 + 0.13 * (i % 3), 0.06 + 0.05 * (i % 2), -0.25 + 0.1 * i));
  // bucket linkage: side links (Q → J), H-links (J → K), pin J
  const side = [bar(M.dark, 0.09, 0.05), bar(M.dark, 0.09, 0.05)], hl = [bar(M.dark, 0.1, 0.05), bar(M.dark, 0.1, 0.05)];
  [...side, ...hl].forEach((b) => stick.add(b));
  const jPin = new THREE.Mesh(zCyl(0.045, 0.66, 16), M.chrome);
  stick.add(jPin);
  // hydraulic cylinders: barrel (foot, head), rod, eyes; lengths from the motion
  const lens = { boom: [9, 0], stick: [9, 0], bucket: [9, 0] };
  for (let s = 0; s <= 200; s++) {
    const q = digPoints(digPose(s / 200));
    for (const k of ["boom", "stick", "bucket"] as const) {
      const v = q[k];
      if (!v) continue;
      const L = Math.hypot(v[1][0] - v[0][0], v[1][1] - v[0][1]);
      lens[k][0] = Math.min(lens[k][0]!, L);
      lens[k][1] = Math.max(lens[k][1]!, L);
    }
  }
  const S0 = 0.13;
  const cylinder = (k: keyof typeof lens, z: number) => {
    const rb = DIG.rb[k], [Lmin, Lmax] = lens[k] as [number, number];
    const barrelL = Lmin - S0 - 0.14, rodL = Lmax - S0 - barrelL + 0.05;
    const inner = new THREE.Group(); // local +Y along the cylinder, origin at the base pin
    arm.add(inner);
    const tube = (r: number, h: number, y: number, mat: THREE.Material) => inner.add(place(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 22), mat), 0, y, 0));
    tube(rb, barrelL, S0 + barrelL / 2, M.dark);
    tube(rb * 1.18, 0.07, S0 + barrelL - 0.035, M.steel);
    tube(rb * 1.12, 0.06, S0 + 0.03, M.steel);
    inner.add(place(new THREE.Mesh(BOX, M.steel), 0, S0 / 2, 0, [rb * 1.1, S0, rb * 1.3]));
    inner.add(new THREE.Mesh(zCyl(rb * 0.9, rb * 1.3, 22), M.steel));
    const rod = new THREE.Group();
    inner.add(rod);
    rod.add(place(new THREE.Mesh(new THREE.CylinderGeometry(rb * 0.5, rb * 0.5, rodL, 16), M.chrome), 0, -rodL / 2, 0));
    rod.add(place(new THREE.Mesh(BOX, M.steel), 0, -0.06, 0, [rb * 1.0, 0.1, rb * 1.3]));
    rod.add(new THREE.Mesh(zCyl(rb * 0.8, rb * 1.3, 22), M.steel));
    return (a: P, b: P) => {
      inner.position.set(a[0], a[1], z);
      inner.rotation.z = Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.PI / 2;
      rod.position.y = Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
  };
  const cyls = { boomL: cylinder("boom", -0.31), boomR: cylinder("boom", 0.31), stick: cylinder("stick", 0), bucket: cylinder("bucket", 0) };
  // falling spoil
  const drops = Array.from({ length: 10 }, (_, i) => { const d = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09 + 0.03 * (i % 3), 0), M.dirt); scene.add(d); return d; });
  const bw = new THREE.Vector3();
  return {
    cam: { pos: [7.4, 5.2, 7.6], look: [1.5, 1.0, -1.25], fov: 34 },
    update(t) {
      const ph = (t % DIG.T) / DIG.T, p = digPose(ph);
      upper.rotation.y = p.sw;
      boom.rotation.z = p.a1 * D;
      stick.rotation.z = p.a2 * D;
      bucket.rotation.z = p.a3 * D;
      const q = digPoints(p), link = bucketLink(p.a3);
      cyls.boomL(...q.boom);
      cyls.boomR(...q.boom);
      cyls.stick(...q.stick);
      if (q.bucket) cyls.bucket(...q.bucket);
      if (link) {
        side.forEach((b, i) => setBar(b, DIG.Q, link.J, i ? 0.29 : -0.29));
        hl.forEach((b, i) => setBar(b, link.J, link.K, i ? 0.235 : -0.235));
        jPin.position.set(link.J[0], link.J[1], 0);
      }
      load.visible = ph > 0.3 && ph < 0.77;
      scene.updateMatrixWorld(true);
      bucket.localToWorld(bw.set(0.6, 0.1, 0));
      drops.forEach((d, i) => {
        const tau = (ph - 0.74 - 0.012 * i) * DIG.T, y = bw.y - 4.9 * tau * tau;
        d.visible = tau > 0 && y > 0.3;
        d.position.set(bw.x + 0.18 * Math.sin(i * 2.1), y, bw.z + 0.22 * Math.cos(i * 1.7));
        d.rotation.set(i + tau * 5, tau * 3, 0);
      });
      dump.scale.y = 0.38 + 0.07 * Math.min(1, Math.max(0, (ph - 0.76) / 0.1)) - 0.07 * Math.max(0, (ph - 0.95) / 0.05);
    },
  };
}

// --- 3. Anchor escapement -------------------------------------------------------------------------------------------

/**
 * Escape wheel, anchor and pallets on the plane z = 0 (contact simulation: escSimulate), the anchor arms behind (z ≈ -0.07),
 * pinion and third wheel at z ≈ -0.3, back plate at -0.78, pendulum behind it (-0.95) carried by the anchor arbor.
 */
function escapement(scene: THREE.Scene, M: Mats): Built {
  const sim = escSimulate();
  const pv = escPivot(), T = ESC.T;
  const wheel = new THREE.Mesh(extrude(shapeOf(escWheel(), [...spokeHoles(5, 0.24, 0.68, 0.06), circlePts(0.05, 24)]), 0.07, -0.035, 0.008), M.brass);
  scene.add(wheel);
  wheel.add(new THREE.Mesh(zCyl(0.13, 0.12), M.brass));
  const n1 = 8, n2 = 44, r1: [number, number] = [0.17, 0.245], r2: [number, number] = [1.17, 1.27], dist = 1.42, dir = (15 * Math.PI) / 180;
  wheel.add(new THREE.Mesh(extrude(shapeOf(gearTeeth(n1, ...r1).flat()), 0.16, -0.36, 0.006), M.steel));
  scene.add(place(new THREE.Mesh(zCyl(0.045, 0.9), M.chrome), 0, 0, -0.34));
  const phase = meshPhase(n1, r1, n2, r2, dist, dir);
  const big = place(new THREE.Mesh(extrude(shapeOf(gearTeeth(n2, ...r2).flat(), spokeHoles(6, 0.26, 1.0, 0.07)), 0.07, -0.32, 0.008), M.bronze), dist * Math.cos(dir), dist * Math.sin(dir), 0);
  scene.add(big);
  big.add(place(new THREE.Mesh(zCyl(0.16, 0.12), M.bronze), 0, 0, -0.285));
  scene.add(place(new THREE.Mesh(zCyl(0.05, 0.6), M.chrome), big.position.x, big.position.y, -0.5));
  // second pinion on the third wheel arbor, fourth wheel
  const n3 = 10, n4 = 48, r3: [number, number] = [0.2, 0.27], r4: [number, number] = [1.08, 1.18], dist2 = 1.365, dir2 = (-20 * Math.PI) / 180;
  big.add(new THREE.Mesh(extrude(shapeOf(gearTeeth(n3, ...r3).flat()), 0.12, -0.56, 0.006), M.steel));
  const phase2 = meshPhase(n3, r3, n4, r4, dist2, dir2);
  const fourth = place(new THREE.Mesh(extrude(shapeOf(gearTeeth(n4, ...r4).flat(), spokeHoles(5, 0.26, 0.9, 0.07)), 0.07, -0.535, 0.008), M.bronze), big.position.x + dist2 * Math.cos(dir2), big.position.y + dist2 * Math.sin(dir2), 0);
  scene.add(fourth);
  fourth.add(place(new THREE.Mesh(zCyl(0.16, 0.12), M.bronze), 0, 0, -0.5));
  scene.add(place(new THREE.Mesh(zCyl(0.05, 0.4), M.chrome), fourth.position.x, fourth.position.y, -0.6));
  // anchor: ruby pallets, arms and hub, arbor through the back plate to the pendulum
  const anchor = place(new THREE.Group(), pv[0], pv[1], 0);
  scene.add(anchor);
  for (const pal of escPallets()) {
    anchor.add(new THREE.Mesh(extrude(shapeOf(pal), 0.09, -0.045, 0.006), M.ruby));
    const c: P = [(pal[1]![0] + pal[2]![0]) / 2, (pal[1]![1] + pal[2]![1]) / 2];
    anchor.add(new THREE.Mesh(extrude(shapeOf(stadium([0, 0], c, 0.075)), 0.05, -0.1, 0.006), M.steel));
  }
  anchor.add(place(new THREE.Mesh(zCyl(0.15, 0.1), M.steel), 0, 0, -0.07));
  anchor.add(place(new THREE.Mesh(zCyl(0.045, 1.0), M.chrome), 0, 0, -0.5));
  const rodL = 2.9;
  const rod = bar(M.steel, 0.05, 0.035);
  setBar(rod, [0, 0.12], [0, -rodL], -0.95);
  anchor.add(rod);
  anchor.add(place(new THREE.Mesh(zCyl(0.34, 0.1, 48), M.brass), 0, -rodL, -0.95));
  anchor.add(place(new THREE.Mesh(zCyl(0.1, 0.12, 24), M.steel), 0, -rodL, -0.93));
  // skeleton back plate
  const back = (a: P, b: P, w: number) => { const m = bar(M.dark, w, 0.08); setBar(m, a, b, -0.78); scene.add(m); };
  const E: P = [0, 0], B: P = [big.position.x, big.position.y], F: P = [fourth.position.x, fourth.position.y], A: P = [pv[0], pv[1]];
  back([A[0] - 0.5, A[1]], [B[0], A[1]], 0.16);
  back(A, E, 0.12);
  back(E, B, 0.12);
  back(B, F, 0.12);
  back([B[0], A[1]], B, 0.12);
  back(E, [F[0], -1.15], 0.12);
  back([F[0], -1.15], F, 0.12);
  for (const p of [E, A, B, F]) scene.add(place(new THREE.Mesh(zCyl(0.11, 0.06), M.steel), p[0], p[1], -0.71));
  const N = sim.wheel.length - 1, period = 2 * T, pitch = TAU / ESC.n;
  return {
    cam: { pos: [0.75, -0.15, 6.9], look: [0.55, -0.05, 0], fov: 36 },
    update(t) {
      const k = Math.floor(t / period), u = ((t % period) / period) * N, i = Math.floor(u), f = u - i;
      const w = sim.wheel[i]! + (sim.wheel[Math.min(N, i + 1)]! - sim.wheel[i]!) * f - 2 * pitch * k;
      wheel.rotation.z = w;
      big.rotation.z = phase - (w * n1) / n2;
      fourth.rotation.z = phase2 - (big.rotation.z * n3) / n4;
      anchor.rotation.z = sim.anchor(t % period);
    },
  };
}

// --- 4. Jansen walker -----------------------------------------------------------------------------------------------

/**
 * Level of each bar of a leg across its plane (index in JANSEN_EDGES, unit = bar thickness): the bars never cross in the
 * plane (test), the bars sharing a joint are stacked; the crank arm behind. The mirrored leg of the same plane uses the
 * opposite levels (both meet at the crank pin M).
 */
export const JANSEN_LEVELS = [-2.5, 1.5, 0.5, -0.5, -1.5, 1.5, 0.5, -1.5, -0.5, 1.5, 0.5];

function jansen(scene: THREE.Scene, M: Mats): Built {
  const T = 2.4, S = 0.01, L = JANSEN, step = 0.018;
  const legs: { z: number; ph: number; mir: 1 | -1; bars: THREE.Mesh[]; foot: THREE.Mesh; pins: THREE.Mesh[] }[] = [];
  const layers: [number, number][] = [[0.16, 0], [0.3, 1], [0.44, 2], [-0.16, 0.5], [-0.3, 1.5], [-0.44, 2.5]];
  const PINS = ["M", "C", "D", "E", "F", "G"] as const;
  for (const [z, ph] of layers) for (const mir of [1, -1] as const) {
    const bars = JANSEN_EDGES.map((_, i) => bar(i < 3 ? M.accent : M.steel, 0.024, 0.016));
    bars.forEach((b) => scene.add(b));
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), M.dark);
    scene.add(foot);
    const pins = PINS.map(() => { const m = new THREE.Mesh(zCyl(0.011, 0.1, 10), M.chrome); scene.add(m); return m; });
    legs.push({ z, ph: (ph * TAU) / 3, mir, bars, foot, pins });
  }
  const crank = new THREE.Mesh(zCyl(0.022, 1.04), M.chrome);
  scene.add(crank);
  for (const x of [-L.a * S, L.a * S]) scene.add(place(new THREE.Mesh(zCyl(0.02, 1.04), M.chrome), x, -L.l * S, 0));
  for (const z of [-0.54, 0.54]) {
    const beam = bar(M.dark, 0.06, 0.05);
    setBar(beam, [-L.a * S - 0.06, -L.l * S], [L.a * S + 0.06, -L.l * S], z);
    scene.add(beam);
    const post = bar(M.dark, 0.05, 0.05);
    setBar(post, [0, 0.03], [0, -L.l * S], z);
    scene.add(post);
  }
  const groundY = -0.92 - 0.026;
  const ground = softGround(M, 4.6, 2.2, 0.3);
  ground.mesh.position.y = groundY;
  scene.add(ground.mesh);
  const v = 23 * S * (TAU / T); // ground speed = foot speed in stance (about 23 units per crank radian)
  return {
    cam: { pos: [1.55, 0.35, 2.75], look: [0, -0.42, 0], fov: 38 },
    update(t) {
      const th = (TAU * t) / T;
      crank.rotation.z = th;
      for (const lg of legs) {
        const q = jansenLeg(lg.mir > 0 ? th + lg.ph : Math.PI - (th + lg.ph));
        const W = (p: P): P => [lg.mir * p[0] * S, p[1] * S];
        JANSEN_EDGES.forEach(([u, w], i) => setBar(lg.bars[i]!, W(q[u]), W(q[w]), lg.z + lg.mir * step * JANSEN_LEVELS[i]!));
        lg.foot.position.set(...W(q.G), lg.z);
        PINS.forEach((k, i) => lg.pins[i]!.position.set(...W(q[k]), lg.z));
      }
      ground.scroll(v * t);
    },
  };
}

// --- mount ----------------------------------------------------------------------------------------------------------

const BUILDERS: Record<SplashMechanism, (s: THREE.Scene, m: Mats) => Built> = { geneva, excavator, escapement, jansen };

/**
 * Frames the mechanism for a 2:1 view: keeps the camera direction of the builder, recentres and sets the distance so that
 * the parts (ground excluded) stay inside ±FILL of the view over the whole cycle.
 */
const FILL = 0.9;
function frame(scene: THREE.Scene, camera: THREE.PerspectiveCamera, built: Built, skip: Set<THREE.Material>) {
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < 24; i++) {
    built.update(i * 0.2);
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.visible || o.userData.noFit || skip.has(o.material as THREE.Material)) return;
      const pos = o.geometry.getAttribute("position");
      const stride = Math.max(1, Math.floor(pos.count / 160));
      for (let j = 0; j < pos.count; j += stride) pts.push(v.fromBufferAttribute(pos, j).applyMatrix4(o.matrixWorld).clone());
    });
  }
  const look = new THREE.Vector3(...built.cam.look);
  for (let it = 0; it < 4; it++) {
    camera.aspect = 2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { v.copy(p).project(camera); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
    const dir = camera.position.clone().sub(look), d = dir.length();
    const halfH = d * Math.tan((camera.fov * Math.PI) / 360), right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    look.addScaledVector(right, ((x0 + x1) / 2) * halfH * 2).addScaledVector(up, ((y0 + y1) / 2) * halfH);
    const k = Math.max((x1 - x0) / 2, (y1 - y0) / 2) / FILL;
    camera.position.copy(look).addScaledVector(dir.normalize(), d * k);
    camera.lookAt(look);
  }
}

/** Scene of a mechanism, without renderer (lights included): `update(t)` poses it at time t (seconds). */
export function splashScene(kind: SplashMechanism, dark: boolean, accent: string) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a8, 1.7));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 6, 8);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8);
  rim.position.set(-6, 3, -4);
  scene.add(key, rim);
  const mats = materials(dark, accent);
  const built = BUILDERS[kind](scene, mats);
  const camera = new THREE.PerspectiveCamera(built.cam.fov, 2, 0.1, 100);
  camera.position.set(...built.cam.pos);
  camera.lookAt(...built.cam.look);
  frame(scene, camera, built, new Set<THREE.Material>([mats.ground, mats.line]));
  return { scene, camera, update: built.update, mats };
}

export interface SplashMechanismHandle {
  stop(): void;
}

/**
 * Draws a mechanism in a canvas appended to `host` (sized by the host's CSS box) until `stop`. Without WebGL: nothing.
 * `still`: a single frame (reduced motion).
 */
export function mountSplashMechanism(host: HTMLElement, kind: SplashMechanism, opts: { dark: boolean; accent: string; still?: boolean }): SplashMechanismHandle {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return { stop() {} };
  }
  // edges faded out: the ground (and anything at the rim) dissolves into the card
  const fade = "linear-gradient(to right, transparent, #000 7%, #000 93%, transparent), linear-gradient(to bottom, #000 82%, transparent)";
  canvas.style.setProperty("mask-image", fade);
  canvas.style.setProperty("-webkit-mask-image", fade);
  canvas.style.setProperty("mask-composite", "intersect");
  canvas.style.setProperty("-webkit-mask-composite", "source-in");
  host.append(canvas);
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const { scene, camera: cam, update } = splashScene(kind, opts.dark, opts.accent);
  const t0 = performance.now();
  let raf = 0, stopped = false;
  const frame = (now: number) => {
    if (stopped) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h && (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio()))) {
      renderer.setSize(w, h, false);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    update(opts.still ? 0.6 : (now - t0) / 1000);
    renderer.render(scene, cam);
    if (!opts.still) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      const done = new Set<unknown>();
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        if (o.geometry !== BOX) o.geometry.dispose();
        const m = o.material as THREE.MeshStandardMaterial;
        if (done.has(m)) return;
        done.add(m);
        m.map?.dispose();
        m.alphaMap?.dispose();
        m.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
