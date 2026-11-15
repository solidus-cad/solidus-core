import { expect, test, type Page } from "@playwright/test";

/** Exports the part to STEP (download) and counts its solids. */
async function stepSolids(page: Page): Promise<number> {
  await page.evaluate(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Fichier" }).click();
  await page.getByRole("button", { name: "Exporter en" }).hover();
  await page.getByRole("button", { name: "STEP", exact: true }).click();
  const file = await download;
  const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  expect(text).toContain("ISO-10303-21");
  return text.match(/MANIFOLD_SOLID_BREP/g)?.length ?? 0;
}

test("multi-body: new body, hiding, union and STEP export", async ({ page }) => {
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
  const panel = page.locator(".property-panel");
  const bodies = page.locator(".tree-section", { has: page.locator(".tree-section-title", { hasText: "Corps" }) });

  // Box 100 × 60 × 40: a single body, no Bodies section.
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  await expect(bodies).toHaveCount(0);

  // Second box offset by 50 in X, as a new body: the volumes add up without merging.
  await page.getByRole("button", { name: "Boîte" }).click();
  await panel.getByLabel("Opération").selectOption("new");
  await panel.getByLabel("Position X").fill("50");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 480 cm³");
  await expect(bodies.locator(".count")).toHaveText("2");
  await expect(bodies.locator(".tree-row")).toHaveText([/Boîte1/, /Boîte2/]);
  expect(await stepSolids(page)).toBe(2);

  // Hiding a body changes the image, without affecting the computation.
  const canvas = page.locator(".viewport canvas").first();
  const before = await canvas.screenshot();
  const row = bodies.locator(".tree-row", { hasText: "Boîte2" });
  await row.getByTitle("Masquer").click();
  await expect(row.getByTitle("Afficher")).toBeVisible();
  await expect.poll(async () => Buffer.compare(before, await canvas.screenshot())).not.toBe(0);
  await expect(status).toContainText("Volume 480 cm³");
  await row.getByTitle("Afficher").click();

  // A third box as a new body targets the bodies before it: it does not offer itself as its own target.
  await page.getByRole("button", { name: "Boîte" }).click();
  await panel.getByLabel("Opération").selectOption("new");
  await panel.getByLabel("Position X").fill("300");
  await expect(status).toContainText("Volume 720 cm³");
  await expect(panel.getByLabel("Corps cible").locator("option")).toHaveText(["Corps actif", "Boîte1", "Boîte2"]);
  await page.getByRole("button", { name: "✕ Annuler" }).click();
  await expect(status).toContainText("Volume 480 cm³");

  // Union of Boîte1 into the target body (Boîte2): 240 + 240 − 120 overlap.
  await page.getByRole("button", { name: "Combiner des corps" }).click();
  await panel.getByRole("checkbox", { name: "Boîte1" }).check();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 360 cm³");
  await expect(bodies).toHaveCount(0);
  expect(await stepSolids(page)).toBe(1);

  expect(errors).toEqual([]);
});

test("multi-body: a fillet selected on a non-targeted body applies to that body", async ({ page }) => {
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
  const panel = page.locator(".property-panel");

  // Boîte1, then Boîte2 apart as a new body: Boîte2 becomes the target body, then it is hidden.
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await page.getByRole("button", { name: "Boîte" }).click();
  await panel.getByLabel("Opération").selectOption("new");
  await panel.getByLabel("Position X").fill("300");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 480 cm³");
  await page.locator(".tree-row", { hasText: "Boîte2" }).getByTitle("Masquer").click();

  // Fillet: the feature first targets the active body (Boîte2, recorded in the feature); the selected edge
  // belongs to Boîte1, so the feature switches to that body.
  await page.getByRole("button", { name: "Congé" }).click();
  await expect(panel.getByLabel("Corps cible").locator("option:checked")).toHaveText("Boîte2");
  const box = (await page.locator(".viewport").boundingBox())!;
  const x = box.x + box.width / 2;
  let found = false;
  for (let y = box.y + 60; y < box.y + box.height - 60 && !found; y += 3) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    found = (await panel.textContent())!.includes("1 arête(s)");
  }
  expect(found).toBe(true);
  await expect(panel.getByLabel("Corps cible").locator("option:checked")).toHaveText("Boîte1");
  await panel.getByLabel("Rayon").fill("5");
  await expect(page.locator(".panel-error")).toBeHidden();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Prêt");
  const volume = Number(/Volume ([\d,]+) cm³/.exec((await status.textContent())!)![1]!.replace(",", "."));
  expect(volume).toBeLessThan(480);
  expect(volume).toBeGreaterThan(480 - 0.55);
  expect(errors).toEqual([]);
});
