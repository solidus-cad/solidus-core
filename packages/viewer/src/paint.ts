import * as THREE from "three";
import type { Appearance, BodyDisplay, MeshPayload } from "@solidus-cad/sdk";
import { faceBodies } from "./bodies.ts";
import { matchRef } from "./refpick.ts";

/**
 * Own color of each mesh face (index k into `faceGroups`), null: color of the part.
 * Priority: picked face, then the feature that created the face (`faceFeatures`, provided by the kernel), then body (`bodies`,
 * multi-body).
 */
export function faceColorsOf(m: MeshPayload, appearance: Appearance, faceFeatures?: (string | null)[], bodies?: Record<string, BodyDisplay>): (string | null)[] {
  const count = m.faceGroups.length / 3;
  const out: (string | null)[] = new Array(count).fill(null);
  if (bodies) faceBodies(m).forEach((b, k) => (out[k] = (b && bodies[b]?.color) || null));
  const byFeature = appearance.features ?? {};
  if (faceFeatures) {
    for (let k = 0; k < count; k++) {
      const f = faceFeatures[k];
      if (f && byFeature[f]) out[k] = byFeature[f]!;
    }
  }
  if (appearance.faces?.length) {
    const tol = refTolerance(m);
    for (const { ref, color } of appearance.faces) {
      const k = matchRef(m, ref, tol);
      if (k >= 0) out[k] = color;
    }
  }
  return out;
}

/** Same tolerance as the reference picking in the view: proportional to the size of the part. */
function refTolerance(m: MeshPayload): number {
  const box = new THREE.Box3().setFromArray(m.positions);
  const r = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length() / 2;
  return Math.max(r * 4e-3, 1e-3);
}

/**
 * Paint layer: only the colored faces, laid over the mesh of the part (position and normal attributes
 * shared), slightly forward. Null if no face has its own color.
 */
export function paintMesh(geo: THREE.BufferGeometry, m: MeshPayload, colors: (string | null)[]): THREE.Mesh | null {
  const painted = colors.flatMap((c, k) => (c ? [k] : []));
  if (painted.length === 0) return null;
  const g = m.faceGroups;
  const index = new Uint32Array(painted.reduce((n, k) => n + g[k * 3 + 1]!, 0));
  const rgb = new Float32Array(m.positions.length);
  const c = new THREE.Color();
  let o = 0;
  for (const k of painted) {
    const tris = m.indices.subarray(g[k * 3]!, g[k * 3]! + g[k * 3 + 1]!);
    index.set(tris, o);
    o += tris.length;
    c.set(colors[k]!);
    for (const v of tris) rgb.set([c.r, c.g, c.b], v * 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", geo.getAttribute("position"));
  pg.setAttribute("normal", geo.getAttribute("normal"));
  pg.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
  pg.setIndex(new THREE.BufferAttribute(index, 1));
  const mesh = new THREE.Mesh(
    pg,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.15,
      roughness: 0.55,
      // Between the body (1) and the hover (0): the paint covers the body without hiding the preselection.
      polygonOffset: true,
      polygonOffsetFactor: 0.5,
      polygonOffsetUnits: 0.5,
      side: THREE.DoubleSide,
    }),
  );
  tintBackFaces(mesh.material as THREE.MeshStandardMaterial);
  mesh.raycast = () => {};
  return mesh;
}

/** Back-face tint: that of an open surface stands out from its front (a solid does not show its own). */
const BACK_TINT = "vec3(0.93, 0.62, 0.30)";

/** Back faces tinted (orange), to read the orientation of an open surface. */
export function tintBackFaces(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>\n\tif (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, ${BACK_TINT}, 0.6);`,
    );
  };
  material.customProgramCacheKey = () => "back-tint";
}

/** Releases a paint layer (its geometry shares the position and normal of the body: only its own data is disposed). */
export function disposePaint(mesh: THREE.Mesh | null): void {
  if (!mesh) return;
  mesh.removeFromParent();
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
}
