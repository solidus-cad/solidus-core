import type { AssemblyDocument, AxisValues, MachineAxis, Matrix4, Point3 } from "@solidus-cad/sdk";

/**
 * Forward kinematics of a machine: position of each occurrence for given axis values.
 * Axes are defined at the zero position (that of the modelled assembly); a child axis is carried by its parent:
 *   M(occurrence) = T(racine) · … · T(parent) · T(axe) · M0(occurrence)
 */

/** Product of 4×4 column-major matrices (a × b). */
export function mul4(a: Matrix4, b: Matrix4): Matrix4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

export function translation(x: number, y: number, z: number): Matrix4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Rotation by `deg` degrees about the axis (`origin`, `dir`). */
export function rotationAbout(origin: Point3, dir: Point3, deg: number): Matrix4 {
  const n = Math.hypot(...dir) || 1;
  const [x, y, z] = [dir[0] / n, dir[1] / n, dir[2] / n];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  // Rodrigues, column-major
  const r: Matrix4 = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
  return mul4(translation(...origin), mul4(r, translation(-origin[0], -origin[1], -origin[2])));
}

/** Transformation of a single axis at value `v`. */
export function axisTransform(axis: MachineAxis, v: number): Matrix4 {
  if (axis.kind === "linear") {
    const [x, y, z] = axis.direction;
    return translation(x * v, y * v, z * v);
  }
  return rotationAbout(axis.origin ?? [0, 0, 0], axis.direction, v);
}

/** Chain of axes from the root to `axisId` (inclusive). */
/** Any definition with axes: machine or fixture. */
export type Kinematic = { axes: MachineAxis[] };

function chain(machine: Kinematic, axisId: string): MachineAxis[] {
  const byId = new Map(machine.axes.map((a) => [a.id, a]));
  const out: MachineAxis[] = [];
  for (let a = byId.get(axisId); a; a = a.parent ? byId.get(a.parent) : undefined) {
    if (out.includes(a)) throw new Error(`Cinématique cyclique sur l'axe ${a.id}`);
    out.unshift(a);
  }
  return out;
}

/** Axis that directly moves an occurrence (or undefined: fixed occurrence, on the frame). */
export function axisOf(machine: Kinematic, component: string): MachineAxis | undefined {
  return machine.axes.find((a) => a.components.includes(component));
}

/** World transformation of axis `axisId` and of its carrier axes. */
export function chainTransform(machine: Kinematic, axisId: string | undefined, values: AxisValues): Matrix4 {
  let m: Matrix4 = translation(0, 0, 0);
  if (!axisId) return m;
  for (const a of chain(machine, axisId)) m = mul4(m, axisTransform(a, values[a.id] ?? 0));
  return m;
}

/**
 * Matrices of the assembly occurrences for the requested pose (key: occurrence id).
 * `machine`: definition to use (by default the assembly's own; otherwise a definition being edited).
 */
export function machinePose(asm: AssemblyDocument, values: AxisValues, machine: Kinematic | undefined = asm.machine): Record<string, Matrix4> {
  if (!machine) throw new Error("L'assemblage n'est pas une machine");
  const out: Record<string, Matrix4> = {};
  for (const c of asm.components) out[c.id] = mul4(chainTransform(machine, axisOf(machine, c.id)?.id, values), c.matrix);
  return out;
}

/** World frame of a frame attached to an occurrence (spindle, table, ...). */
export function frameInWorld(
  asm: AssemblyDocument,
  frame: { component: string; frame: Matrix4 },
  values: AxisValues,
  machine: Kinematic | undefined = asm.machine,
): Matrix4 {
  const c = asm.components.find((x) => x.id === frame.component);
  if (!c || !machine) throw new Error(`Occurrence inconnue : ${frame.component}`);
  return mul4(mul4(chainTransform(machine, axisOf(machine, c.id)?.id, values), c.matrix), frame.frame);
}

/**
 * Position of the spindle gauge line in the table frame: displayed machine coordinates
 * (they vary like the linear axes, whichever side — tool or part — moves).
 */
export function spindleInTable(asm: AssemblyDocument, values: AxisValues, machine = asm.machine): Point3 | null {
  if (!machine) return null;
  const ids = new Set(asm.components.map((c) => c.id));
  if (!ids.has(machine.spindle.component) || !ids.has(machine.table.component)) return null;
  const s = frameInWorld(asm, machine.spindle, values, machine);
  const t = frameInWorld(asm, machine.table, values, machine);
  // t⁻¹ · spindle origin (t is rigid)
  const d = [s[12]! - t[12]!, s[13]! - t[13]!, s[14]! - t[14]!];
  return [0, 1, 2].map((i) => t[i * 4]! * d[0]! + t[i * 4 + 1]! * d[1]! + t[i * 4 + 2]! * d[2]!) as Point3;
}

/** Axes out of travel for a given pose. */
export function overTravel(machine: Kinematic, values: AxisValues): string[] {
  return machine.axes.filter((a) => {
    const v = values[a.id] ?? 0;
    return (a.min !== undefined && v < a.min - 1e-9) || (a.max !== undefined && v > a.max + 1e-9);
  }).map((a) => a.id);
}

/** Consistency checks of a machine definition against its assembly. */
export function validateMachine(asm: AssemblyDocument, m = asm.machine): string[] {
  if (!m) return ["Pas de définition de machine"];
  const errors: string[] = [];
  const ids = new Set(asm.components.map((c) => c.id));
  const seen = new Set<string>();
  for (const a of m.axes) {
    if (!a.id.trim()) errors.push("Axe sans nom");
    if (seen.has(a.id)) errors.push(`Axe ${a.id} en double`);
    if (a.components.length === 0) errors.push(`Axe ${a.id} : aucune occurrence mobile`);
    if (a.min !== undefined && a.max !== undefined && a.min > a.max) errors.push(`Axe ${a.id} : course min supérieure à la course max`);
    seen.add(a.id);
    if (a.parent && !m.axes.some((p) => p.id === a.parent)) errors.push(`Axe ${a.id} : porteur ${a.parent} inconnu`);
    for (const c of a.components) if (!ids.has(c)) errors.push(`Axe ${a.id} : occurrence ${c} inconnue`);
    if (Math.abs(Math.hypot(...a.direction) - 1) > 1e-6) errors.push(`Axe ${a.id} : direction non unitaire`);
    try {
      chain(m, a.id);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const moved = m.axes.flatMap((a) => a.components);
  if (new Set(moved).size !== moved.length) errors.push("Une occurrence est portée par plusieurs axes");
  for (const [label, f] of [["Broche", m.spindle], ["Table", m.table]] as const) {
    if (!f.component) errors.push(`${label} : face non désignée`);
    else if (!ids.has(f.component)) errors.push(`${label} : occurrence inconnue (${f.component})`);
  }
  if (m.magazine.display && !ids.has(m.magazine.display.component)) errors.push("Magasin : occurrence inconnue");
  return errors;
}
