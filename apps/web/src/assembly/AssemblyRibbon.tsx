import { For, Show } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import { canPasteComponents, checkInterferences, copySelection, copyToClipboard, cutToClipboard, pasteFromClipboard, deleteSelection, groupSelection, insertSkeleton, mateTypeAllowed, pickComponent, redoAsm, setGizmo, setWs, startMate, undoAsm, updateComponent, ws } from "../workspace.ts";
import { startSketch3D } from "../sketch3d/session.ts";
import type { MateType } from "@solidus-cad/sdk";
import { hasModuleAction, runModuleAction } from "../host.ts";
import { asmPlanes, beginAsmPlane } from "./planes.ts";
import { planeFeature } from "@solidus-cad/bench-part";
import { shortcutTitle } from "../keymap/keymap.ts";
import { previewUrl } from "../components/HoverPreview.tsx";
import { registerActions, type ShortcutAction } from "../keymap/registry.ts";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

interface Btn {
  label: TKey;
  icon: string;
  run: () => void;
  active?: () => boolean;
  needsSelection?: boolean;
  enabled?: () => boolean;
  /** Button shown only when true (feature provided by a module). */
  visible?: () => boolean;
  /** Action from the shortcut registry (shown in the tooltip). */
  action?: string;
}

const toggleFixed = () => {
  const sel = ws.asm?.components.filter((c) => ws.selection.includes(c.id)) ?? [];
  const fix = !sel.every((c) => c.fixed);
  for (const c of sel) updateComponent(c.id, { fixed: fix });
};

/** Group without a label: attached to the next group (same visual block). */
const GROUPS: { label?: TKey; buttons: Btn[]; stacked?: boolean }[] = [
  {
    stacked: true,
    buttons: [
      { label: "asm.insert", icon: svg('<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M12 8v8M8 12h8"/>'), run: () => setWs("insertOpen", true), action: "assembly.insert" },
      {
        label: "lib.partsShort",
        icon: svg('<path d="M7 3h10l2 3.5-2 3.5H7L5 6.5z"/><path d="M9 10v11M15 10v11M9 13l6 1.5M9 16.5l6 1.5M9 20l6 1"/>'),
        run: () => runModuleAction("library.parts"),
        action: "assembly.partCatalog",
        visible: () => hasModuleAction("library.parts"),
      },
    ],
  },
  {
    label: "asm.g.components",
    stacked: true,
    buttons: [
      { label: "asm.duplicate", icon: svg('<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>'), run: copySelection, needsSelection: true, action: "assembly.copy" },
      { label: "tree.delete", icon: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'), run: deleteSelection, needsSelection: true, action: "assembly.delete" },
      { label: "asm.groupSel", icon: svg('<path d="M3 7h6l2 2h10v10H3z"/>'), run: groupSelection, needsSelection: true, action: "assembly.group" },
    ],
  },
  {
    label: "asm.g.position",
    stacked: true,
    buttons: [
      { label: "asm.move", icon: svg('<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'), run: () => setGizmo("translate"), active: () => ws.gizmo === "translate", action: "assembly.move" },
      { label: "asm.rotate", icon: svg('<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/>'), run: () => setGizmo("rotate"), active: () => ws.gizmo === "rotate", action: "assembly.rotate" },
      { label: "asm.fix", icon: svg('<path d="M12 21v-7M8 3h8l-1 5 3 3H6l3-3z"/>'), run: toggleFixed, needsSelection: true, action: "assembly.fix" },
    ],
  },
  {
    label: "datum.group",
    buttons: [{ label: "datum.new", icon: planeFeature.icon, run: beginAsmPlane, active: () => !!asmPlanes.edit, action: "assembly.datum" }],
  },
  {
    label: "asm.g.mates",
    stacked: true,
    buttons: (
      [
        ["coincident", "mate.coincident", '<path d="M3 14h18M3 10h18"/><path d="M8 6v4M16 18v-4"/>'],
        ["concentric", "mate.concentric", '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>'],
        ["distance", "mate.distance", '<path d="M4 6h16M4 18h16M12 7v10"/><path d="m10 9 2-2 2 2M10 15l2 2 2-2"/>'],
        ["angle", "mate.angle", '<path d="M4 20h16M4 20 16 6"/><path d="M10 20a6 6 0 0 0-2-4.5"/>'],
        ["parallel", "mate.parallel", '<path d="M7 4 4 20M15 4l-3 16"/>'],
        ["perpendicular", "mate.perpendicular", '<path d="M4 20h16M12 20V4"/>'],
        ["gear", "mate.gear", '<circle cx="8" cy="12" r="4"/><circle cx="17" cy="12" r="3"/><path d="M8 6v-1M8 19v-1M2 12h1M13 9l2-1M13 15l2 1"/>'],
        ["belt", "mate.belt", '<circle cx="7" cy="12" r="3.5"/><circle cx="18" cy="12" r="2.5"/><path d="M7 8.5 18 9.5M7 15.5 18 14.5"/>'],
        ["rackpinion", "mate.rackpinion", '<circle cx="12" cy="8" r="4"/><path d="M3 16h18v3H3zM5 16v-1.5h2V16M9 16v-1.5h2V16M13 16v-1.5h2V16M17 16v-1.5h2V16"/>'],
      ] as [MateType, TKey, string][]
    ).map(([type, label, icon]) => ({
      label,
      icon: svg(icon),
      run: () => startMate(type),
      active: () => ws.mateDraft?.type === type,
      enabled: () => mateTypeAllowed(type),
      action: `assembly.mate.${type}`,
    })),
  },
  {
    label: "asm.g.skeleton",
    stacked: true,
    buttons: [
      {
        label: "s3d.new",
        icon: svg('<path d="M4 18 10 8l5 6 5-9"/><path d="M4 18h6M4 18v-6" stroke-dasharray="1.5 1.5"/><circle cx="10" cy="8" r="1.3" fill="currentColor"/><circle cx="15" cy="14" r="1.3" fill="currentColor"/>'),
        run: () => startSketch3D(),
        action: "assembly.sketch3d",
      },
      {
        label: "frm.new",
        icon: svg('<path d="M4 20V8h16v12"/><path d="M4 8l3-4h10l3 4" /><path d="M8 20V12h8v8" stroke-dasharray="1.5 1.5"/>'),
        run: () => runModuleAction("frame.start"),
        action: "assembly.frame",
        visible: () => hasModuleAction("frame.start"),
      },
      { label: "asm.newSkeleton", icon: svg('<path d="M4 7h16M4 12h16M4 17h16M8 4v16M16 4v16" stroke-dasharray="2 1.5"/>'), run: () => void insertSkeleton(), action: "assembly.skeleton" },
    ],
  },
  {
    label: "asm.g.document",
    stacked: true,
    buttons: [
      { label: "interf.check", icon: svg('<rect x="3" y="7" width="11" height="11"/><rect x="10" y="3" width="11" height="11"/><path d="M10 7h4v7h-4z" fill="currentColor" opacity=".35"/>'), run: () => void checkInterferences(), action: "assembly.interferences" },
      { label: "asm.bom", icon: svg('<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 8h8M8 12h8M8 16h5"/>'), run: () => setWs("bomOpen", true), action: "assembly.bom" },
      { label: "proj.pub.short", icon: svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>'), run: () => runModuleAction("project.publish"), visible: () => hasModuleAction("project.publish") },
    ],
  },
];

/** Text selected in the page (panel, dialog): Ctrl+C / Ctrl+X are left to the browser. */
const textSelected = (): boolean => !!window.getSelection()?.toString();

/** CAD profile shortcuts for assembly actions. */
const ASM_DEFAULTS: Record<string, string[]> = {
  "assembly.move": ["M"],
  "assembly.rotate": ["R"],
};

/** Registry actions derived from the buttons (declared once). */
const ASM_ACTIONS: ShortcutAction[] = GROUPS.flatMap((g) =>
  g.buttons
    .filter((b) => b.action)
    .map((b) => ({
      id: b.action!,
      scope: "assembly" as const,
      label: () => t(b.label),
      icon: b.icon,
      defaults: ASM_DEFAULTS[b.action!] ?? [],
      run: b.run,
      enabled: b.enabled,
    })),
);

registerActions([
  ...ASM_ACTIONS,
  { id: "assembly.undo", scope: "assembly", label: () => t("cmd.undo"), defaults: [], run: () => undoAsm(), enabled: () => ws.canUndo },
  { id: "assembly.redo", scope: "assembly", label: () => t("cmd.redo"), defaults: [], run: () => redoAsm(), enabled: () => ws.canRedo },
  // Clipboard: inactive while text is selected in the interface (the browser copy keeps working).
  { id: "assembly.clipCopy", scope: "assembly", label: () => t("asm.clipCopy"), defaults: ["Ctrl+C"], run: copyToClipboard, enabled: () => ws.selection.length > 0 && !textSelected() },
  { id: "assembly.cut", scope: "assembly", label: () => t("asm.cut"), defaults: ["Ctrl+X"], run: cutToClipboard, enabled: () => ws.selection.length > 0 && !textSelected() },
  { id: "assembly.paste", scope: "assembly", label: () => t("asm.paste"), defaults: ["Ctrl+V"], run: () => void pasteFromClipboard(), enabled: canPasteComponents },
  { id: "assembly.cancel", scope: "assembly", label: () => t("key.cancelAsm"), defaults: ["Escape"], locked: true, run: () => pickComponent(null, false) },
]);

export function AssemblyRibbon() {
  return (
    <div class="ribbon-body">
      <For each={GROUPS}>
        {(g) => (
          <div class="ribbon-group" classList={{ joined: !g.label }}>
            <div class="ribbon-buttons" classList={{ stacked: !!g.stacked, compact: !g.stacked && g.buttons.length > 6 }}>
              <For each={g.buttons}>
                {(b) => {
                  const preview = b.action ? previewUrl(b.action) : undefined;
                  return (
                    <Show when={b.visible?.() ?? true}>
                      <button
                        class="ribbon-btn"
                        classList={{ pressed: b.active?.() ?? false }}
                        disabled={(b.needsSelection && ws.selection.length === 0) || !(b.enabled?.() ?? true)}
                        // With a video preview, the native tooltip would duplicate it (the shortcut stays in the label).
                        title={preview ? undefined : shortcutTitle(t(b.label), b.action)}
                        data-preview={preview}
                        data-preview-label={preview ? shortcutTitle(t(b.label), b.action) : undefined}
                        onClick={b.run}
                      >
                        <span class="icon" innerHTML={b.icon} />
                        <span>{t(b.label)}</span>
                      </button>
                    </Show>
                  );
                }}
              </For>
            </div>
            <div class="ribbon-group-label">{g.label ? t(g.label) : "\u00a0"}</div>
          </div>
        )}
      </For>
    </div>
  );
}
