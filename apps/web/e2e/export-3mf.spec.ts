import { expect, test, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

/** Runs the File menu command and returns the model of the downloaded 3MF. */
async function export3mf(page: Page, confirm: boolean): Promise<string> {
  await page.evaluate(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Fichier" }).click();
  // File › Export as › 3MF (submenu opened on hover).
  await page.locator(".menu-popup .has-sub").hover();
  await page.locator(".menu-popup .submenu").getByRole("button", { name: "3MF" }).click();
  if (confirm) await page.getByRole("dialog").getByRole("button", { name: "Exporter" }).click();
  const file = await download;
  const data = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c));
  return strFromU8(unzipSync(data)["3D/3dmodel.model"]!);
}

test("3MF export: a part, then an assembly with one object and one item per occurrence", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");

  // Box: 8 welded vertices, 12 triangles.
  const part = await export3mf(page, false);
  expect(part).toContain('unit="millimeter"');
  expect(part.match(/<vertex /g)).toHaveLength(8);
  expect(part.match(/<triangle /g)).toHaveLength(12);
  expect(part.match(/<item /g)).toHaveLength(1);

  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");
  const asm = await export3mf(page, true);
  expect(asm.match(/<object /g)).toHaveLength(1);
  expect(asm.match(/<item objectid="1" transform="/g)).toHaveLength(2);
  expect(errors).toEqual([]);
});
