import { For, Show } from "solid-js";
import { DATUM_METHODS, type DatumMethod, type DatumPlaneDef, type DatumRef, type DatumRole, type I18nText } from "@solidus-cad/sdk";
import { t, tx } from "../i18n.ts";
import { assignRef, changeMethod, firstEmptySlot } from "../datum.ts";
import { Stepper } from "./Stepper.tsx";
import { LengthInput } from "./LengthInput.tsx";
import { unitLabel } from "../units.ts";

/**
 * Reference plane editing panel, shared by the part ("plane" feature) and the assembly:
 * construction method, elements to pick (in the view, or base planes and axes), distance, angle, flip.
 */

const L = (fr: string, en: string): I18nText => ({ fr, en });

export const METHOD_LABELS: Record<DatumMethod, I18nText> = {
  offset: L("Décalé d'un plan", "Offset from plane"),
  parallel: L("Parallèle passant par un point", "Parallel through point"),
  midplane: L("Médian (symétrique) / bissecteur", "Mid-plane / bisector"),
  angle: L("Incliné autour d'un axe", "At angle about axis"),
  axisPoint: L("Passant par un axe et un point", "Through axis and point"),
  tangent: L("Tangent à un cylindre", "Tangent to cylinder"),
  threePoints: L("Par trois points", "Through three points"),
  normal: L("Normal à un axe", "Normal to axis"),
};

const SLOT_LABELS: Record<DatumMethod, I18nText[]> = {
  offset: [L("Plan ou face de référence", "Reference plane or face")],
  parallel: [L("Plan ou face de référence", "Reference plane or face"), L("Point de passage", "Through point")],
  midplane: [L("Premier plan ou face", "First plane or face"), L("Second plan ou face", "Second plane or face")],
  angle: [L("Axe de rotation", "Rotation axis"), L("Plan ou face de référence (0°)", "Reference plane or face (0°)")],
  axisPoint: [L("Axe", "Axis"), L("Point", "Point")],
  tangent: [L("Face cylindrique", "Cylindrical face"), L("Plan parallèle (facultatif)", "Parallel plane (optional)")],
  threePoints: [L("Point 1", "Point 1"), L("Point 2", "Point 2"), L("Point 3", "Point 3")],
  normal: [L("Axe ou arête", "Axis or edge"), L("Point de passage (facultatif)", "Through point (optional)")],
};

const ROLE_HINTS: Record<DatumRole, I18nText> = {
  plane: L("Cliquez une face plane ou un plan affiché.", "Click a planar face or a displayed plane."),
  axis: L("Cliquez une arête rectiligne, une arête circulaire ou une face cylindrique.", "Click a straight edge, a circular edge or a cylindrical face."),
  point: L("Cliquez un sommet, un centre de cercle, une arête ou une face.", "Click a vertex, a circle center, an edge or a face."),
  cylinder: L("Cliquez une face cylindrique.", "Click a cylindrical face."),
};

const FLIP_LABELS: Partial<Record<DatumMethod, I18nText>> = {
  offset: L("Inverser le côté", "Flip side"),
  tangent: L("Autre côté", "Other side"),
  midplane: L("Autre bissectrice (plans sécants)", "Other bisector (intersecting planes)"),
};
const FLIP_NORMAL = L("Inverser la normale", "Flip normal");

const BASE_LABELS: Record<string, I18nText> = {
  XY: L("Plan XY", "XY plane"),
  XZ: L("Plan XZ", "XZ plane"),
  YZ: L("Plan YZ", "YZ plane"),
  X: L("Axe X", "X axis"),
  Y: L("Axe Y", "Y axis"),
  Z: L("Axe Z", "Z axis"),
  O: L("Origine", "Origin"),
};

/** Base planes and axes offered for a role. */
const BASES: Record<DatumRole, string[]> = { plane: ["XY", "XZ", "YZ"], axis: ["X", "Y", "Z"], point: ["O"], cylinder: [] };

const num = (v: number) => String(Math.round(v * 100) / 100);

/** Label of a picked element. */
export function refLabel(ref: DatumRef, datumName: (id: string) => string | undefined, componentName?: (key: string) => string | undefined): string {
  const on = "component" in ref && ref.component ? ` — ${componentName?.(ref.component) ?? ref.component}` : "";
  switch (ref.kind) {
    case "base":
      return tx(BASE_LABELS[ref.name]!);
    case "datum":
      return datumName(ref.id) ?? tx(L("Plan supprimé", "Deleted plane"));
    case "plane":
      return tx(L("Face plane", "Planar face")) + on;
    case "axis":
      return tx(L("Axe", "Axis")) + on;
    case "point":
      return `${tx(L("Point", "Point"))} (${ref.p.map(num).join(" ; ")})${on}`;
    case "cylinder":
      return `${tx(L("Cylindre", "Cylinder"))} Ø${num(ref.r * 2)}${on}`;
  }
}

export interface DatumPanelProps {
  icon: string;
  name: string;
  onName(name: string): void;
  def: DatumPlaneDef;
  error: string | null | undefined;
  /** Slot currently being picked in the view. */
  slot: number | null;
  onSlot(slot: number | null): void;
  onChange(mutate: (d: DatumPlaneDef) => void): void;
  /** Usable reference planes (placed before this one). */
  datums: { id: string; name: string }[];
  componentName?(key: string): string | undefined;
  evalExpr(expr: string): { value?: number; error?: string };
  onOk(): void;
  onCancel(): void;
}

export function DatumPanel(p: DatumPanelProps) {
  const spec = () => DATUM_METHODS[p.def.method];
  const datumName = (id: string) => p.datums.find((d) => d.id === id)?.name;
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.currentTarget as HTMLElement).blur();
      p.onOk();
    } else if (e.key === "Escape") p.onCancel();
  };

  const Expr = (q: { label: I18nText; value: string; unit: string; set(v: string): void; len?: boolean }) => {
    const ev = () => p.evalExpr(q.value);
    return (
      <label class="field">
        <span>{tx(q.label)}</span>
        <div class="input-unit" classList={{ invalid: !!ev().error }}>
          <Show
            when={q.len}
            fallback={
              <>
                <input value={q.value} onInput={(e) => q.set(e.currentTarget.value)} onKeyDown={keys} spellcheck={false} />
                <Stepper get={() => q.value} set={q.set} evalExpr={p.evalExpr} />
              </>
            }
          >
            <LengthInput value={q.value} onValue={q.set} onKeyDown={keys} evalExpr={p.evalExpr} />
          </Show>
          <span class="unit">{q.unit}</span>
        </div>
        <Show when={ev().error}>
          <small class="field-error">{ev().error}</small>
        </Show>
      </label>
    );
  };

  return (
    <div class="property-panel datum-panel">
      <div class="panel-header">
        <span class="icon" innerHTML={p.icon} />
        <h2>{tx(L("Plan de référence", "Reference plane"))}</h2>
      </div>
      <div class="panel-actions">
        <button class="btn primary" onClick={() => p.onOk()}>
          ✓ {t("prop.ok")}
        </button>
        <button class="btn" onClick={() => p.onCancel()}>
          ✕ {t("prop.cancel")}
        </button>
      </div>
      <Show when={p.error}>
        <div class="panel-error" role="alert">
          {p.error}
        </div>
      </Show>
      <label class="field">
        <span>{t("prop.name")}</span>
        <input value={p.name} onChange={(e) => p.onName(e.currentTarget.value)} onKeyDown={keys} />
      </label>
      <label class="field">
        <span>{tx(L("Méthode", "Method"))}</span>
        <select
          value={p.def.method}
          onChange={(e) => {
            const m = e.currentTarget.value as DatumMethod;
            let next: number | null = null;
            p.onChange((d) => {
              changeMethod(d, m);
              next = firstEmptySlot(d);
            });
            p.onSlot(next);
          }}
          onKeyDown={keys}
        >
          <For each={Object.keys(METHOD_LABELS) as DatumMethod[]}>{(m) => <option value={m}>{tx(METHOD_LABELS[m])}</option>}</For>
        </select>
      </label>
      <For each={spec().roles}>
        {(role, i) => {
          const ref = () => p.def.refs[i()] ?? null;
          const active = () => p.slot === i();
          const presets = () => [...BASES[role].map((b) => ({ value: `base:${b}`, label: tx(BASE_LABELS[b]!) })), ...(role === "plane" ? p.datums.map((d) => ({ value: `datum:${d.id}`, label: d.name })) : [])];
          const choose = (v: string) => {
            if (!v) return;
            const [kind, id] = v.split(":") as [string, string];
            const r: DatumRef = kind === "base" ? { kind: "base", name: id as "XY" } : { kind: "datum", id };
            let next: number | null = null;
            p.onChange((d) => void (next = assignRef(d, i(), r)));
            p.onSlot(next);
          };
          return (
            <div class="field datum-slot">
              <span>{tx(SLOT_LABELS[p.def.method][i()] ?? L("Élément", "Element"))}</span>
              <div class="refs-box" classList={{ idle: !active() }} onClick={() => p.onSlot(i())} title={tx(ROLE_HINTS[role])}>
                <span class="datum-ref" classList={{ empty: !ref() }}>
                  {ref() ? refLabel(ref()!, datumName, p.componentName) : active() ? tx(L("À désigner dans la vue…", "Pick in the view…")) : "—"}
                </span>
                <Show when={ref()}>
                  <button
                    class="link-btn"
                    title={t("prop.clear")}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onChange((d) => void (d.refs[i()] = null));
                      p.onSlot(i());
                    }}
                  >
                    ×
                  </button>
                </Show>
              </div>
              <Show when={active()}>
                <small class="field-hint">{tx(ROLE_HINTS[role])}</small>
              </Show>
              <Show when={presets().length > 0}>
                <select class="datum-preset" value="" onChange={(e) => choose(e.currentTarget.value)} aria-label={tx(L("Plan ou axe de base", "Base plane or axis"))}>
                  <option value="">{tx(L("… ou choisir :", "… or choose:"))}</option>
                  <For each={presets()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                </select>
              </Show>
            </div>
          );
        }}
      </For>
      <Show when={spec().distance}>
        <Expr label={L("Distance", "Distance")} len unit={unitLabel()} value={p.def.distance ?? "0"} set={(v) => p.onChange((d) => void (d.distance = v))} />
      </Show>
      <Show when={spec().angle}>
        <Expr label={L("Angle", "Angle")} unit="°" value={p.def.angle ?? "0"} set={(v) => p.onChange((d) => void (d.angle = v))} />
      </Show>
      <label class="check">
        <input type="checkbox" checked={!!p.def.flip} onChange={(e) => p.onChange((d) => void (d.flip = e.currentTarget.checked || undefined))} />
        {tx(FLIP_LABELS[p.def.method] ?? FLIP_NORMAL)}
      </label>
    </div>
  );
}
