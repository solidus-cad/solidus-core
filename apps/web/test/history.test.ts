import { describe, expect, it } from "vitest";
import { createPartDocument, type PartDocument } from "@solidus-cad/sdk";
import { packHistory, unpackHistory, type History } from "../src/history.ts";

describe("compressed history", () => {
  it("restores the snapshots exactly and takes much less space", () => {
    const snap = (i: number) => ({ ...createPartDocument(`Pièce${i}`), id: "p" });
    const h: History<PartDocument> = { past: Array.from({ length: 100 }, (_, i) => snap(i)), future: [snap(-1)] };
    const json = JSON.stringify({ past: h.past, future: h.future });
    packHistory(h);
    expect(h.past).toEqual([]);
    expect(h.packed!.byteLength).toBeLessThan(json.length / 10);
    unpackHistory(h);
    expect(h.packed).toBeUndefined();
    expect(JSON.stringify({ past: h.past, future: h.future })).toBe(json);
  });

  it("does nothing on an empty history", () => {
    const h: History<number> = { past: [], future: [] };
    packHistory(h);
    expect(h.packed).toBeUndefined();
    expect(unpackHistory(h)).toBe(h);
  });
});
