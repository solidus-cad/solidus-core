import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { MAX_ARCHIVE_FILES, readMachineArchive } from "../src/archive.ts";

/** Read guards for .vasm archives (archives submitted by the community). */
describe("readMachineArchive: malicious archives", () => {
  const asm = strToU8(JSON.stringify({ format: "cad.assembly", formatVersion: 1, id: "a", name: "A", components: [], groups: [], mates: [] }));

  it("accepts an ordinary archive", () => {
    expect(readMachineArchive(zipSync({ "assembly.json": asm })).assembly.id).toBe("a");
  });

  it("rejects an archive that decompresses beyond 50 MB (a few KB compressed)", () => {
    const bomb = zipSync({ "assembly.json": asm, "padding.bin": new Uint8Array(60 * 1024 * 1024) }, { level: 1 });
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => readMachineArchive(bomb)).toThrow(/50 Mo/);
  }, 30_000);

  it("rejects an archive with too many files", () => {
    const files: Record<string, Uint8Array> = { "assembly.json": asm };
    for (let i = 0; i <= MAX_ARCHIVE_FILES; i++) files[`x/${i}.txt`] = new Uint8Array(1);
    expect(() => readMachineArchive(zipSync(files))).toThrow(/fichiers/);
  });
});
