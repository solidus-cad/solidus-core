import { For } from "solid-js";
import { gt, type GKey } from "./i18n.ts";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

export const GEAR_ICONS = {
  spur: svg('<circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.8"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'),
  rack: svg('<path d="M3 15h18v4H3z"/><path d="M4 15v-3h2v3M8 15v-3h2v3M12 15v-3h2v3M16 15v-3h2v3"/>'),
  bevel: svg('<path d="M4 9l8-4 8 4v6l-8 4-8-4z"/><path d="M12 5v14M4 9l8 4 8-4" stroke-dasharray="2 1.5"/>'),
};

interface Btn {
  label: GKey;
  title: GKey;
  icon: string;
  run: () => void;
  /** Video preview on hover (it then replaces the native tooltip). */
  preview?: string;
}

/** Body of the Gears tab ribbon: one button per gear type. */
export function GearsRibbon(props: { buttons: Btn[] }) {
  return (
    <div class="ribbon-body">
      <div class="ribbon-group">
        <div class="ribbon-buttons">
          <For each={props.buttons}>
            {(b) => (
              <button class="ribbon-btn" title={b.preview ? undefined : gt(b.title)} data-preview={b.preview} data-preview-label={gt(b.label)} onClick={b.run}>
                <span class="icon" innerHTML={b.icon} />
                <span>{gt(b.label)}</span>
              </button>
            )}
          </For>
        </div>
        <div class="ribbon-group-label">{gt("g.gears")}</div>
      </div>
    </div>
  );
}
