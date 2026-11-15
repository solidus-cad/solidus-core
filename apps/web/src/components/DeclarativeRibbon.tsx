import { For, Show } from "solid-js";
import type { I18nText } from "@solidus-cad/sdk";
import { commandById, runCommand } from "../commands.ts";
import { tx } from "../i18n.ts";
import { shortcutTitle } from "../keymap/keymap.ts";
import { previewUrl } from "./HoverPreview.tsx";

/** Ribbon command group described by a workbench or a plugin (identifiers of registered commands). */
export interface RibbonGroup {
  label?: I18nText;
  /** Label and icon: those of the registered command if omitted. */
  commands: { id: string; label?: I18nText; icon?: string }[];
  /** Small buttons spread over 3 rows. */
  stacked?: boolean;
}

/** Declarative ribbon body: groups of command buttons. */
export function DeclarativeRibbon(props: { groups: RibbonGroup[] }) {
  return (
    <div class="ribbon-body">
      <For each={props.groups}>
        {(group) => (
          <div class="ribbon-group">
            <div class="ribbon-buttons" classList={{ stacked: !!group.stacked }}>
              <For each={group.commands}>
                {(c) => {
                  const cmd = () => commandById.get(c.id);
                  const preview = previewUrl(c.id);
                  const label = () => (c.label ? tx(c.label) : (cmd()?.label() ?? c.id));
                  // Shortcut as configured by the user (follows its changes).
                  const title = () => shortcutTitle(label(), c.id);
                  return (
                    <button
                      class="ribbon-btn"
                      disabled={!(cmd()?.enabled?.() ?? !!cmd())}
                      onClick={() => runCommand(c.id)}
                      // With a video preview, the native tooltip would duplicate it (the shortcut stays in the label).
                      title={preview ? undefined : title()}
                      data-preview={preview}
                      data-cmd={c.id}
                      data-preview-label={title()}
                    >
                      <span class="icon" innerHTML={c.icon ?? cmd()?.icon ?? ""} />
                      <span>{label()}</span>
                    </button>
                  );
                }}
              </For>
            </div>
            <Show when={group.label}>
              <div class="ribbon-group-label">{tx(group.label!)}</div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
