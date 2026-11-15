import { expect, test } from "@playwright/test";

test("UI language: translations loaded on demand, selector in Settings › User", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("cad.lang", "de");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Bereit", { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  // Translations provided by a plugin (the Quoting dictionary), if the build includes it (CAD_EXTENSIONS).
  if (process.env.CAD_EXTENSIONS) await expect(page.getByRole("tab", { name: "Kalkulation" })).toBeVisible();

  await page.getByRole("button", { name: "Einstellungen" }).click();
  await page.locator(".menu-popup").getByText("Sprache…").click();
  const select = page.getByRole("dialog").locator("select").first();
  await expect(select).toHaveValue("de");
  await select.selectOption("ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await select.selectOption("fr");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("dialog")).toContainText("Langue de l'interface");
  expect(errors).toEqual([]);
});
