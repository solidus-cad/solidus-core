import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createAssemblyDocument, createPartDocument } from "@solidus-cad/sdk";
import { readMachineArchive } from "@solidus-cad/assembly";
import {
  addCheckpoint,
  checkpointsOf,
  clearCheckpointDirty,
  deleteCheckpoint,
  forgetCheckpoints,
  isCheckpointDirty,
  nextNumber,
  readCheckpoints,
  setHead,
  snapshotOf,
  writeCheckpoints,
} from "../src/checkpoints.ts";

describe("checkpoints", () => {
  it("numbers the versions and keeps the later versions after a revert", () => {
    const id = "p1";
    const doc = createPartDocument("Pièce");
    addCheckpoint(id, { ...doc, name: "A" }, "première");
    addCheckpoint(id, { ...doc, name: "B" }, "deuxième");
    addCheckpoint(id, { ...doc, name: "C" }, "troisième");
    expect(checkpointsOf(id).head).toBe(3);
    // Revert to v1: v2 and v3 remain, the next one (v4) starts from v1.
    setHead(id, 1);
    const c = addCheckpoint(id, { ...doc, name: "D" }, "branche");
    expect(c).toMatchObject({ number: 4, parent: 1 });
    expect(checkpointsOf(id).list.map((x) => [x.number, x.parent])).toEqual([
      [1, null],
      [2, 1],
      [3, 2],
      [4, 1],
    ]);
    expect(snapshotOf<typeof doc>(id, 2)!.name).toBe("B");
    expect(nextNumber(id)).toBe(5);
    expect(isCheckpointDirty(id)).toBe(true);
    clearCheckpointDirty([id]);
    expect(isCheckpointDirty(id)).toBe(false);
    forgetCheckpoints(id);
    expect(checkpointsOf(id).list).toEqual([]);
  });

  it("deletion: the versions derived from it are attached to the parent, the numbers are not reused", () => {
    const id = "p3";
    const doc = createPartDocument("Pièce");
    for (const c of ["un", "deux", "trois"]) addCheckpoint(id, doc, c);
    deleteCheckpoint(id, 2);
    expect(checkpointsOf(id).list.map((x) => [x.number, x.parent])).toEqual([
      [1, null],
      [3, 1],
    ]);
    // The current version deleted: the document derives from its parent; v3 is not reassigned.
    deleteCheckpoint(id, 3);
    expect(checkpointsOf(id).head).toBe(1);
    expect(snapshotOf(id, 3)).toBeUndefined();
    expect(addCheckpoint(id, doc, "quatre")).toMatchObject({ number: 4, parent: 1 });
    // Read back from the archive, the counter is kept.
    deleteCheckpoint(id, 4);
    const files: Record<string, Uint8Array> = {};
    writeCheckpoints(files, id);
    forgetCheckpoints(id);
    readCheckpoints(files, id);
    expect(nextNumber(id)).toBe(5);
    forgetCheckpoints(id);
  });

  it("are saved in the archive and read back", () => {
    const id = "p2";
    const doc = createPartDocument("Pièce");
    addCheckpoint(id, { ...doc, name: "v1" }, "un", "Alice");
    addCheckpoint(id, { ...doc, name: "v2" }, "deux");
    setHead(id, 1);
    const files: Record<string, Uint8Array> = {};
    writeCheckpoints(files, id);
    const zip = unzipSync(zipSync(files));
    forgetCheckpoints(id);
    expect(readCheckpoints(zip, id)).toBe(true);
    expect(checkpointsOf(id)).toMatchObject({ head: 1, list: [{ number: 1, comment: "un", author: "Alice" }, { number: 2, parent: 1 }] });
    expect(snapshotOf<typeof doc>(id, 2)!.name).toBe("v2");
    expect(isCheckpointDirty(id)).toBe(false);
    expect(readCheckpoints(zip, "autre")).toBe(false);
  });

  it("do not prevent reading a .vasm", () => {
    const asm = createAssemblyDocument("Ensemble");
    const part = createPartDocument("Pièce");
    addCheckpoint(asm.id, { assembly: asm, parts: [part], assemblies: [] }, "asm");
    const files: Record<string, Uint8Array> = {
      "assembly.json": strToU8(JSON.stringify(asm)),
      [`parts/${part.id}.json`]: strToU8(JSON.stringify(part)),
    };
    writeCheckpoints(files, asm.id);
    const b = readMachineArchive(zipSync(files));
    expect(b.assembly.id).toBe(asm.id);
    expect(b.parts.map((p) => p.id)).toEqual([part.id]);
  });
});
