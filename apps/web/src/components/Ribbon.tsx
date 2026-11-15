import { For, Show } from "solid-js";
import { t } from "../i18n.ts";
import { HoverPreview } from "./HoverPreview.tsx";
import { panels, PanelToggle } from "./PanelToggle.tsx";
import { explainLocked, hasFeature, requireFeature } from "../license.ts";
import type { Feature } from "../license.ts";
import "../plugins/builtin.tsx";
import { bodyTab, documentTab, visibleTabs, type RibbonTab } from "../plugins/tabs.ts";

/** Ribbon of a locked workbench: documents remain viewable, tools are unavailable. */
function LockedRibbon(props: { feature: Feature }) {
  return (
    <div class="ribbon-body ribbon-locked">
      <span>{t("lic.locked")}</span>
      <button class="link-btn" onClick={() => void explainLocked(props.feature)}>
        {t("lic.check")}
      </button>
    </div>
  );
}

function openTab(tab: RibbonTab): void {
  if (!tab.open) return;
  if (tab.license) requireFeature(tab.license, tab.open);
  else tab.open();
}

/** Ribbon: tabs of the internal workbenches and plugins (registry plugins/tabs.ts), body of the displayed workbench. */
export function Ribbon() {
  /** Displayed workbench locked by the licence (view only), otherwise undefined. */
  const locked = (): Feature | undefined => {
    const need = documentTab()?.needs?.();
    return need && !hasFeature(need) ? need : undefined;
  };

  // Contextual workbenches (sketch…) have their tools and their exit in the ribbon: it stays open for them.
  const collapsed = () => panels.top.collapsed() && !visibleTabs().some((tab) => tab.contextual);

  return (
    <section class="ribbon" {...panels.top.hover}>
      <div class="ribbon-tabs" role="tablist">
        <For each={visibleTabs()}>
          {(tab) =>
            tab.contextual ? (
              <button role="tab" class="active contextual">
                {tab.label()}
              </button>
            ) : (
              <button role="tab" classList={{ active: tab.active() }} disabled={tab.disabled?.()} title={tab.title?.()} onClick={() => openTab(tab)}>
                {tab.label()}
              </button>
            )
          }
        </For>
      </div>
      <PanelToggle id="top" />
      <div class="ribbon-content" classList={{ collapsed: collapsed() }}>
        <Show when={!locked()} fallback={<LockedRibbon feature={locked()!} />}>
          <Show when={bodyTab()} keyed>
            {(tab) => tab.body!()}
          </Show>
        </Show>
      </div>
      <HoverPreview />
    </section>
  );
}
