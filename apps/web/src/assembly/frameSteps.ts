import { sectionFamily, type Feature, type PartDocument } from "@solidus-cad/sdk";
import { tx } from "../i18n.ts";
import { ws } from "../workspace.ts";

/**
 * Steps of a welded frame part, as shown in the assembly tree. The frame is computed by the core (features
 * `frameMembers`, @solidus-cad/sdk); it is edited by the welded frame module (action "frame.start").
 */

/** Steps (`frameMembers` features) of a frame part. */
export function stepsOf(doc: PartDocument | undefined): Feature[] {
  void ws.partRev;
  return doc?.features.filter((f) => f.type === "frameMembers") ?? [];
}

export function profileLabel(family: string, size: string): string {
  const fam = sectionFamily(family);
  return `${fam ? tx(fam.label) : family} ${size}`;
}

/** Step label: "Step 1 — Square tube 40x3 (4)". */
export function stepLabel(f: Feature): string {
  const fam = f.params.family ?? "";
  return `${f.name} — ${profileLabel(fam, f.params[`size_${fam}`] ?? "")} (${f.frame?.segments.length ?? 0})`;
}
