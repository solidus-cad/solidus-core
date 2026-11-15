import { newId } from "./document.ts";
import type { V3 } from "./sketch3d.ts";

/**
 * Motion study (Motion workbench): tracks drive assembly constraints over time,
 * the other parts follow by solving the constraints, frame by frame.
 */

/** Interpolation between a key and the next one. */
export type MotionEase = "linear" | "ease" | "step";

export interface MotionKey {
  /** Time (s). */
  t: number;
  /** Value (mm or °). */
  value: number;
  ease?: MotionEase;
}

export interface MotionTrack {
  id: string;
  /** Driven constraint. */
  mate: string;
  kind: "linear" | "rotary";
  keys: MotionKey[];
  /** Travel limits: beyond them, the value is blocked and the frame flagged. */
  min?: number;
  max?: number;
  muted?: boolean;
  /** Reversed direction: the track value is counted in the other direction (relative constraints: concentric, coincident axes). */
  reverse?: boolean;
}

export interface CameraKey {
  t: number;
  position: V3;
  target: V3;
  up: V3;
  /** Zoom of the orthographic camera. */
  zoom?: number;
  ease?: MotionEase;
}

export interface MotionStudy {
  id: string;
  name: string;
  /** Duration (s). */
  duration: number;
  /** Frames per second. */
  fps: number;
  loop: boolean;
  tracks: MotionTrack[];
  /** Animated viewpoints; absent or empty: free view camera. */
  camera?: CameraKey[];
  /** Collision detection on one frame every `step`. */
  collisions?: { enabled: boolean; step: number };
}

export function createMotionStudy(name: string): MotionStudy {
  return { id: newId(), name, duration: 5, fps: 30, loop: true, tracks: [] };
}
