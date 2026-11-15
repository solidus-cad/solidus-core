import { createMemo, createSignal, For, Show } from "solid-js";
import type { Liaison, LiaisonGraph } from "@solidus-cad/assembly";
import { t, type TKey } from "../i18n.ts";
import { measure } from "../measure.ts";
import { DATUM_BODY } from "../assembly/flex.ts";
import { activeKind, asmLiaisons, componentAt, occurrenceLabel, selectOccurrences, ws } from "../workspace.ts";
import { isInch, toUnit, unitLabel } from "../units.ts";

/**
 * Liaison graph of the active assembly (Tools workbench): one bubble per kinematic class (parts without
 * relative motion), one edge per joint between two classes, labelled with its normalised name (pivot, glissière,
 * rotule…); motion couplings (gear, belt, rack and pinion) as dashed edges.
 */

type V3 = [number, number, number];

const n = (v: number, digits = 2) => v.toLocaleString(undefined, { maximumFractionDigits: digits });
const fmtPoint = (p: V3) => `(${p.map((c) => n(Math.abs(toUnit(c)) < 0.005 ? 0 : toUnit(c), isInch() ? 3 : 2)).join(" ; ")})`;

/** Direction: name of the axis it is parallel to, otherwise its components. */
function fmtDir(d: V3): string {
  const i = [0, 1, 2].find((k) => Math.abs(Math.abs(d[k]!) - 1) < 1e-6);
  return i !== undefined ? "XYZ"[i]! : `(${d.map((c) => n(Math.abs(c) < 5e-4 ? 0 : c, 3)).join(" ; ")})`;
}

const NORMAL_KINDS = new Set(["planar", "cylinderPlane", "spherePlane", "fingerSpherical"]);

/** Geometric details of a joint (axis, normal, centre, pitch). */
export function liaisonDetails(l: Liaison): string {
  const parts: string[] = [];
  if (l.kind === "compound") parts.push(`${l.rotations} ${t("lia.rotations")} · ${l.translations} ${t("lia.translations")}`);
  if (l.axis) {
    const s = `${t(NORMAL_KINDS.has(l.kind) ? "lia.normal" : "lia.axis")} ${fmtDir(l.axis)}`;
    parts.push(l.point && l.kind !== "spherical" && l.kind !== "fingerSpherical" ? `${s} ${t("lia.through")} ${fmtPoint(l.point)}` : s);
  }
  if (l.point && (l.kind === "spherical" || l.kind === "fingerSpherical")) parts.push(`${t("lia.centre")} ${fmtPoint(l.point)}`);
  if (l.pitch !== undefined) parts.push(`${t("lia.pitch")} ${n(toUnit(Math.abs(l.pitch)), isInch() ? 4 : 3)} ${unitLabel()}`);
  return parts.join(" · ");
}

const bodyLabel = (id: string) => (id === DATUM_BODY ? t("lia.datums") : occurrenceLabel(id));

// --- Layout ---------------------------------------------------------------------------------------

const NODE_W = 132;
const LINE_H = 14;
const MAX_NAMES = 3;
const COL_GAP = 28;
const ROW_GAP = 64;
const PAD = 12;

interface Node {
  index: number;
  x: number;
  y: number;
  h: number;
  names: string[];
  more: number;
  ground: boolean;
  isolated: boolean;
}

/** Layers from the ground (breadth-first), ordered by the mean position of their parents; isolated classes last. */
function layout(g: LiaisonGraph): { nodes: Node[]; width: number; height: number } {
  const links = [...g.liaisons, ...g.couplings];
  const adj = g.classes.map(() => new Set<number>());
  for (const l of links) {
    adj[l.a]!.add(l.b);
    adj[l.b]!.add(l.a);
  }
  const depth = g.classes.map(() => -1);
  const rows: number[][] = [];
  const visit = (start: number) => {
    if (depth[start] !== -1) return;
    const base = rows.length;
    depth[start] = base;
    let frontier = [start];
    while (frontier.length) {
      const d = depth[frontier[0]!]!;
      (rows[d] ??= []).push(...frontier);
      const next: number[] = [];
      for (const i of frontier) for (const j of adj[i]!) if (depth[j] === -1) {
        depth[j] = d + 1;
        next.push(j);
      }
      frontier = next;
    }
  };
  // Ground first, then the other connected sets; classes without any joint in a last row.
  const isolated = g.classes.map((c, i) => !c.ground && adj[i]!.size === 0);
  g.classes.forEach((c, i) => c.ground && visit(i));
  g.classes.forEach((_, i) => !isolated[i] && visit(i));
  const lonely = g.classes.map((_, i) => i).filter((i) => isolated[i]);
  if (lonely.length) rows.push(lonely);

  const heights = g.classes.map((c) => {
    const names = Math.min(c.bodies.length, MAX_NAMES) + (c.bodies.length > MAX_NAMES ? 1 : 0);
    return 22 + names * LINE_H + (c.ground ? 16 : 0);
  });
  const width = Math.max(...rows.map((r) => r.length), 1) * (NODE_W + COL_GAP) - COL_GAP + PAD * 2;
  const pos = new Map<number, { x: number; y: number }>();
  let y = PAD;
  const nodes: Node[] = [];
  for (const row of rows) {
    // Barycentre of the already placed neighbours: fewer crossings.
    const key = (i: number) => {
      const xs = [...adj[i]!].map((j) => pos.get(j)?.x).filter((x): x is number => x !== undefined);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : Infinity;
    };
    const ordered = [...row].sort((a, b) => key(a) - key(b));
    const rowW = ordered.length * (NODE_W + COL_GAP) - COL_GAP;
    const h = Math.max(...ordered.map((i) => heights[i]!));
    ordered.forEach((i, k) => {
      const x = (width - rowW) / 2 + k * (NODE_W + COL_GAP) + NODE_W / 2;
      pos.set(i, { x, y: y + h / 2 });
      const c = g.classes[i]!;
      const names = c.bodies.slice(0, MAX_NAMES).map(bodyLabel);
      nodes.push({ index: i, x, y: y + h / 2, h: heights[i]!, names, more: Math.max(0, c.bodies.length - MAX_NAMES), ground: c.ground, isolated: isolated[i]! });
    });
    y += h + ROW_GAP;
  }
  return { nodes, width, height: y - ROW_GAP + PAD };
}

/** Text shortened to fit a bubble. */
const clip = (s: string, max = 20) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function LiaisonResults() {
  const graph = createMemo(() => {
    if (!measure.on || measure.tool !== "liaisons" || activeKind() !== "assembly" || !ws.asm) return null;
    // Dependencies: the whole assembly (positions, constraints) and the recomputed parts (skeleton references).
    void JSON.stringify(ws.asm);
    void ws.partRev;
    try {
      return asmLiaisons();
    } catch (e) {
      console.error(e);
      return null;
    }
  });
  const view = createMemo(() => {
    const g = graph();
    return g ? layout(g) : null;
  });
  const [hover, setHover] = createSignal<string | null>(null);
  const nodeAt = (i: number) => view()!.nodes.find((x) => x.index === i)!;
  const selected = (i: number) => {
    const bodies = graph()!.classes[i]!.bodies.filter((b) => b !== DATUM_BODY);
    return bodies.length > 0 && bodies.every((b) => ws.selection.includes(b));
  };
  const select = (i: number) => selectOccurrences(graph()!.classes[i]!.bodies.filter((b) => b !== DATUM_BODY && !!componentAt(b)));
  const className = (i: number) => {
    const c = graph()!.classes[i]!;
    return c.ground ? t("lia.ground") : clip(bodyLabel(c.bodies[0]!), 28) + (c.bodies.length > 1 ? ` +${c.bodies.length - 1}` : "");
  };

  /** Edges: joints, then couplings (offset when they share the pair of classes of a joint). */
  const edges = () => {
    const g = graph()!;
    const out: { id: string; a: number; b: number; label: string; title: string; dashed: boolean; bend: number }[] = [];
    const seen = new Map<string, number>();
    const bendOf = (a: number, b: number) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      return k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 26;
    };
    g.liaisons.forEach((l, k) => {
      const name = t(`lia.kind.${l.kind}` as TKey);
      const details = liaisonDetails(l);
      out.push({ id: `l${k}`, a: l.a, b: l.b, label: name, title: `${name} — ${l.dof} ${t("lia.dof")}${details ? `\n${details}` : ""}`, dashed: false, bend: bendOf(l.a, l.b) });
    });
    g.couplings.forEach((c, k) => {
      const name = t(`lia.coupling.${c.type}` as TKey);
      out.push({ id: `c${k}`, a: c.a, b: c.b, label: name, title: name, dashed: true, bend: bendOf(c.a, c.b) });
    });
    return out;
  };

  const path = (e: { a: number; b: number; bend: number }) => {
    const p = nodeAt(e.a);
    const q = nodeAt(e.b);
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    // Control point offset perpendicular to the segment (parallel edges of the same pair).
    const cx = mx - (dy / l) * e.bend * 2;
    const cy = my + (dx / l) * e.bend * 2;
    return { d: `M${p.x},${p.y} Q${cx},${cy} ${q.x},${q.y}`, lx: (p.x + 2 * cx + q.x) / 4, ly: (p.y + 2 * cy + q.y) / 4 };
  };

  return (
    <Show when={activeKind() === "assembly"} fallback={<div class="muted">{t("lia.noAsm")}</div>}>
      <Show when={graph()} fallback={<div class="muted">{t("lia.empty")}</div>}>
        {(g) => (
          <>
            <dl class="meas-grid">
              <dt>{t("lia.mobility")}</dt>
              <dd>{g().mobility}</dd>
              <dt>{t("lia.hyper")}</dt>
              <dd classList={{ "meas-warn": g().hyperstatic > 0 }}>{g().hyperstatic}</dd>
            </dl>
            <div class="lia-wrap">
              <svg class="lia-graph" viewBox={`0 0 ${view()!.width} ${view()!.height}`} width={view()!.width} role="img" aria-label={t("lia.graph")}>
                <defs>
                  <pattern id="lia-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="1.2" />
                  </pattern>
                </defs>
                <For each={edges()}>
                  {(e) => {
                    const geo = () => path(e);
                    const w = () => Math.max(36, e.label.length * 6.2 + 12);
                    return (
                      <g class="lia-edge" classList={{ hover: hover() === e.id, coupling: e.dashed }} onMouseEnter={() => setHover(e.id)} onMouseLeave={() => setHover(null)}>
                        <title>{e.title}</title>
                        <path d={geo().d} />
                        <rect x={geo().lx - w() / 2} y={geo().ly - 9} width={w()} height={18} rx={9} />
                        <text x={geo().lx} y={geo().ly + 4}>
                          {e.label}
                        </text>
                      </g>
                    );
                  }}
                </For>
                <For each={view()!.nodes}>
                  {(nd) => (
                    <g
                      class="lia-node"
                      classList={{ ground: nd.ground, isolated: nd.isolated, selected: selected(nd.index) }}
                      role="button"
                      tabindex="0"
                      onClick={() => select(nd.index)}
                      onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), select(nd.index))}
                    >
                      <title>{g().classes[nd.index]!.bodies.map(bodyLabel).join("\n")}</title>
                      <rect x={nd.x - NODE_W / 2} y={nd.y - nd.h / 2} width={NODE_W} height={nd.h} rx={14} />
                      <Show when={nd.ground}>
                        <text class="lia-ground" x={nd.x} y={nd.y - nd.h / 2 + 15}>
                          {t("lia.ground")}
                        </text>
                        <rect class="lia-hatch" x={nd.x - NODE_W / 2 + 14} y={nd.y + nd.h / 2 - 9} width={NODE_W - 28} height={5} fill="url(#lia-hatch)" />
                      </Show>
                      <For each={nd.names}>
                        {(name, k) => (
                          <text x={nd.x} y={nd.y - nd.h / 2 + 16 + (nd.ground ? 16 : 0) + k() * LINE_H}>
                            {clip(name)}
                          </text>
                        )}
                      </For>
                      <Show when={nd.more > 0}>
                        <text class="lia-more" x={nd.x} y={nd.y - nd.h / 2 + 16 + (nd.ground ? 16 : 0) + nd.names.length * LINE_H}>
                          +{nd.more}
                        </text>
                      </Show>
                    </g>
                  )}
                </For>
              </svg>
            </div>
            <Show when={g().liaisons.length + g().couplings.length > 0}>
              <table class="meas-table lia-table">
                <tbody>
                  <For each={g().liaisons}>
                    {(l, k) => (
                      <tr classList={{ hover: hover() === `l${k()}` }} onMouseEnter={() => setHover(`l${k()}`)} onMouseLeave={() => setHover(null)}>
                        <td>
                          {className(l.a)} — {className(l.b)}
                        </td>
                        <td>
                          <strong>{t(`lia.kind.${l.kind}` as TKey)}</strong> <span class="muted">· {l.dof} {t("lia.dof")}</span>
                          <Show when={liaisonDetails(l)}>
                            <div class="muted">{liaisonDetails(l)}</div>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                  <For each={g().couplings}>
                    {(c, k) => (
                      <tr classList={{ hover: hover() === `c${k()}` }} onMouseEnter={() => setHover(`c${k()}`)} onMouseLeave={() => setHover(null)}>
                        <td>
                          {className(c.a)} — {className(c.b)}
                        </td>
                        <td>
                          <strong>{t(`lia.coupling.${c.type}` as TKey)}</strong>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
            <div class="muted">{t("lia.hint")}</div>
          </>
        )}
      </Show>
    </Show>
  );
}
