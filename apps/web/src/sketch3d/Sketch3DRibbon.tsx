import { For, Show } from "solid-js";
import { t, type TKey } from "../i18n.ts";
import {
  applyTypedOrFinish,
  canConstrain,
  cancelSketch3D,
  constrain,
  cyclePlane,
  deleteSelection3,
  escapeCascade,
  finishSketch3D,
  lookAtPlane,
  redo3,
  s3,
  setS3,
  setTool,
  setWorkPlane,
  sketchPlanes,
  undo3,
  type ConstraintCmd,
  type Tool3,
} from "./session.ts";
import { AXIS_COLOR } from "./Sketch3DEditor.tsx";
import { previewUrl } from "../components/HoverPreview.tsx";
import { shortcutTitle } from "../keymap/keymap.ts";
import { registerActions, type ShortcutAction } from "../keymap/registry.ts";

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

const TOOLS: { tool: Tool3; label: TKey; icon: string; action: string }[] = [
  { tool: "select", label: "s3d.select", icon: svg('<path d="M5 3l14 8-6 2-3 6z"/>'), action: "sketch3d.select" },
  { tool: "line", label: "s3d.line", icon: svg('<path d="M4 18 10 8l5 6 5-9"/><circle cx="4" cy="18" r="1.5"/><circle cx="10" cy="8" r="1.5"/><circle cx="15" cy="14" r="1.5"/><circle cx="20" cy="5" r="1.5"/>'), action: "sketch3d.line" },
  { tool: "spline", label: "sk.spline", icon: svg('<path d="M3 18c4-12 8 4 12-6s5-6 6-6"/><circle cx="3" cy="18" r="1.4"/><circle cx="21" cy="6" r="1.4"/>'), action: "sketch3d.spline" },
  { tool: "point", label: "s3d.point", icon: svg('<circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>'), action: "sketch3d.point" },
  { tool: "dimension", label: "s3d.dimension", icon: svg('<path d="M4 17 20 7"/><path d="M4 13v8M20 3v8"/><path d="m7 15-3 2 3 1M17 9l3-2-3-1"/>'), action: "sketch3d.dimension" },
];

const axisIcon = (a: "X" | "Y" | "Z") =>
  `<svg viewBox="0 0 24 24"><path d="M4 18 20 6" stroke="${AXIS_COLOR[a]}" stroke-width="2"/><text x="3" y="11" font-size="10" font-weight="700" fill="${AXIS_COLOR[a]}">${a}</text></svg>`;

const CONSTRAINTS: { cmd: ConstraintCmd; label: TKey; icon: string; action: string }[] = [
  { cmd: "X", label: "s3d.c.X", icon: axisIcon("X"), action: "sketch3d.c.X" },
  { cmd: "Y", label: "s3d.c.Y", icon: axisIcon("Y"), action: "sketch3d.c.Y" },
  { cmd: "Z", label: "s3d.c.Z", icon: axisIcon("Z"), action: "sketch3d.c.Z" },
  { cmd: "inPlane", label: "s3d.c.inPlane", icon: svg('<path d="M3 16 9 8h12l-6 8z"/><path d="M8 13l7-3" stroke-width="2"/>'), action: "sketch3d.c.inPlane" },
  { cmd: "parallel", label: "s3d.c.parallel", icon: svg('<path d="M7 4 4 20M15 4l-3 16"/>'), action: "sketch3d.c.parallel" },
  { cmd: "perpendicular", label: "s3d.c.perpendicular", icon: svg('<path d="M4 20h16M12 20V4"/>'), action: "sketch3d.c.perpendicular" },
  { cmd: "equal", label: "s3d.c.equal", icon: svg('<path d="M5 9h14M5 15h14"/>'), action: "sketch3d.c.equal" },
  { cmd: "pointOnLine", label: "s3d.c.pointOnLine", icon: svg('<path d="M4 18 20 6"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>'), action: "sketch3d.c.pointOnLine" },
  { cmd: "coincident", label: "s3d.c.coincident", icon: svg('<circle cx="9" cy="12" r="4"/><circle cx="15" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>'), action: "sketch3d.c.coincident" },
  { cmd: "fix", label: "s3d.c.fix", icon: svg('<path d="M12 21v-7M8 3h8l-1 5 3 3H6l3-3z"/>'), action: "sketch3d.c.fix" },
];

/** CAD profile shortcuts for the 3D sketch tools. */
const S3D_DEFAULTS: Record<string, string[]> = {
  "sketch3d.point": ["P"],
};

/** Current drawing tool (the X/Y/Z locks only apply to the line, the spline and the point). */
const drawingTool = () => s3.tool === "line" || s3.tool === "spline" || s3.tool === "point";

registerActions([
  ...TOOLS.map(
    (b): ShortcutAction => ({
      id: b.action,
      scope: "sketch3d",
      label: () => t(b.label),
      icon: b.icon,
      defaults: S3D_DEFAULTS[b.action] ?? [],
      run: () => setTool(b.tool),
    }),
  ),
  ...CONSTRAINTS.map(
    (b): ShortcutAction => ({
      id: b.action,
      scope: "sketch3d",
      label: () => t(b.label),
      icon: b.icon,
      defaults: [],
      run: () => constrain(b.cmd),
      enabled: () => canConstrain(b.cmd),
    }),
  ),
  { id: "sketch3d.plane", scope: "sketch3d", label: () => t("s3d.pickPlane"), defaults: [], run: () => setTool("plane") },
  { id: "sketch3d.lookAt", scope: "sketch3d", label: () => t("s3d.normalView"), defaults: [], run: lookAtPlane },
  { id: "sketch3d.delete", scope: "sketch3d", label: () => t("tree.delete"), defaults: [], run: deleteSelection3 },
  { id: "sketch3d.undo", scope: "sketch3d", label: () => t("cmd.undo"), defaults: [], run: undo3, enabled: () => s3.canUndo },
  { id: "sketch3d.redo", scope: "sketch3d", label: () => t("cmd.redo"), defaults: [], run: redo3, enabled: () => s3.canRedo },
  { id: "sketch3d.confirm", scope: "sketch3d", label: () => t("s3d.finish"), defaults: ["Enter"], locked: true, run: applyTypedOrFinish },
  { id: "sketch3d.cancel", scope: "sketch3d", label: () => t("s3d.cancel"), defaults: ["Escape"], locked: true, run: escapeCascade },
  { id: "sketch3d.workplane", scope: "sketch3d", label: () => t("s3d.workPlane"), defaults: ["Tab"], locked: true, run: cyclePlane },
  { id: "sketch3d.lockX", scope: "sketch3d", label: () => t("s3d.lockX"), defaults: ["X"], locked: true, enabled: drawingTool, run: () => setS3("lock", (l) => (l === "X" ? null : "X")) },
  { id: "sketch3d.lockY", scope: "sketch3d", label: () => t("s3d.lockY"), defaults: ["Y"], locked: true, enabled: drawingTool, run: () => setS3("lock", (l) => (l === "Y" ? null : "Y")) },
  { id: "sketch3d.lockZ", scope: "sketch3d", label: () => t("s3d.lockZ"), defaults: ["Z"], locked: true, enabled: drawingTool, run: () => setS3("lock", (l) => (l === "Z" ? null : "Z")) },
]);

/** Value of the work plane selector. */
function planeValue(): string {
  const w = s3.work;
  if (w.mode === "auto") return "auto";
  if (w.mode === "base") return w.base;
  const i = sketchPlanes().findIndex((p) => p.label === w.label);
  return i >= 0 ? `sk${i}` : "custom";
}

function onPlaneChange(value: string): void {
  if (value === "auto") return setWorkPlane({ mode: "auto" });
  if (value === "XY" || value === "XZ" || value === "YZ") return setWorkPlane({ mode: "base", base: value });
  if (value === "pick") return setTool("plane");
  const p = sketchPlanes()[Number(value.slice(2))];
  if (p) setWorkPlane({ mode: "custom", plane: p.plane, label: p.label });
}

/** 3D sketch ribbon (replaces the assembly ribbon during editing). */
export function Sketch3DRibbon() {
  return (
    <div class="ribbon-body">
      <div class="ribbon-group">
        <div class="ribbon-buttons stacked">
          <For each={TOOLS}>
            {(b) => (
              <button
                class="ribbon-btn"
                classList={{ pressed: s3.tool === b.tool }}
                title={previewUrl(b.action) ? undefined : shortcutTitle(t(b.label), b.action)}
                data-preview={previewUrl(b.action)}
                onClick={() => setTool(b.tool)}
              >
                <span class="icon" innerHTML={b.icon} />
                <span>{t(b.label)}</span>
              </button>
            )}
          </For>
        </div>
        <div class="ribbon-group-label">{t("s3d.g.draw")}</div>
      </div>
      <div class="ribbon-group">
        <div class="ribbon-buttons s3-plane-group">
          <label class="s3-plane-select">
            <span>{t("s3d.workPlane")}</span>
            <select value={planeValue()} onChange={(e) => onPlaneChange(e.currentTarget.value)} aria-label={t("s3d.workPlane")}>
              <option value="auto">{t("s3d.auto")}</option>
              <option value="XY">XY</option>
              <option value="XZ">XZ</option>
              <option value="YZ">YZ</option>
              <For each={sketchPlanes()}>{(p, i) => <option value={`sk${i()}`}>{p.label}</option>}</For>
              <Show when={planeValue() === "custom"}>
                <option value="custom">{s3.work.mode === "custom" ? s3.work.label : ""}</option>
              </Show>
              <option value="pick">{t("s3d.pickPlane")}</option>
            </select>
          </label>
          <button
            class="ribbon-btn"
            classList={{ pressed: s3.tool === "plane" }}
            title={t("s3d.pickPlaneHint")}
            onClick={() => setTool("plane")}
          >
            <span class="icon" innerHTML={svg('<path d="M3 16 9 8h12l-6 8z"/><path d="m12 3 2 4-4 0z" fill="currentColor"/>')} />
            <span>{t("s3d.pickPlane")}</span>
          </button>
          <button class="ribbon-btn" title={shortcutTitle(t("s3d.normalView"), "sketch3d.lookAt")} onClick={lookAtPlane}>
            <span class="icon" innerHTML={svg('<path d="M3 16 9 8h12l-6 8z"/><path d="M12 12V2M9 5l3-3 3 3"/>')} />
            <span>{t("s3d.normalView")}</span>
          </button>
        </div>
        <div class="ribbon-group-label">{t("s3d.g.plane")}</div>
      </div>
      <div class="ribbon-group">
        <div class="ribbon-buttons stacked">
          <For each={CONSTRAINTS}>
            {(b) => (
              <button
                class="ribbon-btn"
                disabled={!canConstrain(b.cmd)}
                title={previewUrl(b.action) ? undefined : t(b.label)}
                data-preview={previewUrl(b.action)}
                onClick={() => constrain(b.cmd)}
              >
                <span class="icon" innerHTML={b.icon} />
                <span>{t(b.label)}</span>
              </button>
            )}
          </For>

        </div>
        <div class="ribbon-group-label">{t("s3d.g.constraints")}</div>
      </div>
      <div class="ribbon-group">
        <div class="ribbon-buttons">
          <button class="ribbon-btn" title={shortcutTitle(t("s3d.finish"), "sketch3d.confirm")} onClick={finishSketch3D}>
            <span class="icon" innerHTML={svg('<path d="m5 12 5 5 9-10"/>')} />
            <span>{t("s3d.finish")}</span>
          </button>
          <button class="ribbon-btn" title={shortcutTitle(t("s3d.cancel"), "sketch3d.cancel")} onClick={cancelSketch3D}>
            <span class="icon" innerHTML={svg('<path d="M6 6l12 12M18 6 6 18"/>')} />
            <span>{t("s3d.cancel")}</span>
          </button>
        </div>
        <div class="ribbon-group-label">{t("s3d.title")}</div>
      </div>
    </div>
  );
}
