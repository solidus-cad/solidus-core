import { For } from "solid-js";
import { t, type TKey } from "../texts.ts";
import { previewUrl } from "@app/components/HoverPreview.tsx";
import { shortcutTitle } from "@app/keymap/keymap.ts";
import { registerActions, type ShortcutAction } from "@app/keymap/registry.ts";
import { trackKindsFor } from "./engine.ts";
import { ws } from "@app/workspace.ts";
import {
  addCameraKey,
  addKey,
  addTrack,
  clearCamera,
  deleteSelectedKey,
  deleteStudy,
  finishMotion,
  ms,
  newStudy,
  rewind,
  setMs,
  setStudy,
  stepFrame,
  study,
  toggleLoop,
  togglePlay,
} from "./session.ts";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

interface Btn {
  label: TKey | (() => TKey);
  icon: string;
  run: () => void;
  active?: () => boolean;
  enabled?: () => boolean;
  action?: string;
}

const selectedMate = () => ws.asm?.mates.find((m) => m.id === ms.mate);
const canDrive = (kind: "linear" | "rotary") => () => {
  const m = selectedMate();
  return !!m && trackKindsFor(m).includes(kind) && !study()?.tracks.some((x) => x.mate === m.id && x.kind === kind);
};

/** Key on the selected track (camera: current viewpoint). */
const keyHere = () => {
  if (ms.track === "camera") addCameraKey();
  else if (ms.track) addKey(ms.track);
};

const GROUPS: { label: TKey; buttons: Btn[]; stacked?: boolean }[] = [
  {
    label: "mot.g.study",
    stacked: true,
    buttons: [
      { label: "mot.newStudy", icon: svg('<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M12 9v6M9 12h6"/>'), run: newStudy, action: "motion.newStudy" },
      { label: "mot.deleteStudy", icon: svg('<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M9 12h6"/>'), run: deleteStudy, enabled: () => (ws.asm?.motion?.length ?? 0) > 1, action: "motion.deleteStudy" },
      { label: "mot.close", icon: svg('<path d="M6 6l12 12M18 6 6 18"/>'), run: finishMotion, action: "motion.close" },
    ],
  },
  {
    label: "mot.g.drivers",
    stacked: true,
    buttons: [
      {
        label: "mot.rotary",
        icon: svg('<circle cx="12" cy="12" r="3"/><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v4h-4"/>'),
        run: () => addTrack("rotary"),
        enabled: canDrive("rotary"),
        action: "motion.rotary",
      },
      {
        label: "mot.linear",
        icon: svg('<path d="M3 12h18"/><path d="m17 8 4 4-4 4"/><rect x="6" y="9" width="6" height="6" rx="1"/>'),
        run: () => addTrack("linear"),
        enabled: canDrive("linear"),
        action: "motion.linear",
      },
    ],
  },
  {
    label: "mot.g.keys",
    stacked: true,
    buttons: [
      { label: "mot.addKey", icon: svg('<path d="m12 4 6 8-6 8-6-8z"/>'), run: keyHere, enabled: () => !!ms.track, action: "motion.key" },
      { label: "mot.deleteKey", icon: svg('<path d="m12 4 6 8-6 8-6-8z"/><path d="M9 12h6"/>'), run: deleteSelectedKey, enabled: () => !!ms.track && ms.key !== null, action: "motion.deleteKey" },
    ],
  },
  {
    label: "mot.g.playback",
    stacked: true,
    buttons: [
      { label: "mot.rewind", icon: svg('<path d="M6 5v14"/><path d="M18 5 9 12l9 7z"/>'), run: rewind, action: "motion.rewind" },
      {
        label: () => (ms.playing ? "mot.pause" : "mot.play"),
        icon: svg('<path d="M7 5v14l11-7z"/>'),
        run: togglePlay,
        active: () => ms.playing,
        action: "motion.play",
      },
      { label: "mot.loop", icon: svg('<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>'), run: toggleLoop, active: () => !!study()?.loop, action: "motion.loop" },
    ],
  },
  {
    label: "mot.g.camera",
    stacked: true,
    buttons: [
      { label: "mot.cameraKey", icon: svg('<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'), run: addCameraKey, action: "motion.cameraKey" },
      { label: "mot.freeCamera", icon: svg('<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><path d="m4 4 16 16"/>'), run: clearCamera, enabled: () => (study()?.camera?.length ?? 0) > 0, action: "motion.freeCamera" },
    ],
  },
  {
    label: "mot.g.analysis",
    stacked: true,
    buttons: [
      {
        label: "mot.collisions",
        icon: svg('<rect x="3" y="7" width="11" height="11"/><rect x="10" y="3" width="11" height="11"/><path d="M10 7h4v7h-4z" fill="currentColor" opacity=".35"/>'),
        run: () => {
          const s = study();
          if (s) setStudy({ collisions: { enabled: !s.collisions?.enabled, step: s.collisions?.step ?? 5 } });
        },
        active: () => !!study()?.collisions?.enabled,
        action: "motion.collisions",
      },
      {
        label: "mot.video",
        icon: svg('<rect x="3" y="6" width="13" height="12" rx="1"/><path d="m16 10 5-3v10l-5-3z"/>'),
        run: () => setMs("videoOpen", true),
        enabled: () => !ms.baking && ms.exporting === null,
        action: "motion.video",
      },
    ],
  },
];

const label = (b: Btn): TKey => (typeof b.label === "function" ? b.label() : b.label);

/** CAD profile shortcuts for the Motion workbench. */
const DEFAULTS: Record<string, string[]> = {
  "motion.play": ["Space"],
  "motion.rewind": ["Home"],
  "motion.key": ["K"],
  "motion.loop": ["L"],
  "motion.deleteKey": ["Delete"],
};

registerActions([
  ...GROUPS.flatMap((g) =>
    g.buttons
      .filter((b) => b.action)
      .map(
        (b): ShortcutAction => ({
          id: b.action!,
          scope: "motion",
          label: () => t(label(b)),
          icon: b.icon,
          defaults: DEFAULTS[b.action!] ?? [],
          run: b.run,
          enabled: b.enabled,
        }),
      ),
  ),
  { id: "motion.prevFrame", scope: "motion", label: () => t("mot.prevFrame"), defaults: ["ArrowLeft"], run: () => stepFrame(-1) },
  { id: "motion.nextFrame", scope: "motion", label: () => t("mot.nextFrame"), defaults: ["ArrowRight"], run: () => stepFrame(1) },
]);

export function MotionRibbon() {
  return (
    <div class="ribbon-body">
      <For each={GROUPS}>
        {(g) => (
          <div class="ribbon-group">
            <div class="ribbon-buttons" classList={{ stacked: !!g.stacked }}>
              <For each={g.buttons}>
                {(b) => (
                  <button
                    class="ribbon-btn"
                    classList={{ pressed: b.active?.() ?? false }}
                    disabled={!(b.enabled?.() ?? true)}
                    // With a video preview, the native tooltip would duplicate it.
                    title={b.action && previewUrl(b.action) ? undefined : shortcutTitle(t(label(b)), b.action)}
                    data-preview={b.action ? previewUrl(b.action) : undefined}
                    data-preview-label={shortcutTitle(t(label(b)), b.action)}
                    onClick={b.run}
                  >
                    <span class="icon" innerHTML={b.icon} />
                    <span>{t(label(b))}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="ribbon-group-label">{t(g.label)}</div>
          </div>
        )}
      </For>
    </div>
  );
}
