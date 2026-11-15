import { GcsWrapper, SolveStatus, init_planegcs_module, type SketchPrimitive } from "@salusoft89/planegcs";
import {
  bsplineKnots,
  curveEnds,
  evaluate,
  SKETCH_AXIS_H,
  SKETCH_AXIS_V,
  SKETCH_ORIGIN,
  type Scope,
  type SketchData,
  type SkDimension,
  type SkCurve,
  type SkGeometry,
} from "@solidus-cad/sdk";
import { flatten, project } from "./bspline.ts";

export interface SolveOptions {
  /** Global parameters used to evaluate the dimensions. */
  scope?: Scope;
  /** Mouse drag: the points follow as closely as possible without violating the constraints. */
  drag?: { points: Record<string, { x: number; y: number }> };
  /**
   * Positions used to orient the signed dimensions (horizontal, vertical, angle): by default the solved
   * geometry. The kernel passes the stored geometry, before realignment of the projected references, so that
   * a reference that moves does not flip the dimension to the other side.
   */
  orientFrom?: SkGeometry[];
}

export interface SolveResult {
  ok: boolean;
  /** Updated geometry (solved coordinates and radii). */
  geometry: SkGeometry[];
  /** Remaining degrees of freedom (0 = fully constrained). */
  dof: number;
  conflicting: string[];
  redundant: string[];
  /** Dimension evaluation errors (invalid expression...), by identifier. */
  dimensionErrors: Record<string, string>;
}

type Prim = SketchPrimitive;
type Dict = Record<string, unknown>;

const REF_POINTS: Prim[] = [
  { id: SKETCH_ORIGIN, type: "point", x: 0, y: 0, fixed: true },
  { id: `${SKETCH_ORIGIN}:H`, type: "point", x: 1, y: 0, fixed: true },
  { id: `${SKETCH_ORIGIN}:V`, type: "point", x: 0, y: 1, fixed: true },
  { id: SKETCH_AXIS_H, type: "line", p1_id: SKETCH_ORIGIN, p2_id: `${SKETCH_ORIGIN}:H` },
  { id: SKETCH_AXIS_V, type: "line", p1_id: SKETCH_ORIGIN, p2_id: `${SKETCH_ORIGIN}:V` },
] as Prim[];

const REF_COORDS: Record<string, { x: number; y: number }> = {
  [SKETCH_ORIGIN]: { x: 0, y: 0 },
  [`${SKETCH_ORIGIN}:H`]: { x: 1, y: 0 },
  [`${SKETCH_ORIGIN}:V`]: { x: 0, y: 1 },
};

/** Sketch axes seen as lines (for angle dimensions, symmetries, revolutions). */
export const AXIS_LINES: SkGeometry[] = [
  { id: SKETCH_AXIS_H, type: "line", p1: SKETCH_ORIGIN, p2: `${SKETCH_ORIGIN}:H` },
  { id: SKETCH_AXIS_V, type: "line", p1: SKETCH_ORIGIN, p2: `${SKETCH_ORIGIN}:V` },
];

/** Sketch solver (PlaneGCS, the FreeCAD solver, compiled to WASM). */
export class SketchSolver {
  private constructor(private readonly gcs: GcsWrapper) {}

  static async create(wasmUrl?: string): Promise<SketchSolver> {
    const mod = await init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    return new SketchSolver(new GcsWrapper(new mod.GcsSystem(), mod));
  }

  solve(sketch: SketchData, opts: SolveOptions = {}): SolveResult {
    const gcs = this.gcs;
    gcs.clear_data();
    const byId = new Map<string, SkGeometry>([...AXIS_LINES, ...sketch.geometry].map((g) => [g.id, g]));
    const fixed = new Set(sketch.constraints.flatMap((c) => (c.type === "fix" ? [c.point] : [])));
    // Geometry projected from the model: fixed.
    for (const g of sketch.geometry) {
      if (!g.projected) continue;
      if (g.type === "point") fixed.add(g.id);
      else if (g.type === "line") fixed.add(g.p1).add(g.p2);
      else if (g.type === "circle") fixed.add(g.c);
      else if (g.type === "arc") fixed.add(g.c).add(g.start).add(g.end);
      else if (g.type === "bspline") for (const p of g.poles) fixed.add(p);
    }
    const dimensionErrors: Record<string, string> = {};
    const prims: Prim[] = [...REF_POINTS];
    const point = (id: string) => {
      const g = byId.get(id);
      if (g?.type === "point") return g;
      const ref = REF_COORDS[id];
      if (ref) return ref;
      throw new Error(`Point inconnu ${id}`);
    };
    const stored = opts.orientFrom ? new Map(opts.orientFrom.map((g) => [g.id, g])) : null;
    const orient = (id: string) => {
      const g = stored?.get(id);
      return g?.type === "point" ? g : point(id);
    };
    const kind = (id: string) => (id === SKETCH_AXIS_H || id === SKETCH_AXIS_V ? "line" : byId.get(id)?.type);

    // Geometry: points first (the others reference them), then curves.
    for (const g of sketch.geometry) {
      if (g.type === "point") prims.push({ id: g.id, type: "point", x: g.x, y: g.y, fixed: fixed.has(g.id) } as Prim);
    }
    for (const g of sketch.geometry) {
      if (g.type === "line") prims.push({ id: g.id, type: "line", p1_id: g.p1, p2_id: g.p2 } as Prim);
      else if (g.type === "circle") {
        prims.push({ id: g.id, type: "circle", c_id: g.c, radius: g.r } as Prim);
        if (g.projected) prims.push({ id: `${g.id}:r`, type: "circle_radius", c_id: g.id, radius: g.r } as Prim);
      }
      else if (g.type === "arc") {
        const c = point(g.c);
        const s = point(g.start);
        const e = point(g.end);
        const a0 = Math.atan2(s.y - c.y, s.x - c.x);
        let a1 = Math.atan2(e.y - c.y, e.x - c.x);
        if (a1 <= a0) a1 += 2 * Math.PI;
        prims.push({
          id: g.id,
          type: "arc",
          c_id: g.c,
          radius: Math.hypot(s.x - c.x, s.y - c.y),
          start_angle: a0,
          end_angle: a1,
          start_id: g.start,
          end_id: g.end,
        } as Prim);
        prims.push({ id: `${g.id}:rules`, type: "arc_rules", a_id: g.id } as Prim);
      }
    }
    // Splines: their poles are points of the sketch. The spline itself is only needed by "point on curve".
    const splines = new Set(
      sketch.constraints.flatMap((c) => (c.type === "pointOnCurve" && byId.get(c.curve)?.type === "bspline" ? [c.curve] : [])),
    );
    for (const id of splines) {
      const g = byId.get(id) as Extract<SkGeometry, { type: "bspline" }>;
      const { knots, mults } = bsplineKnots(g);
      prims.push({
        id,
        type: "bspline",
        pole_ids: g.poles,
        weights: g.weights ?? g.poles.map(() => 1),
        knots,
        mult: mults,
        degree: g.degree,
        periodic: !!g.periodic,
      } as Prim);
    }
    const pointsOf = () => new Map([...Object.entries(REF_COORDS), ...sketch.geometry.flatMap((g) => (g.type === "point" ? [[g.id, g] as const] : []))]);

    const center = (id: string) => {
      const g = byId.get(id);
      return g?.type === "circle" || g?.type === "arc" ? g.c : undefined;
    };

    for (const c of sketch.constraints) {
      const p: Dict = { id: c.id };
      switch (c.type) {
        case "horizontal":
        case "vertical":
          prims.push({ ...p, type: c.type === "horizontal" ? "horizontal_l" : "vertical_l", l_id: c.a } as Prim);
          break;
        case "parallel":
          prims.push({ ...p, type: "parallel", l1_id: c.a, l2_id: c.b } as Prim);
          break;
        case "perpendicular":
          prims.push({ ...p, type: "perpendicular_ll", l1_id: c.a, l2_id: c.b } as Prim);
          break;
        case "equal": {
          const ka = kind(c.a);
          const kb = kind(c.b);
          if (ka === "line" && kb === "line") prims.push({ ...p, type: "equal_length", l1_id: c.a, l2_id: c.b } as Prim);
          else if (ka === "circle" && kb === "circle") prims.push({ ...p, type: "equal_radius_cc", c1_id: c.a, c2_id: c.b } as Prim);
          else if (ka === "arc" && kb === "arc") prims.push({ ...p, type: "equal_radius_aa", a1_id: c.a, a2_id: c.b } as Prim);
          else if (ka === "circle" && kb === "arc") prims.push({ ...p, type: "equal_radius_ca", c1_id: c.a, a2_id: c.b } as Prim);
          else if (ka === "arc" && kb === "circle") prims.push({ ...p, type: "equal_radius_ca", c1_id: c.b, a2_id: c.a } as Prim);
          break;
        }
        case "tangent": {
          const [a, b] = kind(c.a) === "line" ? [c.a, c.b] : kind(c.b) === "line" ? [c.b, c.a] : [c.a, c.b];
          const ka = kind(a);
          const kb = kind(b);
          if (ka === "line" && kb === "circle") prims.push({ ...p, type: "tangent_lc", l_id: a, c_id: b } as Prim);
          else if (ka === "line" && kb === "arc") prims.push({ ...p, type: "tangent_la", l_id: a, a_id: b } as Prim);
          else if (ka === "circle" && kb === "circle") prims.push({ ...p, type: "tangent_cc", c1_id: a, c2_id: b } as Prim);
          else if (ka === "circle" && kb === "arc") prims.push({ ...p, type: "tangent_ca", c_id: a, a_id: b } as Prim);
          else if (ka === "arc" && kb === "circle") prims.push({ ...p, type: "tangent_ca", c_id: b, a_id: a } as Prim);
          else if (ka === "arc" && kb === "arc") prims.push({ ...p, type: "tangent_aa", a1_id: a, a2_id: b } as Prim);
          else if (ka === "bspline" || kb === "bspline") {
            const prim = splineTangency(p, byId.get(a) as SkCurve | undefined, byId.get(b) as SkCurve | undefined);
            if (prim) prims.push(prim);
          }
          break;
        }
        case "concentric": {
          const ca = center(c.a);
          const cb = center(c.b);
          if (ca && cb) prims.push({ ...p, type: "p2p_coincident", p1_id: ca, p2_id: cb } as Prim);
          break;
        }
        case "pointOnCurve": {
          const k = kind(c.curve);
          if (k === "line") prims.push({ ...p, type: "point_on_line_pl", p_id: c.point, l_id: c.curve } as Prim);
          else if (k === "circle") prims.push({ ...p, type: "point_on_circle", p_id: c.point, c_id: c.curve } as Prim);
          else if (k === "arc") prims.push({ ...p, type: "point_on_arc", p_id: c.point, a_id: c.curve } as Prim);
          else if (k === "bspline") {
            // Free parameter of the point along the spline, starting from its projection.
            const param = `${c.id}:t`;
            const at = project(flatten(byId.get(c.curve) as Extract<SkGeometry, { type: "bspline" }>, pointsOf()), point(c.point));
            gcs.push_sketch_param(param, at.t, false);
            prims.push({ ...p, type: "point_on_bspline", p_id: c.point, b_id: c.curve, pointparam: param } as Prim);
          }
          break;
        }
        case "midpoint": {
          const l = byId.get(c.curve);
          if (l?.type === "line") prims.push({ ...p, type: "p2p_symmetric_ppp", p1_id: l.p1, p2_id: l.p2, p_id: c.point } as Prim);
          break;
        }
        case "symmetric":
          prims.push({ ...p, type: "p2p_symmetric_ppl", p1_id: c.a, p2_id: c.b, l_id: c.axis } as Prim);
          break;
        case "fix":
          break; // handled by `fixed` on the point
      }
    }

    for (const d of sketch.dimensions) {
      if (!d.driving) continue;
      let value: number;
      try {
        value = evaluate(d.value, opts.scope ?? new Map());
      } catch (e) {
        dimensionErrors[d.id] = (e as Error).message;
        continue;
      }
      const prim = this.dimensionPrimitive(d, value, byId, orient);
      if (prim) prims.push(prim);
      else dimensionErrors[d.id] = "Cote invalide";
    }

    if (opts.drag) {
      for (const [id, pos] of Object.entries(opts.drag.points)) {
        prims.push({ id: `drag:x:${id}`, type: "coordinate_x", p_id: id, x: pos.x, temporary: true } as Prim);
        prims.push({ id: `drag:y:${id}`, type: "coordinate_y", p_id: id, y: pos.y, temporary: true } as Prim);
      }
    }

    gcs.push_primitives_and_params(prims);
    const status = gcs.solve();
    const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
    if (ok) gcs.apply_solution();

    const solved = new Map(gcs.sketch_index.get_primitives().map((p) => [p.id, p as unknown as Dict]));
    const geometry = sketch.geometry.map((g): SkGeometry => {
      const s = solved.get(g.id);
      if (!ok || !s) return g;
      if (g.type === "point") return { ...g, x: s.x as number, y: s.y as number };
      if (g.type === "circle") return { ...g, r: s.radius as number };
      return g;
    });

    return {
      ok,
      geometry,
      dof: opts.drag ? -1 : gcs.gcs.dof(),
      conflicting: gcs.get_gcs_conflicting_constraints(),
      redundant: gcs.get_gcs_redundant_constraints(),
      dimensionErrors,
    };
  }

  dispose(): void {
    this.gcs.destroy_gcs_module();
  }

  private dimensionPrimitive(
    d: SkDimension,
    value: number,
    byId: Map<string, SkGeometry>,
    point: (id: string) => { x: number; y: number },
  ): Prim | null {
    const base = { id: d.id };
    const a = byId.get(d.a);
    const b = d.b ? byId.get(d.b) : undefined;
    // A single line: its length, or the distance between its endpoints.
    const ends = (): [string, string] | null => {
      if (a?.type === "line" && !d.b) return [a.p1, a.p2];
      if ((a?.type === "point" || d.a === SKETCH_ORIGIN) && d.b && (b?.type === "point" || d.b === SKETCH_ORIGIN)) return [d.a, d.b];
      return null;
    };
    switch (d.type) {
      case "distance": {
        if (a?.type === "point" && b?.type === "line") return { ...base, type: "p2l_distance", p_id: d.a, l_id: d.b!, distance: value } as Prim;
        if (a?.type === "line" && b?.type === "point") return { ...base, type: "p2l_distance", p_id: d.b!, l_id: d.a, distance: value } as Prim;
        const e = ends();
        return e ? ({ ...base, type: "p2p_distance", p1_id: e[0], p2_id: e[1], distance: value } as Prim) : null;
      }
      case "horizontalDistance":
      case "verticalDistance": {
        const e = ends();
        if (!e) return null;
        const prop = d.type === "horizontalDistance" ? "x" : "y";
        // The sign follows the current layout: the dimension keeps the side where the user placed the points.
        const [p1, p2] = point(e[1])[prop] >= point(e[0])[prop] ? e : [e[1], e[0]];
        return { ...base, type: "difference", param1: { o_id: p1, prop }, param2: { o_id: p2, prop }, difference: value } as Prim;
      }
      case "radius":
      case "diameter": {
        const field = d.type;
        if (a?.type === "circle") return { ...base, type: `circle_${field}`, c_id: d.a, [field]: value } as Prim;
        if (a?.type === "arc") return { ...base, type: `arc_${field}`, a_id: d.a, [field]: value } as Prim;
        return null;
      }
      case "angle": {
        if (a?.type !== "line" || b?.type !== "line") return null;
        // Signed angle from a to b: the current rotation direction is kept.
        const dir = (l: typeof a) => {
          const p1 = point(l.p1);
          const p2 = point(l.p2);
          return [p2.x - p1.x, p2.y - p1.y] as const;
        };
        const [ax, ay] = dir(a);
        const [bx, by] = dir(b);
        const sign = ax * by - ay * bx < 0 ? -1 : 1;
        return { ...base, type: "l2l_angle_ll", l1_id: d.a, l2_id: d.b!, angle: (sign * value * Math.PI) / 180 } as Prim;
      }
    }
  }
}

/** End of a curve at the point `at`, and the next point of its tangent there (spline: neighbouring pole). */
function endTangent(c: SkCurve, at: string): string | null {
  if (c.type === "line") return c.p1 === at ? c.p2 : c.p2 === at ? c.p1 : null;
  if (c.type === "bspline" && !c.periodic) {
    const n = c.poles.length;
    return c.poles[0] === at ? c.poles[1]! : c.poles[n - 1] === at ? c.poles[n - 2]! : null;
  }
  return null;
}

/**
 * Tangency with a spline, at an endpoint it shares with the other curve: the end segment of its control polygon is
 * aligned with the line, perpendicular to the radius of the arc, or aligned with the end segment of the other spline.
 * Elsewhere than at a shared endpoint, the constraint has no effect.
 */
function splineTangency(base: Dict, a: SkCurve | undefined, b: SkCurve | undefined): Prim | null {
  if (!a || !b) return null;
  const [spline, other] = a.type === "bspline" ? [a, b] : [b, a];
  const otherEnds: string[] = curveEnds(other) ?? [];
  const shared = (curveEnds(spline) ?? []).find((p) => otherEnds.includes(p));
  if (!shared) return null;
  const next = endTangent(spline, shared)!;
  if (other.type === "line") return { ...base, type: "point_on_line_pl", p_id: next, l_id: other.id } as Prim;
  if (other.type === "arc") return { ...base, type: "perpendicular_pppp", l1p1_id: other.c, l1p2_id: shared, l2p1_id: shared, l2p2_id: next } as Prim;
  const across = endTangent(other, shared);
  return across ? ({ ...base, type: "point_on_line_ppp", p_id: shared, lp1_id: next, lp2_id: across } as Prim) : null;
}
