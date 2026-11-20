import { createSignal, type JSX } from "solid-js";
import type { Feature } from "../license.ts";
import { moduleEnabled } from "./modules.ts";
import { createRegistry } from "./registry.ts";

/**
 * Ribbon tab. Built-in workbenches (Part, Assembly, Drawing, CAM…) and plugins all go through this registry:
 * the header shows the visible tabs in `order` order; the ribbon body is that of the tab that "owns" it.
 */
export interface RibbonTab {
  id: string;
  label: () => string;
  /** Position in the header (ascending). Built-in workbenches: 0 to 99; plugins: 100 and above. */
  order: number;
  /** Optional module (see modules.ts): the tab disappears from the ribbon when the user disables it. */
  module?: string;
  /** Displayed tab (default: always). Contextual tabs (sketch, frame…) are only visible in their context. */
  visible?: () => boolean;
  /** Contextual tab: not clickable, distinct style. */
  contextual?: boolean;
  /** Announced tab ("Coming soon" on hover): greyed, nothing behind it. */
  soon?: boolean;
  /** Highlighted as the current tab. */
  active: () => boolean;
  disabled?: () => boolean;
  title?: () => string | undefined;
  /** Click on the tab (no effect if absent). */
  open?: () => void;
  /** Paid feature required to open the tab (`requireFeature`). */
  license?: Feature;
  /**
   * Ribbon body: shown when `owns()` is true, the tab with the highest `priority` winning.
   * A tab without a body (or that never owns it) is only a header button.
   */
  body?: () => JSX.Element;
  owns?: () => boolean;
  priority?: number;
  /** Overlay body on the document (Measure, Analysis): does not determine the license of the displayed workbench. */
  overlay?: boolean;
  /** License required to use the displayed body (workbench in view-only mode without it). */
  needs?: () => Feature | undefined;
  /** Plugin tab: document types on which it takes the ribbon body. */
  docKinds?: readonly string[];
}

export const tabRegistry = createRegistry<RibbonTab>();

/** Tabs displayed in the header, in order. */
export const visibleTabs = (): RibbonTab[] =>
  tabRegistry
    .list()
    .filter((t) => (t.module === undefined || moduleEnabled(t.module)) && (t.visible?.() ?? true))
    .sort((a, b) => a.order - b.order);

const byPriority = (a: RibbonTab, b: RibbonTab) => (b.priority ?? 0) - (a.priority ?? 0);

/** Tab whose body is displayed. */
export function bodyTab(): RibbonTab | undefined {
  return tabRegistry
    .list()
    .filter((t) => t.body && (t.owns?.() ?? false))
    .sort(byPriority)[0];
}

/** Tab of the displayed workbench, excluding overlays (Measure, Analysis): used for the license. */
export function documentTab(): RibbonTab | undefined {
  return tabRegistry
    .list()
    .filter((t) => !t.overlay && t.body && (t.owns?.() ?? false))
    .sort(byPriority)[0];
}

/** Chosen part workbench (Part, Sheet metal, or a plugin workbench). */
export const [partBenchId, setPartBenchId] = createSignal("part");

/** Chosen plugin tab: it takes the ribbon body on the documents it declares, in place of the built-in workbench. */
export const [pluginTabId, setPluginTabId] = createSignal<string | null>(null);

/** Does the chosen plugin tab apply to this document type? */
export function pluginTabShown(kind: string): boolean {
  const id = pluginTabId();
  return !!id && !!tabRegistry.get(id)?.docKinds?.includes(kind);
}
