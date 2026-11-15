import { createSignal, type JSX } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import { draggedDoc } from "../workspace.ts";

export type PanelMode = "open" | "auto" | "closed";

/** Time after the pointer leaves a panel in automatic mode before it retracts. */
const AUTO_DELAY_MS = 3000;

const MODES: PanelMode[] = ["open", "auto", "closed"];
const LABELS: Record<PanelMode, TKey> = { open: "panel.open", auto: "panel.auto", closed: "panel.closed" };

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
/** Pin, clock and crossed-out eye: the icon always shows the current mode. */
const ICONS: Record<PanelMode, string> = {
  open: icon('<path d="M9 3h6l-1 7 3 4H7l3-4z"/><path d="M12 14v7"/>'),
  auto: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  closed: icon('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/><path d="M4 4l16 16"/>'),
};

export interface Panel {
  mode: () => PanelMode;
  /** Mode and retraction combined; callers add their own reasons to stay open. */
  collapsed: () => boolean;
  cycle: () => void;
  /** To spread on the panel and on anything else that must keep it open. */
  hover: Pick<JSX.HTMLAttributes<HTMLElement>, "onPointerEnter" | "onPointerLeave">;
}

function createPanel(id: string, selector: string): Panel {
  const key = `cad.panel.${id}`;
  const read = (): PanelMode => {
    try {
      const v = localStorage.getItem(key);
      return v === "auto" || v === "closed" ? v : "open";
    } catch {
      return "open";
    }
  };
  const write = (m: PanelMode) => {
    try {
      if (m === "open") localStorage.removeItem(key);
      else localStorage.setItem(key, m);
    } catch {
      /* storage unavailable */
    }
  };

  const [mode, setMode] = createSignal(read());
  const [retracted, setRetracted] = createSignal(false);
  let timer: number | undefined;
  let hovering = false;
  // Never retract under a field being typed in or a document being dragged from the panel.
  const busy = () => {
    const el = document.activeElement;
    return hovering || !!draggedDoc() || (!!el?.matches("input, textarea, select") && !!el.closest(selector));
  };
  const arm = () => {
    window.clearTimeout(timer);
    if (mode() !== "auto") return;
    timer = window.setTimeout(() => (busy() ? arm() : setRetracted(true)), AUTO_DELAY_MS);
  };
  arm();

  return {
    mode,
    collapsed: () => mode() === "closed" || (mode() === "auto" && retracted()),
    cycle: () => {
      const next = MODES[(MODES.indexOf(mode()) + 1) % MODES.length]!;
      setMode(next);
      write(next);
      setRetracted(false);
      arm();
    },
    hover: {
      onPointerEnter: () => {
        hovering = true;
        window.clearTimeout(timer);
        setRetracted(false);
      },
      onPointerLeave: () => {
        hovering = false;
        arm();
      },
    },
  };
}

export const panels = {
  left: createPanel("left", ".side.left"),
  right: createPanel("right", ".side.right"),
  top: createPanel("top", ".ribbon"),
};

/** Three-state switch of a panel. */
export function PanelToggle(props: { id: keyof typeof panels }) {
  const panel = panels[props.id];
  const next = () => MODES[(MODES.indexOf(panel.mode()) + 1) % MODES.length]!;
  const label = () => `${t(LABELS[panel.mode()])} → ${t(LABELS[next()])}`;
  return (
    <button
      class={`panel-toggle ${props.id}`}
      data-mode={panel.mode()}
      title={label()}
      aria-label={label()}
      innerHTML={ICONS[panel.mode()]}
      onClick={panel.cycle}
      {...panel.hover}
    />
  );
}
