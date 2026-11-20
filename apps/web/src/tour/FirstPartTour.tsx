import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import { editingFeature, editingSketch, state } from "../store.ts";
import { session } from "../sketch/session.ts";
import { activate, activeKind, newPart, ws } from "../workspace.ts";
import { setPartBenchId, setPluginTabId } from "../plugins/tabs.ts";
import { firstRunPending } from "../plugins/modules.ts";
import { closeMeasure } from "../measure.ts";
import { closeModuleOverlays } from "../host.ts";
import { readOnly } from "../edition.ts";
import { ExampleCards } from "../components/ExampleCards.tsx";
import { docFs } from "../docfiles/fs.ts";

/**
 * Guided tour "first part": a plate drawn as a rectangle in a sketch, then extruded.
 * The current step is derived from the document and the sketch session, never stored: the tour follows the user
 * when they go back (Undo, Cancel) or take another path (Extrude before Sketch). The overlay lets every click through.
 */

/** Set once the tour has been offered (accepted, postponed or finished): no more automatic offer. */
const SEEN_KEY = "cad.tour.firstPart";

type Step = "folder" | "sketch" | "rect" | "draw" | "dims" | "finishSketch" | "extrude" | "depth";
/** Web version only: the project folder where the documents are saved comes first (the desktop app uses real paths). */
const WEB = docFs.kind !== "desktop";
const STEPS: Step[] = [...(WEB ? (["folder"] as const) : []), "sketch", "rect", "draw", "dims", "finishSketch", "extrude", "depth"];

interface StepView {
  title: TKey;
  text: TKey;
  /** Element to highlight; none: the bubble sits at the bottom of the 3D view. */
  target?: string;
  /** The user works in the 3D view at this step: the bubble docks in its bottom left corner, out of the drawing's way. */
  dock?: boolean;
}

const VIEWS: Record<Step, StepView> = {
  folder: { title: "tour.folder.title", text: "tour.folder.text" },
  sketch: { title: "tour.sketch.title", text: "tour.sketch.text", target: '.ribbon-btn[data-cmd="part.sketch"]' },
  rect: { title: "tour.rect.title", text: "tour.rect.text", target: '.ribbon-btn[data-action="sketch.rect"]' },
  draw: { title: "tour.draw.title", text: "tour.draw.text", dock: true },
  dims: { title: "tour.dims.title", text: "tour.dims.text", target: '.ribbon-btn[data-action="sketch.dim"]', dock: true },
  // The panel button stays visible on narrow screens, where the end of the sketch ribbon is cut off.
  finishSketch: { title: "tour.finishSketch.title", text: "tour.finishSketch.text", target: ".side.left .property-panel .panel-actions .btn.primary", dock: true },
  extrude: { title: "tour.extrude.title", text: "tour.extrude.text", target: '.ribbon-btn[data-cmd="part.extrude"]' },
  depth: { title: "tour.depth.title", text: "tour.depth.text", target: ".side.left .property-panel" },
};

type Stage = "intro" | "run" | "done";
const [stage, setStage] = createSignal<Stage | null>(null);
/** Part the tour works on. */
const [tourDoc, setTourDoc] = createSignal<string | null>(null);
/** The optional dimension step was skipped. */
const [dimsSkipped, setDimsSkipped] = createSignal(false);
/** The project folder step was skipped (web). */
const [folderSkipped, setFolderSkipped] = createSignal(false);

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage unavailable: the offer may come back next time */
  }
}

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/** Opens the tour on its welcome card (Help menu). */
export function openFirstPartTour(): void {
  setStage("intro");
}

function begin(): void {
  markSeen();
  // A blank part: the current one if it is empty, otherwise a new one (the user's work stays untouched).
  if (activeKind() !== "part" || state.doc.features.length > 0 || state.editing) newPart();
  closeMeasure();
  closeModuleOverlays();
  setPartBenchId("part");
  setPluginTabId(null);
  setDimsSkipped(false);
  setFolderSkipped(false);
  setTourDoc(ws.activeId);
  setStage("run");
}

function quit(): void {
  markSeen();
  setStage(null);
  setTourDoc(null);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
const sameBox = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
const boxOf = (el: Element | null): Box | null => {
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
};

const BUBBLE_W = 320;
const GAP = 12;

export function FirstPartTour() {
  // Automatic offer to new users only: the first-startup wizard was pending when the application opened.
  const newcomer = firstRunPending() && !seen() && !navigator.webdriver;
  createEffect(() => {
    if (newcomer && !firstRunPending() && !readOnly() && stage() === null && !seen()) setStage("intro");
  });

  /** Current step, or "away" when the tour's part is not displayed, "other" when another feature is being edited. */
  const current = createMemo((): Step | "away" | "other" | "complete" => {
    if (stage() !== "run") return "away";
    if (activeKind() !== "part" || ws.activeId !== tourDoc()) return "away";
    const editing = editingFeature();
    const sk = editingSketch();
    if (sk) {
      const closed = (session.profiles?.regions.length ?? 0) > 0;
      if (!closed) return sk.geometry.length > 0 || session.tool === "rect" || session.tool === "rectCenter" ? "draw" : "rect";
      // Two dimensions of any kind (driving or reference), or nothing left free: the sketch is dimensioned.
      const dimensioned = sk.dimensions.length >= 2 || (session.solved && session.dof === 0);
      return dimensioned || dimsSkipped() ? "finishSketch" : "dims";
    }
    if (editing?.type === "extrude") return "depth";
    if (editing) return "other";
    const committed = state.doc.features.slice(0, state.doc.rollback);
    if (committed.some((f) => f.type === "extrude")) return "complete";
    if (committed.some((f) => f.type === "sketch" && (f.sketch?.geometry.length ?? 0) > 0)) return "extrude";
    // Web: project folder first, as long as none is chosen (skippable; File › Project folder later).
    if (WEB && !docFs.rootName() && !folderSkipped() && state.doc.features.length === 0) return "folder";
    return "sketch";
  });

  // Extrusion validated: closing card.
  createEffect(on(current, (c) => c === "complete" && setStage("done")));
  // Part closed during the tour: the tour stops.
  createEffect(() => {
    const id = tourDoc();
    if (id && stage() === "run" && !ws.entries.some((e) => e.id === id)) quit();
  });

  const step = (): Step | null => {
    const c = current();
    return (STEPS as string[]).includes(c) ? (c as Step) : null;
  };
  const view = () => (step() ? VIEWS[step()!] : null);

  // Positions follow the layout (ribbon wrapping, panels opening): measured on each frame while the tour is shown.
  const [target, setTarget] = createSignal<Box | null>(null);
  const [center, setCenter] = createSignal<Box | null>(null);
  createEffect(on(() => !!stage(), (shown) => {
    if (!shown) return;
    let raf = 0;
    const tick = () => {
      const sel = stage() === "run" ? view()?.target : undefined;
      const tb = sel ? boxOf(document.querySelector(sel)) : null;
      const cb = boxOf(document.querySelector(".workspace > .center"));
      if (!sameBox(tb, target())) setTarget(tb);
      if (!sameBox(cb, center())) setCenter(cb);
      raf = requestAnimationFrame(tick);
    };
    tick();
    onCleanup(() => cancelAnimationFrame(raf));
  }));

  /**
   * Bubble position: bottom left corner of the 3D view at the steps worked in the view (the bubble takes the clicks: it
   * must not cover the drawing); otherwise under the target, or to its right for a tall panel; at the bottom of the 3D
   * view without target.
   */
  const bubbleStyle = () => {
    const vw = window.innerWidth;
    const clampX = (x: number) => Math.max(8, Math.min(x, vw - BUBBLE_W - 8));
    const tb = stage() === "run" ? target() : null;
    const c = center() ?? { left: 0, top: 0, width: vw, height: window.innerHeight };
    if (stage() === "run" && view()?.dock) return { left: `${clampX(c.left + GAP)}px`, top: `${c.top + c.height - GAP}px`, transform: "translateY(-100%)" };
    if (tb) {
      if (tb.height > window.innerHeight * 0.4) return { left: `${clampX(tb.left + tb.width + GAP)}px`, top: `${tb.top + 40}px` };
      // Ribbon button: below the document tabs, which stay clickable.
      return { left: `${clampX(tb.left + tb.width / 2 - BUBBLE_W / 2)}px`, top: `${Math.max(tb.top + tb.height + GAP, c.top + 8)}px` };
    }
    const left = `${clampX(c.left + c.width / 2 - BUBBLE_W / 2)}px`;
    // Welcome card: centred; closing card and steps without target: at the bottom, out of the part's way.
    return stage() !== "intro" ? { left, top: `${c.top + c.height - 24}px`, transform: "translateY(-100%)" } : { left, top: `${c.top + c.height / 2}px`, transform: "translateY(-50%)" };
  };

  const goBack = () => {
    const id = tourDoc();
    if (id) activate(id);
  };

  return (
    <Show when={stage()}>
      <div class="tour-layer" aria-live="polite">
        <Show when={stage() === "run" && target()}>
          {(b) => <div class="tour-spot" style={{ left: `${b().left - 4}px`, top: `${b().top - 4}px`, width: `${b().width + 8}px`, height: `${b().height + 8}px` }} />}
        </Show>
        <div class="tour-bubble" role="dialog" aria-label={t("tour.menu")} style={{ width: `${BUBBLE_W}px`, ...bubbleStyle() }}>
          <Show when={stage() === "intro"}>
            <strong class="tour-title">{t("tour.intro.title")}</strong>
            <p>{t("tour.intro.text")}</p>
            <div class="tour-actions">
              <button class="btn" onClick={quit}>
                {t("tour.later")}
              </button>
              <button class="btn primary" onClick={begin}>
                {t("tour.start")}
              </button>
            </div>
          </Show>
          <Show when={stage() === "done"}>
            <strong class="tour-title">✓ {t("tour.done.title")}</strong>
            <p>{t("tour.done.text")}</p>
            <p class="tour-examples-intro">{t("tour.done.examples")}</p>
            <ExampleCards onOpened={quit} />
            <div class="tour-actions">
              <button class="btn primary" onClick={quit}>
                {t("tour.close")}
              </button>
            </div>
          </Show>
          <Show when={stage() === "run"}>
            <Show
              when={view()}
              fallback={
                <>
                  <strong class="tour-title">{t(current() === "other" ? "tour.other.title" : "tour.away.title")}</strong>
                  <p>{t(current() === "other" ? "tour.other.text" : "tour.away.text")}</p>
                  <div class="tour-actions">
                    <button class="btn" onClick={quit}>
                      {t("tour.quit")}
                    </button>
                    <Show when={current() === "away"}>
                      <button class="btn primary" onClick={goBack}>
                        {t("tour.back")}
                      </button>
                    </Show>
                  </div>
                </>
              }
            >
              {(v) => (
                <>
                  <span class="tour-count">{t("tour.count").replace("{n}", String(STEPS.indexOf(step()!) + 1)).replace("{total}", String(STEPS.length))}</span>
                  <strong class="tour-title">{t(v().title)}</strong>
                  <p>{t(v().text)}</p>
                  <div class="tour-actions">
                    <button class="btn" onClick={quit}>
                      {t("tour.quit")}
                    </button>
                    <Show when={step() === "dims"}>
                      <button class="btn primary" onClick={() => setDimsSkipped(true)}>
                        {t("tour.skip")}
                      </button>
                    </Show>
                    <Show when={step() === "folder"}>
                      <button class="btn" onClick={() => setFolderSkipped(true)}>
                        {t("tour.skip")}
                      </button>
                      <button class="btn primary" onClick={() => void docFs.ensureRoot(true)}>
                        {t("tour.folder.pick")}
                      </button>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
