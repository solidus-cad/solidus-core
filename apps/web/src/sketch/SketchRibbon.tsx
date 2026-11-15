import { For } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import { confirmEdit } from "../store.ts";
import { previewUrl } from "../components/HoverPreview.tsx";
import { shortcutTitle } from "../keymap/keymap.ts";
import { registerActions, type ShortcutAction } from "../keymap/registry.ts";
import {
  constrain,
  deleteSelection,
  dimensionSelection,
  finishSpline,
  mirrorSelection,
  setSession,
  session,
  setTool,
  sketchRedo,
  sketchUndo,
  toggleConstruction,
  type ConstraintCommand,
  type DimensionTool,
  type Tool,
} from "./session.ts";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const glyph = (text: string) =>
  `<svg viewBox="0 0 24 24"><text x="12" y="17" text-anchor="middle" font-size="15" font-weight="600" fill="currentColor" font-family="system-ui">${text}</text></svg>`;

interface Btn {
  label: TKey;
  icon: string;
  run: () => void;
  active?: () => boolean;
  /** Action of the shortcut registry (shown in the tooltip). */
  action?: string;
}

const tool = (tl: Tool, label: TKey, icon: string): Btn => ({ label, icon, run: () => setTool(tl), active: () => session.tool === tl, action: `sketch.${tl}` });
const dim = (k: DimensionTool, label: TKey, icon: string, action: string): Btn => ({
  label,
  icon,
  run: () => dimensionSelection(k ?? undefined),
  active: () => session.tool === "dimension" && session.dimKind === k,
  action,
});
const cons = (c: ConstraintCommand, label: TKey, text: string): Btn => ({
  label,
  icon: glyph(text),
  run: () => constrain(c),
  active: () => session.tool === "constraint" && session.constraintCmd === c,
  action: `sketch.c.${c}`,
});

/**
 * `stacked`: small buttons spread over 3 rows to shorten the ribbon.
 * Group without a label: attached to the next group (same visual block).
 */
export const SKETCH_GROUPS: { label?: TKey; buttons: Btn[]; stacked?: boolean }[] = [
  {
    label: "sk.g.draw",
    stacked: true,
    buttons: [
      tool("select", "sk.select", svg('<path d="M6 3l12 9-6 1-3 6z"/>')),
      tool("line", "sk.line", svg('<path d="M4 20 20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>')),
      tool("rect", "sk.rect", svg('<rect x="4" y="6" width="16" height="12"/>')),
      tool("rectCenter", "sk.rectCenter", svg('<rect x="4" y="6" width="16" height="12"/><path d="M4 6l16 12" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="1.4"/>')),
      tool("circle", "sk.circle", svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.2"/>')),
      tool("arc", "sk.arc", svg('<path d="M5 17a8 8 0 0 1 14 0"/><circle cx="12" cy="17" r="1.2"/>')),
      tool("spline", "sk.spline", svg('<path d="M3 18c4-12 8 4 12-6s5-6 6-6"/><circle cx="3" cy="18" r="1.4"/><circle cx="21" cy="6" r="1.4"/>')),
      tool("point", "sk.point", svg('<circle cx="12" cy="12" r="2.5"/>')),
      tool("text", "sk.text", svg('<path d="M5 6h14M12 6v13M9 19h6"/>')),
      { label: "sk.construction", icon: svg('<path d="M4 20 20 4" stroke-dasharray="3 2.5"/>'), run: toggleConstruction, active: () => session.construction, action: "sketch.construction" },
    ],
  },
  {
    label: "sk.g.constraints",
    stacked: true,
    buttons: [
      cons("coincident", "sk.c.coincident", "⊙"),
      cons("horizontal", "sk.c.horizontal", "H"),
      cons("vertical", "sk.c.vertical", "V"),
      cons("parallel", "sk.c.parallel", "∥"),
      cons("perpendicular", "sk.c.perpendicular", "⊥"),
      cons("tangent", "sk.c.tangent", "T"),
      cons("equal", "sk.c.equal", "="),
      cons("concentric", "sk.c.concentric", "◎"),
      cons("midpoint", "sk.c.midpoint", "M"),
      cons("symmetric", "sk.c.symmetric", "⇋"),
      cons("fix", "sk.c.fix", "⚓"),
    ],
  },
  {
    buttons: [dim(null, "sk.smartDim", svg('<path d="M4 8v8M20 8v8M4 12h16"/><path d="m7 10-3 2 3 2M17 10l3 2-3 2"/>'), "sketch.dim")],
  },
  {
    label: "sk.g.dimensions",
    stacked: true,
    buttons: [
      dim("horizontalDistance", "sk.dimH", glyph("↔"), "sketch.dimH"),
      dim("verticalDistance", "sk.dimV", glyph("↕"), "sketch.dimV"),
      dim("angle", "sk.dimAngle", svg('<path d="M4 19h16M4 19 16 6"/><path d="M12 19a8 8 0 0 0-2.6-5.9"/>'), "sketch.dimAngle"),
    ],
  },
  {
    label: "sk.g.tools",
    stacked: true,
    buttons: [
      tool("project", "sk.project", svg('<path d="M4 18h16"/><path d="M8 6h8l3 4H5z" stroke-dasharray="2 1.5"/><path d="M12 10v7M10 15l2 2 2-2"/>')),
      tool("trim", "sk.trim", svg('<path d="M4 12h16M12 4v16" /><path d="M14 6l4 4M18 6l-4 4" stroke="#c43c3c"/>')),
      tool("fillet", "sk.fillet", svg('<path d="M5 20V12a7 7 0 0 1 7-7h7"/><path d="M5 5h4M5 5v4" stroke-dasharray="1.5 2"/>')),
      { label: "sk.offset2", icon: svg('<rect x="7" y="7" width="10" height="10"/><rect x="3" y="3" width="18" height="18" stroke-dasharray="2.5 2"/>'), run: () => setSession("offsetOpen", true), action: "sketch.offset" },
      { label: "sk.mirror", icon: svg('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7 4 17h5zM15 7l5 10h-5z"/>'), run: mirrorSelection, action: "sketch.mirror" },
      { label: "tree.delete", icon: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'), run: deleteSelection, action: "sketch.delete" },
    ],
  },
  {
    label: "sk.g.exit",
    buttons: [{ label: "sk.finish", icon: svg('<path d="m5 12 5 5 9-10"/>'), run: confirmEdit, action: "global.confirm" }],
  },
];

/**
 * CAD profile shortcuts specific to the sketch. Select, line, rectangle, circle, arc, dimension,
 * delete, undo and redo follow the shared actions (keymap/common.ts).
 */
const SKETCH_DEFAULTS: Record<string, string[]> = {
  "sketch.project": ["P"],
  "sketch.trim": ["T"],
};

/** Registry actions derived from the buttons (declared once). */
const SKETCH_ACTIONS: ShortcutAction[] = SKETCH_GROUPS.flatMap((g) =>
  g.buttons
    .filter((b) => b.action?.startsWith("sketch.")) // "Finish" reuses global.confirm (Enter), already registered
    .map((b) => ({
      id: b.action!,
      scope: "sketch" as const,
      label: () => t(b.label),
      icon: b.icon,
      defaults: SKETCH_DEFAULTS[b.action!] ?? [],
      run: b.run,
    })),
);

registerActions([
  ...SKETCH_ACTIONS,
  // Undo/redo: menu bar buttons (MenuBar), which follow the active workbench.
  { id: "sketch.undo", scope: "sketch", label: () => t("cmd.undo"), defaults: [], run: sketchUndo, enabled: () => session.canUndo },
  { id: "sketch.redo", scope: "sketch", label: () => t("cmd.redo"), defaults: [], run: sketchRedo, enabled: () => session.canRedo },
  {
    id: "sketch.cancel",
    scope: "sketch",
    label: () => t("key.cancelSketch"),
    defaults: ["Escape"],
    locked: true,
    run: () => {
      // A spline being drawn is ended (kept), any other pending drawing is cancelled.
      if (finishSpline()) return;
      if (session.pending) setSession("pending", null);
      else if (session.tool !== "select") setTool("select");
      else setSession("selection", []);
    },
  },
]);

export function SketchRibbon() {
  return (
    <div class="ribbon-body">
      <For each={SKETCH_GROUPS}>
        {(g) => (
          <div class="ribbon-group" classList={{ joined: !g.label }}>
            <div class="ribbon-buttons" classList={{ stacked: !!g.stacked, compact: !g.stacked && g.buttons.length > 6 }}>
              <For each={g.buttons}>
                {(b) => (
                  <button
                    class="ribbon-btn"
                    classList={{ pressed: b.active?.() ?? false }}
                    aria-pressed={b.active ? b.active() : undefined}
                    // With a video preview, the native tooltip would duplicate it (the shortcut remains in the label).
                    title={b.action && previewUrl(b.action) ? undefined : shortcutTitle(t(b.label), b.action)}
                    data-preview={b.action ? previewUrl(b.action) : undefined}
                    data-preview-label={shortcutTitle(t(b.label), b.action)}
                    data-action={b.action}
                    onClick={b.run}
                  >
                    <span class="icon" innerHTML={b.icon} />
                    <span>{t(b.label)}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="ribbon-group-label">{g.label ? t(g.label) : "\u00a0"}</div>
          </div>
        )}
      </For>
    </div>
  );
}
