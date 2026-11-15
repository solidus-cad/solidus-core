import { assemblyDatumPlanes, IDENTITY, type AssemblyComponent, type AssemblyDocument, type Mate, type MateRef } from "@solidus-cad/sdk";
import { liaisonGraph, solveMates, type LiaisonGraph, type SolveResult } from "@solidus-cad/assembly";

/**
 * Solving an assembly with sub-assemblies:
 * - rigid: the sub-assembly is a single body; constraints aimed at one of its parts are brought back
 *   into the occurrence's coordinate system;
 * - flexible: its direct parts become bodies of the system, with their internal constraints;
 *   their positions are stored in the occurrence (`flex`); the original sub-assembly is not modified.
 * The keys of sub-assembly parts are "occurrence/part" paths.
 */

export type Mat = number[];

export function mul(a: Mat, b: Mat): Mat {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

/** Inverse of a displacement matrix (rotation + translation), column-major. */
export function invRigid(m: Mat): Mat {
  const r = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!]; // colonnes
  const t = [m[12]!, m[13]!, m[14]!];
  // Rᵀ: columns become rows.
  const out = [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) out[12 + i] = -(out[i]! * t[0]! + out[4 + i]! * t[1]! + out[8 + i]! * t[2]!);
  return out;
}

function applyPoint(m: Mat, p: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => m[i]! * p[0] + m[4 + i]! * p[1] + m[8 + i]! * p[2] + m[12 + i]!) as [number, number, number];
}

function applyDir(m: Mat, d: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => m[i]! * d[0] + m[4 + i]! * d[1] + m[8 + i]! * d[2]) as [number, number, number];
}

/** Local position of a direct part of a sub-assembly, for a given occurrence. */
export function localOf(occ: AssemblyComponent, child: AssemblyComponent): Mat {
  return occ.flex?.[child.id] ?? child.matrix;
}

/** Matrix (in the `doc` coordinate system) of a part path "a/b/c", sub-assemblies included. */
export function pathMatrix(doc: AssemblyDocument, path: string[], getAsm: (id: string) => AssemblyDocument | undefined, depth = 0): Mat | null {
  const [head, ...rest] = path;
  const c = doc.components.find((x) => x.id === head);
  if (!c || depth > 16) return null;
  if (rest.length === 0) return c.matrix;
  const sub = c.assemblyId ? getAsm(c.assemblyId) : undefined;
  if (!sub) return null;
  const child = sub.components.find((x) => x.id === rest[0]);
  if (!child) return null;
  const inner = rest.length === 1 ? localOf(c, child) : (() => {
    const deeper = pathMatrix(sub, rest, getAsm, depth + 1);
    return deeper ? mul(localOf(c, child), mul(invRigid(child.matrix), deeper)) : null;
  })();
  return inner ? mul(c.matrix, inner) : null;
}

export interface Leaf {
  /** Occurrence path ("occurrence/part/…"). */
  key: string;
  partId: string;
  /** Matrix in the root assembly coordinate system. */
  matrix: Mat;
  name: string;
  hidden: boolean;
  skeleton: boolean;
}

/**
 * Parts of an occurrence, sub-assemblies expanded: each level applies the flexible positions
 * stored in the occurrence that contains it.
 */
export function leavesOf(c: AssemblyComponent, getAsm: (id: string) => AssemblyDocument | undefined, world: Mat = c.matrix, prefix = "", depth = 0): Leaf[] {
  const key = prefix ? `${prefix}/${c.id}` : c.id;
  if (!c.assemblyId) return [{ key, partId: c.partId, matrix: world, name: c.name, hidden: !!c.hidden, skeleton: !!c.skeleton }];
  const sub = getAsm(c.assemblyId);
  if (!sub || depth > 16) return [];
  return sub.components.flatMap((child) =>
    leavesOf(child, getAsm, mul(world, localOf(c, child)), key, depth + 1).map((l) => ({
      ...l,
      name: `${c.name} / ${l.name}`,
      hidden: l.hidden || !!c.hidden,
    })),
  );
}

/** True if assembly `id` contains (directly or not) assembly `target`. */
export function containsAssembly(id: string, target: string, getAsm: (id: string) => AssemblyDocument | undefined, depth = 0): boolean {
  if (id === target) return true;
  const a = getAsm(id);
  if (!a || depth > 16) return false;
  return a.components.some((c) => !!c.assemblyId && containsAssembly(c.assemblyId, target, getAsm, depth + 1));
}

export interface FlexSolveResult extends SolveResult {
  /** Updates to apply: occurrence matrices and flexible positions. */
  updates: { id: string; matrix: Mat; flex?: Record<string, Mat> }[];
}

/** Body of the solver that carries the assembly reference planes (fixed, world frame). */
export const DATUM_BODY = "@datums";

/**
 * Bodies and constraints of the solver for an assembly: rigid occurrences, parts of the flexible sub-assemblies
 * (with their internal constraints), constraints brought into the frame of the body carrying each reference.
 */
export function assemblySystem(a: AssemblyDocument, getAsm: (id: string) => AssemblyDocument | undefined): { bodies: AssemblyComponent[]; mates: Mate[]; flexible: AssemblyComponent[] } {
  const bodies: AssemblyComponent[] = [];
  const mates: Mate[] = [];
  /** Solver body targeted by a key, and the key's matrix in that body's coordinate system. */
  const bodyOf = new Map<string, { body: string; local: Mat }>();
  const flexible: AssemblyComponent[] = [];

  for (const c of a.components) {
    const sub = c.assemblyId ? getAsm(c.assemblyId) : undefined;
    if (!sub || !c.flexible) {
      bodies.push({ ...c });
      bodyOf.set(c.id, { body: c.id, local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
      continue;
    }
    flexible.push(c);
    for (const child of sub.components) {
      const key = `${c.id}/${child.id}`;
      bodies.push({ ...child, id: key, matrix: mul(c.matrix, localOf(c, child)), fixed: !!(c.fixed && child.fixed) });
      bodyOf.set(key, { body: key, local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
    }
    // Internal constraints of the sub-assembly, between its direct parts.
    for (const m of sub.mates) {
      mates.push({ ...m, id: `${c.id}/${m.id}`, a: { ...m.a, component: `${c.id}/${m.a.component}` }, b: { ...m.b, component: `${c.id}/${m.b.component}` } });
    }
  }

  // Assembly reference planes: carried by a fictitious fixed body (world coordinate system).
  const datumBody = DATUM_BODY;
  const datums = a.mates.some((m) => m.a.datum || m.b.datum)
    ? assemblyDatumPlanes(a.planes ?? [], (k) => pathMatrix(a, k.split("/"), getAsm) ?? undefined)
    : null;
  if (datums) {
    bodies.push({ id: datumBody, name: "", partId: "", matrix: [...IDENTITY], fixed: true });
    bodyOf.set(datumBody, { body: datumBody, local: [...IDENTITY] });
  }

  /** Body that carries a reference, and the transform from the targeted part's coordinate system (by its path) to that body's. */
  const carrier = (ref: MateRef): { body: string; inBody: Mat } | null => {
    if (ref.datum) return { body: datumBody, inBody: [...IDENTITY] };
    const path = ref.component.split("/");
    // Body: the occurrence (rigid) or "occurrence/part" (flexible).
    const bodyKey = bodyOf.has(path.slice(0, 2).join("/")) ? path.slice(0, 2).join("/") : path[0]!;
    const b = bodyOf.get(bodyKey);
    if (!b) return null;
    const body = bodies.find((x) => x.id === b.body)!;
    const world = pathMatrix(a, path, getAsm);
    if (!world) return null;
    return { body: b.body, inBody: mul(invRigid(path.length > 1 && bodyKey === path[0] ? a.components.find((x) => x.id === path[0])!.matrix : body.matrix), world) };
  };

  /** Brings a reference (coordinate system of the part targeted by its path) into the coordinate system of the body carrying it. */
  const mapRef = (ref: MateRef, c: { body: string; inBody: Mat }): MateRef | null => {
    if (ref.datum) {
      const f = datums?.get(ref.datum)?.frame;
      if (!f) return null;
      return { ...ref, component: datumBody, kind: "plane", p: [f.origin.x, f.origin.y, f.origin.z], d: [f.normal.x, f.normal.y, f.normal.z] };
    }
    const m = c.inBody;
    return { ...ref, component: c.body, p: applyPoint(m, ref.p), d: applyDir(m, ref.d), u: ref.u ? applyDir(m, ref.u) : undefined };
  };
  for (const m of a.mates) {
    const ca = carrier(m.a);
    const cb = carrier(m.b);
    const ma = ca && mapRef(m.a, ca);
    const mb = cb && mapRef(m.b, cb);
    if (!ma || !mb) continue;
    // Rotary driver: its reference directions (part coordinate systems) follow the same transform as the references.
    const drive = m.drive && [m.drive].flat().map((d) => ({ ...d, ua: d.ua && applyDir(ca.inBody, d.ua), ub: d.ub && applyDir(cb.inBody, d.ub) }));
    mates.push({ ...m, a: ma, b: mb, drive });
  }
  return { bodies, mates, flexible };
}

/** Kinematic liaison graph of an assembly (at its current, solved, pose). */
export function assemblyLiaisons(a: AssemblyDocument, getAsm: (id: string) => AssemblyDocument | undefined): LiaisonGraph {
  const { bodies, mates } = assemblySystem(a, getAsm);
  return liaisonGraph(bodies, mates);
}

/** `pull`: target poses of solver bodies (occurrence id, or "occurrence/part" in a flexible sub-assembly) during a move. */
export function solveAssembly(a: AssemblyDocument, getAsm: (id: string) => AssemblyDocument | undefined, opts: { pull?: Map<string, Mat> } = {}): FlexSolveResult {
  const { bodies, mates, flexible } = assemblySystem(a, getAsm);
  const r = solveMates(bodies, mates, undefined, { pull: opts.pull });
  const world = (id: string) => r.matrices[id] ?? bodies.find((b) => b.id === id)!.matrix;
  const updates: FlexSolveResult["updates"] = [];
  for (const c of a.components) {
    if (!flexible.includes(c)) {
      if (r.matrices[c.id]) updates.push({ id: c.id, matrix: r.matrices[c.id]! });
      continue;
    }
    const sub = getAsm(c.assemblyId!)!;
    // Anchor part: the first fixed part of the sub-assembly (otherwise the first part) carries the occurrence.
    const anchor = sub.components.find((x) => x.fixed) ?? sub.components[0];
    if (!anchor) continue;
    const occ = mul(world(`${c.id}/${anchor.id}`), invRigid(localOf(c, anchor)));
    const inv = invRigid(occ);
    const flex: Record<string, Mat> = {};
    for (const child of sub.components) flex[child.id] = mul(inv, world(`${c.id}/${child.id}`));
    updates.push({ id: c.id, matrix: occ, flex });
  }
  return { ...r, updates };
}
