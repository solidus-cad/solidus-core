import * as THREE from "three";

/**
 * Shading analyses of the part (surface quality), drawn by a material that replaces the one of the part:
 *  - zebra: alternating bands of the angle between the normal and a direction (isophotes): a kink in the bands shows a
 *    tangency break (G1), a sharp bend in their direction a curvature break (G2);
 *  - draft: angle of the faces to a pull direction, in three classes (enough draft, not enough, undercut);
 *  - scalar: a value per vertex (curvature from the kernel) on a color scale, gray where it is not defined.
 * Computed per pixel from the interpolated normals: independent of the size of the mesh triangles.
 */

type V3 = [number, number, number];

export type ShadingAnalysis =
  /** `width`: angular width of a band (°). */
  | { kind: "zebra"; dir: V3; width: number }
  /** `angle`: minimum draft (°); positive side: faces opening along `dir`. */
  | { kind: "draft"; dir: V3; angle: number }
  /** One value per vertex of the displayed mesh (`positions` order); [min, max] mapped onto the color scale. */
  | { kind: "scalar"; values: Float32Array; min: number; max: number };

/** Colors of the draft classes: enough draft, not enough (between -angle and +angle), undercut. */
export const DRAFT_COLORS = { positive: 0x2f9e44, insufficient: 0xf2c94c, negative: 0xd64545 };

/** Color scale of the scalar analysis, from min (blue) to max (red). Also used by the legend. */
export function scaleColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  // Blue → cyan → green → yellow → red.
  const stops: [number, number, number][] = [
    [0.18, 0.3, 0.85],
    [0.1, 0.75, 0.85],
    [0.2, 0.7, 0.3],
    [0.95, 0.8, 0.2],
    [0.85, 0.2, 0.2],
  ];
  const f = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const k = f - i;
  return [0, 1, 2].map((c) => stops[i]![c]! + (stops[i + 1]![c]! - stops[i]![c]!) * k) as [number, number, number];
}

const vertex = /* glsl */ `
attribute float analysis;
varying vec3 vNormal;
varying vec3 vViewNormal;
varying float vValue;
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  vViewNormal = normalize(normalMatrix * normal);
  vValue = analysis;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragment = /* glsl */ `
uniform int mode;
uniform vec3 dir;
uniform float width;
uniform float angle;
uniform float vmin;
uniform float vmax;
uniform vec3 positive;
uniform vec3 insufficient;
uniform vec3 negative;
varying vec3 vNormal;
varying vec3 vViewNormal;
varying float vValue;

vec3 scale(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  vec3 c0 = vec3(0.18, 0.3, 0.85), c1 = vec3(0.1, 0.75, 0.85), c2 = vec3(0.2, 0.7, 0.3), c3 = vec3(0.95, 0.8, 0.2), c4 = vec3(0.85, 0.2, 0.2);
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  return mix(c3, c4, t - 3.0);
}

void main() {
  vec3 n = normalize(vNormal);
  // Faces seen from behind (surfaces): the visible side, so that the bands stay continuous across a fold.
  if (!gl_FrontFacing) n = -n;
  float light = 0.55 + 0.45 * abs(normalize(vViewNormal).z);
  vec3 color;
  if (mode == 0) {
    float a = degrees(acos(clamp(dot(n, dir), -1.0, 1.0)));
    color = mod(floor(a / width), 2.0) < 1.0 ? vec3(0.08) : vec3(0.97);
    light = 1.0;
  } else if (mode == 1) {
    float draft = 90.0 - degrees(acos(clamp(dot(n, dir), -1.0, 1.0)));
    color = draft >= angle ? positive : (draft <= -angle ? negative : insufficient);
  } else {
    color = vValue < -1e29 || vmax <= vmin ? vec3(0.6) : scale((vValue - vmin) / (vmax - vmin));
  }
  gl_FragColor = vec4(color * light, 1.0);
}
`;

const MODES = { zebra: 0, draft: 1, scalar: 2 } as const;

/** Material of an analysis; the "analysis" attribute (scalar) is set on the geometry by `applyValues`. */
export function analysisMaterial(a: ShadingAnalysis): THREE.ShaderMaterial {
  const d = new THREE.Vector3(...(a.kind === "scalar" ? ([0, 0, 1] as V3) : a.dir)).normalize();
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms: {
      mode: { value: MODES[a.kind] },
      dir: { value: d },
      width: { value: a.kind === "zebra" ? Math.max(a.width, 0.5) : 10 },
      angle: { value: a.kind === "draft" ? a.angle : 0 },
      vmin: { value: a.kind === "scalar" ? a.min : 0 },
      vmax: { value: a.kind === "scalar" ? a.max : 1 },
      // Written to the screen as they are (no color management in this shader): the colors of the legend.
      positive: { value: new THREE.Color().setHex(DRAFT_COLORS.positive, THREE.LinearSRGBColorSpace) },
      insufficient: { value: new THREE.Color().setHex(DRAFT_COLORS.insufficient, THREE.LinearSRGBColorSpace) },
      negative: { value: new THREE.Color().setHex(DRAFT_COLORS.negative, THREE.LinearSRGBColorSpace) },
    },
  });
}

/**
 * "analysis" attribute of the geometry: the values of a scalar analysis if there is one per vertex, otherwise NaN
 * (shown gray; the mesh changed since the values were computed). Returns false in that case. Undefined values are gray too.
 */
export function applyValues(geo: THREE.BufferGeometry, a: ShadingAnalysis): boolean {
  const count = geo.getAttribute("position").count;
  const fits = a.kind === "scalar" && a.values.length === count;
  // Undefined values (NaN) as a sentinel: some GPUs do not keep NaN in vertex attributes.
  const values = fits ? a.values.map((v) => (Number.isNaN(v) ? -1e30 : v)) : new Float32Array(count).fill(-1e30);
  geo.setAttribute("analysis", new THREE.BufferAttribute(values, 1));
  return fits || a.kind !== "scalar";
}
