import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { AssemblyDocument, PartDocument } from "@solidus-cad/sdk";

/**
 * Machine `.vasm` archive: same structure as an ordinary assembly
 * (`assembly.json` + `parts/<id>.json` + `assemblies/<id>.json`). The machine definition lives in `assembly.json`
 * (`machine` field), so the machine can be opened, edited and saved again like an assembly without losing its kinematics.
 */
export function machineArchive(asm: AssemblyDocument, parts: PartDocument[], assemblies: AssemblyDocument[] = []): Uint8Array {
  const files: Record<string, Uint8Array> = { "assembly.json": strToU8(JSON.stringify(asm, null, 2)) };
  for (const p of parts) files[`parts/${p.id}.json`] = strToU8(JSON.stringify(p, null, 2));
  for (const a of assemblies) files[`assemblies/${a.id}.json`] = strToU8(JSON.stringify(a, null, 2));
  return zipSync(files, { level: 6 });
}

export interface AssemblyBundle {
  assembly: AssemblyDocument;
  parts: PartDocument[];
  /** Sub-assemblies (all levels). */
  assemblies: AssemblyDocument[];
}

/** Reads a `.vasm` archive (assembly or machine). Throws an error if the archive is not an assembly. */
/** Guards against malicious archives (zip bombs): total uncompressed size and number of files. */
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 1000;

export function readMachineArchive(data: Uint8Array): AssemblyBundle {
  let files: Record<string, Uint8Array>;
  let total = 0;
  let count = 0;
  try {
    // The filter sees the declared size of each file before it is decompressed.
    files = unzipSync(data, {
      filter: (f) => {
        total += f.originalSize;
        if (++count > MAX_ARCHIVE_FILES) throw new RangeError(`archive de plus de ${MAX_ARCHIVE_FILES} fichiers`);
        if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new RangeError(`archive de plus de ${MAX_ARCHIVE_UNCOMPRESSED_BYTES / 1024 / 1024} Mo décompressée`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof RangeError) throw new Error(`Archive .vasm refusée : ${e.message}`);
    throw new Error("Archive .vasm illisible");
  }
  const json = <T>(bytes: Uint8Array, name: string): T => {
    try {
      return JSON.parse(strFromU8(bytes)) as T;
    } catch {
      throw new Error(`${name} : JSON invalide`);
    }
  };
  const main = files["assembly.json"];
  if (!main) throw new Error("assembly.json absent de l'archive");
  const assembly = json<AssemblyDocument>(main, "assembly.json");
  if (assembly.format !== "cad.assembly") throw new Error("assembly.json n'est pas un assemblage");
  const parts: PartDocument[] = [];
  const assemblies: AssemblyDocument[] = [];
  for (const [path, bytes] of Object.entries(files)) {
    if (path.startsWith("parts/") && path.endsWith(".json")) {
      const p = json<PartDocument>(bytes, path);
      if (p.format !== "cad.part" || !p.id) throw new Error(`${path} n'est pas une pièce`);
      parts.push(p);
    } else if (path.startsWith("assemblies/") && path.endsWith(".json")) {
      const a = json<AssemblyDocument>(bytes, path);
      if (a.format !== "cad.assembly" || !a.id) throw new Error(`${path} n'est pas un assemblage`);
      assemblies.push(a);
    }
  }
  return { assembly, parts, assemblies };
}
