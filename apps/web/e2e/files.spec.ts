import { expect, test, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

/**
 * Simulated project folder: the File System Access API pickers return files from the origin's private storage
 * (OPFS), in the "projet" folder. `__nextOpen`: path that the open picker returns.
 */
async function stubProjectFolder(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("projet", { create: true });
    w.showDirectoryPicker = dir;
    w.showSaveFilePicker = async (o: { suggestedName: string }) => (await dir()).getFileHandle(o.suggestedName, { create: true });
    w.showOpenFilePicker = async () => [await (await dir()).getFileHandle(w.__nextOpen as string)];
  });
}

const listFiles = (page: Page) =>
  page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("projet", { create: true });
    const names: string[] = [];
    for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
    return names.sort();
  });

const readFile = async (page: Page, name: string) =>
  new Uint8Array(
    await page.evaluate(async (n) => {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("projet");
      return [...new Uint8Array(await (await (await d.getFileHandle(n)).getFile()).arrayBuffer())];
    }, name),
  );

test("assembly: parts in their files, renamed part reported then replaced", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stubProjectFolder(page);
  // On each load: no recovered document (the reopened part must come from the file); the project folder,
  // kept in IndexedDB, survives the reload.
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("projet", { recursive: true }).catch(() => {});
  });
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });

  // Pièce1 (box) inserted in an assembly.
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume");
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  await page.getByRole("button", { name: "Insérer" }).click();
  await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  await expect(status).toContainText("1 occurrence(s)");

  // Save: the part, without a file, is written next to the assembly; the assembly no longer embeds it.
  await page.keyboard.press("Control+s");
  await expect(status).toContainText("Enregistré, avec 1 document(s) référencé(s)");
  expect(await listFiles(page)).toEqual(["Assemblage1.vasm", "Pièce1.vpart"]);
  let vasm = unzipSync(await readFile(page, "Assemblage1.vasm"));
  expect(Object.keys(vasm).some((k) => k.startsWith("parts/"))).toBe(false);
  let refs = JSON.parse(strFromU8(vasm["references.json"]!)) as { references: { path: string; kind: string }[] };
  expect(refs.references).toEqual([expect.objectContaining({ kind: "part", path: "Pièce1.vpart" })]);
  // Save again without changes: nothing else is rewritten, in the same file (no picker).
  await page.keyboard.press("Control+s");
  await expect(status).toContainText("Enregistré");

  // The part is renamed outside the application.
  await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("projet");
    const data = await (await (await d.getFileHandle("Pièce1.vpart")).getFile()).arrayBuffer();
    const w = await (await d.getFileHandle("Bride.vpart", { create: true })).createWritable();
    await w.write(data);
    await w.close();
    await d.removeEntry("Pièce1.vpart");
  });

  // New session: the reopened assembly reports the part as not found.
  await page.reload();
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__nextOpen = "Assemblage1.vasm"));
  await page.keyboard.press("Control+o");
  const missing = page.getByRole("dialog", { name: "Références introuvables" });
  await expect(missing).toBeVisible();
  await expect(missing).toContainText("Pièce1");
  await expect(missing).toContainText("Pièce1.vpart");
  await expect(page.locator(".tree-row.missing")).toHaveCount(1);

  // Replace: the renamed part is chosen on disk.
  await missing.getByRole("button", { name: "Remplacer…" }).click();
  const replace = page.getByRole("dialog", { name: "Remplacer" });
  await expect(replace).toBeVisible();
  await page.evaluate(() => ((window as unknown as Record<string, unknown>).__nextOpen = "Bride.vpart"));
  await replace.getByRole("button", { name: "Fichier…" }).click();
  await expect(replace).toContainText("Remplacer par : Pièce1");
  await replace.getByRole("button", { name: "Remplacer", exact: true }).click();
  await expect(replace).toBeHidden();
  await expect(missing).toBeHidden();
  await expect(page.locator(".tree-row.missing")).toHaveCount(0);
  await expect(status).toContainText("1 occurrence(s)");

  // The saved assembly now points to Bride.vpart.
  await page.keyboard.press("Control+s");
  await expect(status).toContainText("Enregistré");
  vasm = unzipSync(await readFile(page, "Assemblage1.vasm"));
  refs = JSON.parse(strFromU8(vasm["references.json"]!)) as { references: { path: string; kind: string }[] };
  expect(refs.references).toEqual([expect.objectContaining({ kind: "part", path: "Bride.vpart" })]);
  expect(await listFiles(page)).toEqual(["Assemblage1.vasm", "Bride.vpart"]);
  expect(errors).toEqual([]);
});

test("pack: tree of files, relative references, reopened complete after import", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await stubProjectFolder(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
    // Parts go to a subfolder, zips to the origin root (outside the project folder).
    const w = window as unknown as Record<string, unknown>;
    w.showSaveFilePicker = async (o: { suggestedName: string }) => {
      const root = await navigator.storage.getDirectory();
      if (o.suggestedName.endsWith(".zip")) return root.getFileHandle(o.suggestedName, { create: true });
      const d = await root.getDirectoryHandle("projet", { create: true });
      const target = o.suggestedName.endsWith(".vpart") ? await d.getDirectoryHandle("pieces", { create: true }) : d;
      return target.getFileHandle(o.suggestedName, { create: true });
    };
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("projet", { recursive: true }).catch(() => {});
  });
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });

  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume");
  await page.keyboard.press("Control+s");
  await expect(status).toContainText("Enregistré");
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  await page.getByRole("button", { name: "Insérer" }).click();
  await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  await expect(status).toContainText("1 occurrence(s)");

  await page.keyboard.press("Control+s");
  await expect(status).toContainText("Enregistré");
  await page.getByRole("button", { name: "Fichier", exact: true }).click();
  await page.getByRole("button", { name: "Pack & Export…" }).click();
  await expect(status).toContainText("Pack exporté : 2 fichier(s)");
  expect(await listFiles(page)).toEqual(["Assemblage1.vasm", "pieces"]);

  const zipBytes = new Uint8Array(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return [...new Uint8Array(await (await (await root.getFileHandle("Assemblage1.zip")).getFile()).arrayBuffer())];
    }),
  );
  const zip = unzipSync(zipBytes);
  expect(Object.keys(zip).sort()).toEqual(["Assemblage1.vasm", "pack.json", "pieces/Pièce1.vpart"]);
  expect(JSON.parse(strFromU8(zip["pack.json"]!))).toEqual({ format: "cad.pack", version: 1, root: "Assemblage1.vasm" });
  const refs = JSON.parse(strFromU8(unzipSync(zip["Assemblage1.vasm"]!)["references.json"]!)) as { references: Record<string, unknown>[] };
  expect(refs.references).toEqual([expect.objectContaining({ kind: "part", path: "pieces/Pièce1.vpart" })]);
  expect(refs.references[0]).not.toHaveProperty("absolute");

  // Without the original files, new session: the import opens the assembly complete, linked to the extracted files.
  await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("projet");
    await d.removeEntry("pieces", { recursive: true });
    await d.removeEntry("Assemblage1.vasm");
  });
  await page.reload();
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  await page.getByRole("button", { name: "Fichier", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Importer…" }).click();
  await (await chooser).setFiles({ name: "Assemblage1.zip", mimeType: "application/zip", buffer: Buffer.from(zipBytes) });
  await expect(status).toContainText("1 occurrence(s)");
  await expect(page.getByRole("dialog", { name: "Références introuvables" })).toHaveCount(0);
  await expect(page.locator(".tree-row.missing")).toHaveCount(0);
  await page.keyboard.press("Control+s");
  await expect(status).toContainText("Enregistré");
  const extracted = await page.evaluate(async () => {
    const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("projet")).getDirectoryHandle("Assemblage1");
    await (await d.getDirectoryHandle("pieces")).getFileHandle("Pièce1.vpart");
    await d.getFileHandle("Assemblage1.vasm");
    return true;
  });
  expect(extracted).toBe(true);

  // Part lost from the extracted folder: the pack is refused rather than incomplete.
  await page.evaluate(async () => {
    const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("projet")).getDirectoryHandle("Assemblage1");
    await d.removeEntry("pieces", { recursive: true });
  });
  await page.reload();
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => {
      const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("projet")).getDirectoryHandle("Assemblage1");
      return [await d.getFileHandle("Assemblage1.vasm")];
    };
  });
  await page.keyboard.press("Control+o");
  const missing = page.getByRole("dialog", { name: "Références introuvables" });
  await expect(missing).toContainText("Pièce1");
  await missing.getByRole("button", { name: "Plus tard" }).click();
  await page.getByRole("button", { name: "Fichier", exact: true }).click();
  await page.getByRole("button", { name: "Pack & Export…" }).click();
  await expect(status).toContainText("Pack impossible, références introuvables : Pièce1");
  await expect(missing).toBeVisible();
  expect(errors).toEqual([]);
});
