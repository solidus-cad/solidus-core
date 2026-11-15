import * as THREE from "three";
import type { Finish } from "@solidus-cad/sdk";
import { tintBackFaces } from "./paint.ts";

/**
 * Rendering of a finish. Pattern: height mapped by triplanar projection (brushing streaks, grain), or wood grain
 * computed in the shader; the height modulates the relief, the roughness and the tint.
 */
interface FinishLook {
  metalness: number;
  roughness: number;
  pattern?: "brushed" | "grain" | "wood";
  /** Size of a texture pattern on the part (mm). */
  tile?: number;
  bump?: number;
  /** Roughness and tint factors at the troughs and peaks of the pattern. */
  rough?: [number, number];
  tint?: [number, number];
}

const LOOKS: Record<Finish, FinishLook> = {
  polished: { metalness: 1, roughness: 0.12 },
  brushed: { metalness: 1, roughness: 0.32, pattern: "brushed", tile: 40, bump: 0.3, rough: [0.7, 1.3], tint: [0.86, 1.06] },
  sandblasted: { metalness: 1, roughness: 0.62, pattern: "grain", tile: 6, bump: 0.2, rough: [0.85, 1.15], tint: [0.92, 1.04] },
  glossy: { metalness: 0, roughness: 0.18 },
  grained: { metalness: 0, roughness: 0.6, pattern: "grain", tile: 12, bump: 0.35, rough: [0.85, 1.2], tint: [0.94, 1.03] },
  wood: { metalness: 0, roughness: 0.62, pattern: "wood", tile: 60, bump: 0.08, rough: [0.9, 1.1], tint: [0.7, 1.04] },
};

/**
 * Triplanar projection: the texture is mapped along the three axes of the part and blended according to the normal.
 * The kernel mesh has no texture coordinates: this mapping does not need any and follows the part when it moves.
 */
const TRIPLANAR_PARS = /* glsl */ `
varying vec3 vFinPos;
varying vec3 vFinNormal;
uniform sampler2D uFinHeight;
uniform float uFinScale;
uniform float uFinBump;
float finTri(sampler2D t, float scale) {
  vec3 w = pow(abs(normalize(vFinNormal)), vec3(8.0));
  w /= w.x + w.y + w.z;
  vec3 p = vFinPos * scale;
  return texture2D(t, p.yz).r * w.x + texture2D(t, p.xz).r * w.y + texture2D(t, p.xy).r * w.z;
}
// Wood: growth rings around an axis parallel to X (outside the part: arcs, not circles), waved by the pattern
// taken at large scale, and fine fibers along X.
float finWood() {
  float wave = finTri(uFinHeight, uFinScale * 0.08);
  float r = length(vFinPos.yz + vec2(37.0, -140.0)) / 5.0 + 2.5 * wave;
  float rings = pow(0.5 + 0.5 * sin(r * 6.2832), 3.0);
  return 0.75 * rings + 0.25 * finTri(uFinHeight, uFinScale);
}
// Relief from the screen-space variations of the height (like perturbNormalArb in three.js, without texture coordinates).
vec3 finPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos));
  vec3 sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

const glslRange = ([a, b]: [number, number]) => `${a.toFixed(3)}, ${b.toFixed(3)}`;

/** Material of a finish, with the given color and its own reflections (`envMap`), even without realistic rendering. */
export function createFinishMaterial(finish: Finish, color: THREE.ColorRepresentation, envMap: THREE.Texture, maxAnisotropy: number): THREE.MeshStandardMaterial {
  const look = LOOKS[finish];
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness: look.metalness,
    roughness: look.roughness,
    envMap,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: THREE.DoubleSide,
  });
  tintBackFaces(material);
  const pattern = look.pattern;
  if (!pattern) return material;

  const height = heightOf(pattern === "grain" ? "grain" : "brushed");
  height.anisotropy = maxAnisotropy;
  const tint = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    tint.call(material, shader, renderer);
    shader.uniforms.uFinHeight = { value: height };
    shader.uniforms.uFinScale = { value: 1 / look.tile! };
    shader.uniforms.uFinBump = { value: look.bump! };
    const h = pattern === "wood" ? "finWood()" : "finTri(uFinHeight, uFinScale)";
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFinPos;\nvarying vec3 vFinNormal;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvFinPos = transformed;\n\tvFinNormal = objectNormal;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${TRIPLANAR_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n\tfloat finH = ${h};\n\tdiffuseColor.rgb *= mix(${glslRange(look.tint!)}, finH);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n\troughnessFactor *= mix(${glslRange(look.rough!)}, finH);`)
      .replace(
        "#include <normal_fragment_maps>",
        "#include <normal_fragment_maps>\n\tnormal = finPerturb(-vViewPosition, normal, vec2(dFdx(finH), dFdy(finH)) * uFinBump, faceDirection);",
      );
  };
  material.customProgramCacheKey = () => `back-tint+${finish}`;
  return material;
}

/** Patterns computed once and shared by all materials (part, occurrences and batches of an assembly). */
const heights = new Map<"brushed" | "grain", THREE.DataTexture>();

function heightOf(kind: "brushed" | "grain"): THREE.DataTexture {
  let tex = heights.get(kind);
  if (!tex) {
    tex = kind === "grain" ? grainHeight(256) : brushedHeight(512);
    heights.set(kind, tex);
  }
  return tex;
}

/** Releases the shared patterns (viewer teardown). */
export function disposeFinishTextures(): void {
  for (const tex of heights.values()) tex.dispose();
  heights.clear();
}

/**
 * Height of a brushed finish, computed (no image to download) and tileable: streaks of varying widths along X,
 * slightly modulated along their length. Deterministic: the same pattern on every open.
 */
function brushedHeight(n: number): THREE.DataTexture {
  const rand = mulberry32(0x5eed);
  // Cross profile of the streaks: periodic noise at several scales (fine streaks and wider bands).
  const across = new Float32Array(n);
  for (const [period, amp] of [[4, 0.4], [16, 0.35], [64, 0.25]] as const) {
    const pts = Array.from({ length: n / period }, () => rand());
    for (let y = 0; y < n; y++) across[y]! += amp * smoothPeriodic(pts, y / period);
  }
  // Variation along a streak: very slow, so that the streak stays long.
  const along = Array.from({ length: n }, () => Array.from({ length: 4 }, () => rand()));
  const data = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) data[y * n + x] = toByte(0.8 * across[y]! + 0.2 * smoothPeriodic(along[y]!, (x / n) * 4));
  }
  return heightTexture(data, n);
}

/** Height of an undirected grain (sandblasting, grained plastic): tileable value noise at several scales. */
function grainHeight(n: number): THREE.DataTexture {
  const rand = mulberry32(0x9a17);
  const sum = new Float32Array(n * n);
  for (const [period, amp] of [[4, 0.4], [8, 0.3], [16, 0.2], [32, 0.1]] as const) {
    const cells = n / period;
    const grid = Array.from({ length: cells }, () => Array.from({ length: cells }, () => rand()));
    for (let y = 0; y < n; y++) {
      const rows = [0, 1].map((d) => grid[(Math.floor(y / period) + d) % cells]!);
      const fy = smooth(y / period - Math.floor(y / period));
      for (let x = 0; x < n; x++) {
        const a = smoothPeriodic(rows[0]!, x / period);
        const b = smoothPeriodic(rows[1]!, x / period);
        sum[y * n + x]! += amp * (a + (b - a) * fy);
      }
    }
  }
  return heightTexture(Uint8Array.from(sum, toByte), n);
}

function heightTexture(data: Uint8Array, n: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const smooth = (f: number) => f * f * (3 - 2 * f);

/** Smooth interpolation between values placed at integers, wrapping around. */
function smoothPeriodic(pts: readonly number[], t: number): number {
  const k = Math.floor(t);
  const a = pts[((k % pts.length) + pts.length) % pts.length]!;
  const b = pts[(((k + 1) % pts.length) + pts.length) % pts.length]!;
  return a + (b - a) * smooth(t - k);
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
