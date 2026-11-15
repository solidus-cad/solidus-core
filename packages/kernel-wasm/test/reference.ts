// Reference kernel for parity tests: recorded results of an earlier TypeScript kernel (built on
// replicad-opencascadejs) that no longer exists. Its responses are stored in reference.json, per test and in call
// order; each test replays them instead of calling that kernel.
// Arguments are kept at call sites for readability but are not read.
import { expect } from "vitest";
import type { FeatureStatus, FlatPattern, Interference, MassProperties, ProjectedView, RecomputeResult, SketchSolveInfo } from "@solidus-cad/sdk";
import data from "./reference.json";

/** What is compared from a recompute: the mesh is reduced to its face count. */
export interface RefRecompute {
  statuses: FeatureStatus[];
  sketches: Record<string, SketchSolveInfo>;
  parameterErrors: Record<string, string>;
  rebuilt: number;
  mass: MassProperties | null;
  faces: number;
}

/** Projected view: total segment lengths instead of the segments. */
export interface RefView {
  bounds: [number, number, number, number];
  visible: number;
  hidden: number;
  circles: number;
  hatches: { key: string; length: number }[];
}

export interface RefFlat {
  bounds: [number, number, number, number];
  bends: FlatPattern["bends"];
  outline: number;
  circles: number;
}

/** Response of each reference kernel request. */
interface RefValues {
  recompute: RefRecompute;
  flat: RefFlat;
  interferences: Interference[];
  views: RefView[];
  featureAt: string | null;
}

/** Recorded response: a value, or the error thrown by the kernel ("throw"). */
export type RefEntry = { [K in keyof RefValues]: { kind: K; value: RefValues[K] } }[keyof RefValues] | { kind: "throw"; value: string };

/** Total length of 2D segments (x1, y1, x2, y2…). */
export function length(s: Float32Array): number {
  let len = 0;
  for (let i = 0; i < s.length; i += 4) len += Math.hypot(s[i + 2]! - s[i]!, s[i + 3]! - s[i + 1]!);
  return len;
}

export const faceCount = (r: RecomputeResult) => (r.mesh ? r.mesh.faceGroups.length / 3 : 0);

export function summarizeRecompute(r: RecomputeResult): RefRecompute {
  return { statuses: r.statuses, sketches: r.sketches, parameterErrors: r.parameterErrors, rebuilt: r.rebuilt, mass: r.mass, faces: faceCount(r) };
}

export function summarizeView(v: ProjectedView): RefView {
  return {
    bounds: v.bounds,
    visible: length(v.visible),
    hidden: length(v.hidden),
    circles: v.circles.length,
    hatches: (v.hatches ?? []).map((h) => ({ key: h.key, length: length(h.segments) })),
  };
}

export function summarizeFlat(f: FlatPattern): RefFlat {
  return { bounds: f.bounds, bends: f.bends, outline: length(f.outline), circles: f.circles.length };
}

const recorded = data as unknown as Record<string, RefEntry[]>;
const cursors = new Map<string, number>();

/** Next response for the current test; fails if the test makes a call that was not recorded. */
function value<K extends keyof RefValues>(kind: K): RefValues[K] {
  const test = expect.getState().currentTestName ?? "";
  const i = cursors.get(test) ?? 0;
  const entry = recorded[test]?.[i];
  if (!entry || (entry.kind !== kind && entry.kind !== "throw")) throw new Error(`Reference: no "${kind}" response #${i + 1} for "${test}"`);
  cursors.set(test, i + 1);
  if (entry.kind === "throw") throw new Error(entry.value);
  return entry.value as RefValues[K];
}

export const reference = {
  recompute: (_doc: unknown, _opts?: unknown): RefRecompute => value("recompute"),
  flatPattern: (_doc: unknown): RefFlat => value("flat"),
  interferences: (_parts: unknown): Interference[] => value("interferences"),
  project: (_doc: unknown, _views: unknown): RefView[] => value("views"),
  projectScene: (_items: unknown, _views: unknown): RefView[] => value("views"),
  featureAt: (_docId: string, _point: [number, number, number]): string | null => value("featureAt"),
};
