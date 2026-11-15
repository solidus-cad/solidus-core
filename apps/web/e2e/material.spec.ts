import { expect, test } from "@playwright/test";

test("part material: base by families, properties and custom material", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("init")) {
      localStorage.clear();
      localStorage.setItem("cad.lang", "fr");
      sessionStorage.setItem("init", "1");
    }
  });

  await page.goto("/");
  const status = page.locator(".statusbar");
  await expect(status).toContainText("Prêt", { timeout: 30_000 });

  // Box 100 × 60 × 40 = 240 cm³
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");

  const section = page.locator(".material-section");
  const select = section.getByLabel("Matériau");
  await expect(select.locator("optgroup[label='Aluminiums'] option")).toHaveCount(11);

  // Aluminum 6061 T6: 2.7 g/cm³ → 0.648 kg; properties expanded
  await select.selectOption("Aluminium 6061 T6");
  await section.getByRole("button", { name: "Matériau" }).click();
  const props = section.locator(".material-props");
  await expect(props).toContainText("Aluminiums");
  await expect(props).toContainText("69 GPa");
  await expect(props).toContainText("0,648 kg");

  // Custom material based on the current entry
  await section.getByTitle("Nouvelle matière personnalisée").click();
  const dialog = page.getByRole("dialog", { name: "Nouvelle matière personnalisée" });
  await dialog.getByLabel("Nom").fill("Alu maison");
  await dialog.getByLabel("Masse volumique (g/cm³)").fill("2");
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog).toBeHidden();
  await expect(select).toHaveValue("Alu maison");
  await expect(select.locator("optgroup[label='Mes matières'] option")).toHaveText(["Alu maison"]);
  await expect(props).toContainText("0,48 kg");
  await expect(props).toContainText("69 GPa");

  // Name already taken
  await section.getByTitle("Nouvelle matière personnalisée").click();
  await dialog.getByLabel("Nom").fill("Acier S235");
  await expect(dialog.getByRole("alert")).toContainText("existe déjà");
  await dialog.getByRole("button", { name: "Annuler" }).click();

  // The custom base survives the reload
  await page.reload();
  await expect(status).toContainText("Prêt", { timeout: 30_000 });
  await expect(page.locator(".material-section").getByLabel("Matériau").locator("optgroup[label='Mes matières'] option")).toHaveText(["Alu maison"]);

  // File on the machine (OPFS)
  const stored = await page.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    return JSON.parse(await (await (await dir.getFileHandle("materials.json")).getFile()).text());
  });
  expect(stored.materials.map((m: { name: string }) => m.name)).toEqual(["Alu maison"]);

  expect(errors).toEqual([]);
});

test("takes over the materials from the old location (localStorage)", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("init")) {
      localStorage.clear();
      localStorage.setItem("cad.lang", "fr");
      localStorage.setItem("cad.materials", JSON.stringify([{ name: "Ancienne", density: 1.5 }]));
      sessionStorage.setItem("init", "1");
    }
  });
  await page.goto("/");
  const options = page.locator(".material-section").getByLabel("Matériau").locator("optgroup[label='Mes matières'] option");
  await expect(options).toHaveText(["Ancienne"], { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("cad.materials"))).toBeNull();
  await page.reload();
  await expect(options).toHaveText(["Ancienne"], { timeout: 30_000 });
});
