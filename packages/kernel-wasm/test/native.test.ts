// Parity between native cad-core (cad-kernel process, as in the desktop application) and WASM cad-core: same protocol
// as Tauri (frames over stdin / stdout), deferred preparation callbacks included. Skipped if the native kernel is not
// built (tools/build-kernel.sh native).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-ignore -- Node modules, available under Vitest.
import { spawn } from "node:child_process";
// @ts-ignore
import { existsSync } from "node:fs";
// @ts-ignore
import { fileURLToPath } from "node:url";
import type { RecomputeResult } from "@solidus-cad/sdk";
import { SketchSolver } from "@solidus-cad/sketch";
import { WasmKernelEngine } from "../src/engine.ts";
import { NativeKernelEngine, type Exchange } from "../src/native.ts";
import { doc, SCENARIOS } from "./scenarios.ts";

const EXE: string = fileURLToPath(new URL("../../../build/core-native/bindings/cad-kernel.exe", import.meta.url));
const available = existsSync(EXE);

/** Node transport: same frames as kernel.rs (Tauri), [u32 length][payload]. */
function nodeExchange(path: string): { exchange: Exchange; close(): void } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child: any = spawn(path, [], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = new Uint8Array(0);
  let waiting: ((frame: Uint8Array) => void) | null = null;
  const pump = () => {
    if (!waiting || buf.length < 4) return;
    const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
    if (buf.length < 4 + n) return;
    const frame = buf.slice(4, 4 + n);
    buf = buf.slice(4 + n);
    const w = waiting;
    waiting = null;
    w(frame);
  };
  child.stdout.on("data", (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    pump();
  });
  const exchange: Exchange = (frame) =>
    new Promise((resolve) => {
      waiting = resolve;
      const payload = new TextEncoder().encode(frame);
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint32(0, payload.length, true);
      child.stdin.write(head);
      child.stdin.write(payload);
      pump();
    });
  return { exchange, close: () => child.kill() };
}

let wasm: WasmKernelEngine;
let native: NativeKernelEngine;
let transport: ReturnType<typeof nodeExchange> | undefined;

beforeAll(async () => {
  if (!available) return;
  const solver = await SketchSolver.create();
  wasm = await WasmKernelEngine.create(solver);
  transport = nodeExchange(EXE);
  native = new NativeKernelEngine(transport.exchange, solver);
});

afterAll(() => transport?.close());

const close = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

function same(a: RecomputeResult, b: RecomputeResult): void {
  expect(b.statuses).toEqual(a.statuses);
  expect(b.rebuilt).toBe(a.rebuilt);
  expect(b.mass === null).toBe(a.mass === null);
  if (a.mass && b.mass) {
    expect(close(b.mass.volume, a.mass.volume), `volume ${b.mass.volume} ≠ ${a.mass.volume}`).toBe(true);
    expect(close(b.mass.area, a.mass.area), `aire ${b.mass.area} ≠ ${a.mass.area}`).toBe(true);
  }
  expect(b.mesh?.faceGroups.length).toBe(a.mesh?.faceGroups.length);
  expect(b.mesh?.names).toEqual(a.mesh?.names);
  expect(Object.keys(b.sketches).sort()).toEqual(Object.keys(a.sketches).sort());
}

describe.skipIf(!available)("cad-core native / WASM", () => {
  it("responds to the protocol", async () => {
    expect(await native.ping()).toBe("cad-core");
  });

  for (const [name, make] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const d = make();
      same(wasm.recompute(d), await native.recompute(d));
    });
  }

  it("calls back the client for a sketch with projected edges, then reuses its cache", async () => {
    const sk = {
      id: "sk",
      type: "sketch",
      params: {},
      sketch: {
        plane: { base: "XY" as const, offset: "0", face: { p: [50, 30, 40] as [number, number, number], n: [0, 0, 1] as [number, number, number] } },
        geometry: [
          { id: "a", type: "point" as const, x: 0, y: 0 },
          { id: "b", type: "point" as const, x: 100, y: 0 },
          { id: "l", type: "line" as const, p1: "a", p2: "b", projected: { kind: "edge" as const, p: [50, 0, 40] as [number, number, number], size: 100 } },
        ],
        constraints: [],
        dimensions: [],
      },
    };
    const box = (w: string) => ({ type: "box", params: { width: w, depth: "60", height: "40", x: "0", y: "0", z: "0", op: "add" } });
    for (const w of ["100", "120", "120"]) {
      const d = doc([box(w), sk]);
      d.id = "projected";
      const a = wasm.recompute(d);
      const b = await native.recompute(d);
      same(a, b);
      const pb = b.sketches.sk!.geometry.find((g) => g.id === "b") as { x: number };
      expect(pb.x).toBeCloseTo(Number(w), 6);
    }
  });

  it("exports, projects drawings, flattens and measures interference like the WASM build", async () => {
    const part = SCENARIOS["box with hole"]!();
    wasm.recompute(part);
    await native.recompute(part);
    const step = new TextDecoder().decode(await native.exportShape("step", part.id));
    expect(step.startsWith("ISO-10303-21")).toBe(true);
    expect((await native.exportShape("stl", part.id)).length).toBeGreaterThan(100);

    const [va] = wasm.project(part, ["front"]);
    const [vb] = await native.project(part, ["front"]);
    expect(vb!.bounds).toEqual(va!.bounds.map((x) => expect.closeTo(x, 4)));
    expect(vb!.visible.length).toBe(va!.visible.length);

    const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const parts = [
      { key: "A", doc: part, matrix: at(0) },
      { key: "B", doc: part, matrix: at(90) },
    ];
    const ia = wasm.interferences(parts);
    const ib = await native.interferences(parts);
    expect(ib.map((i) => [i.a, i.b])).toEqual(ia.map((i) => [i.a, i.b]));
    expect(close(ib[0]!.volume, ia[0]!.volume)).toBe(true);

    await expect(native.flatPattern(part)).rejects.toThrow("tôle");
  });

  it("reports a failed request without stopping the kernel", async () => {
    await expect(native.exportShape("obj" as never, "inconnu")).rejects.toThrow();
    expect(await native.ping()).toBe("cad-core");
  });
});
