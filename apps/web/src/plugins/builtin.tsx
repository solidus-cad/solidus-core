import type { JSX } from "solid-js";
import type { Bench } from "@solidus-cad/sdk";
import type { Feature } from "../license.ts";
import { t, tx } from "../i18n.ts";
import { editingSketch } from "../store.ts";
import { activeKind, openLinkedPart, openOrCreateAssembly, setWs, ws } from "../workspace.ts";
import { SketchRibbon } from "../sketch/SketchRibbon.tsx";
import { AssemblyRibbon } from "../assembly/AssemblyRibbon.tsx";
import { Sketch3DRibbon } from "../sketch3d/Sketch3DRibbon.tsx";
import { closeModuleContexts, closeModuleOverlays, docKind, moduleOverlayOn } from "../host.ts";
import { closeMeasure, measure, openMeasure } from "../measure.ts";
import { MeasureRibbon } from "../components/MeasurePanel.tsx";
import { DeclarativeRibbon } from "../components/DeclarativeRibbon.tsx";
import { benchFeatureOf, benchRegistry } from "./benches.ts";
import { MODULES } from "./modules.ts";
import { toolRegistry } from "./tools.ts";
import { partBenchId, pluginTabId, pluginTabShown, setPartBenchId, setPluginTabId, tabRegistry, type RibbonTab } from "./tabs.ts";

/** Built-in workbenches: ribbon tabs registered at startup, with the same API as plugins. */

/** Paid feature of a part workbench (registered by its module, see benches.ts), otherwise undefined (free). */
const benchFeature = (id: string): Feature | undefined => benchFeatureOf(id);

const overlayOn = () => measure.on || moduleOverlayOn();

/** License of the workbench displayed on an assembly: frame or CAM program machine (the assembly is free). */
const assemblyNeeds = (): Feature | undefined => (ws.frame ? "frame" : ws.camReturn ? "cam" : undefined);

/** Built-in part workbenches, at the head of the ribbon; those of plugins come after the built-in workbenches. */
const BUILTIN_BENCHES = ["part", "sheetmetal"];

function benchTab(b: Bench, index: number): RibbonTab {
  const builtin = BUILTIN_BENCHES.indexOf(b.id);
  return {
    id: `bench:${b.id}`,
    label: () => tx(b.label),
    order: builtin >= 0 ? builtin : 100 + index,
    active: () => partBenchId() === b.id && !editingSketch() && activeKind() === "part" && !overlayOn() && !pluginTabShown("part"),
    license: benchFeature(b.id),
    module: MODULES().some((m) => m.id === b.id) ? b.id : undefined,
    open: () => {
      closeMeasure();
      closeModuleOverlays();
      setPartBenchId(b.id);
      setPluginTabId(null);
      // From an assembly or a drawing: the part linked to the displayed document.
      openLinkedPart();
    },
    body: () => <DeclarativeRibbon groups={b.ribbon} />,
    owns: () => activeKind() === "part" && !editingSketch() && partBenchId() === b.id,
    needs: () => benchFeature(b.id),
  };
}

const fixedTabs: RibbonTab[] = [
  {
    id: "sketch",
    label: () => t("sk.title"),
    order: 10,
    contextual: true,
    visible: () => !!editingSketch(),
    active: () => true,
    body: () => <SketchRibbon />,
    owns: () => activeKind() === "part" && !!editingSketch(),
    priority: 30,
  },
  {
    id: "assembly",
    label: () => t("bench.assembly"),
    order: 20,
    active: () => activeKind() === "assembly" && !ws.sketch3d && !ws.frame && !ws.camReturn && !ws.motion && !overlayOn() && !pluginTabShown("assembly"),
    open: () => {
      closeMeasure();
      closeModuleOverlays();
      // CAM program machine: it becomes an ordinary assembly again (end of the "Machine" context).
      setWs("camReturn", null);
      setPluginTabId(null);
      closeModuleContexts();
      openOrCreateAssembly();
    },
    body: () => <AssemblyRibbon />,
    owns: () => activeKind() === "assembly",
    needs: assemblyNeeds,
  },
  {
    id: "sketch3d",
    label: () => t("s3d.title"),
    order: 21,
    contextual: true,
    visible: () => activeKind() === "assembly" && !!ws.sketch3d,
    active: () => true,
    body: () => <Sketch3DRibbon />,
    owns: () => activeKind() === "assembly" && !!ws.sketch3d,
    priority: 22,
    needs: assemblyNeeds,
  },
  {
    id: "measure",
    label: () => t("bench.measure"),
    order: 30,
    active: () => measure.on && activeKind() !== "drawing",
    disabled: () => activeKind() === "drawing" || activeKind() === "cam" || !!editingSketch() || !!ws.sketch3d || !!ws.frame || !!ws.motion,
    open: () => {
      closeModuleOverlays();
      openMeasure();
    },
    body: () => <MeasureRibbon />,
    owns: () => measure.on && activeKind() !== "drawing",
    priority: 40,
    overlay: true,
  },

];

/** Announced workbenches: greyed tab, "Coming soon" on hover, hidden as soon as the real module is loaded. */
const MESH_LABEL = {
  fr: "Maillage", en: "Mesh", de: "Netz", es: "Malla", it: "Mesh", pt: "Malha", pl: "Siatka", ru: "Сетка",
  cs: "Síť", tr: "Mesh", zh: "网格", "zh-TW": "網格", ja: "メッシュ", ko: "메시", ar: "شبكة",
};
/** `present`: the real module is loaded (its tab or its tool is registered). */
const QUOTE_LABEL = {
  fr: "Chiffrage", en: "Quoting", de: "Kalkulation", es: "Presupuestos", it: "Preventivo", pt: "Orçamento", pl: "Wycena",
  ru: "Смета", cs: "Kalkulace", tr: "Teklif", zh: "报价", "zh-TW": "報價", ja: "見積り", ko: "견적", ar: "التسعير",
};
const soonTab =(id: string, label: () => string, order: number, present: () => boolean): RibbonTab => ({
  id: `soon:${id}`,
  label,
  order,
  soon: true,
  visible: () => !present(),
  active: () => false,
  title: () => t("plg.soon"),
});
fixedTabs.push(
  soonTab("cam", () => t("bench.cam"), 50, () => !!tabRegistry.get("cam")),
  soonTab("quote", () => tx(QUOTE_LABEL), 60, () => !!tabRegistry.get("quote")),
  soonTab("mesh", () => tx(MESH_LABEL), 100, () => !!tabRegistry.get("bench:mesh")),
  // The PLM module has no ribbon tab of its own (tool + right pane): the announced tab gives way to its tool.
  soonTab("plm", () => "PLM", 101, () => !!toolRegistry.get("plm")),
);

tabRegistry.add(...fixedTabs, ...benchRegistry.list().map(benchTab));

// Part workbench added or removed by a plugin: its tab follows.
benchRegistry.subscribe((added, removed) => {
  tabRegistry.remove(...removed.map((b) => `bench:${b.id}`));
  if (removed.some((b) => b.id === partBenchId()) && !added.some((b) => b.id === partBenchId())) setPartBenchId("part");
  const all = benchRegistry.list();
  tabRegistry.add(...added.map((b) => benchTab(b, all.indexOf(b))));
});

/** Current workbench of a document: editing context (sketch, frame…) in which a plugin tab is not displayed. */
const inContext = () => !!editingSketch() || !!ws.sketch3d || !!ws.frame || !!ws.camReturn || !!ws.motion;

/** Built-in workbench license of the document, also required by the plugin tabs displayed there. */
const kindNeeds = (kind: string): Feature | undefined => docKind(kind)?.feature;

/** Opens a document of the wanted type (the nearest to the displayed document). */
const OPEN_KIND: Record<string, () => void> = { part: openLinkedPart, assembly: openOrCreateAssembly };

/** Plugin tab: declarative body, displayed on the `docKinds` document types. */
export function pluginTab(spec: { id: string; label: () => string; order: number; docKinds: readonly string[]; body: () => JSX.Element }): RibbonTab {
  const here = () => spec.docKinds.includes(activeKind());
  return {
    id: spec.id,
    label: spec.label,
    order: spec.order,
    docKinds: spec.docKinds,
    active: () => pluginTabId() === spec.id && here() && !overlayOn() && !inContext(),
    open: () => {
      closeMeasure();
      closeModuleOverlays();
      setPluginTabId(spec.id);
      if (!here()) (OPEN_KIND[spec.docKinds[0]!] ?? (() => docKind(spec.docKinds[0]!)?.openOrCreate()))();
    },
    body: spec.body,
    owns: () => pluginTabId() === spec.id && here(),
    priority: 5,
    needs: () => kindNeeds(activeKind()),
  };
}
