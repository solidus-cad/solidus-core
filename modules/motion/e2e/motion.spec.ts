import { expect, test, type Page } from "@playwright/test";

/** Intercepted save: simulated `showSaveFilePicker`, bytes kept in `window.__saved`. */
async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "fr");
    const w = window as unknown as { showSaveFilePicker: unknown; __saved?: number[]; __savedName?: string };
    w.showSaveFilePicker = async (o: { suggestedName: string }) => ({
      createWritable: async () => ({
        write: async (b: Blob) => {
          w.__saved = [...new Uint8Array(await b.arrayBuffer())];
          w.__savedName = o.suggestedName;
        },
        close: async () => {},
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  return errors;
}

/** Two boxes: parallel XZ planes and XY planes 15 mm apart (the distance will be driven). */
async function twoBoxes(page: Page): Promise<void> {
  const status = page.locator(".statusbar");
  await page.getByRole("button", { name: "Boîte" }).click();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Volume 240 cm³");
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");
  const planeSelect = page.locator("label.field", { hasText: "…ou un plan de pièce" }).locator("select");
  await page.getByRole("button", { name: "Parallèle" }).click();
  await planeSelect.selectOption({ label: "Pièce1 <1> — Plan XZ" });
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XZ" });
  await page.getByRole("button", { name: "Distance" }).click();
  await page.locator("label.field", { hasText: "Valeur (mm)" }).locator("input").fill("15");
  await planeSelect.selectOption({ label: "Pièce1 <1> — Plan XY" });
  await planeSelect.selectOption({ label: "Pièce1 <2> — Plan XY" });
  await expect(page.getByText("2 degré(s) de liberté")).toBeVisible();
}

/** Boxes aligned in X and Y (YZ and XZ planes coincident): they interpenetrate while the vertical offset is < 40 mm. */
async function alignBoxes(page: Page): Promise<void> {
  const planeSelect = page.locator("label.field", { hasText: "…ou un plan de pièce" }).locator("select");
  for (const plane of ["YZ", "XZ"]) {
    await page.getByRole("button", { name: "Coïncidence" }).click();
    // Planes with the same orientation (the part is not flipped).
    await page.getByLabel("Inverser l'orientation").check();
    await planeSelect.selectOption({ label: `Pièce1 <1> — Plan ${plane}` });
    await planeSelect.selectOption({ label: `Pièce1 <2> — Plan ${plane}` });
  }
  await expect(page.getByText("0 degré(s) de liberté")).toBeVisible();
}

test("Motion workbench: linear motor, stop, loop playback and video export", async ({ page }) => {
  const errors = await start(page);
  await twoBoxes(page);
  await alignBoxes(page);

  await page.getByRole("tab", { name: "Motion" }).click();
  const panel = page.locator(".motion-panel");
  await expect(panel.getByRole("heading", { name: "Étude de mouvement" })).toBeVisible();
  const timeline = page.getByRole("region", { name: "Frise temporelle" });
  await expect(timeline).toBeVisible();

  // Linear motor on the distance: from 15 to 65 mm in 5 s.
  await panel.locator(".tree-row", { hasText: "Distance" }).click();
  await page.locator(".ribbon-btn", { hasText: "Moteur linéaire" }).click();
  await expect(timeline.locator(".motion-label", { hasText: "Distance" })).toBeVisible();
  await expect(timeline.locator(".motion-key")).toHaveCount(2);
  // Speed of the motor: 50 mm in 5 s; setting it moves the last key, read back by the field.
  const speed = panel.locator("label.field", { hasText: "Vitesse (mm/s)" }).locator("input");
  await expect(speed).toHaveValue("10");
  await speed.fill("20");
  await speed.press("Tab");
  await timeline.locator(".motion-key").last().click();
  await expect(panel.locator("label.field", { hasText: "Valeur (mm)" }).locator("input")).toHaveValue("115");
  await speed.fill("10");
  await speed.press("Tab");
  // Baking finished: all frames satisfy the constraints.
  await expect(timeline.locator(".motion-run.pending")).toHaveCount(0, { timeout: 30_000 });
  await expect(timeline.locator(".motion-run.ok")).toHaveCount(1);
  await expect(timeline.locator(".motion-run.fail")).toHaveCount(0);

  // The driven part moves: the view differs between the start and the end.
  const canvas = page.locator(".viewport canvas").first();
  await page.waitForTimeout(300);
  const atStart = await canvas.screenshot();
  await timeline.locator(".motion-ruler").click({ position: { x: (await timeline.locator(".motion-ruler").boundingBox())!.width - 1, y: 10 } });
  await expect(timeline.locator(".motion-clock")).toContainText("5.00 / 5.00 s");
  await page.waitForTimeout(300);
  const atEnd = await canvas.screenshot();
  expect(Buffer.compare(atStart, atEnd)).not.toBe(0);

  // Stop at 40 mm: the end of travel is shown on the timeline and in the panel.
  await timeline.locator(".motion-label", { hasText: "Distance" }).click();
  await panel.locator("label.field", { hasText: "Max" }).locator("input").fill("40");
  await panel.locator("label.field", { hasText: "Max" }).locator("input").press("Enter");
  await expect(timeline.locator(".motion-run.limit")).toHaveCount(1, { timeout: 30_000 });
  await expect(panel.getByText("Butée atteinte")).toBeVisible();
  await page.screenshot({ path: process.env.SHOT_MOTION ?? "test-results/motion.png" });

  // Loop playback: time advances and wraps back to the start.
  await timeline.getByRole("button", { name: "Début" }).click();
  await expect(timeline.locator(".motion-clock")).toContainText("0.00 / 5.00 s");
  await timeline.getByRole("button", { name: "Lecture" }).click();
  await page.waitForTimeout(700);
  await timeline.getByRole("button", { name: "Pause" }).click();
  await expect(timeline.locator(".motion-clock")).not.toContainText("0.00 / 5.00 s");

  // Collisions: the boxes overlap at the start (40 mm high, 15 mm vertical offset).
  await timeline.getByRole("button", { name: "Début" }).click();
  await page.locator(".ribbon-btn", { hasText: "Collisions" }).click();
  await expect(timeline.locator(".motion-run.collision").first()).toBeVisible({ timeout: 60_000 });
  await expect(timeline.locator(".motion-state")).not.toContainText("contrôle des collisions", { timeout: 60_000 });
  await expect(panel.getByText("Collisions à cet instant")).toBeVisible();
  await expect(panel.getByText("Pièce1 <1> ↔ Pièce1 <2>", { exact: true })).toBeVisible();
  await page.locator(".ribbon-btn", { hasText: "Collisions" }).click();
  await expect(timeline.locator(".motion-run.collision")).toHaveCount(0, { timeout: 30_000 });

  // 720p video export: a non-empty MP4 file (or WebM if H.264 is unavailable).
  await page.locator(".ribbon-btn", { hasText: "Vidéo" }).click();
  const dialog = page.getByRole("dialog", { name: "Vidéo" });
  await dialog.locator("label.field", { hasText: "Résolution" }).locator("select").selectOption("720");
  await dialog.getByRole("button", { name: "Exporter" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __savedName?: string }).__savedName ?? ""), { timeout: 60_000 }).toMatch(/^Étude 1\.(mp4|webm)$/);
  const bytes = await page.evaluate(() => (window as unknown as { __saved: number[] }).__saved);
  expect(bytes.length).toBeGreaterThan(2000);
  const name = await page.evaluate(() => (window as unknown as { __savedName: string }).__savedName);
  console.log(`vidéo : ${name}, ${bytes.length} octets`);
  if (name.endsWith(".mp4")) expect(String.fromCharCode(...bytes.slice(4, 8))).toBe("ftyp");
  else expect(bytes.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

  // The study is saved in the assembly; on closing, the assembly returns to the modeling position.
  await page.locator(".ribbon-btn", { hasText: "Fermer l'étude" }).click();
  await expect(timeline).toHaveCount(0);
  await expect(page.getByText("0 degré(s) de liberté")).toBeVisible();
  await page.getByRole("tab", { name: "Motion" }).click();
  await expect(page.getByRole("region", { name: "Frise temporelle" }).locator(".motion-label", { hasText: "Distance" })).toBeVisible();
  expect(errors).toEqual([]);
});
