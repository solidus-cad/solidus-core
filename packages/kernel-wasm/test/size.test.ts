import { describe, expect, it } from "vitest";
// @ts-ignore -- Node modules, available under Vitest.
import { existsSync, readFileSync } from "node:fs";
// @ts-ignore
import { gzipSync } from "node:zlib";

/**
 * Size budget of the kernel module (core/README.md, "Module size"): the test fails when the module grows beyond it,
 * so that a growth is noticed and the budget raised on purpose (table of the README updated at the same time).
 */
const BUDGET = { raw: 22 * 2 ** 20, gzip: 7 * 2 ** 20 };
const wasm = new URL("../dist/kernel.wasm", import.meta.url);

describe.skipIf(!existsSync(wasm))("kernel.wasm size", () => {
  it("stays within its budget, raw and compressed", () => {
    const bytes = readFileSync(wasm);
    const gzip = gzipSync(bytes, { level: 9 }).length;
    console.info(`kernel.wasm: ${(bytes.length / 2 ** 20).toFixed(1)} MiB, gzip -9 ${(gzip / 2 ** 20).toFixed(1)} MiB`);
    expect(bytes.length).toBeLessThan(BUDGET.raw);
    expect(gzip).toBeLessThan(BUDGET.gzip);
  });
});
