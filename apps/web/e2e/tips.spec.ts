import { expect, test } from "@playwright/test";

const start = async (page: import("@playwright/test").Page, lang = "fr") => {
  await page.addInitScript((l) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.clear();
    localStorage.setItem("cad.lang", l);
  }, lang);
  await page.goto("/");
};

test("right panel: tips by default, one tab presented, other tips", async ({ page }) => {
  await start(page);
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });

  const panel = page.locator(".side.right");
  await expect(panel.getByRole("tab", { name: "Astuces" })).toHaveClass(/active/);
  await expect(panel.locator(".tip-count")).toContainText("/ 12");

  const title = panel.locator(".tip-title");
  const first = await title.textContent();
  await panel.getByRole("button", { name: "Astuce suivante" }).click();
  await expect(title).not.toHaveText(first!);
  await panel.getByRole("button", { name: "Astuce précédente" }).click();
  await expect(title).toHaveText(first!);

  const presented = panel.locator(".tips-legend-row");
  await expect(presented).toHaveCount(1);
  const name = await presented.locator("strong").textContent();
  const pointed = panel.getByRole("tab", { name: name!, exact: true });
  await expect(pointed).toHaveClass(/presented/);
  const tabBox = (await pointed.boundingBox())!;
  const bubbleBox = (await presented.boundingBox())!;
  const tipX = await presented.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--tip-x")));
  expect(Math.abs(bubbleBox.x + tipX - (tabBox.x + tabBox.width / 2))).toBeLessThan(1);
  await page.screenshot({ path: process.env.SHOT_TIPS ?? "test-results/tips.png" });
  await presented.click();
  await expect(panel.getByRole("tab", { name: name!, exact: true })).toHaveClass(/active/);
  await panel.getByRole("tab", { name: "Astuces" }).click();
  await expect(title).toHaveText(first!);
});

test("tips are translated", async ({ page }) => {
  await start(page, "de");
  await expect(page.locator(".side.right").getByRole("tab", { name: "Tipps" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".side.right").getByRole("button", { name: "Nächster Tipp" })).toBeVisible();
});

test("panels: three modes, kept after a reload; forms and sketch tools stay reachable", async ({ page }) => {
  await start(page);
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  const left = page.locator(".side.left");
  const right = page.locator(".side.right");
  const ribbon = page.locator(".ribbon-content");
  const toggle = (id: string) => page.locator(`.panel-toggle.${id}`);
  const canvas = page.locator(".viewport canvas").first();
  const before = (await canvas.boundingBox())!;

  // Open > automatic: stays open under the pointer, retracts once it has left, comes back on hover.
  await toggle("right").click();
  await expect(toggle("right")).toHaveAttribute("data-mode", "auto");
  await page.waitForTimeout(3500);
  await expect(right).toBeVisible();
  await page.mouse.move(600, 500);
  await expect(right).toBeHidden({ timeout: 5000 });
  await toggle("right").hover();
  await expect(right).toBeVisible();
  await page.mouse.move(600, 500);
  await expect(right).toBeHidden({ timeout: 5000 });

  // Automatic > always closed: hovering no longer opens it.
  await toggle("right").hover();
  await expect(right).toBeVisible();
  await toggle("right").click();
  await expect(toggle("right")).toHaveAttribute("data-mode", "closed");
  await expect(right).toBeHidden();
  await toggle("right").hover();
  await page.waitForTimeout(300);
  await expect(right).toBeHidden();

  for (const id of ["left", "top"]) {
    await toggle(id).click();
    await toggle(id).click();
    await expect(toggle(id)).toHaveAttribute("data-mode", "closed");
  }
  await page.mouse.move(600, 500);
  await expect(left).toBeHidden();
  await expect(ribbon).toBeHidden();
  await expect(page.getByRole("tab", { name: "Assemblage", exact: true })).toBeVisible();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(before.width + 400);
  await expect.poll(async () => (await canvas.boundingBox())!.height).toBeGreaterThan(before.height + 80);
  await page.screenshot({ path: process.env.SHOT_SIDES ?? "test-results/sides.png" });

  await page.reload();
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  await expect(left).toBeHidden();
  await expect(right).toBeHidden();
  await expect(ribbon).toBeHidden();

  // A form opens the left panel, which closes again with the form.
  await toggle("top").click();
  await expect(ribbon).toBeVisible();
  await page.getByRole("button", { name: "Boîte" }).click();
  await expect(left).toBeVisible();
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(left).toBeHidden();

  await toggle("top").click();
  await toggle("top").click();
  await page.mouse.move(600, 500);
  await expect(ribbon).toBeHidden();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Esquisse");
  await page.keyboard.press("Enter");
  // Both panels are "always closed", yet the sketch needs them.
  await expect(ribbon).toBeVisible();
  await expect(left).toBeVisible();
  await expect(toggle("left")).toHaveCount(0);
  await expect(page.locator(".ribbon-tabs .contextual")).toBeVisible();
  await page.screenshot({ path: process.env.SHOT_SKETCH ?? "test-results/panels-sketch.png" });
});
