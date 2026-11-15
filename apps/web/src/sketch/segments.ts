import {
  evaluate,
  resolveParameters,
  effectiveParameters,
  sketch3DSegments,
  sketchFrame,
  activeFeatures,
  partDatumPlanes,
  planeFrame,
  sketchToWorld,
  type Feature,
  type PartDocument,
  type Sketch3DData,
  type SketchSolveInfo,
  type SkGeometry,
} from "@solidus-cad/sdk";
import { pointMap, sampleCurve, solveSketch3D, sampleSpline3 } from "@solidus-cad/sketch";

type Frame = ReturnType<typeof sketchFrame>;

/** 3D segments (pairs of points) of a solved sketch. */
export function sketchSegments(geometry: SkGeometry[], frame: Frame, out: number[], withConstruction = false): void {
  const pts = pointMap(geometry);
  for (const g of geometry) {
    if (g.type === "point" || (g.construction && !withConstruction)) continue;
    const s = sampleCurve(g, pts, 48);
    for (let i = 0; i + 1 < s.length; i++) {
      for (const p of [s[i]!, s[i + 1]!]) {
        const w = sketchToWorld(frame, p.x, p.y);
        out.push(w.x, w.y, w.z);
      }
    }
  }
}

/** Frame of a document sketch (offset evaluated with the effective parameters). */
export function frameOf(doc: PartDocument, sketchId: string): Frame | null {
  const f = doc.features.find((x) => x.id === sketchId);
  if (!f?.sketch) return null;
  let offset = 0;
  const scope = resolveParameters(effectiveParameters(doc)).scope;
  try {
    offset = evaluate(f.sketch.plane.offset, scope);
  } catch {
    /* invalid offset */
  }
  const datums = f.sketch.plane.datum ? partDatumPlanes(activeFeatures(doc), scope) : null;
  return sketchFrame(f.sketch.plane, offset, (id) => datums?.get(id)?.frame);
}

const solved3D = new Map<string, Sketch3DData>();

/** 3D sketch solved with the part's effective parameters (memoized: called at each display). */
export function sketch3DOf(doc: PartDocument, f: Feature): Sketch3DData | null {
  if (f.type !== "sketch3d" || !f.sketch3d) return null;
  const scope = resolveParameters(effectiveParameters(doc)).scope;
  const key = JSON.stringify([f.sketch3d, [...scope]]);
  let r = solved3D.get(key);
  if (!r) {
    r = { ...f.sketch3d, geometry: solveSketch3D(f.sketch3d, { scope }).geometry };
    if (solved3D.size > 200) solved3D.clear();
    solved3D.set(key, r);
  }
  return r;
}

/** All sketches of a skeleton part (2D and 3D), as 3D segments (part frame), construction included. */
export function skeletonSegments(doc: PartDocument, solved: Record<string, SketchSolveInfo>, skip?: string): Float32Array {
  const out: number[] = [];
  for (const f of doc.features) {
    if (f.suppressed || f.id === skip) continue;
    const s3 = sketch3DOf(doc, f);
    if (s3) sketch3DSegments(s3, out, true, sampleSpline3);
    if (f.type !== "sketch" || !solved[f.id]) continue;
    const frame = frameOf(doc, f.id);
    if (frame) sketchSegments(solved[f.id]!.geometry, frame, out, true);
  }
  return new Float32Array(out);
}

/** Part element usable by a constraint: line (axis), base plane, reference plane or sketch plane. */
export interface SkeletonEntity {
  sketch: string;
  /** Line identifier, or "plane" for a plane (sketch, reference plane, base plane "@XY"…). */
  entity: string;
  label: string;
  kind: "axis" | "plane";
  /** Point and direction in the skeleton part frame. */
  p: [number, number, number];
  d: [number, number, number];
}

export function skeletonEntities(doc: PartDocument, solved: Record<string, SketchSolveInfo>, lang: "fr" | "en"): SkeletonEntity[] {
  const out: SkeletonEntity[] = [];
  // Base planes of the part (origin of the part frame).
  for (const base of ["XY", "XZ", "YZ"] as const) {
    const f = planeFrame(base, 0);
    out.push({ sketch: `@${base}`, entity: "plane", label: `${lang === "fr" ? "Plan" : "Plane"} ${base}`, kind: "plane", p: [0, 0, 0], d: [f.normal.x, f.normal.y, f.normal.z] });
  }
  // Reference planes of the skeleton: usable as planes by the assembly constraints.
  const datums = doc.features.some((f) => f.type === "plane") ? partDatumPlanes(activeFeatures(doc), resolveParameters(effectiveParameters(doc)).scope) : null;
  for (const f of doc.features) {
    const s3 = f.suppressed ? null : sketch3DOf(doc, f);
    if (s3) out.push(...sketch3DEntities(f, s3, lang));
    const df = f.type === "plane" ? datums?.get(f.id)?.frame : undefined;
    if (df) {
      const o = df.origin;
      const n = df.normal;
      out.push({ sketch: f.id, entity: "plane", label: f.name, kind: "plane", p: [o.x, o.y, o.z], d: [n.x, n.y, n.z] });
    }
    if (f.type !== "sketch" || f.suppressed || !solved[f.id]) continue;
    const frame = frameOf(doc, f.id);
    if (!frame) continue;
    const o = frame.origin;
    const n = frame.normal;
    out.push({ sketch: f.id, entity: "plane", label: `${f.name} — ${lang === "fr" ? "plan" : "plane"}`, kind: "plane", p: [o.x, o.y, o.z], d: [n.x, n.y, n.z] });
    const pts = pointMap(solved[f.id]!.geometry);
    let k = 0;
    for (const g of solved[f.id]!.geometry) {
      if (g.type !== "line") continue;
      k++;
      const a = pts.get(g.p1)!;
      const b = pts.get(g.p2)!;
      const wa = sketchToWorld(frame, a.x, a.y);
      const wb = sketchToWorld(frame, b.x, b.y);
      const l = Math.hypot(wb.x - wa.x, wb.y - wa.y, wb.z - wa.z) || 1;
      out.push({
        sketch: f.id,
        entity: g.id,
        label: `${f.name} — ${lang === "fr" ? "ligne" : "line"} ${k}`,
        kind: "axis",
        p: [wa.x, wa.y, wa.z],
        d: [(wb.x - wa.x) / l, (wb.y - wa.y) / l, (wb.z - wa.z) / l],
      });
    }
  }
  return out;
}

/** Lines of a 3D sketch, usable as axes by the assembly constraints. */
function sketch3DEntities(f: Feature, data: Sketch3DData, lang: "fr" | "en"): SkeletonEntity[] {
  const pts = new Map(data.geometry.flatMap((g) => (g.type === "point" ? [[g.id, g] as const] : [])));
  const out: SkeletonEntity[] = [];
  let k = 0;
  for (const g of data.geometry) {
    if (g.type !== "line") continue;
    k++;
    const a = pts.get(g.p1);
    const b = pts.get(g.p2);
    if (!a || !b) continue;
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    out.push({
      sketch: f.id,
      entity: g.id,
      label: `${f.name} — ${lang === "fr" ? "ligne" : "line"} ${k}`,
      kind: "axis",
      p: [a.x, a.y, a.z],
      d: [(b.x - a.x) / l, (b.y - a.y) / l, (b.z - a.z) / l],
    });
  }
  return out;
}

/** Line of a skeleton (2D or 3D sketch) with its ends, in the part frame. */
export interface SkeletonLine {
  /** "sketch:element". */
  key: string;
  sketch: string;
  label: string;
  a: [number, number, number];
  b: [number, number, number];
}

/** All lines (construction included) of the 2D and 3D sketches of a skeleton part. */
export function skeletonLines(doc: PartDocument, solved: Record<string, SketchSolveInfo>, lang: "fr" | "en"): SkeletonLine[] {
  const out: SkeletonLine[] = [];
  const word = lang === "fr" ? "ligne" : "line";
  for (const f of doc.features) {
    if (f.suppressed) continue;
    const s3 = sketch3DOf(doc, f);
    if (s3) {
      const pts = new Map(s3.geometry.flatMap((g) => (g.type === "point" ? [[g.id, g] as const] : [])));
      let k = 0;
      for (const g of s3.geometry) {
        if (g.type !== "line") continue;
        k++;
        const a = pts.get(g.p1);
        const b = pts.get(g.p2);
        if (a && b) out.push({ key: `${f.id}:${g.id}`, sketch: f.id, label: `${f.name} — ${word} ${k}`, a: [a.x, a.y, a.z], b: [b.x, b.y, b.z] });
      }
      continue;
    }
    if (f.type !== "sketch" || !solved[f.id]) continue;
    const frame = frameOf(doc, f.id);
    if (!frame) continue;
    const pts = pointMap(solved[f.id]!.geometry);
    let k = 0;
    for (const g of solved[f.id]!.geometry) {
      if (g.type !== "line") continue;
      k++;
      const pa = pts.get(g.p1);
      const pb = pts.get(g.p2);
      if (!pa || !pb) continue;
      const a = sketchToWorld(frame, pa.x, pa.y);
      const b = sketchToWorld(frame, pb.x, pb.y);
      out.push({ key: `${f.id}:${g.id}`, sketch: f.id, label: `${f.name} — ${word} ${k}`, a: [a.x, a.y, a.z], b: [b.x, b.y, b.z] });
    }
  }
  return out;
}
