import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { contributions } from "./host.ts";
import { installShortcuts } from "./commands.ts";
import { FirstRunDialog, PluginsDialog } from "./plugins/PluginsDialog.tsx";
import { FilesUi } from "./docfiles/FilesUi.tsx";
import { AppearanceDialog } from "./components/AppearanceDialog.tsx";
import { PluginForm } from "./plugins/PluginForm.tsx";
import { editingSketch, state } from "./store.ts";
import { SketchPanel } from "./sketch/SketchPanel.tsx";
import { AssemblyTree } from "./assembly/AssemblyTree.tsx";
import { Sketch3DPanel } from "./sketch3d/Sketch3DPanel.tsx";
import { BomDialog } from "./assembly/BomDialog.tsx";
import { ReplaceDialog } from "./assembly/ReplaceDialog.tsx";
import { ShortcutsDialog } from "./keymap/ShortcutsDialog.tsx";
import { GestureMenu } from "./gestures/GestureMenu.tsx";
import { GesturesDialog } from "./gestures/GesturesDialog.tsx";
import { UserDialog } from "./components/UserDialog.tsx";
import { AboutDialog } from "./components/AboutDialog.tsx";
import { FirstPartTour } from "./tour/FirstPartTour.tsx";
import { BugReportDialog } from "./bugreport/BugReportDialog.tsx";
import { MaterialDialog } from "./components/MaterialDialog.tsx";
import { FlatPatternDialog } from "./sheetmetal/FlatPatternDialog.tsx";
import { openFlatPattern } from "./sheetmetal/flat.ts";
import { registerAction } from "./store.ts";

registerAction("sheetmetal.exportFlatDxf", () => void openFlatPattern());
import { activeKind, canDropInto, draggedDoc, dropInto, isDirty, returnToAssembly, ws } from "./workspace.ts";
import { t } from "./i18n.ts";
import { MenuBar } from "./components/MenuBar.tsx";
import { Ribbon } from "./components/Ribbon.tsx";
import { FeatureTree } from "./components/FeatureTree.tsx";
import { PropertyPanel } from "./components/PropertyPanel.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { Viewport } from "./components/Viewport.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { Dialog } from "./components/Dialog.tsx";
import { CheckpointDialog, VersionPanel } from "./components/CheckpointDialog.tsx";
import { ExportAssemblyDialog } from "./components/ExportAssemblyDialog.tsx";
import { DocTabs } from "./components/DocTabs.tsx";
import { panels, PanelToggle } from "./components/PanelToggle.tsx";
import { readOnly } from "./edition.ts";

export function App() {
  let search!: HTMLInputElement;
  // Left panel provided by a module (CAM program…): it replaces the default tree while its condition is true.
  const moduleLeft = createMemo(() => contributions("leftPanels").find((p) => p.when()));
  // Right panel provided by a module (quoting); CSS classes added by modules to the workspace and central area.
  const moduleRight = createMemo(() => contributions("rightPanels").find((p) => p.when()));
  const centerView = createMemo(() => contributions("centerViews").find((c) => c.when()));
  const classesFor = (target: "app" | "workspace" | "center") => Object.fromEntries(contributions("classes").filter((c) => c.target === target).map((c) => [c.name, c.when()]));
  // Modules with their own workspace grid (quoting) keep their panels; an edit form lives in the left panel, which reopens for it.
  const moduleLayout = () => Object.values(classesFor("workspace")).some(Boolean);
  const leftHidden = () => !moduleLayout() && panels.left.collapsed() && !state.editing;
  const rightHidden = () => !moduleLayout() && panels.right.collapsed();
  // Drop of a document dragged from the Documents panel onto the active assembly (tree or 3D view).
  const [dropHover, setDropHover] = createSignal(false);
  const dropZone = {
    onDragOver: (ev: DragEvent) => {
      if (draggedDoc() === ws.activeId || !canDropInto(draggedDoc())) return;
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = "copy";
      setDropHover(true);
    },
    onDragLeave: (ev: DragEvent) => {
      const to = ev.relatedTarget as Node | null;
      if (!to || !(ev.currentTarget as HTMLElement).contains(to)) setDropHover(false);
    },
    onDrop: (ev: DragEvent) => {
      ev.preventDefault();
      setDropHover(false);
      const id = draggedDoc();
      if (id) dropInto(id);
    },
  };
  onMount(() => onCleanup(installShortcuts(() => search.focus())));
  onMount(() => {
    // Closing or reloading the page with modified documents: the browser asks for confirmation.
    const warn = (ev: BeforeUnloadEvent) => {
      if (!ws.entries.some((e) => isDirty(e.id))) return;
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    onCleanup(() => window.removeEventListener("beforeunload", warn));
  });

  return (
    <div class="app" classList={{ "read-only": readOnly(), ...classesFor("app") }}>
      <MenuBar searchRef={(el) => (search = el)} />
      <For each={contributions("appBanners")}>{(b) => <Dynamic component={b.component} />}</For>
      <Ribbon />
      <DocTabs />
      <main class="workspace" classList={{ ...classesFor("workspace"), "left-collapsed": leftHidden(), "right-collapsed": rightHidden() }}>
        <aside class="side left" classList={{ "drop-target": dropHover() }} {...dropZone} {...panels.left.hover}>
          <Show
            when={moduleLeft()}
            fallback={
          <Show
            when={activeKind() === "part"}
            fallback={
              <Show
                when={activeKind() === "assembly" && ws.asm}
              >
                <For each={contributions("assemblyBanners")}>{(b) => <Dynamic component={b.component} />}</For>
                <Show when={ws.sketch3d} fallback={<><AssemblyTree /><VersionPanel /></>}>
                  <Sketch3DPanel />
                </Show>
              </Show>
            }
          >
            <Show when={ws.returnTo}>
              <div class="context-banner">
                <span>{ws.inPlace ? t("asm.inPlace").replace("{asm}", ws.entries.find((e) => e.id === ws.inPlace!.asmId)?.name ?? "") : t("asm.inContext")}</span>
                <button class="btn" onClick={returnToAssembly}>
                  ↩ {t("asm.back")}
                </button>
              </div>
            </Show>
            <Show when={state.editing} fallback={<><FeatureTree /><VersionPanel /></>}>
              <Show when={editingSketch()} fallback={<PropertyPanel />}>
                <SketchPanel />
              </Show>
            </Show>
          </Show>
            }
          >
            {(p) => <Dynamic component={p().component} />}
          </Show>
        </aside>
        {/* The 3D view stays mounted (hidden while a module view replaces it: drawing sheet) to keep its state. */}
        <div class="center" classList={{ hidden: !!centerView(), "drop-target": dropHover(), ...classesFor("center") }} {...dropZone}>
          <Viewport />
          <For each={contributions("centerFooters")}>{(f) => <Show when={f.when()}><Dynamic component={f.component} /></Show>}</For>
        </div>
        <Show when={centerView()}>{(c) => <Dynamic component={c().component} />}</Show>
        <For each={contributions("stages")}>{(st) => <Show when={st.when()}><Dynamic component={st.component} /></Show>}</For>
        <Show when={moduleRight()} fallback={<RightPanel />}>
          {(p) => <Dynamic component={p().component} />}
        </Show>
        <Show when={!moduleLayout()}>
          <Show when={!state.editing}>
            <PanelToggle id="left" />
          </Show>
          <PanelToggle id="right" />
        </Show>
      </main>
      <StatusBar />
      <ContextMenu />
      <ShortcutsDialog />
      <GesturesDialog />
      <GestureMenu />
      <UserDialog />
      <AboutDialog />
      <BugReportDialog />
      <Dialog />
      <PluginsDialog />
      <FilesUi />
      <FirstRunDialog />
      <PluginForm />
      <AppearanceDialog />
      <BomDialog />
      <CheckpointDialog />
      <ExportAssemblyDialog />
      <For each={contributions("dialogs")}>{(d) => <Dynamic component={d.component} />}</For>
      <ReplaceDialog />
      <MaterialDialog />
      <FlatPatternDialog />
      <FirstPartTour />
    </div>
  );
}
