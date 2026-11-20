import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DATUM_METHODS, evaluate, sketch3DSegments, sketchFrame } from "@solidus-cad/sdk";
import { sketch3DOf, sketchSegments } from "../sketch/segments.ts";
import { Viewer, type SketchRegion } from "@solidus-cad/viewer";
import { analyzeProfiles } from "@solidus-cad/sketch";
import { t } from "../i18n.ts";
import { theme } from "../theme.ts";
import { unwrap } from "solid-js/store";
import { activeDatums, attachViewer, treeHover, consumedSketches, continueSketchFor, editFeature, editingFeature, editingSketch, faceColorOf, featureAtFace, parameterScope, pickDatumRef, refTarget, selectPlane, setFaceColor, setFeatureColor, setState, showFeatureDims, state, toggleRef } from "../store.ts";
import { pickColor } from "./colorPick.ts";
import { FeatureDims } from "./FeatureDims.tsx";
import { SheetSide } from "./SheetSide.tsx";
import { openContextMenu } from "./ContextMenu.tsx";
import { refMarks } from "../datum.ts";
import { asmDatumViews, asmPlanes, editingAsmPlane, pickAsmDatumRef, selectAsmPlane } from "../assembly/planes.ts";
import { SketchEditor } from "../sketch/SketchEditor.tsx";
import { Sketch3DEditor } from "../sketch3d/Sketch3DEditor.tsx";
import { SectionPanel } from "./SectionPanel.tsx";
import { ViewSelector } from "./ViewSelector.tsx";
import { activeSection, sectionSettings, toggleSection } from "../section.ts";
import { activeKind, canPasteComponents, pasteFromClipboard, inPlaceGhosts, leafMatrix, pickDatumForMate, mateAcceptsRef, moveComponent, pickComponent, pickMateEntity, selectableOf, setViewHover, ws } from "../workspace.ts";
import { componentMenuItems } from "../assembly/componentMenu.ts";
import { Dynamic } from "solid-js/web";
import { contributions, moduleHidesBody } from "../host.ts";
import { bindMeasure } from "../measure.ts";
import { CentreLabels, MeasureLabel, MeasurePanel } from "./MeasurePanel.tsx";
import { gesturesEnabled } from "../gestures/gestures.ts";

export function Viewport() {
  let el!: HTMLDivElement;
  const [viewer, setViewer] = createSignal<Viewer | null>(null);

  onMount(() => {
    const v = new Viewer(el, {
      hover: (face) => setState("hover", face),
      select: (faces) => {
        setState("selection", faces);
        continueSketchFor();
      },
      componentPick: (key, additive, hit) => pickComponent(key, additive, hit),
      planePick: (plane) => {
        if (activeKind() !== "assembly") return selectPlane(plane);
        // Constraint in progress: a clicked assembly plane becomes its reference (fixed).
        const view = ws.mateDraft ? asmDatumViews().find((x) => x.id === plane) : undefined;
        if (view) pickDatumForMate(view.id, view.frame);
        else selectAsmPlane(plane);
      },
      componentMoved: (key, matrix, final) => moveComponent(key, matrix, final),
      componentHover: (key) => setViewHover(key),
      ghostPick: (face) => {
        const ctx = ws.inPlace;
        setState("ghostFace", face && ctx ? { plane: face.plane, link: { asm: ctx.asmId, path: face.key, target: ctx.path, ref: face.ref } } : null);
        if (face) continueSketchFor();
      },
    });
    createEffect(() => v.setDark(theme() === "dark"));
    attachViewer(v);
    setViewer(v);
    bindMeasure(v);
    for (const b of contributions("viewerBinders")) b.bind(v);
    // Gesture menu active: right drag is left to it (panning stays on left drag).
    createEffect(() => v.setRightDragPan(!gesturesEnabled()));
    createEffect(() =>
      v.setViewCubeLabels({
        front: t("cube.front"),
        back: t("cube.back"),
        top: t("cube.top"),
        bottom: t("cube.bottom"),
        left: t("cube.left"),
        right: t("cube.right"),
      }),
    );
    // Sketches visible in 3D: those not consumed by a feature, and the one selected in the tree.
    createEffect(() => {
      const features = state.doc.features;
      const consumed = consumedSketches(features);
      const editing = state.editing?.featureId;
      // Sketches of the feature being edited: shown highlighted, to judge the result against them.
      const edited = editing ? consumedSketches(state.doc.features.filter((f) => f.id === editing)) : new Set<string>();
      const normal: number[] = [];
      const highlighted: number[] = [];
      const regions: SketchRegion[] = [];
      const scope = parameterScope();
      const datums = activeDatums();
      // Sketch hovered in the tree: highlighted (and shown even if a feature consumed it).
      const hover = treeHover();
      const hovered = hover && "feature" in hover ? hover.feature : null;
      for (const f of features) {
        // 3D sketch (skeleton part): shown unless hidden.
        const s3 = f.suppressed || state.doc.display?.sketches?.[f.id] === false ? null : sketch3DOf(unwrap(state.doc), f);
        if (s3) sketch3DSegments(s3, state.activeFeatureId === f.id || hovered === f.id ? highlighted : normal);
        const info = state.sketchInfos[f.id];
        if (f.type !== "sketch" || !f.sketch || !info || f.id === editing) continue;
        const active = state.activeFeatureId === f.id || hovered === f.id || edited.has(f.id);
        const forced = state.doc.display?.sketches?.[f.id];
        if (forced === false && !active) continue;
        if (forced === undefined && consumed.has(f.id) && !active) continue;
        let offset = 0;
        try {
          offset = evaluate(f.sketch.plane.offset, scope);
        } catch {
          /* invalid offset */
        }
        const frame = sketchFrame(f.sketch.plane, offset, (id) => datums.get(id)?.frame);
        sketchSegments(info.geometry, frame, active ? highlighted : normal);
        // Tinted closed areas (outer contour minus holes).
        for (const r of analyzeProfiles(info.geometry).regions) {
          regions.push({ frame, outer: r.outer.polygon, holes: r.holes.map((h) => h.polygon), active });
        }
      }
      v.setSketchLines(new Float32Array(normal), new Float32Array(highlighted));
      v.setSketchRegions(regions);
    });
    // Reference planes and bodies: active part, or active assembly.
    createEffect(() => {
      const kind = activeKind();
      const planes = kind === "assembly" ? (ws.asm?.display?.planes ?? {}) : kind === "part" ? (state.doc.display?.planes ?? {}) : {};
      const editingPlane = kind === "part" && editingFeature()?.type === "plane" ? editingFeature()!.id : null;
      const selected = kind === "part" ? (editingPlane ?? state.selectedPlane) : kind === "assembly" ? (asmPlanes.edit?.id ?? asmPlanes.selected) : null;
      if (editingSketch()) v.setDatumPlanes([]);
      else if (kind === "part") {
        const hidden = new Set(state.doc.display?.hiddenDatums ?? []);
        const views = [...activeDatums()].flatMap(([id, r]) => (r.frame && (!hidden.has(id) || id === editingPlane) ? [{ id, frame: r.frame, center: r.center }] : []));
        v.setDatumPlanes(views);
      } else v.setDatumPlanes(kind === "assembly" ? asmDatumViews() : []);
      v.setReferencePlanes(planes, selected);
      v.setBodyVisible(kind !== "part" || (!state.doc.display?.bodyHidden && !moduleHidesBody()));
    });
    // Reference plane being edited: picking of its elements in the view, markers for the chosen elements.
    createEffect(() => {
      const kind = activeKind();
      const part = kind === "part" ? editingFeature() : undefined;
      const def = part?.type === "plane" ? part.datum : kind === "assembly" ? editingAsmPlane()?.def : undefined;
      const slot = kind === "part" ? state.datumSlot : asmPlanes.slot;
      const role = def && slot !== null ? (DATUM_METHODS[def.method].roles[slot] ?? null) : null;
      if (role) v.setDatumPicking(role, kind === "part" ? pickDatumRef : pickAsmDatumRef);
      else v.setDatumPicking(null);
      const marks = def ? refMarks(JSON.parse(JSON.stringify(unwrap(def))), (k) => leafMatrix(k) ?? undefined, 60 * v.pixelSize()) : null;
      v.setDatumMarks(marks?.points ?? [], marks?.segments ?? []);
    });
    // Assembly constraint in progress: compatible elements can be picked, first element highlighted.
    createEffect(() => {
      const on = activeKind() === "assembly" && !!ws.mateDraft;
      v.setMatePicking(on ? mateAcceptsRef : null, pickMateEntity);
      const mark = on ? ws.mateDraft?.mark : null;
      v.setMateMarks(mark ? [JSON.parse(JSON.stringify(unwrap(mark)))] : []);
    });
    // In-place editing: the other parts of the assembly shown as ghosts, in the part's coordinate system.
    createEffect(() => {
      const on = activeKind() === "part" && !!ws.inPlace && state.doc.id === ws.inPlace.partId;
      v.setGhosts(on ? inPlaceGhosts().map((g) => ({ key: g.key, mesh: g.mesh, matrix: g.matrix })) : null);
    });
    // Section view of the active document (suspended while a sketch is being edited).
    createEffect(() => v.setSection(editingSketch() ? null : sectionSettings(activeSection())));
    // Picking edges / faces for the feature being edited.
    createEffect(() => {
      const f = editingFeature();
      const target = f ? refTarget(f) : null;
      if (f && target) {
        v.setRefPicking(target.kind, toggleRef, target.filter);
        // Marked elements: those of the active group.
        v.setMarkedRefs(JSON.parse(JSON.stringify(unwrap(f.refs ?? []).filter((r) => r.group === target.group))));
      } else {
        v.setRefPicking(null);
        v.setMarkedRefs([]);
      }
    });
    onCleanup(() => {
      attachViewer(null);
      v.dispose();
    });
  });

  // Right click without dragging on an assembly occurrence: occurrence menu (as in the tree).
  const assemblyMenu = (e: MouseEvent) => {
    const v = viewer();
    if (!v || ws.mateDraft || ws.sketch3d || ws.frame || ws.machinePick) return;
    const rect = v.element.getBoundingClientRect();
    const hit = v.pickAssemblyAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) {
      // Empty space: paste the copied occurrences.
      if (canPasteComponents()) openContextMenu(e, [{ label: t("asm.paste"), run: () => void pasteFromClipboard() }]);
      return;
    }
    const items = componentMenuItems(selectableOf(hit.key));
    if (items.length) openContextMenu(e, items);
  };

  // Right click without dragging in a part: feature that created the face under the pointer (otherwise the one chosen in the tree).
  let rightDown: { x: number; y: number } | null = null;
  const onContextMenu = async (e: MouseEvent) => {
    e.preventDefault();
    const moved = !rightDown || Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) > 4;
    if (!moved && activeKind() === "assembly") return assemblyMenu(e);
    if (moved || activeKind() !== "part" || state.editing) return;
    const hit = viewer()?.faceAt(e.clientX, e.clientY);
    const id = hit ? await featureAtFace(hit.id, hit.point) : state.activeFeatureId;
    const f = state.doc.features.find((x) => x.id === id);
    if (!f || state.editing) return;
    setState("activeFeatureId", f.id);
    // Face under the pointer: with the other selected faces if it is part of them.
    const faces = !hit ? [] : state.selection.some((s) => s.index === hit.index) ? state.selection.map((s) => s.index) : [hit.index];
    const featureColor = state.doc.appearance.features?.[f.id];
    openContextMenu(e, [
      state.dimsFeature === f.id ? { label: t("fdim.hide"), run: () => showFeatureDims(null) } : { label: `${t("fdim.show")} : ${f.name}`, run: () => showFeatureDims(f.id) },
      { label: `${t("tree.edit")} : ${f.name}`, run: () => editFeature(f.id) },
      ...(faces.length
        ? [{ label: faces.length > 1 ? t("color.faces").replace("{n}", String(faces.length)) : t("color.face"), run: () => pickColor(e.clientX, e.clientY, faceColorOf(faces[0]!) ?? featureColor ?? state.doc.appearance.color, (c) => setFaceColor(faces, c)) }]
        : []),
      ...(faces.some((i) => faceColorOf(i)) ? [{ label: t("color.faceReset"), run: () => setFaceColor(faces, null) }] : []),
      { label: `${t("color.feature")} : ${f.name}…`, run: () => pickColor(e.clientX, e.clientY, featureColor ?? state.doc.appearance.color, (c) => setFeatureColor(f.id, c)) },
      ...(featureColor ? [{ label: `${t("color.featureReset")} : ${f.name}`, run: () => setFeatureColor(f.id, null) }] : []),
    ]);
  };

  return (
    <div class="viewport" onPointerDown={(e) => e.button === 2 && (rightDown = { x: e.clientX, y: e.clientY })} onContextMenu={onContextMenu}>
      {/* Container dedicated to the canvas: Solid must not empty it when the sketch layer disappears. */}
      <div class="canvas-host" ref={el} />
      <Show when={viewer() && editingSketch()}>
        <SketchEditor viewer={viewer()!} />
      </Show>
      <Show when={viewer() && activeKind() === "part" && state.dimsFeature && !state.editing}>
        <FeatureDims viewer={viewer()!} />
      </Show>
      <Show when={viewer() && activeKind() === "part" && editingFeature()?.type === "sheetBase"}>
        <SheetSide viewer={viewer()!} />
      </Show>
      <Show when={viewer() && activeKind() === "assembly" && ws.sketch3d}>
        <Sketch3DEditor viewer={viewer()!} />
      </Show>
      <For each={contributions("viewerEditors")}>{(c) => <Show when={viewer() && c.when()}><Dynamic component={c.component} viewer={viewer()!} /></Show>}</For>
      <Show when={viewer() && !editingSketch() && !ws.sketch3d && !ws.frame}>
        <div class="view-tools">
          <button classList={{ pressed: !!activeSection() }} title={t("sec.toggle")} aria-pressed={!!activeSection()} onClick={toggleSection}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
              <path d="M4 8 12 4l8 4v8l-8 4-8-4z" />
              <path d="M3 13 21 9" stroke-dasharray="2 2" />
              <path d="M12 12 4 16l8 4 8-4z" fill="currentColor" opacity=".25" />
            </svg>
            {t("sec.title")}
          </button>
          <ViewSelector viewer={viewer()!} />
          <For each={contributions("viewportTools")}>{(c) => <Dynamic component={c.component} />}</For>
        </div>
        <SectionPanel />
        <MeasurePanel />
        <MeasureLabel viewer={viewer()!} />
        <CentreLabels viewer={viewer()!} />
        <For each={contributions("viewportOverlays")}>{(c) => <Dynamic component={c.component} />}</For>
      </Show>
    </div>
  );
}
