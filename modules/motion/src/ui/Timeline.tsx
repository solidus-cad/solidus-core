import { createMemo, createSignal, For, Show } from "solid-js";
import type { MotionTrack } from "@solidus-cad/sdk";
import { t, type TKey } from "../texts.ts";
import { ws } from "@app/workspace.ts";
import { frameCount, valueAt } from "./engine.ts";
import { addKey, keysOf, mateLabel, ms, rewind, seek, setKey, setMs, setSpeed, study, toggleLoop, togglePlay, type FrameStatus } from "./session.ts";

/** Timeline height kept in storage (display comfort, per browser). */
const HEIGHT_KEY = "cad.motion.timelineHeight";
const savedHeight = (): number => {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return v >= 120 && v <= 600 ? v : 200;
  } catch {
    return 200;
  }
};

const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** Ruler ticks: a "round" step giving about ten marks. */
function ticks(duration: number): number[] {
  const raw = duration / 10;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let x = 0; x <= duration + 1e-9; x += step) out.push(Math.round(x * 1000) / 1000);
  return out;
}

/** Ranges of frames with the same state (one band per range, rather than one per frame). */
function runs(status: FrameStatus[]): { from: number; to: number; s: FrameStatus }[] {
  const out: { from: number; to: number; s: FrameStatus }[] = [];
  status.forEach((s, i) => {
    const last = out[out.length - 1];
    if (last && last.s === s) last.to = i + 1;
    else out.push({ from: i, to: i + 1, s });
  });
  return out;
}

/** Timeline of the Motion workbench, below the 3D view. */
export function Timeline() {
  const [height, setHeight] = createSignal(savedHeight());
  /** Key being dragged: track, rank, provisional time. */
  const [drag, setDrag] = createSignal<{ track: string; index: number; t: number } | null>(null);
  const s = () => study();
  const dur = () => Math.max(1e-6, s()?.duration ?? 1);
  const pct = (time: number) => `${(time / dur()) * 100}%`;
  let lanes: HTMLDivElement | undefined;

  /** Time under the pointer (snapped to the nearest frame). */
  const timeAt = (clientX: number): number => {
    const st = s();
    if (!lanes || !st) return 0;
    const r = lanes.getBoundingClientRect();
    const raw = ((clientX - r.left) / Math.max(1, r.width)) * st.duration;
    return Math.max(0, Math.min(st.duration, Math.round(raw * st.fps) / st.fps));
  };

  const scrub = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const dragKey = (e: PointerEvent, track: string, index: number) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setMs({ track, key: index });
    const t0 = keysOf(track)[index]?.t ?? 0;
    setDrag({ track, index, t: t0 });
    const move = (ev: PointerEvent) => setDrag({ track, index, t: timeAt(ev.clientX) });
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      const d = drag();
      setDrag(null);
      if (d && Math.abs(d.t - t0) > 1e-9) setKey(track, index, { t: d.t });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const resize = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = height();
    const move = (ev: PointerEvent) => setHeight(Math.max(120, Math.min(600, h0 + y0 - ev.clientY)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(height()));
      } catch {
        /* storage unavailable */
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  /** Displayed time of a key (provisional during a drag). */
  const keyTime = (track: string, index: number, time: number) => {
    const d = drag();
    return d && d.track === track && d.index === index ? d.t : time;
  };

  /** Value curve of a track (normalized to the lane height). */
  const curve = (tr: MotionTrack): string => {
    const n = 120;
    const vals = Array.from({ length: n + 1 }, (_, i) => valueAt(tr, (i / n) * dur()).value);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo || 1;
    return vals.map((v, i) => `${(i / n) * 1000},${90 - ((v - lo) / span) * 80}`).join(" ");
  };

  const statusRuns = createMemo(() => runs(ms.status));
  const total = () => (s() ? frameCount(s()!) : 1);
  const mateOf = (id: string) => ws.asm?.mates.find((m) => m.id === id);
  const fmt = (v: number) => v.toFixed(2);

  return (
    <Show when={s()}>
      {(st) => (
        <div class="motion-timeline" style={{ height: `${height()}px` }} role="region" aria-label={t("mot.timeline")}>
          <div class="motion-resize" onPointerDown={resize} title={t("mot.resize")} />
          <div class="motion-transport">
            <button class="icon-btn" title={t("mot.rewind")} aria-label={t("mot.rewind")} onClick={rewind}>
              ⏮
            </button>
            <button class="icon-btn motion-play" title={ms.playing ? t("mot.pause") : t("mot.play")} aria-label={ms.playing ? t("mot.pause") : t("mot.play")} onClick={togglePlay}>
              {ms.playing ? "⏸" : "▶"}
            </button>
            <button class="icon-btn" classList={{ pressed: st().loop }} title={t("mot.loop")} aria-label={t("mot.loop")} aria-pressed={st().loop} onClick={toggleLoop}>
              ⟲
            </button>
            <span class="motion-clock">
              {fmt(ms.time)} / {fmt(st().duration)} s
            </span>
            <label class="motion-speed">
              <span>{t("mot.speed")}</span>
              <select value={ms.speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))}>
                <For each={SPEEDS}>{(v) => <option value={v}>×{v}</option>}</For>
              </select>
            </label>
            <span class="motion-state">
              <Show when={ms.baking}>
                {t("mot.baking")} {ms.baked}/{total()}
              </Show>
              <Show when={ms.checking}> · {t("mot.checking")}</Show>
              <Show when={ms.exporting !== null}> · {t("mot.exporting")} {Math.round((ms.exporting ?? 0) * 100)} %</Show>
            </span>
          </div>

          <div class="motion-grid">
            <div class="motion-label" />
            <div class="motion-ruler" onPointerDown={scrub} ref={lanes}>
              <For each={ticks(st().duration)}>
                {(x) => (
                  <span class="motion-tick" classList={{ end: x >= st().duration - 1e-9 && x > 0 }} style={{ left: pct(x) }}>
                    {x}
                  </span>
                )}
              </For>
            </div>

            <div class="motion-label">{t("mot.state")}</div>
            <div class="motion-lane motion-status" onPointerDown={scrub}>
              <For each={statusRuns()}>
                {(r) => <span class={`motion-run ${r.s}`} style={{ left: `${(r.from / total()) * 100}%`, width: `${((r.to - r.from) / total()) * 100}%` }} title={t(`mot.status.${r.s}` as TKey)} />}
              </For>
            </div>

            <div class="motion-label" classList={{ active: ms.track === "camera" }} onClick={() => setMs({ track: "camera", key: null })}>
              {t("mot.camera")}
            </div>
            <div class="motion-lane" classList={{ active: ms.track === "camera" }} onPointerDown={scrub}>
              <For each={keysOf("camera")}>
                {(k, i) => (
                  <span
                    class="motion-key camera"
                    classList={{ selected: ms.track === "camera" && ms.key === i() }}
                    style={{ left: pct(keyTime("camera", i(), k.t)) }}
                    title={`${fmt(k.t)} s`}
                    onPointerDown={(e) => dragKey(e, "camera", i())}
                  />
                )}
              </For>
            </div>

            <For each={st().tracks}>
              {(tr) => (
                <>
                  <div class="motion-label" classList={{ active: ms.track === tr.id, muted: !!tr.muted }} onClick={() => setMs({ track: tr.id, key: null })} title={mateOf(tr.mate) ? mateLabel(mateOf(tr.mate)!) : ""}>
                    {tr.kind === "rotary" ? "⟳" : "⇄"} {mateOf(tr.mate) ? mateLabel(mateOf(tr.mate)!) : t("mot.missingMate")}
                  </div>
                  <div
                    class="motion-lane"
                    classList={{ active: ms.track === tr.id, muted: !!tr.muted }}
                    onPointerDown={scrub}
                    onDblClick={(e) => addKey(tr.id, timeAt(e.clientX))}
                    title={t("mot.dblClickKey")}
                  >
                    <svg class="motion-curve" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
                      <polyline points={curve(tr)} />
                    </svg>
                    <For each={keysOf(tr.id)}>
                      {(k, i) => (
                        <span
                          class="motion-key"
                          classList={{ selected: ms.track === tr.id && ms.key === i(), step: k.ease === "step", ease: k.ease === "ease" }}
                          style={{ left: pct(keyTime(tr.id, i(), k.t)) }}
                          title={`${fmt(k.t)} s · ${"value" in k ? k.value : ""} ${tr.kind === "rotary" ? "°" : "mm"}`}
                          onPointerDown={(e) => dragKey(e, tr.id, i())}
                        />
                      )}
                    </For>
                  </div>
                </>
              )}
            </For>

            <div class="motion-playhead-host">
              <span class="motion-playhead" style={{ left: pct(ms.time) }} />
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
