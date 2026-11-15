import { createSignal, For, Index, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { MATERIALS, type Inertia } from "@solidus-cad/sdk";
import type { Viewer } from "@solidus-cad/viewer";
import { t, type TKey } from "../i18n.ts";
import { assignMaterial, AXIS_COLORS, axisLegs, type MassReport, clearPoints, closeMeasure, currentModuleTool, distance, hasMeasure, massReport, measure, modulePicking, pointOwner, radiusEnd, setMeasure, setTool, type MeasureTool } from "../measure.ts";
import { activeKind, ws } from "../workspace.ts";
import { previewUrl } from "./HoverPreview.tsx";
import { LiaisonResults } from "./LiaisonGraph.tsx";
import { hasFeature, requireFeature } from "../license.ts";
import { comingSoonTools, toolGroups, type ToolButton } from "../plugins/tools.ts";
import { fmtVol, isInch, MM_PER_INCH, toUnit, unitLabel } from "../units.ts";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

const n = (v: number, digits = 2) => v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 2) });

const TOOLS: { tool: MeasureTool; label: TKey; icon: string }[] = [
  { tool: "distance", label: "meas.distance", icon: svg('<circle cx="5" cy="17" r="2"/><circle cx="19" cy="7" r="2"/><path d="M6.7 15.8 17.3 8.2" stroke-dasharray="2 1.6"/>') },
  { tool: "circle", label: "meas.circle", icon: svg('<circle cx="12" cy="12" r="8"/><path d="M6.3 17.7 17.7 6.3"/><circle cx="12" cy="12" r="1" fill="currentColor"/>') },
  { tool: "mass", label: "meas.mass", icon: svg('<path d="M7 9h10l3 11H4z"/><circle cx="12" cy="6" r="2.5"/>') },
];

/** Two bubbles joined by a joint. */
const LIAISON_ICON = svg('<rect x="2.5" y="4" width="7" height="5" rx="2.5"/><rect x="14.5" y="15" width="7" height="5" rx="2.5"/><path d="M8 9l8 6"/><circle cx="12" cy="12" r="2"/>');

/** Button of a tool contributed by a module (plugins/tools.ts): license checked by the core, lock without it. */
function ToolButtonView(props: { tool: ToolButton }) {
  const available = () => !props.tool.docKinds || props.tool.docKinds.includes(activeKind());
  const locked = () => !!props.tool.needs && !hasFeature(props.tool.needs);
  return (
    <button
      class="ribbon-btn"
      classList={{ pressed: !!props.tool.pressed?.(), locked: locked() }}
      disabled={!available()}
      title={props.tool.title?.() ?? (locked() ? t("tools.premium") : undefined)}
      onClick={() => (props.tool.needs ? requireFeature(props.tool.needs, props.tool.run) : props.tool.run())}
    >
      <span class="icon" innerHTML={props.tool.icon} />
      <span>
        {props.tool.label()}
        <Show when={locked()}> 🔒</Show>
      </span>
    </button>
  );
}

/** Utility absent from this build: greyed out, "Coming soon". */
function SoonButton(props: { icon: string; label: string }) {
  return (
    <button class="ribbon-btn soon" disabled title={t("plg.soon")}>
      <span class="icon" innerHTML={props.icon} />
      <span>{props.label}</span>
      <small class="soon-tag">{t("plg.soon")}</small>
    </button>
  );
}

/** Banner of the Tools workbench (measurements, liaison graph, module tools). */
export function MeasureRibbon() {
  return (
    <div class="ribbon-body">
      <div class="ribbon-group">
        <div class="ribbon-buttons">
          <For each={TOOLS}>
            {(b) => (
              <button
                class="ribbon-btn"
                classList={{ pressed: measure.tool === b.tool }}
                data-preview={previewUrl(`measure.${b.tool}`)}
                data-preview-label={t(b.label)}
                onClick={() => setTool(b.tool)}
              >
                <span class="icon" innerHTML={b.icon} />
                <span>{t(b.label)}</span>
              </button>
            )}
          </For>
        </div>
        <div class="ribbon-group-label">{t("meas.g.tools")}</div>
      </div>
      <For each={toolGroups()}>
        {(g) => (
          <Show when={g.group === "assembly" || g.tools.length > 0 || comingSoonTools(g.group).length > 0}>
            <div class="ribbon-group">
              <div class="ribbon-buttons">
                <Show when={g.group === "assembly"}>
                  <button
                    class="ribbon-btn"
                    classList={{ pressed: measure.tool === "liaisons" }}
                    disabled={activeKind() !== "assembly"}
                    title={activeKind() !== "assembly" ? t("lia.noAsm") : undefined}
                    onClick={() => setTool("liaisons")}
                  >
                    <span class="icon" innerHTML={LIAISON_ICON} />
                    <span>{t("lia.graph")}</span>
                  </button>
                </Show>
                <For each={g.tools}>{(tool) => <ToolButtonView tool={tool} />}</For>
                <For each={comingSoonTools(g.group)}>{(s) => <SoonButton icon={s.icon} label={t(s.label)} />}</For>
              </div>
              <div class="ribbon-group-label">{g.group === "assembly" ? t("meas.g.assembly") : g.group === "calc" ? t("meas.g.calc") : (g.label?.() ?? g.group)}</div>
            </div>
          </Show>
        )}
      </For>
      <div class="ribbon-group">
        <div class="ribbon-buttons">
          <button class="ribbon-btn" disabled={!hasMeasure()} title={t("meas.clear")} onClick={clearPoints}>
            <span class="icon" innerHTML={svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>')} />
            <span>{t("meas.clear")}</span>
          </button>
        </div>
        <div class="ribbon-group-label">{t("meas.g.view")}</div>
      </div>
    </div>
  );
}

// Values rounded to zero without sign (no "-0.00").
const fmtDir = (p: number[]) => `(${p.map((c) => n(Math.abs(c) < 0.005 ? 0 : c, 2)).join(" ; ")})`;
/** Point (mm) in the display unit. */
const fmtPoint = (p: number[]) => fmtDir(p.map(toUnit).map((c) => (isInch() ? Math.round(c * 1000) / 1000 : c)));
/** Length (mm) in the display unit, with its unit (3 decimals in mm, 4 in inches). */
const len = (mm: number, digits = 3) => `${n(toUnit(mm), isInch() ? digits + 1 : digits)} ${unitLabel()}`;
/** Inertia unit: kg·mm² or kg·in² (the mass stays in kg). */
const inertiaUnit = () => (isInch() ? "kg·in²" : "kg·mm²");
const inertiaValue = (kgmm2: number) => (isInch() ? kgmm2 / MM_PER_INCH ** 2 : kgmm2);

function DistanceResults() {
  return (
    <>
      <For each={measure.points}>
        {(p, i) => (
          <div class="meas-point">
            <span class="meas-dot">{i() + 1}</span>
            <span>
              {fmtPoint(p.point)}
              <span class="muted">
                {" "}
                · {t(`meas.snap.${p.kind}` as TKey)} · {pointOwner(p)}
              </span>
            </span>
          </div>
        )}
      </For>
      <Show
        when={distance()}
        fallback={<div class="muted">{measure.points.length === 0 ? t("meas.hintFirst") : t("meas.hintSecond")}</div>}
      >
        {(r) => (
          <>
            <div class="meas-big">
              {t("meas.dist")} <strong>{len(r().d)}</strong>
            </div>
            <dl class="meas-grid">
              <For each={["X", "Y", "Z"] as const}>
                {(axis, i) => (
                  <>
                    <dt class="meas-axis" style={{ color: AXIS_COLORS[axis] }}>Δ{axis}</dt>
                    <dd class="meas-axis" style={{ color: AXIS_COLORS[axis] }}>{len(r().delta[i()]!)}</dd>
                  </>
                )}
              </For>
            </dl>
            <div class="muted">{t("meas.hintAgain")}</div>
          </>
        )}
      </Show>
    </>
  );
}

const INERTIA_KEYS: [keyof Inertia, string][] = [
  ["xx", "Ixx"],
  ["yy", "Iyy"],
  ["zz", "Izz"],
  ["xy", "Ixy"],
  ["xz", "Ixz"],
  ["yz", "Iyz"],
];

function InertiaResults(props: { report: MassReport }) {
  const values = () => props.report.inertia?.[measure.inertiaAt] ?? null;
  // Products that are zero up to rounding errors: shown as 0 (not "-0").
  const clean = (x: number) => {
    const v = values();
    const eps = v ? Math.max(Math.abs(v.xx), Math.abs(v.yy), Math.abs(v.zz)) * 1e-9 : 0;
    return Math.abs(x) <= eps ? 0 : x;
  };
  const copy = () => {
    const v = values();
    if (!v) return;
    const text = INERTIA_KEYS.map(([k, label]) => `${label}\t${inertiaValue(v[k])}`).join("\n");
    void navigator.clipboard?.writeText(`${t("meas.inertia")} (${inertiaUnit()})\n${text}`);
  };
  return (
    <Show when={values()} fallback={<Show when={props.report.volume > 0}><div class="muted">{t("meas.inertiaNeedsMaterial")}</div></Show>}>
      {(v) => (
        <div class="meas-inertia">
          <div class="meas-subhead">
            <span title={t("meas.inertiaHint")}>{t("meas.inertia")} ({inertiaUnit()})</span>
            <button class="icon-btn" title={t("meas.copy")} aria-label={t("meas.copy")} onClick={copy}>
              ⧉
            </button>
          </div>
          <div class="seg">
            <button classList={{ active: measure.inertiaAt === "cog" }} onClick={() => setMeasure("inertiaAt", "cog")}>
              {t("meas.atCog")}
            </button>
            <button classList={{ active: measure.inertiaAt === "origin" }} onClick={() => setMeasure("inertiaAt", "origin")}>
              {t("meas.atOrigin")}
            </button>
          </div>
          <dl class="meas-inertia-grid">
            <For each={INERTIA_KEYS}>
              {([k, label]) => (
                <div>
                  <dt>{label}</dt>
                  <dd>{n(inertiaValue(clean(v()[k])), isInch() ? 4 : 2)}</dd>
                </div>
              )}
            </For>
          </dl>
          <Show when={props.report.inertiaPartial}>
            <div class="muted meas-warn">{t("meas.inertiaPartial")}</div>
          </Show>
        </div>
      )}
    </Show>
  );
}

function MassResults() {
  const report = () => massReport();
  const asm = () => activeKind() === "assembly";
  return (
    <>
      <Show when={asm()}>
        <div class="seg">
          <button classList={{ active: measure.scope === "selection" }} onClick={() => setMeasure("scope", "selection")}>
            {t("meas.scope.selection")}
          </button>
          <button classList={{ active: measure.scope === "all" }} onClick={() => setMeasure("scope", "all")}>
            {t("meas.scope.all")}
          </button>
        </div>
        <Show when={measure.scope === "selection" && ws.selection.length === 0}>
          <div class="muted">{t("meas.noSelection")}</div>
        </Show>
      </Show>
      <dl class="meas-grid">
        <dt>{t("meas.volume")}</dt>
        <dd>{fmtVol(report().volume, 3, 2)}</dd>
        <dt>{t("meas.massTotal")}</dt>
        <dd classList={{ "meas-warn": report().missing > 0 }}>
          <Show when={report().mass > 0 || report().missing === 0} fallback="—">
            {n(report().mass, 3)} kg
          </Show>
          <Show when={report().missing > 0 && report().mass > 0}>
            <span class="muted"> ({t("meas.partial")})</span>
          </Show>
        </dd>
        <Show when={report().cog}>
          {(c) => (
            <>
              <dt>
                <span class="meas-sym cog" aria-hidden="true" /> {t("meas.cog")}
              </dt>
              <dd>{fmtPoint(c())}</dd>
            </>
          )}
        </Show>
        {/* Single homogeneous part: the volume centre is the centroid; shown only without material. */}
        <Show when={(asm() || !report().cog) && report().cov}>
          {(c) => (
            <>
              <dt>
                <span class="meas-sym cov" aria-hidden="true" /> {t("meas.cov")}
              </dt>
              <dd>{fmtPoint(c())}</dd>
            </>
          )}
        </Show>
      </dl>
      <label class="check">
        <input type="checkbox" checked={measure.showCentres} onChange={(e) => setMeasure("showCentres", e.currentTarget.checked)} />
        {t("meas.showCentres")}
      </label>
      <InertiaResults report={report()} />
      <Show when={report().pending > 0}>
        <div class="muted">{t("meas.pending")}</div>
      </Show>
      <Show when={report().missing > 0}>
        <div class="meas-alert" role="alert">
          {asm() ? `${report().missing} ${t("meas.parts")} ${t("meas.missing")}` : t("meas.missingPart")}
        </div>
      </Show>
      <div class="meas-table-wrap">
        <table class="meas-table">
          <thead>
            <tr>
              <th>{t("meas.part")}</th>
              <Show when={asm()}>
                <th class="num">{t("bom.qty")}</th>
              </Show>
              <th>{t("doc.material")}</th>
              <th class="num">{t("meas.unitMass")}</th>
            </tr>
          </thead>
          <tbody>
            <Index each={report().lines}>
              {(l) => (
                <tr classList={{ missing: !l().material }}>
                  <td>{l().name}</td>
                  <Show when={asm()}>
                    <td class="num">{l().quantity}</td>
                  </Show>
                  <td>
                    <Show when={l().material} fallback={
                      <select
                        class="meas-assign"
                        aria-label={`${t("meas.assign")} ${l().name}`}
                        value=""
                        onChange={(e) => {
                          const m = MATERIALS.find((x) => x.name === e.currentTarget.value);
                          if (m) assignMaterial(l().partId, m);
                        }}
                      >
                        <option value="">{t("meas.assign")}</option>
                        <For each={MATERIALS}>{(m) => <option value={m.name}>{m.name}</option>}</For>
                      </select>
                    }>
                      {l().material}
                    </Show>
                  </td>
                  <td class="num">{l().mass === null ? "—" : `${n(l().mass!, 3)} kg`}</td>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
      </div>
    </>
  );
}

const deg = (rad: number) => (rad * 180) / Math.PI;

function CircleResults() {
  return (
    <Show when={measure.circle} fallback={<div class="muted">{t("meas.hintCircle")}</div>}>
      {(c) => (
        <>
          <div class="muted">
            {c().kind === "face" ? t("meas.kind.cylinder") : c().closed ? t("meas.kind.circle") : t("meas.kind.arc")} · {pointOwner(c())}
          </div>
          <div class="meas-big">
            {t("meas.diameter")} <strong>Ø {len(c().radius * 2)}</strong>
          </div>
          <div class="meas-big">
            {t("meas.radius")} <strong>R {len(c().radius)}</strong>
          </div>
          <dl class="meas-grid">
            <Show when={!c().closed}>
              <dt>{t("meas.arcAngle")}</dt>
              <dd>{n(deg(c().angle), 2)}°</dd>
              <dt>{t("meas.arcLength")}</dt>
              <dd>{len(c().angle * c().radius)}</dd>
            </Show>
            <dt>{t("meas.center")}</dt>
            <dd>{fmtPoint(c().center)}</dd>
            <dt>{t("meas.axis")}</dt>
            <dd>{fmtDir(c().normal)}</dd>
          </dl>
          <div class="muted">{t("meas.hintAgainCircle")}</div>
        </>
      )}
    </Show>
  );
}

const TITLES: Partial<Record<MeasureTool, TKey>> = { distance: "meas.distance", circle: "meas.circle", mass: "meas.mass", liaisons: "lia.graph" };
const toolTitle = (): string => { const k = TITLES[measure.tool]; return k ? t(k) : (currentModuleTool()?.title() ?? ""); };

/** Floating panel of the measurement results. */
export function MeasurePanel() {
  return (
    <Show when={measure.on && activeKind() !== "drawing" && !modulePicking()}>
      <div class="section-panel measure-panel" classList={{ "liaison-panel": measure.tool === "liaisons", [currentModuleTool()?.panelClass ?? "module-tool-panel"]: !!currentModuleTool()?.panelClass }} role="dialog" aria-label={t("bench.measure")}>
        <div class="section-head">
          <span>{toolTitle()}</span>
          <button class="icon-btn" title={t("meas.close")} aria-label={t("meas.close")} onClick={closeMeasure}>
            ×
          </button>
        </div>
        <Show when={measure.tool === "distance"}>
          <DistanceResults />
        </Show>
        <Show when={measure.tool === "circle"}>
          <CircleResults />
        </Show>
        <Show when={measure.tool === "mass"}>
          <MassResults />
        </Show>
        <Show when={measure.tool === "liaisons"}>
          <LiaisonResults />
        </Show>
        <Show when={currentModuleTool()}>{(m) => <Dynamic component={m().panel} />}</Show>
      </div>
    </Show>
  );
}

/** Measurement label (distance at the segment midpoint, diameter at the radius midpoint), which follows the view. */
export function MeasureLabel(props: { viewer: Viewer }) {
  const [tick, setTick] = createSignal(0);
  onCleanup(props.viewer.onViewChange(() => setTick((x) => x + 1)));
  const pos = () => {
    void tick();
    let a: number[];
    let b: number[];
    const c = measure.circle;
    if (measure.tool === "circle" && c) {
      a = c.center;
      b = radiusEnd(c);
    } else if (measure.tool === "distance" && measure.points.length === 2) {
      a = measure.points[0]!.point;
      b = measure.points[1]!.point;
    } else return null;
    return props.viewer.worldToScreen({ x: (a[0]! + b[0]!) / 2, y: (a[1]! + b[1]!) / 2, z: (a[2]! + b[2]!) / 2 });
  };
  const text = () => {
    const c = measure.circle;
    if (measure.tool === "circle" && c) return c.closed ? `Ø ${len(c.radius * 2)}` : `R ${len(c.radius)}`;
    const d = distance();
    return d ? len(d.d) : "";
  };
  // Offsets along the axes, at the midpoint of each branch of the path X → Y → Z (only if there are several).
  const legs = () => {
    if (!measure.on || measure.tool !== "distance") return [];
    void tick();
    const l = axisLegs();
    if (l.length < 2) return [];
    return l.map((s) => ({
      text: `Δ${s.axis} ${n(toUnit(Math.abs(s.d)), isInch() ? 4 : 3)}`,
      color: AXIS_COLORS[s.axis],
      ...props.viewer.worldToScreen({ x: (s.a[0] + s.b[0]) / 2, y: (s.a[1] + s.b[1]) / 2, z: (s.a[2] + s.b[2]) / 2 }),
    }));
  };
  return (
    <>
      <For each={legs()}>
        {(l) => (
          <div class="measure-label axis" style={{ left: `${l.x}px`, top: `${l.y}px`, background: l.color }}>
            {l.text}
          </div>
        )}
      </For>
      <Show when={measure.on && pos()}>
        {(p) => (
          <div class="measure-label" style={{ left: `${p().x}px`, top: `${p().y}px` }}>
            {text()}
          </div>
        )}
      </Show>
    </>
  );
}

/** "CdG" and "CdV" markers next to the symbols shown in the view. */
export function CentreLabels(props: { viewer: Viewer }) {
  const [tick, setTick] = createSignal(0);
  onCleanup(props.viewer.onViewChange(() => setTick((x) => x + 1)));
  const labels = () => {
    if (!measure.on || measure.tool !== "mass" || !measure.showCentres || activeKind() === "drawing") return [];
    void tick();
    const r = massReport();
    const out: { key: string; text: string; x: number; y: number }[] = [];
    const at = (p: number[]) => props.viewer.worldToScreen({ x: p[0]!, y: p[1]!, z: p[2]! });
    if (r.cog) out.push({ key: "cog", text: t("meas.cogShort"), ...at(r.cog) });
    if (r.cov && (activeKind() === "assembly" || !r.cog)) out.push({ key: "cov", text: t("meas.covShort"), ...at(r.cov) });
    return out;
  };
  return (
    <For each={labels()}>
      {(l) => (
        <div class={`centre-label ${l.key}`} style={{ left: `${l.x}px`, top: `${l.y}px` }}>
          {l.text}
        </div>
      )}
    </For>
  );
}
