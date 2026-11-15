import { defineExtension } from "@solidus-cad/sdk";
import { contribute, moduleOverlayOn, registerContextCloser } from "@app/host.ts";
import { t } from "./texts.ts";
import { closeMeasure, measure } from "@app/measure.ts";
import { closeModuleOverlays } from "@app/host.ts";
import { setPluginTabId, tabRegistry } from "@app/plugins/tabs.ts";
import { editingSketch } from "@app/store.ts";
import { activeKind, ws } from "@app/workspace.ts";
import { MotionPanel } from "./ui/MotionPanel.tsx";
import { MotionRibbon } from "./ui/MotionRibbon.tsx";
import { finishMotion, startMotion } from "./ui/session.ts";
import { Timeline } from "./ui/Timeline.tsx";
import { VideoDialog } from "./ui/VideoDialog.tsx";

/**
 * Solidus Motion module: motion studies on an assembly (tracks, keys, playback, collisions) and video export.
 * Plugged into the application through the extension points of `@app/host.ts`; paid feature "motion".
 */

const overlayOn = () => measure.on || moduleOverlayOn();

export default defineExtension({
  id: "pro.solidus.motion",
  activate(ctx) {
    // Usage right requested from the application's license provider, never from a server.
    const withMotion = (run: () => void) => ctx.license.require({ feature: "motion" }, run);

    tabRegistry.add({
      id: "motion",
      label: () => t("bench.motion"),
      order: 23,
      module: "motion",
      active: () => activeKind() === "assembly" && !!ws.motion && !overlayOn(),
      disabled: () => !!editingSketch() || !!ws.sketch3d || !!ws.frame || !!ws.camReturn,
      open: () =>
        withMotion(() => {
          closeMeasure();
          closeModuleOverlays();
          setPluginTabId(null);
          startMotion();
        }),
      body: () => <MotionRibbon />,
      owns: () => activeKind() === "assembly" && !!ws.motion,
      priority: 19,
      needs: () => "motion",
    });

    contribute("leftPanels", {
      id: "motion.panel",
      when: () => activeKind() === "assembly" && !!ws.asm && !ws.sketch3d && !ws.frame && !ws.machineDraft && !ws.fixtureDraft && !!ws.motion,
      component: MotionPanel,
    });
    contribute("centerFooters", { id: "motion.timeline", when: () => activeKind() === "assembly" && !!ws.motion, component: Timeline });
    contribute("classes", { id: "motion.with-timeline", target: "center", name: "with-timeline", when: () => activeKind() === "assembly" && !!ws.motion });
    contribute("dialogs", { id: "motion.video", component: VideoDialog });

    // Back to the Assembly workbench: the displayed study is finished.
    registerContextCloser(finishMotion);
  },
});
