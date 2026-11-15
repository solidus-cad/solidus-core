import { paramShown, type DimensionKind, type FeatureDefinition, type I18nText, type PartDocument } from "@solidus-cad/sdk";

/**
 * Part dimensions not driven by a global parameter: each with a displayable name
 * ("Box — Width (X)", "Sketch 1 — Radius") and its current value.
 * Used for the .xlsx template of the Family panel: columns to turn into parameters.
 */

export interface PartDim {
  name: string;
  value: string;
}

const word = (name: string) => new RegExp(`\\b${name}\\b`);

export function nonParameterizedDims(
  doc: PartDocument,
  definitionOf: (type: string) => FeatureDefinition | undefined,
  tx: (text: I18nText) => string,
  dimLabel: (kind: DimensionKind) => string,
): PartDim[] {
  const names = doc.parameters.map((p) => p.name);
  const driven = (expr: string) => names.some((n) => word(n).test(expr));
  const out: PartDim[] = [];
  const unique = (base: string) => {
    let name = base;
    for (let n = 2; out.some((d) => d.name === name); n++) name = `${base} (${n})`;
    return name;
  };
  for (const f of doc.features.slice(0, doc.rollback)) {
    if (f.suppressed) continue;
    if (f.type === "sketch" && f.sketch) {
      for (const d of f.sketch.dimensions) {
        if (!d.driving || !d.value.trim() || driven(d.value)) continue;
        out.push({ name: unique(`${f.name} — ${dimLabel(d.type)}`), value: d.value.trim() });
      }
    }
    const def = definitionOf(f.type);
    if (!def) continue;
    for (const spec of def.params) {
      if (spec.kind !== "length" && spec.kind !== "angle" && spec.kind !== "number") continue;
      if (!paramShown(spec, f.params, def.params)) continue;
      const expr = (f.params[spec.key] ?? spec.default ?? "").trim();
      if (!expr || driven(expr)) continue;
      out.push({ name: unique(`${f.name} — ${tx(spec.label)}`), value: expr });
    }
  }
  return out;
}
