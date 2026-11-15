import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readXlsx, writeXlsx } from "../src/xlsx.ts";

// Parsing of untrusted workbooks (zip bombs, quadratic tags…) is tested where workbooks come from outside.
describe("xlsx", () => {
  it("reads back what it writes (text, numbers, special characters, empty cells)", () => {
    const table = [
      ["Configuration", "L", "D", "Note"],
      ["Vis M6×20", "20", "6", "acier <8.8> & zingué"],
      ["Vis M8×30", "30.5", "", "é"],
    ];
    expect(readXlsx(writeXlsx(table))).toEqual(table.map((r) => r.map((c) => c)));
  });

  it("stays linear on a sheet of unclosed rows", () => {
    const data = zipSync({ "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${"<row>".repeat(200_000)}</sheetData></worksheet>`) });
    const t = performance.now();
    expect(readXlsx(data)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
