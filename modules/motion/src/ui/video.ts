import { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat, type VideoCodec } from "mediabunny";
import { getViewer, setMessage } from "@app/store.ts";
import { saveBlob } from "@app/files.ts";
import { t } from "../texts.ts";
import { frameCount, frameTime } from "./engine.ts";
import { bakedFrames, ms, pause, seek, setMs, study } from "./session.ts";

/**
 * Video export of a study: each frame is posed then rendered outside the display loop, at the rate
 * of the study (deterministic rendering, independent of the machine's speed), then encoded by WebCodecs:
 * MP4 (H.264) preferred, WebM (VP9 / VP8) otherwise.
 */

export type VideoFormat = "mp4" | "webm";

export interface VideoOptions {
  width: number;
  height: number;
  format: VideoFormat;
  /** Number of chained playbacks (loop). */
  loops: number;
}

/** Codec chosen for a format and a size, or null if the browser cannot encode it. */
async function pickCodec(format: VideoFormat, width: number, height: number): Promise<{ format: VideoFormat; codec: VideoCodec } | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const order: { format: VideoFormat; codec: VideoCodec }[] =
    format === "mp4"
      ? [{ format: "mp4", codec: "avc" }, { format: "webm", codec: "vp9" }, { format: "webm", codec: "vp8" }]
      : [{ format: "webm", codec: "vp9" }, { format: "webm", codec: "vp8" }];
  for (const c of order) if (await canEncodeVideo(c.codec, { width, height, bitrate: QUALITY_HIGH })) return c;
  return null;
}

/** Dimensions accepted by the encoders (even). */
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

let cancelled = false;

export function cancelVideo(): void {
  cancelled = true;
}

export async function exportVideo(opts: VideoOptions): Promise<void> {
  const s = study();
  const v = getViewer();
  const frames = bakedFrames();
  if (!s || !v || ms.baking || frames.length < frameCount(s)) return setMessage(t("mot.notBaked"));
  const width = even(opts.width);
  const height = even(opts.height);
  const choice = await pickCodec(opts.format, width, height);
  if (!choice) return setMessage(t("mot.noEncoder"));
  if (choice.format !== opts.format) setMessage(t("mot.webmFallback"));

  pause();
  const savedTime = ms.time;
  const savedCamera = v.cameraState();
  const target = new BufferTarget();
  const output = new Output({ format: choice.format === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target });
  const canvas = v.beginCapture(width, height);
  const source = new CanvasSource(canvas, { codec: choice.codec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: s.fps });
  cancelled = false;
  setMs({ exporting: 0, videoOpen: false });
  const n = frameCount(s);
  // In a loop, the last frame (identical to the first of a cycle) is not repeated between two playbacks.
  const perLoop = opts.loops > 1 && s.loop ? n - 1 : n;
  const total = perLoop * Math.max(1, opts.loops);
  try {
    await output.start();
    for (let k = 0; k < total; k++) {
      if (cancelled) {
        await output.cancel();
        setMessage(t("mot.videoCancelled"));
        return;
      }
      seek(frameTime(s, k % perLoop));
      v.captureFrame();
      await source.add(k / s.fps, 1 / s.fps);
      setMs("exporting", (k + 1) / total);
    }
    source.close();
    await output.finalize();
  } catch (e) {
    setMessage((e as Error).message);
    return;
  } finally {
    v.endCapture();
    v.setCameraState(savedCamera);
    seek(savedTime);
    setMs("exporting", null);
  }
  const ext = choice.format === "mp4" ? ".mp4" : ".webm";
  try {
    await saveBlob(new Uint8Array(target.buffer!), `${s.name}${ext}`, choice.format === "mp4" ? "video/mp4" : "video/webm", ext);
    setMessage(t("mot.videoSaved"));
  } catch {
    /* recording cancelled */
  }
}
