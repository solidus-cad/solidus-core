import {
  bsplineKnots,
  effectiveParameters,
  evalDatum,
  evaluate,
  frameStepsOf,
  holeThread,
  ISO_HOLES,
  layoutFrame,
  namedPlaneFrame,
  resolveParameters,
  sectionFamily,
  sketchFrame,
  sketchToWorld,
  type DatumContext,
  type DatumOutcome,
  type Feature,
  type GeomRef,
  type ImportedBody,
  type MemberLayout,
  type PartDocument,
  type Scope,
  type Section,
  type SketchData,
  type SketchSolveInfo,
  type SkGeometry,
  type Vec3,
  type GeometryRecipe,
  validateRecipe,
} from "@solidus-cad/sdk";
import {
  analyzeProfiles,
  chainPrims,
  pointMap,
  sketch3DCurves,
  thinOutline,
  type SpaceCurves,
  type Loop,
  type OrientedCurve,
  type SketchSolver,
  type ThinPrim,
} from "@solidus-cad/sketch";

/**
 * Preparation of the document for cad-core, on the TypeScript side (in the Worker):
 *  - evaluation of the global parameters (part family included) and of the feature expressions;
 *  - reference planes (evalDatum of @solidus-cad/sdk);
 *  - resolution of sketches (PlaneGCS, @solidus-cad/sketch) and profile analysis;
 *  - catalog data (ISO holes, structural section profiles) and computations already written in TS (thickened outlines,
 *    placement of welded frames), sent in `prepared`.
 * The C++ side receives resolved values and geometry: a single implementation, shared with the interface.
 * Format described in core/README.md; design choices explained in core/CONCEPTION.md.
 */

type V3 = [number, number, number];
type Frame = ReturnType<typeof sketchFrame>;

export interface PreparedCurveRef {
  id: string;
  reversed: boolean;
}

export interface PreparedLoop {
  /** Reverses the loop: outer contour counterclockwise, holes clockwise. */
  reverse: boolean;
  curves: PreparedCurveRef[];
}

export type PreparedCurve =
  | { type: "line"; p1: string; p2: string }
  | { type: "circle"; c: string; r: number }
  | { type: "arc"; c: string; start: string; end: string }
  /** Poles (point identifiers), distinct knots and multiplicities (OCCT convention), weights if rational. */
  | { type: "bspline"; poles: string[]; degree: number; knots: number[]; mults: number[]; periodic?: boolean; weights?: number[] };

export interface PreparedSketch {
  frame: { origin: V3; xDir: V3; yDir: V3; normal: V3 };
  points: Record<string, [number, number]>;
  /** All curves, including construction ones (revolution axes). */
  curves: Record<string, PreparedCurve>;
  regions: { outer: PreparedLoop; holes: PreparedLoop[] }[];
  chains: PreparedCurveRef[][];
  /** Isolated points (not construction, not connected to any curve): hole positions, with their identifier (naming). */
  isolated: { id: string; p: [number, number] }[];
  /** Non-construction segments: slot center lines, with their identifier (naming). */
  segments: { id: string; a: [number, number]; b: [number, number] }[];
  /** Start of the first open chain (point, tangent), for sweeps. */
  pathStart?: { p: [number, number]; t: [number, number] };
  /** First open chain as a polyline (sheet metal by profile); `linesOnly` is false if it contains an arc. */
  polyline?: { pts: [number, number][]; linesOnly: boolean };
}

export interface PreparedFeature {
  id: string;
  type: string;
  suppressed?: boolean;
  /** Raw expressions (cache key, enumerated parameters). */
  params: Record<string, string>;
  /** Values of the evaluable expressions. */
  values: Record<string, number>;
  /** Messages of the non-evaluable expressions (reported if the constructor requests the value). */
  errors: Record<string, string>;
  sketch?: PreparedSketch;
  refs?: GeomRef[];
  /** Computed data for the constructor (`FeatureInput::prepared`). */
  prepared?: Prepared;
  /** Imported file (importStep). */
  imported?: ImportedBody;
  /** Deferred preparation: completed by the client at construction time (`edges`: projected edges to resolve). */
  deferred?: { edges?: { id: string; ref: GeomRef }[] };
  /** Error detected before the kernel: the feature is reported in error without being built. */
  error?: string;
  /** Target body (multi-body). */
  body?: string;
}

/** Content of `prepared`, depending on the feature type. */
export type Prepared =
  | PreparedThin
  | { frame: { origin: V3; normal: V3; xDir: V3; yDir: V3 } } // reference plane, mirror
  | { iso: (typeof ISO_HOLES)[string] } // hole, slot with screw clearance
  | { section: Section } // structural section profile
  | { error: string }
  | { members: MemberLayout[] } // welded frame
  | { plugin: string; recipe?: GeometryRecipe; error?: string } // plugin feature
  | { curves3d: SpaceCurves }; // 3D sketch: wires of its chains (core/part/sketch.cpp)

/** Thin extrusion: thickened outline of each open chain (key = smallest curve id of the chain). */
export type PreparedThin = { outlines: { key: string; prims: ThinPrim[] }[] } | { error: string };

export interface PreparedDocument {
  /** Document: one cache per document in the kernel. */
  docId: string;
  scope: [string, number][];
  rollback: number;
  /** Show the body as it is before this feature (RecomputeOptions.meshBefore). */
  meshBefore?: string;
  /** Bodies as they are before this feature (RecomputeOptions.bodiesBefore). */
  bodiesBefore?: string;
  features: PreparedFeature[];
}

/** Body data sent by the kernel to a deferred feature. */
export interface DeferredPayload {
  edges?: ProjectedEdge[];
}

/** Completion of a deferred feature (never throws: errors are returned). */
export type DeferredResult = { sketch?: PreparedSketch; prepared?: Prepared } | { error: string };

export interface Preparation {
  input: PreparedDocument;
  /** Deferred features: identifier → completion, called by the kernel during the recompute. */
  deferred: Map<string, (payload: DeferredPayload) => DeferredResult>;
  /** Resolved sketches, to return for those the kernel has built. */
  sketches: Record<string, SketchSolveInfo>;
  parameterErrors: Record<string, string>;
}

/** Open chain of a sketch, ready to thicken. */
interface ThinChain {
  key: string;
  prims: ThinPrim[];
}

/** Resolved sketch, as seen by the following features (linked geometry, thickened outlines). */
interface SolvedSketch {
  frame: Frame;
  geometry: SkGeometry[];
  chains: ThinChain[];
}

type SketchOutcome = { sketch: PreparedSketch; info: SketchSolveInfo; solved: SolvedSketch } | { error: string };

const v3 = (v: Vec3): V3 => [v.x, v.y, v.z];
const frameJson = (f: Frame) => ({ origin: v3(f.origin), xDir: v3(f.xDir), yDir: v3(f.yDir), normal: v3(f.normal) });

function prepareLoop(loop: Loop, reverse: boolean): PreparedLoop {
  return { reverse, curves: loop.curves.map(curveRef) };
}

function curveRef(c: OrientedCurve): PreparedCurveRef {
  return { id: c.curve.id, reversed: c.reversed };
}

function chainKey(chain: OrientedCurve[]): string {
  return chain.map((c) => c.curve.id).reduce((a, b) => (b < a ? b : a));
}

/**
 * Thickened outlines for thinExtrude. Nothing is prepared when the C++ constructor
 * must report the error itself (sketch not found, no chain, invalid thickness): same messages.
 */
function prepareThin(chains: ThinChain[] | undefined, values: Record<string, number>, side: string | undefined): PreparedThin | undefined {
  const t = values.thickness;
  if (!chains?.length || t === undefined || t <= 0) return undefined;
  const [d1, d2] = side === "both" ? [t / 2, -t / 2] : side === "side2" ? [0, -t] : [0, t];
  const outlines: { key: string; prims: ThinPrim[] }[] = [];
  for (const c of chains) {
    const prims = thinOutline(c.prims, d1, d2);
    if (!prims) return { error: "Épaisseur trop grande par rapport aux rayons ou aux longueurs du profil" };
    outlines.push({ key: c.key, prims });
  }
  return { outlines };
}

/** Start of the first chain: point and tangent in the sketch frame. */
function pathStart(chains: OrientedCurve[][], pts: Map<string, { x: number; y: number }>): PreparedSketch["pathStart"] {
  const first = chains[0]?.[0];
  if (!first) return undefined;
  const c = first.curve;
  if (c.type === "line") {
    const [a, b] = first.reversed ? [pts.get(c.p2)!, pts.get(c.p1)!] : [pts.get(c.p1)!, pts.get(c.p2)!];
    return { p: [a.x, a.y], t: [b.x - a.x, b.y - a.y] };
  }
  if (c.type === "arc") {
    const ce = pts.get(c.c)!;
    if (!first.reversed) {
      const s0 = pts.get(c.start)!;
      return { p: [s0.x, s0.y], t: [-(s0.y - ce.y), s0.x - ce.x] };
    }
    const e = pts.get(c.end)!;
    return { p: [e.x, e.y], t: [e.y - ce.y, -(e.x - ce.x)] };
  }
  if (c.type === "bspline" && !c.periodic) {
    // Clamped end: tangent along the first segment of the control polygon.
    const poles = first.reversed ? [...c.poles].reverse() : c.poles;
    const a = pts.get(poles[0]!)!;
    const b = pts.get(poles[1]!)!;
    return { p: [a.x, a.y], t: [b.x - a.x, b.y - a.y] };
  }
  return undefined;
}

/** Ordered points of the first open chain, if it has only lines. */
function polyline(chains: OrientedCurve[][], pts: Map<string, { x: number; y: number }>): PreparedSketch["polyline"] {
  const chain = chains[0];
  if (!chain?.length) return undefined;
  const out: [number, number][] = [];
  for (const c of chain) {
    if (c.curve.type !== "line") return { pts: [], linesOnly: false };
    const [a, b] = c.reversed ? [c.curve.p2, c.curve.p1] : [c.curve.p1, c.curve.p2];
    if (out.length === 0) out.push([pts.get(a)!.x, pts.get(a)!.y]);
    out.push([pts.get(b)!.x, pts.get(b)!.y]);
  }
  return { pts: out, linesOnly: true };
}

/** Isolated points: not connected to a curve and not construction. */
function isolatedPoints(geometry: SkGeometry[]): PreparedSketch["isolated"] {
  const used = new Set<string>();
  for (const g of geometry) {
    if (g.type === "line") used.add(g.p1).add(g.p2);
    else if (g.type === "circle") used.add(g.c);
    else if (g.type === "arc") used.add(g.c).add(g.start).add(g.end);
    else if (g.type === "bspline") for (const p of g.poles) used.add(p);
  }
  return geometry.flatMap((g) => (g.type === "point" && !used.has(g.id) && !g.construction ? [{ id: g.id, p: [g.x, g.y] as [number, number] }] : []));
}

/** Circle through a polyline (start, quarter or middle, end; closed polyline: quarter and middle); null if aligned. */
function circleThrough(pts: { x: number; y: number }[]): { c: { x: number; y: number }; r: number } | null {
  if (pts.length < 3) return null;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const m = pts[Math.floor(pts.length / 2)]!;
  const q = pts[Math.floor(pts.length / 4)]!;
  const closed = Math.hypot(b.x - a.x, b.y - a.y) < 1e-6;
  const p3 = closed ? q : m;
  const p2 = closed ? m : b;
  const d = 2 * (a.x * (p3.y - p2.y) + p3.x * (p2.y - a.y) + p2.x * (a.y - p3.y));
  if (Math.abs(d) < 1e-12) return null;
  const ux = ((a.x ** 2 + a.y ** 2) * (p3.y - p2.y) + (p3.x ** 2 + p3.y ** 2) * (p2.y - a.y) + (p2.x ** 2 + p2.y ** 2) * (a.y - p3.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (p2.x - p3.x) + (p3.x ** 2 + p3.y ** 2) * (a.x - p2.x) + (p2.x ** 2 + p2.y ** 2) * (p3.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}

/**
 * Ends of the segment covered by an aligned polyline (curved edge seen by the slice: its ends are not necessarily
 * those of the segment), oriented closest to `near` so as not to reverse the existing segment.
 */
function segmentSpan(pts: { x: number; y: number }[], near?: { x: number; y: number }): [{ x: number; y: number }, { x: number; y: number }] {
  const far = (o: { x: number; y: number }) => pts.reduce((m, p) => (Math.hypot(p.x - o.x, p.y - o.y) > Math.hypot(m.x - o.x, m.y - o.y) ? p : m));
  const e1 = far(pts[0]!);
  const e2 = far(e1);
  const o = near ?? pts[0]!;
  return Math.hypot(e2.x - o.x, e2.y - o.y) <= Math.hypot(e1.x - o.x, e1.y - o.y) ? [e2, e1] : [e1, e2];
}

/**
 * Points of a circular edge (carrier circle, ends and midpoint): used to project a circle or an arc through the slice,
 * whose ends are not enough. Full circle (midpoint opposite the start): the plane of the circle contains the sketch
 * normal, since it projects to a segment.
 */
function circleSamples(e: ProjectedEdge, normal: { x: number; y: number; z: number }): V3[] {
  if (!e.circle) return [e.first, e.mid, e.last];
  const [cx, cy, cz] = e.circle.c;
  const r = e.circle.r;
  const sub = (p: V3): V3 => [p[0] - cx, p[1] - cy, p[2] - cz];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a: V3): V3 | null => {
    const l = Math.hypot(...a);
    return l < 1e-9 * Math.max(r, 1) ? null : [a[0] / l, a[1] / l, a[2] / l];
  };
  const u = unit(sub(e.first));
  if (!u) return [e.first, e.mid, e.last];
  const w = sub(e.mid);
  const n: V3 = [normal.x, normal.y, normal.z];
  const v = unit([w[0] - dot(w, u) * u[0], w[1] - dot(w, u) * u[1], w[2] - dot(w, u) * u[2]]) ?? unit([n[0] - dot(n, u) * u[0], n[1] - dot(n, u) * u[1], n[2] - dot(n, u) * u[2]]);
  if (!v) return [e.first, e.mid, e.last];
  // The midpoint is at mid-parameter: the arc sweeps twice the angle of the midpoint.
  const sweep = 2 * Math.atan2(dot(w, v), dot(w, u));
  const out: V3[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (sweep * i) / 64;
    const c = r * Math.cos(t);
    const s = r * Math.sin(t);
    out.push([cx + c * u[0] + s * v[0], cy + c * u[1] + s * v[1], cz + c * u[2] + s * v[2]]);
  }
  return out;
}

/**
 * Linked elements: geometry of a skeleton sketch, or polyline of another part kept up to date by the application,
 * brought back into the sketch plane. The projected edges of the part body need the body computed by the kernel:
 * they go through deferred preparation (core/CONCEPTION.md).
 */
function refreshLinked(sketch: SketchData, frame: Frame, solved: Map<string, SolvedSketch>): SkGeometry[] {
  const geometry: SkGeometry[] = JSON.parse(JSON.stringify(sketch.geometry));
  const all = geometry.filter((g) => !!g.projected);
  if (all.length === 0) return geometry;
  const to2d = (x: number, y: number, z: number) => {
    const dx = x - frame.origin.x;
    const dy = y - frame.origin.y;
    const dz = z - frame.origin.z;
    return { x: dx * frame.xDir.x + dy * frame.xDir.y + dz * frame.xDir.z, y: dx * frame.yDir.x + dy * frame.yDir.y + dz * frame.yDir.z };
  };
  const point = (id: string) => geometry.find((g) => g.id === id && g.type === "point") as { x: number; y: number } | undefined;
  for (const g of all) {
    const ref = g.projected!;
    if (ref.kind !== "sketch") continue;
    const src = solved.get(ref.sketch);
    if (!src) throw new Error("Esquisse squelette introuvable ou en erreur");
    const s = src.geometry.find((x) => x.id === ref.entity);
    if (!s || s.type !== g.type) throw new Error("Élément de l'esquisse squelette introuvable");
    const sp = pointMap(src.geometry);
    const map = (id: string) => {
      const p = sp.get(id)!;
      const w = sketchToWorld(src.frame, p.x, p.y);
      return to2d(w.x, w.y, w.z);
    };
    if (g.type === "point") Object.assign(g, map(s.id));
    else if (g.type === "line" && s.type === "line") {
      Object.assign(point(g.p1) ?? {}, map(s.p1));
      Object.assign(point(g.p2) ?? {}, map(s.p2));
    } else if (g.type === "circle" && s.type === "circle") {
      Object.assign(point(g.c) ?? {}, map(s.c));
      g.r = s.r;
    } else if (g.type === "arc" && s.type === "arc") {
      Object.assign(point(g.c) ?? {}, map(s.c));
      Object.assign(point(g.start) ?? {}, map(s.start));
      Object.assign(point(g.end) ?? {}, map(s.end));
    }
  }
  for (const g of all) {
    const ref = g.projected!;
    if (ref.kind !== "external" || ref.points.length === 0) continue;
    const pts = ref.points.map(([x, y, z]) => to2d(x, y, z));
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const circle = circleThrough(pts);
    if (g.type === "point") Object.assign(g, g.anchor === "center" && circle ? circle.c : g.anchor === "end" ? b : a);
    else if (g.type === "line") {
      const [p1, p2] = segmentSpan(pts, point(g.p1));
      Object.assign(point(g.p1) ?? {}, p1);
      Object.assign(point(g.p2) ?? {}, p2);
    } else if (circle && g.type !== "bspline") {
      Object.assign(point(g.c) ?? {}, circle.c);
      if (g.type === "circle") g.r = circle.r;
      else {
        const mid = pts[Math.floor(pts.length / 2)]!;
        const ccw = (a.x - circle.c.x) * (mid.y - circle.c.y) - (a.y - circle.c.y) * (mid.x - circle.c.x) > 0;
        Object.assign(point(g.start) ?? {}, ccw ? a : b);
        Object.assign(point(g.end) ?? {}, ccw ? b : a);
      }
    }
  }
  return geometry;
}

/** Elements projected from the part body (designated edge, GeomRef): resolved by the kernel on the current body. */
function bodyProjections(geometry: SkGeometry[]): SkGeometry[] {
  return geometry.filter((g) => g.projected && g.projected.kind !== "sketch" && g.projected.kind !== "external");
}

/** Projected edge, resolved by the kernel on the current body (Engine::complete, core/document/engine.cpp). */
export interface ProjectedEdge {
  id: string;
  first: V3;
  last: V3;
  mid: V3;
  circle?: { c: V3; r: number };
}

/**
 * Applies the edges resolved by the kernel to the projected elements (the part that needs the body): line → segment,
 * circle → circle or arc, vertex → nearest endpoint or center.
 */
function applyEdges(geometry: SkGeometry[], frame: Frame, edges: ProjectedEdge[]): SkGeometry[] {
  const out: SkGeometry[] = JSON.parse(JSON.stringify(geometry));
  const to2d = ([x, y, z]: V3) => {
    const dx = x - frame.origin.x;
    const dy = y - frame.origin.y;
    const dz = z - frame.origin.z;
    return { x: dx * frame.xDir.x + dy * frame.xDir.y + dz * frame.xDir.z, y: dx * frame.yDir.x + dy * frame.yDir.y + dz * frame.yDir.z };
  };
  const point = (id: string) => out.find((g) => g.id === id && g.type === "point") as { x: number; y: number } | undefined;
  const byId = new Map(edges.map((e) => [e.id, e]));
  for (const g of out) {
    const e = g.projected ? byId.get(g.id) : undefined;
    if (!e) continue;
    const a = to2d(e.first);
    const b = to2d(e.last);
    if (g.type === "point") {
      if (g.anchor === "center") {
        if (e.circle) Object.assign(g, to2d(e.circle.c));
      } else {
        // Vertex: the endpoint closest to the stored position (the edge direction may change).
        Object.assign(g, Math.hypot(a.x - g.x, a.y - g.y) <= Math.hypot(b.x - g.x, b.y - g.y) ? a : b);
      }
    } else if (g.type === "line") {
      // Circular edge seen by the slice: the segment covers the whole projection, not only its ends.
      const [p1, p2] = e.circle ? segmentSpan(circleSamples(e, frame.normal).map(to2d), point(g.p1)) : [a, b];
      Object.assign(point(g.p1) ?? {}, p1);
      Object.assign(point(g.p2) ?? {}, p2);
    } else if (e.circle && g.type !== "bspline") {
      const c = to2d(e.circle.c);
      Object.assign(point(g.c) ?? {}, c);
      if (g.type === "circle") g.r = e.circle.r;
      else {
        // Direction of the arc in the sketch: counterclockwise from `start` to `end`.
        const mid = to2d(e.mid);
        const ccw = (a.x - c.x) * (mid.y - c.y) - (a.y - c.y) * (mid.x - c.x) > 0;
        Object.assign(point(g.start) ?? {}, ccw ? a : b);
        Object.assign(point(g.end) ?? {}, ccw ? b : a);
      }
    }
  }
  return out;
}

/** Sketch whose resolution waits for the projected edges of the body (deferred preparation). */
interface PendingSketch {
  /** References to resolve by the kernel: sketch element → designated edge. */
  refs: { id: string; ref: GeomRef }[];
  complete(edges: ProjectedEdge[]): SketchOutcome;
}

/** Sketch resolution, memoized from one recompute to the next (PlaneGCS is re-run only if the sketch, its plane or its links change). */
export class SketchPreparer {
  private memo = new Map<string, SketchOutcome>();
  private used = new Map<string, SketchOutcome>();

  constructor(private readonly solver: SketchSolver) {}

  /**
   * Resolves sketch `f`. `datum`: frame of the reference planes already computed; `solved`: previous sketches.
   * Order of the checks: offset, reference plane, links, resolution.
   */
  prepare(
    f: Feature,
    scope: Scope,
    scopeKey: string,
    datum: (id: string) => Frame | undefined,
    solved: Map<string, SolvedSketch>,
  ): SketchOutcome | { pending: PendingSketch } {
    if (!f.sketch) return { error: "Esquisse vide" };
    let offset: number;
    try {
      offset = evaluate(f.sketch.plane.offset, scope);
    } catch (e) {
      return { error: `offset : ${(e as Error).message}` };
    }
    if (f.sketch.plane.datum && !datum(f.sketch.plane.datum)) return { error: "Plan de l'esquisse introuvable ou en erreur" };
    const frame = sketchFrame(f.sketch.plane, offset, datum);
    let input: SkGeometry[];
    try {
      input = refreshLinked(f.sketch, frame, solved);
    } catch (e) {
      return { error: (e as Error).message };
    }
    const sketch = f.sketch;
    const projected = bodyProjections(input);
    if (projected.length) {
      return {
        pending: {
          refs: projected.map((g) => ({ id: g.id, ref: g.projected as GeomRef })),
          complete: (edges) => this.solveMemo(scopeKey, sketch, frame, applyEdges(input, frame, edges), scope),
        },
      };
    }
    return this.solveMemo(scopeKey, sketch, frame, input, scope);
  }

  /**
   * Last resolution of a deferred sketch, per document and feature: when the kernel reuses its cache, it does not
   * call the client back, and this resolution (same inputs, same body) remains valid.
   */
  readonly lastDeferred = new Map<string, { sketch: PreparedSketch; info: SketchSolveInfo; solved: SolvedSketch }>();

  private solveMemo(scopeKey: string, sketch: SketchData, frame: Frame, input: SkGeometry[], scope: Scope): SketchOutcome {
    const key = scopeKey + JSON.stringify([sketch, frame, input]);
    let out = this.memo.get(key) ?? this.used.get(key);
    if (!out) {
      try {
        out = this.solve(sketch, input, frame, scope);
      } catch (e) {
        out = { error: (e as Error).message };
      }
    }
    this.used.set(key, out);
    return out;
  }

  /** End of a recompute: sketches that were not used are discarded. */
  commit(): void {
    this.memo = this.used;
    this.used = new Map();
  }

  private solve(sketch: SketchData, geometry: SkGeometry[], frame: Frame, scope: Scope): SketchOutcome {
    const r = this.solver.solve({ ...sketch, geometry }, { scope, orientFrom: sketch.geometry });
    const dimErr = Object.values(r.dimensionErrors)[0];
    if (dimErr) return { error: `Cote : ${dimErr}` };
    if (!r.ok) return { error: "L'esquisse ne peut pas être résolue (contraintes incompatibles)" };
    const info: SketchSolveInfo = { geometry: r.geometry, dof: r.dof, conflicting: r.conflicting, redundant: r.redundant };
    const analysis = analyzeProfiles(r.geometry);
    if (analysis.selfIntersecting) return { error: "Le profil se recoupe" };
    const pts = pointMap(r.geometry);
    const points: Record<string, [number, number]> = {};
    for (const [id, p] of pts) points[id] = [p.x, p.y];
    const curves: Record<string, PreparedCurve> = {};
    for (const g of r.geometry) {
      if (g.type === "line") curves[g.id] = { type: "line", p1: g.p1, p2: g.p2 };
      else if (g.type === "circle") curves[g.id] = { type: "circle", c: g.c, r: g.r };
      else if (g.type === "arc") curves[g.id] = { type: "arc", c: g.c, start: g.start, end: g.end };
      else if (g.type === "bspline")
        curves[g.id] = {
          type: "bspline",
          poles: g.poles,
          degree: g.degree,
          ...bsplineKnots(g),
          ...(g.periodic ? { periodic: true } : {}),
          ...(g.weights ? { weights: g.weights } : {}),
        };
    }
    const prepared: PreparedSketch = {
      frame: frameJson(frame),
      points,
      curves,
      regions: analysis.regions.map((region) => ({
        outer: prepareLoop(region.outer, region.outer.area < 0),
        holes: region.holes.map((h) => prepareLoop(h, h.area > 0)),
      })),
      chains: analysis.chains.map((chain) => chain.map(curveRef)),
      isolated: isolatedPoints(r.geometry),
      segments: r.geometry.flatMap((g): PreparedSketch["segments"] => {
        if (g.type !== "line" || g.construction) return [];
        const a = pts.get(g.p1)!;
        const b = pts.get(g.p2)!;
        return [{ id: g.id, a: [a.x, a.y], b: [b.x, b.y] }];
      }),
      pathStart: pathStart(analysis.chains, pts),
      polyline: polyline(analysis.chains, pts),
    };
    let chains: ThinChain[] = [];
    try {
      chains = analysis.chains.map((chain) => ({ key: chainKey(chain), prims: chainPrims(chain, pts) }));
    } catch {
      // Chain that cannot be thickened: only a thin extrusion of this sketch fails ("Contour de la paroi mince non préparé").
    }
    return { sketch: prepared, info, solved: { frame, geometry: r.geometry, chains } };
  }
}

/** Functions whose frame errors are detected by layoutFrame. */
function prepareFrame(doc: PartDocument, f: Feature, scope: Scope): { prepared?: Prepared; error?: string } {
  const steps = frameStepsOf(doc.features, doc.rollback, scope, f.id);
  const me = steps[steps.length - 1];
  if (!me || me.id !== f.id) return { error: "Étape de bâti incomplète" };
  if (!sectionFamily(me.family)) return { error: "Famille de profilé inconnue" };
  if (!me.data.segments.length) return { error: "Aucune ligne du squelette sélectionnée" };
  const known = new Set(me.data.paths.map((p) => p.key));
  if (me.data.segments.some((k) => !known.has(k))) return { error: "Ligne du squelette introuvable" };
  const members = layoutFrame(steps).filter((m) => m.step === me.id);
  // No bar: the kernel reports "Taille de profilé inconnue ou lignes de longueur nulle".
  return members.length ? { prepared: { members } } : {};
}

export interface PrepareOptions {
  meshBefore?: string;
  bodiesBefore?: string;
}

/** Prepares the document: only the active features are evaluated; the others are passed suspended. */
export function prepareDocument(doc: PartDocument, sketches: SketchPreparer, opts: PrepareOptions = {}): Preparation {
  const { scope, errors } = resolveParameters(effectiveParameters(doc));
  const scopeEntries = [...scope].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const scopeKey = JSON.stringify(scopeEntries);
  const infos: Record<string, SketchSolveInfo> = {};
  const solved = new Map<string, SolvedSketch>();
  // Reference planes encountered so far (a plane relies only on the planes placed before it).
  const datums = new Map<string, DatumOutcome>();
  const datumCtx: DatumContext = {
    num: (e, fb) => (e === undefined || e.trim() === "" ? fb : evaluate(e, scope)),
    datum: (id) => datums.get(id)?.frame,
  };

  const deferred = new Map<string, (payload: DeferredPayload) => DeferredResult>();
  const docId = doc.id ?? "";

  const features = doc.features.map((f, i): PreparedFeature => {
    const active = i < doc.rollback && !f.suppressed;
    if (!active) return { id: f.id, type: f.type, suppressed: true, params: {}, values: {}, errors: {} };
    const values: Record<string, number> = {};
    const errs: Record<string, string> = {};
    for (const [k, expr] of Object.entries(f.params)) {
      try {
        values[k] = evaluate(expr, scope);
      } catch (e) {
        errs[k] = (e as Error).message;
      }
    }
    const out: PreparedFeature = { id: f.id, type: f.type, params: { ...f.params }, values, errors: errs };
    if (f.refs?.length) out.refs = f.refs;
    if (f.body) out.body = f.body;
    // Plugin feature: recipe interpreted by cad-core (core/part/recipe.cpp), validated here first.
    if (f.plugin) {
      out.type = "pluginRecipe";
      const invalid = f.plugin.recipe ? validateRecipe(f.plugin.recipe)[0] : undefined;
      if (invalid) out.error = `Recette invalide : ${invalid}`;
      else out.prepared = { plugin: f.plugin.id, ...(f.plugin.recipe ? { recipe: f.plugin.recipe } : {}), ...(f.plugin.error ? { error: f.plugin.error } : {}) };
      return out;
    }
    switch (f.type) {
      case "plane": {
        const r = evalDatum(f.datum, datumCtx);
        datums.set(f.id, r);
        if (r.error !== undefined) out.error = r.error;
        else out.prepared = { frame: frameJson(r.frame) };
        break;
      }
      case "sketch": {
        const s = sketches.prepare(f, scope, scopeKey, (id) => datums.get(id)?.frame, solved);
        if ("pending" in s) {
          // Projected edges of the body: the kernel resolves them on the current body, then calls `complete` back.
          out.deferred = { edges: s.pending.refs };
          const key = `${docId}/${f.id}`;
          const last = sketches.lastDeferred.get(key);
          if (last) {
            infos[f.id] = last.info;
            solved.set(f.id, last.solved);
          }
          deferred.set(f.id, (payload) => {
            const r = s.pending.complete(payload.edges ?? []);
            if ("error" in r) {
              delete infos[f.id];
              solved.delete(f.id);
              sketches.lastDeferred.delete(key);
              return { error: r.error };
            }
            infos[f.id] = r.info;
            solved.set(f.id, r.solved);
            sketches.lastDeferred.set(key, r);
            return { sketch: r.sketch };
          });
        } else if ("error" in s) out.error = s.error;
        else {
          out.sketch = s.sketch;
          infos[f.id] = s.info;
          solved.set(f.id, s.solved);
        }
        break;
      }
      case "thinExtrude": {
        const sk = f.params.sketch ?? "";
        if (deferred.has(sk)) {
          // Deferred sketch: its chains are known only once resolved by the kernel.
          out.deferred = {};
          deferred.set(f.id, () => {
            const thin = prepareThin(solved.get(sk)?.chains, values, f.params.thinSide);
            return thin ? { prepared: thin } : {};
          });
          break;
        }
        const thin = prepareThin(solved.get(sk)?.chains, values, f.params.thinSide);
        if (thin) out.prepared = thin;
        break;
      }
      case "hole": {
        if (f.params.type === "tapped") {
          // Tapped hole: only the tap drill of the thread is machined (cosmetic thread on the drawing).
          const th = holeThread(f.params, (k) => values[k] ?? Number.NaN);
          if (th) out.prepared = { iso: { tap: th.tap, clear: th.tap, cbD: th.tap, cbH: 0, cskD: th.tap } };
          else out.error = "Filetage inconnu ou invalide";
          break;
        }
        const iso = ISO_HOLES[f.params.size ?? ""];
        if (iso) out.prepared = { iso };
        break;
      }
      case "slot": {
        const iso = f.params.widthMode === "clearance" ? ISO_HOLES[f.params.size ?? ""] : undefined;
        if (iso) out.prepared = { iso };
        break;
      }
      case "profile": {
        const fam = sectionFamily(f.params.family ?? "");
        if (fam) {
          try {
            out.prepared = { section: fam.build(f.params[`size_${fam.id}`] ?? "") };
          } catch (e) {
            out.prepared = { error: (e as Error).message };
          }
        }
        break;
      }
      case "mirror":
      case "splitBody":
      case "trimSurface":
      case "draft": {
        // Invalid offset: the kernel reports the error of the expression (ctx.num("offset")).
        const offset = values.offset;
        const fr = offset === undefined ? undefined : namedPlaneFrame(f.params.plane ?? "", datums, offset);
        if (fr) out.prepared = { frame: frameJson(fr) };
        break;
      }
      case "frameMembers": {
        const r = prepareFrame(doc, f, scope);
        if (r.error) out.error = r.error;
        if (r.prepared) out.prepared = r.prepared;
        break;
      }
      case "sketch3d":
        // Re-solved with the current parameters (driving dimensions written as expressions).
        if (f.sketch3d) out.prepared = { curves3d: sketch3DCurves(f.sketch3d, scope) };
        break;
      case "importStep":
        if (f.imported) out.imported = f.imported;
        break;
    }
    return out;
  });
  sketches.commit();

  const input: PreparedDocument = { docId: doc.id ?? "", scope: scopeEntries, rollback: doc.rollback, features };
  if (opts.meshBefore) input.meshBefore = opts.meshBefore;
  if (opts.bodiesBefore) input.bodiesBefore = opts.bodiesBefore;
  return { input, deferred, sketches: infos, parameterErrors: Object.fromEntries(errors) };
}
