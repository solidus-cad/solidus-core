import { editingSketch } from "../store.ts";
import * as wsp from "../workspace.ts";
import { CONTEXTS, membersOf, type Scope, type ShortcutAction } from "./registry.ts";
import { moduleContext } from "../host.ts";
import { hasFeature } from "../license.ts";
import type { Feature } from "../license.ts";

/** Paid workbench scopes: without a license, their shortcuts are inactive (workbench in view-only mode). */
const PAID: Partial<Record<Scope, Feature>> = { drawing: "drawing", cam: "cam", quote: "quote", motion: "motion", analysis: "fem" };

export function activeScopes(): Scope[] {
  return contextScopes().filter((s) => !PAID[s] || hasFeature(PAID[s]));
}

/** Action of the active workbench that inherits the shared action `id` (undo, redo…), according to scope priority. */
export function activeMember(id: string): ShortcutAction | undefined {
  const members = membersOf(id);
  for (const s of activeScopes()) {
    const a = members.find((m) => m.scope === s);
    if (a) return a;
  }
  return undefined;
}

/**
 * Active scopes, by decreasing priority (the first found wins):
 * sketch → sketch+view+global; 3D sketch → sketch3d+view+global; frame → frame+view+global;
 * analysis → analysis+view+global;
 * CAM program machine → assembly+cam+view+global; assembly → assembly+view+global;
 * CAM program → cam+view+global; drawing → drawing+global; part → part+sheetmetal+view+global.
 */
function contextScopes(): Scope[] {
  return CONTEXTS[activeContext()];
}

/** Active context (sketch, frame, assembly…): key of `CONTEXTS`. */
export function activeContext(): keyof typeof CONTEXTS {
  if (editingSketch()) return "sketch";
  if (wsp.ws.sketch3d) return "sketch3d";
  if (wsp.ws.frame) return "frame";
  const kind = wsp.activeKind();
  // Context provided by a module (analysis)
  const fromModule = kind !== "drawing" ? moduleContext() : undefined;
  if (fromModule) return fromModule as keyof typeof CONTEXTS;
  if (kind === "assembly") return wsp.ws.camReturn ? "machine" : wsp.ws.motion ? "motion" : "assembly";
  if (kind === "cam") return "cam";
  if (kind === "quote") return "quote";
  if (kind === "drawing") return "drawing";
  return "part";
}
