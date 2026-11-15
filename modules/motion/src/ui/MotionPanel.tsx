import { For, Show } from "solid-js";
import type { MotionEase, MotionKey } from "@solidus-cad/sdk";
import { t } from "../texts.ts";
import { occurrenceLabel, ws } from "@app/workspace.ts";
import { isRelative, trackKindsFor, trackSpeed } from "./engine.ts";
import {
  collisionsAt,
  deleteTrack,
  drivableMates,
  finishMotion,
  frameOf,
  keysOf,
  mateLabel,
  ms,
  selectStudy,
  setKey,
  setMs,
  setStudy,
  setTrack,
  setTrackSpeed,
  studies,
  study,
  unitOf,
} from "./session.ts";

/** Number read from a field (empty: undefined). */
const num = (s: string): number | undefined => {
  const v = Number(s.replace(",", "."));
  return s.trim() === "" || !Number.isFinite(v) ? undefined : v;
};
const round = (v: number) => Math.round(v * 1000) / 1000 + 0;
/** Degrees per second in one revolution per minute. */
const DEG_S_PER_RPM = 6;

/** Left panel of the Motion workbench: study, drivable mates, tracks and selected key. */
export function MotionPanel() {
  const s = () => study();
  const track = () => s()?.tracks.find((x) => x.id === ms.track);
  const key = () => (ms.track && ms.key !== null ? keysOf(ms.track)[ms.key] : undefined);
  const frame = () => (void ms.baked, frameOf(ms.time));
  const mateOf = (id: string) => ws.asm?.mates.find((m) => m.id === id);

  return (
    <div class="property-panel motion-panel">
      <div class="panel-header">
        <h2>{t("mot.title")}</h2>
      </div>
      <div class="panel-actions">
        <button class="btn" onClick={finishMotion}>
          {t("mot.close")}
        </button>
      </div>

      <Show when={s()}>
        {(st) => (
          <>
            <label class="field">
              <span>{t("mot.study")}</span>
              <select value={st().id} onChange={(e) => selectStudy(e.currentTarget.value)}>
                <For each={studies()}>{(x) => <option value={x.id}>{x.name}</option>}</For>
              </select>
            </label>
            <label class="field">
              <span>{t("mot.name")}</span>
              <input value={st().name} onChange={(e) => e.currentTarget.value.trim() && setStudy({ name: e.currentTarget.value.trim() })} />
            </label>
            <div class="motion-row2">
              <label class="field">
                <span>{t("mot.duration")} (s)</span>
                <input type="number" min="0.1" step="0.5" value={st().duration} onChange={(e) => setStudy({ duration: num(e.currentTarget.value) ?? st().duration })} />
              </label>
              <label class="field">
                <span>{t("mot.fps")}</span>
                <input type="number" min="1" max="120" step="1" value={st().fps} onChange={(e) => setStudy({ fps: Math.round(num(e.currentTarget.value) ?? st().fps) })} />
              </label>
            </div>
            <Show when={st().collisions?.enabled}>
              <label class="field">
                <span>{t("mot.collisionStep")}</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={st().collisions!.step}
                  onChange={(e) => setStudy({ collisions: { enabled: true, step: Math.max(1, Math.round(num(e.currentTarget.value) ?? 5)) } })}
                />
              </label>
            </Show>

            <div class="tree-section-title static">{t("mot.mates")}</div>
            <Show when={drivableMates().length > 0} fallback={<small class="field-hint">{t("mot.noMates")}</small>}>
              <For each={drivableMates()}>
                {(m) => {
                  const driven = () => st().tracks.some((x) => x.mate === m.id);
                  return (
                    <div class="tree-row" classList={{ active: ms.mate === m.id }} onClick={() => setMs("mate", m.id)} title={trackKindsFor(m).map((k) => t(k === "rotary" ? "mot.rotary" : "mot.linear")).join(" · ")}>
                      <span class="name">{mateLabel(m)}</span>
                      <Show when={driven()}>
                        <span class="motion-badge">{t("mot.driven")}</span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Show>

            <div class="tree-section-title static">{t("mot.tracks")}</div>
            <Show when={st().tracks.length > 0} fallback={<small class="field-hint">{t("mot.noTracks")}</small>}>
              <For each={st().tracks}>
                {(tr) => (
                  <div class="tree-row" classList={{ active: ms.track === tr.id, suppressed: !!tr.muted }} onClick={() => setMs({ track: tr.id, key: null })}>
                    <span class="name">
                      {tr.kind === "rotary" ? "⟳" : "⇄"} {mateOf(tr.mate) ? mateLabel(mateOf(tr.mate)!) : t("mot.missingMate")}
                    </span>
                    <button
                      class="icon-btn"
                      title={tr.muted ? t("mot.unmute") : t("mot.mute")}
                      aria-label={tr.muted ? t("mot.unmute") : t("mot.mute")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setTrack(tr.id, { muted: !tr.muted || undefined });
                      }}
                    >
                      {tr.muted ? "○" : "●"}
                    </button>
                    <button
                      class="icon-btn"
                      title={t("tree.delete")}
                      aria-label={t("tree.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteTrack(tr.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </Show>

            <Show when={track()}>
              {(tr) => (
                <div class="motion-editor">
                  <Show when={mateOf(tr().mate) && isRelative(mateOf(tr().mate)!)}>
                    <label class="check">
                      <input type="checkbox" checked={!!tr().reverse} onChange={(e) => setTrack(tr().id, { reverse: e.currentTarget.checked || undefined })} />
                      {t("mot.reverse")}
                    </label>
                  </Show>
                  <div class="tree-section-title static">{t("mot.limits")}</div>
                  <div class="motion-row2">
                    <label class="field">
                      <span>
                        {t("mot.min")} ({unitOf(tr())})
                      </span>
                      <input value={tr().min ?? ""} placeholder="—" onChange={(e) => setTrack(tr().id, { min: num(e.currentTarget.value) })} />
                    </label>
                    <label class="field">
                      <span>
                        {t("mot.max")} ({unitOf(tr())})
                      </span>
                      <input value={tr().max ?? ""} placeholder="—" onChange={(e) => setTrack(tr().id, { max: num(e.currentTarget.value) })} />
                    </label>
                  </div>
                  {(() => {
                    const scale = () => (tr().kind === "rotary" ? DEG_S_PER_RPM : 1);
                    const speed = () => trackSpeed(tr());
                    return (
                      <label class="field" title={speed() === null ? t("mot.speedHint") : undefined}>
                        <span>
                          {t("mot.speed")} ({t(tr().kind === "rotary" ? "mot.rpm" : "mot.mms")})
                        </span>
                        <input
                          type="number"
                          step="any"
                          disabled={speed() === null}
                          value={speed() === null ? "" : round(speed()! / scale())}
                          placeholder="—"
                          onChange={(e) => {
                            const v = num(e.currentTarget.value);
                            if (v !== undefined) setTrackSpeed(tr().id, v * scale());
                          }}
                        />
                      </label>
                    );
                  })()}
                </div>
              )}
            </Show>

            <Show when={key()}>
              {(k) => (
                <div class="motion-editor">
                  <div class="tree-section-title static">{t("mot.key")}</div>
                  <div class="motion-row2">
                    <label class="field">
                      <span>{t("mot.time")} (s)</span>
                      <input type="number" step="0.1" min="0" max={st().duration} value={round(k().t)} onChange={(e) => setKey(ms.track!, ms.key!, { t: num(e.currentTarget.value) ?? k().t })} />
                    </label>
                    <Show when={ms.track !== "camera"}>
                      <label class="field">
                        <span>
                          {t("mot.value")} ({unitOf(track() ?? { kind: "linear" })})
                        </span>
                        <input type="number" step="any" value={round((k() as MotionKey).value)} onChange={(e) => setKey(ms.track!, ms.key!, { value: num(e.currentTarget.value) ?? (k() as MotionKey).value })} />
                      </label>
                    </Show>
                  </div>
                  <label class="field">
                    <span>{t("mot.ease")}</span>
                    <select value={k().ease ?? "linear"} onChange={(e) => setKey(ms.track!, ms.key!, { ease: e.currentTarget.value as MotionEase })}>
                      <option value="linear">{t("mot.ease.linear")}</option>
                      <option value="ease">{t("mot.ease.ease")}</option>
                      <option value="step">{t("mot.ease.step")}</option>
                    </select>
                  </label>
                </div>
              )}
            </Show>

            <Show when={frame()?.failing.length}>
              <div class="sk-status error" role="alert">
                {t("mot.failingAt")} : {frame()!.failing.map((id) => (mateOf(id) ? mateLabel(mateOf(id)!) : id)).join(", ")}
              </div>
            </Show>
            <Show when={frame()?.overLimit.length}>
              <div class="sk-status warn">{t("mot.limitReached")}</div>
            </Show>
            <Show when={collisionsAt(ms.time).length > 0}>
              <div class="sk-status warn" role="alert">
                {t("mot.collisionAt")} :
                <For each={collisionsAt(ms.time)}>{(c) => <div>{occurrenceLabel(c.a)} ↔ {occurrenceLabel(c.b)}</div>}</For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
