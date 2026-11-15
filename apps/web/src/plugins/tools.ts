import type { Feature } from "../license.ts";
import type { TKey } from "../i18n.ts";
import { createRegistry } from "./registry.ts";
import { tabRegistry } from "./tabs.ts";

/**
 * Buttons of the Tools tab contributed by modules (buckling, tolerance stacks…). The built-in measurement tools
 * stay in MeasurePanel.tsx; these buttons come in groups after them, before the Display group.
 *
 * A tool usually opens its own window (`contribute("dialogs", …)`): it does not take over the 3D view.
 */
export interface ToolButton {
  id: string;
  /** Ribbon group: "calc" (Calculations) or "assembly" for the built-in groups, otherwise a new group. */
  group: string;
  /** Label of a new group (ignored for the built-in groups). */
  groupLabel?: () => string;
  label: () => string;
  /** SVG markup of the 24×24 icon. */
  icon: string;
  /** Position within the group (ascending). */
  order: number;
  /** Paid feature: the core checks the license before `run` (and shows a lock without it). */
  needs?: Feature;
  /** Document types on which the tool is available (default: all). */
  docKinds?: readonly string[];
  title?: () => string | undefined;
  /** Highlighted while its window is open. */
  pressed?: () => boolean;
  run: () => void;
}

export const toolRegistry = createRegistry<ToolButton>();

/** Built-in groups and their position (modules' own groups come after "calc"). */
export const TOOL_GROUPS = ["assembly", "calc"] as const;

/** Utility tool of a module that is not part of this build: shown greyed out, "Coming soon". */
export interface ComingSoonTool {
  /** Identifier of the tool (or ribbon tab) the module registers when it is compiled in. */
  id: string;
  group: string;
  label: TKey;
  icon: string;
}

const soonIcon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

/** Known utilities provided by modules (pipe / cable routing, gears, belts, buckling, tolerance stacks). */
const COMING_SOON_TOOLS: readonly ComingSoonTool[] = [
  { id: "gears", group: "calc", label: "soon.gears", icon: soonIcon('<circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.8"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>') },
  { id: "belt", group: "calc", label: "soon.belt", icon: soonIcon('<circle cx="7" cy="14" r="4"/><circle cx="17.5" cy="8" r="2.5"/><path d="M4.2 11.2 15.6 6.1M9.4 17.3l9.6-7.3"/>') },
  { id: "buckling", group: "calc", label: "soon.buckling", icon: soonIcon('<path d="M5 3h6M5 21h6M8 3c5 5 5 13 0 18"/><path d="M19 3v5M17 6l2 2 2-2"/>') },
  { id: "route", group: "assembly", label: "soon.route", icon: soonIcon('<path d="M3 6h3M3 4v4M21 18h-3M21 16v4"/><path d="M6 6h5a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h-1" stroke-width="3"/>') },
  { id: "tolstack", group: "calc", label: "soon.tolstack", icon: soonIcon('<path d="M4 4v16M20 4v16"/><path d="M4 8h9M11 6l2 2-2 2"/><path d="M13 12h7M18 10l2 2-2 2"/><path d="M4 17h16M7 15l-3 2 3 2M17 15l3 2-3 2"/>') },
];

/** Utilities of a group whose module is absent from this build (reactive). */
export const comingSoonTools = (group: string): ComingSoonTool[] =>
  COMING_SOON_TOOLS.filter((s) => s.group === group && !toolRegistry.get(s.id) && !tabRegistry.get(s.id));

/** Contributed tools, by group, in order. */
export function toolGroups(): { group: string; label?: () => string; tools: ToolButton[] }[] {
  const out = new Map<string, { group: string; label?: () => string; tools: ToolButton[] }>();
  for (const g of TOOL_GROUPS) out.set(g, { group: g, tools: [] });
  for (const tool of toolRegistry.list()) {
    const g = out.get(tool.group) ?? { group: tool.group, label: tool.groupLabel, tools: [] };
    g.tools.push(tool);
    out.set(tool.group, g);
  }
  for (const g of out.values()) g.tools.sort((a, b) => a.order - b.order);
  return [...out.values()];
}
