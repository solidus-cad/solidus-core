import { expect, test } from "@playwright/test";

test("section view: part, then assembly with a non-sectioned part", async ({ page }) => {
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

  // Part: section at mid-height, front plane.
  await page.locator(".view-tools button", { hasText: "Coupe" }).click();
  const panel = page.getByRole("dialog", { name: "Coupe" });
  await expect(panel).toBeVisible();
  const offset = panel.locator(".section-offset");
  await expect(offset).not.toHaveValue("");
  await panel.getByRole("button", { name: "Dessus (XY)" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_SEC ?? "test-results/section-part.png" });
  // The volume is unchanged: the section is display only.
  await expect(status).toContainText("Volume 240 cm³");
  await panel.getByLabel("Inverser le côté conservé").check();
  await panel.getByLabel("Remplir la section (hachures)").uncheck();
  await page.waitForTimeout(200);
  await page.screenshot({ path: process.env.SHOT_SEC2 ?? "test-results/section-part-open.png" });

  // Lamp: a hole that follows the pointer, filled at the bottom; the plane settings are hidden.
  await panel.getByLabel("Remplir la section (hachures)").check();
  const canvas = page.locator(".viewport canvas").first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(200);
  const clip = { x: cx - 30, y: cy - 30, width: 60, height: 60 };
  const plane = await page.screenshot({ clip });
  await panel.getByRole("button", { name: "Lampe" }).click();
  await expect(panel.getByLabel("Inverser le côté conservé")).toHaveCount(0);
  await expect(panel.locator(".section-radius")).not.toHaveValue("");
  await expect(panel.locator(".section-depth")).not.toHaveValue("");
  await page.mouse.move(cx + 40, cy + 10);
  await page.mouse.move(cx, cy);
  await expect.poll(async () => Buffer.compare(plane, await page.screenshot({ clip }))).not.toBe(0);
  await page.screenshot({ path: process.env.SHOT_SEC_LAMP ?? "test-results/section-lamp.png" });
  // Without "Follow the pointer", the hole stays in the center when the pointer goes to the background; otherwise it leaves with it.
  const corner = { x: box.x + box.width - 40, y: box.y + box.height - 40 };
  await panel.getByLabel("Suivre le curseur").uncheck();
  await page.mouse.move(corner.x, corner.y);
  await page.waitForTimeout(200);
  const held = await page.screenshot({ clip });
  await panel.getByLabel("Suivre le curseur").check();
  await page.mouse.move(corner.x, corner.y);
  await expect.poll(async () => Buffer.compare(held, await page.screenshot({ clip }))).not.toBe(0);
  await panel.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(panel.getByLabel("Inverser le côté conservé")).toBeChecked();
  // Closing the panel keeps the section; the button reopens the panel, then turns the section off.
  const toggle = page.locator(".view-tools button", { hasText: "Coupe" });
  await panel.getByRole("button", { name: "Fermer" }).click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Inverser le côté conservé")).toBeChecked();
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Assembly: two occurrences, the second one is not sectioned.
  await page.getByRole("tab", { name: "Assemblage", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Insérer" }).click();
    await page.locator(".insert-row", { hasText: "Pièce1" }).click();
  }
  await expect(status).toContainText("2 occurrence(s)");
  await page.locator(".view-tools button", { hasText: "Coupe" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".section-list .check")).toHaveCount(2);
  await panel.locator(".section-list .check", { hasText: "Pièce1 <2>" }).locator("input").uncheck();
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_SEC3 ?? "test-results/section-asm.png" });

  // The section is specific to each document: the part is not sectioned.
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await page.locator(".doc-entry", { hasText: "Pièce1" }).click();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});
