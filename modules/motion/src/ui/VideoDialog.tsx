import { createSignal, For, Show } from "solid-js";
import { t, type TKey } from "../texts.ts";
import { getViewer } from "@app/store.ts";
import { ms, setMs, study } from "./session.ts";
import { cancelVideo, exportVideo, type VideoFormat } from "./video.ts";

/** Proposed resolutions; "view": size of the 3D view on screen. */
const SIZES: { id: string; label: TKey; size?: [number, number] }[] = [
  { id: "view", label: "mot.res.view" },
  { id: "720", label: "mot.res.720", size: [1280, 720] },
  { id: "1080", label: "mot.res.1080", size: [1920, 1080] },
];

/** Video export of the displayed study (format, resolution, number of loops), then progress. */
export function VideoDialog() {
  const [size, setSize] = createSignal("1080");
  const [format, setFormat] = createSignal<VideoFormat>("mp4");
  const [loops, setLoops] = createSignal(1);
  const close = () => setMs("videoOpen", false);

  const start = () => {
    const pick = SIZES.find((x) => x.id === size())!;
    const el = getViewer() ? document.querySelector<HTMLElement>(".viewport") : null;
    const [width, height] = pick.size ?? [el?.clientWidth ?? 1280, el?.clientHeight ?? 720];
    void exportVideo({ width, height, format: format(), loops: loops() });
  };

  return (
    <>
      <Show when={ms.videoOpen && study()}>
        <div class="dialog-backdrop" onClick={close}>
          <div class="dialog" role="dialog" aria-modal="true" aria-label={t("mot.video")} onClick={(e) => e.stopPropagation()}>
            <h2>
              {t("mot.video")} — {study()!.name}
            </h2>
            <label class="field">
              <span>{t("mot.format")}</span>
              <select value={format()} onChange={(e) => setFormat(e.currentTarget.value as VideoFormat)}>
                <option value="mp4">MP4 (H.264)</option>
                <option value="webm">WebM (VP9)</option>
              </select>
            </label>
            <label class="field">
              <span>{t("mot.resolution")}</span>
              <select value={size()} onChange={(e) => setSize(e.currentTarget.value)}>
                <For each={SIZES}>{(x) => <option value={x.id}>{t(x.label)}</option>}</For>
              </select>
            </label>
            <Show when={study()!.loop}>
              <label class="field">
                <span>{t("mot.loops")}</span>
                <input type="number" min="1" max="20" step="1" value={loops()} onChange={(e) => setLoops(Math.max(1, Math.min(20, Math.round(Number(e.currentTarget.value) || 1))))} />
              </label>
            </Show>
            <p class="field-hint">
              {study()!.duration * loops()} s · {study()!.fps} {t("mot.fps")} · {t((study()!.camera?.length ?? 0) > 0 ? "mot.cameraAnimated" : "mot.cameraCurrent")}
            </p>
            <div class="dialog-actions">
              <button class="btn" onClick={close}>
                {t("mot.cancel")}
              </button>
              <button class="btn primary" onClick={start}>
                {t("mot.export")}
              </button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={ms.exporting !== null}>
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-modal="true" aria-label={t("mot.exporting")}>
            <h2>{t("mot.exporting")}</h2>
            <progress class="motion-progress" max="1" value={ms.exporting ?? 0} />
            <p class="field-hint">{Math.round((ms.exporting ?? 0) * 100)} %</p>
            <div class="dialog-actions">
              <button class="btn" onClick={cancelVideo}>
                {t("mot.cancel")}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
