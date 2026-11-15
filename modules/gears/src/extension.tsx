import { createComponent } from "solid-js";
import { defineExtension } from "@solidus-cad/sdk";
import { previewUrl } from "@app/components/HoverPreview.tsx";
import { pluginTab } from "@app/plugins/builtin.tsx";
import { pluginFeatureTypes } from "@app/plugins/features.ts";
import { tabRegistry } from "@app/plugins/tabs.ts";
import { beginFeature } from "@app/store.ts";
import { GEAR_ICONS, GearsRibbon } from "./ui/GearsRibbon.tsx";
import { BEVEL, BEVEL_DEF, buildBevel, buildRack, buildSpur, PLUGIN_ID, RACK, RACK_DEF, SPUR, SPUR_DEF } from "./ui/features.ts";
import { gt } from "./ui/i18n.ts";

/**
 * Gears module (free, no license): parametric features (straight or helical spur gear, rack,
 * simplified bevel gear) created on the fly from a tab of the Part workbench ribbon. The features go through the plugin
 * feature registry: property panel with preview, re-editing and a geometric recipe interpreted by the kernel.
 */
export default defineExtension({
  id: PLUGIN_ID,
  activate() {
    const version = "0.1.0";
    for (const [def, build] of [
      [SPUR_DEF, buildSpur],
      [RACK_DEF, buildRack],
      [BEVEL_DEF, buildBevel],
    ] as const)
      pluginFeatureTypes.add({ id: def.type, pluginId: PLUGIN_ID, version, definition: def, build: async (values) => build(values) });

    const buttons = [
      { label: "spur", title: "spurHint", icon: GEAR_ICONS.spur, preview: previewUrl("gears.spur"), run: () => beginFeature(SPUR) },
      { label: "rack", title: "rackHint", icon: GEAR_ICONS.rack, preview: previewUrl("gears.rack"), run: () => beginFeature(RACK) },
      { label: "bevel", title: "bevelHint", icon: GEAR_ICONS.bevel, preview: previewUrl("gears.bevel"), run: () => beginFeature(BEVEL) },
    ] as const;

    tabRegistry.add(
      pluginTab({
        id: "gears",
        label: () => gt("bench"),
        order: 70,
        docKinds: ["part"],
        body: () => createComponent(GearsRibbon, { buttons: [...buttons] }),
      }),
    );
  },
});
