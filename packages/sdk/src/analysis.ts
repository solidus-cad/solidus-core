import type { GeomRef } from "./document.ts";
import type { Material } from "./materials.ts";
import type { V3 } from "./sketch3d.ts";

/**
 * Analysis studies saved in the part:
 * - `beam`: frame on the lines of a skeleton (sections and materials assigned per bar);
 * - `solid`: volumetric finite elements on the body of a solid part.
 * Units: mm, N, N/mm (line loads), MPa (pressure), N·mm (moments).
 */

/** Settings of a bar (skeleton line); absent fields take the values of the study. */
export interface BeamMemberSetting {
  family?: string;
  size?: string;
  /** Rotation of the section about the axis (°), same convention as the frame. */
  rotation?: number;
  /** Name of a material sheet (base or personal materials). */
  material?: string;
  /** Hinges (free bending) at the first and second end of the line. */
  hinges?: [boolean, boolean];
  /** Bar excluded from the calculation (construction line). */
  excluded?: boolean;
}

export type BeamSupportType = "fixed" | "pinned" | "rollerZ" | "custom";

export interface BeamSupportDef {
  id: string;
  /** Point of the skeleton (part frame). */
  at: V3;
  type: BeamSupportType;
  /** Blocked DOFs (ux, uy, uz, rx, ry, rz) for the "custom" type. */
  dofs?: boolean[];
}

/** Blocked DOFs of a support. */
export function supportDofs(s: BeamSupportDef): boolean[] {
  switch (s.type) {
    case "fixed":
      return [true, true, true, true, true, true];
    case "pinned":
      return [true, true, true, false, false, false];
    case "rollerZ":
      return [false, false, true, false, false, false];
    default:
      return [0, 1, 2, 3, 4, 5].map((i) => !!s.dofs?.[i]);
  }
}

export interface BeamNodalLoad {
  id: string;
  at: V3;
  /** Fx, Fy, Fz (N), Mx, My, Mz (N·mm), part frame. */
  f: number[];
}

export interface BeamDistributedLoad {
  id: string;
  /** Skeleton line (key "sketch:element"). */
  member: string;
  /** Line load (N/mm, part frame) at the first and second end. */
  q1: V3;
  q2: V3;
}

export interface BeamLoadCase {
  id: string;
  name: string;
  selfWeight: boolean;
  nodal: BeamNodalLoad[];
  distributed: BeamDistributedLoad[];
}

export interface BeamStudy {
  /** Default section of the bars. */
  family: string;
  size: string;
  rotation: number;
  /** Default material (copy of the sheet). */
  material: Material;
  members: Record<string, BeamMemberSetting>;
  supports: BeamSupportDef[];
  cases: BeamLoadCase[];
  /** Displayed case. */
  activeCase: string;
  /** Division of each bar for the calculation (finer deformed shape and diagrams). */
  divisions: number;
}

export interface SolidFixture {
  id: string;
  ref: GeomRef;
}

export interface SolidLoad {
  id: string;
  ref: GeomRef;
  kind: "force" | "pressure";
  /** Total force (N) or pressure (MPa, positive toward the material). */
  value: number;
  /** Direction of the force (part frame); absent: normal to the face, toward the material. */
  dir?: V3;
}

export interface SolidStudy {
  /** Target element size (mm); 0: automatic. */
  meshSize: number;
  fixtures: SolidFixture[];
  loads: SolidLoad[];
  selfWeight: boolean;
}

export interface AnalysisStudies {
  beam?: BeamStudy;
  solid?: SolidStudy;
}

/** Gravity (mm/s² → N/kg × 1000): the self-weight is ρ·A·g (N/mm), with ρ in kg/mm³ and g = 9.81 m/s². */
export const GRAVITY = 9.81;
