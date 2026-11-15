import { expect, test } from "@playwright/test";

test("fillet on an edge picked in the view", async ({ page }) => {
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

  await page.getByRole("button", { name: "Congé" }).click();
  const panel = page.locator(".property-panel");
  await expect(panel).toContainText("0 arête(s) désignée(s)");

  // Vertical sweep through the center of the view until an edge is hit.
  const box = (await page.locator(".viewport").boundingBox())!;
  const x = box.x + box.width / 2;
  let found = false;
  for (let y = box.y + 60; y < box.y + box.height - 60 && !found; y += 3) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    found = (await panel.textContent())!.includes("1 arête(s)");
  }
  expect(found).toBe(true);
  await panel.getByLabel("Rayon").fill("5");
  await page.getByRole("button", { name: "✓ Valider" }).click();
  await expect(status).toContainText("Prêt");
  const text = (await status.textContent())!;
  const volume = Number(/Volume ([\d,]+) cm³/.exec(text)![1]!.replace(",", "."));
  // Single rounded edge: volume loss of (1 - π/4)·r²·L, with L between 40 and 100 mm.
  expect(volume).toBeLessThan(240);
  expect(volume).toBeGreaterThan(240 - 0.55);
  await page.screenshot({ path: process.env.SHOT_REFS ?? "test-results/refs.png" });
  expect(errors).toEqual([]);
});
