import { describe, expect, it } from "vitest";
import { holeThread, paramShown, THREADS, type ParamSpec } from "../src/index.ts";

describe("threads of tapped holes", () => {
  const num = (p: Record<string, string>) => (k: string) => Number(p[k]);

  it("reads the size of each standard, coarse metric by default (older documents)", () => {
    expect(holeThread({ type: "tapped", size: "M8" }, num({}))).toEqual({ name: "M8", major: 8, tap: 6.8 });
    expect(holeThread({ thread: "G", sizeG: "G1/4" }, num({}))).toEqual({ name: "G1/4", major: 13.157, tap: 11.8 });
    expect(holeThread({ thread: "UNC", sizeUNC: "1/4-20 UNC" }, num({}))?.tap).toBe(5.1);
    expect(holeThread({ thread: "G", sizeG: "M8" }, num({}))).toBeNull();
    // Every size has a tap drill smaller than its nominal diameter.
    for (const table of Object.values(THREADS)) for (const t of Object.values(table)) expect(t.tap).toBeLessThan(t.major);
  });

  it("builds a custom metric thread from the diameter and the pitch", () => {
    const p = { thread: "custom", threadD: "14", threadPitch: "1.25" };
    expect(holeThread(p, num(p))).toEqual({ name: "M14×1.25", major: 14, tap: 12.75 });
    expect(holeThread({ ...p, threadPitch: "20" }, num({ ...p, threadPitch: "20" }))).toBeNull();
  });

  it("shows a parameter under combined conditions, with the defaults of missing parameters", () => {
    const specs: ParamSpec[] = [
      { key: "type", label: { fr: "", en: "" }, kind: "enum", default: "simple", options: [] },
      { key: "thread", label: { fr: "", en: "" }, kind: "enum", default: "M", options: [] },
    ];
    const size = { when: { key: "type", is: ["simple"], or: { key: "thread", is: ["M"] } } };
    const sizeG = { when: { key: "thread", is: ["G"], and: { key: "type", is: ["tapped"] } } };
    expect(paramShown(size, {}, specs)).toBe(true);
    expect(paramShown(size, { type: "tapped" }, specs)).toBe(true);
    expect(paramShown(size, { type: "tapped", thread: "G" }, specs)).toBe(false);
    expect(paramShown(sizeG, { type: "tapped", thread: "G" }, specs)).toBe(true);
    expect(paramShown(sizeG, { type: "simple", thread: "G" }, specs)).toBe(false);
  });
});
