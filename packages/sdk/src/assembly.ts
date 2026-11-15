import { newId, type DocumentProperties } from "./document.ts";
import type { FixtureDefinition, MachineDefinition } from "./cam.ts";
import type { AssemblyPlane } from "./datum.ts";
import type { MotionStudy } from "./motion.ts";

/**
 * Assembly: occurrences of parts placed by a 4×4 matrix (three.js convention, column-major),
 * groupable, and linked by assembly constraints.
 */

export type Matrix4 = number[];

export const IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export interface AssemblyComponent {
  id: string;
  /** Occurrence name shown in the tree ("Vis M6 <2>"). */
  name: string;
  /** Identifier of the part document (PartDocument.id); empty for a sub-assembly. */
  partId: string;
  /** Sub-assembly (AssemblyDocument.id): the occurrence then carries a whole assembly. */
  assemblyId?: string;
  /** Flexible sub-assembly: its parts keep their internal degrees of freedom within the parent assembly. */
  flexible?: boolean;
  /** Positions of the direct parts of the sub-assembly for THIS occurrence (occurrence frame). */
  flex?: Record<string, Matrix4>;
  matrix: Matrix4;
  fixed?: boolean;
  hidden?: boolean;
  /** Part group (tree folder). */
  group?: string;
  /** Skeleton part: reference sketches for constraints; fixed, excluded from the BOM, interferences and drawings. */
  skeleton?: boolean;
}

/**
 * Geometry targeted by a constraint: plane (flat face), axis (cylindrical face, straight edge)
 * or point (vertex, center of a circular edge).
 */
export type MateRefKind = "plane" | "axis" | "point";

/** Reference to an element (face, edge, vertex) of an occurrence, in part coordinates (local frame). */
export interface MateRef {
  component: string;
  /** Point of the element and normal (plane), direction (axis) or normal of the origin circle (point), in the part's local frame. */
  p: [number, number, number];
  d: [number, number, number];
  kind: MateRefKind;
  /**
   * Designated element, by its topological name (core/NAMING.md, cad-core kernel): face, edge, or vertex (end
   * of a named edge). It follows the element when the part changes or is replaced by another configuration of its family;
   * absent with a kernel without naming (the geometry then serves alone).
   */
  topo?: MateTopo;
  /**
   * Targeted skeleton element or part plane (sketch, line or "plane"; `sketch` is "@XY", "@XZ" or "@YZ"
   * for a base plane): p and d are recomputed on each resolution.
   */
  sketchRef?: { sketch: string; entity: string };
  /** Assembly reference plane (`component` empty): fixed reference, recomputed on each resolution. */
  datum?: string;
  /** Concentric with locked rotation: frame direction perpendicular to the axis (local frame), aligned between the two parts. */
  u?: [number, number, number];
}

/** Topological name of the element targeted by a constraint reference. */
export interface MateTopo {
  element: "face" | "edge" | "vertex";
  /** Name of the face or edge (for a vertex: the edge it is an end of). */
  name: string;
  /** Vertex: end of the edge. */
  end?: "start" | "end";
}

/**
 * Constraint types. The last three couple two motions (the value is a ratio):
 * - `gear`: gear, B turns in the opposite direction to A, θB = −ratio·θA (ratio = ZA / ZB);
 * - `belt`: belt or chain, same direction, θB = +ratio·θA;
 * - `rackpinion`: pinion A (rotation axis) and rack B (axis = translation direction), sB = pitch radius · θA (value = radius, mm).
 * The axes are otherwise held (concentric with the frame); `flip` reverses the direction.
 */
export type MateType = "coincident" | "concentric" | "distance" | "angle" | "parallel" | "perpendicular" | "gear" | "belt" | "rackpinion";

/** Constraints that link two motions instead of positioning two elements. */
export const COUPLING_MATES: readonly MateType[] = ["gear", "belt", "rackpinion"];

/**
 * Pairs of elements accepted by each constraint type (unordered).
 * Coincident: coincident planes, coincident axes, point on plane / axis, coincident points, axis in a plane.
 */
const MATE_PAIRS: Record<MateType, string[]> = {
  coincident: ["plane/plane", "axis/axis", "point/point", "plane/point", "axis/point", "axis/plane"],
  concentric: ["axis/axis", "axis/point"],
  distance: ["plane/plane", "axis/axis", "point/point", "plane/point", "axis/point", "axis/plane"],
  angle: ["plane/plane", "axis/axis", "axis/plane"],
  parallel: ["plane/plane", "axis/axis", "axis/plane"],
  perpendicular: ["plane/plane", "axis/axis", "axis/plane"],
  gear: ["axis/axis"],
  belt: ["axis/axis"],
  rackpinion: ["axis/axis"],
};

const pairKey = (a: MateRefKind, b: MateRefKind) => [a, b].sort().join("/");

/**
 * True if the constraint type accepts element `b` after the first element `a`
 * (without `a`: if `b` can be the first element of an accepted pair).
 */
export function mateAccepts(type: MateType, a: MateRefKind | null | undefined, b: MateRefKind): boolean {
  const pairs = MATE_PAIRS[type];
  return a ? pairs.includes(pairKey(a, b)) : pairs.some((p) => p.split("/").includes(b));
}

export interface Mate {
  id: string;
  type: MateType;
  a: MateRef;
  b: MateRef;
  /** Distance (mm) or angle (°) depending on the type; ratio for gear and belt, pitch radius (mm) for rack and pinion. */
  value?: string;
  /** Opposite directions (faces facing each other) or aligned. */
  flip?: boolean;
  /** Concentric: rotation about the common axis locked (directions `u` of both elements aligned). */
  lockRotation?: boolean;
  suppressed?: boolean;
  /** Element(s) not found after an occurrence was replaced ("a", "b" or "ab"): constraint ignored until it is re-designated. */
  unresolved?: "a" | "b" | "ab";
  /** Driver of a motion study (transient: set by the Motion workbench on each frame, never saved). */
  drive?: MateDrive | MateDrive[];
}

/**
 * Driving of a constraint by the Motion workbench:
 * - distance, angle: `value` replaces the constraint value;
 * - concentric, rotary: signed angle (°) of part B about the common axis, measured from `ua` (frame of A) to `ub` (frame of B);
 * - concentric, rotary: also on a rotation-locked mate (the motor replaces the lock);
 * - concentric or coincident axes, linear: signed position (mm) of B's point along the axis of A;
 * - parallel, linear: signed position (mm) of B's point along the direction of A (plane normal or axis).
 */
export interface MateDrive {
  kind: "rotary" | "linear";
  value: number;
  ua?: [number, number, number];
  ub?: [number, number, number];
}

export interface AssemblyDocument {
  format: "cad.assembly";
  formatVersion: 1;
  id: string;
  name: string;
  components: AssemblyComponent[];
  groups: { id: string; name: string }[];
  mates: Mate[];
  properties?: DocumentProperties;
  /** Drawing planes shown. */
  display?: { planes?: Partial<Record<"XY" | "XZ" | "YZ", boolean>> };
  /** Reference planes of the assembly (built on the base planes or on the faces of the parts). */
  planes?: AssemblyPlane[];
  /**
   * Machine-tool assembly: kinematics, spindle, table and magazine (CAM workbench).
   * An ordinary assembly (imported from STEP, for example) becomes a machine by filling in this field.
   */
  machine?: MachineDefinition;
  /** Fixture (vise, 4th / 5th axis, plate): degrees of freedom, support and clamping frame (CAM workbench). */
  fixture?: FixtureDefinition;
  /** Envelope of a single part published to the community catalog: opening only creates the part. */
  partWrapper?: boolean;
  /** Provenance: assembly (machine) downloaded from the online catalog. */
  source?: CatalogSource;
  /** Motion studies (Motion workbench). */
  motion?: MotionStudy[];
  /**
   * Data of the modules, by module identifier (tolerance stacks…): saved with the assembly, opaque to the core.
   * Each module validates what it reads (the field may come from a file edited by hand or from another version).
   */
  modules?: Record<string, unknown>;
}

/** What a document records of its provenance in the catalog: (library, family, version, configuration). */
export interface CatalogSource {
  library: string;
  family: string;
  /** Identifier of the published version (immutable) and readable number. */
  version: string;
  versionNumber: number;
  configuration: string;
  configurationName: string;
}

export function createAssemblyDocument(name: string): AssemblyDocument {
  return { format: "cad.assembly", formatVersion: 1, id: newId(), name, components: [], groups: [], mates: [] };
}
