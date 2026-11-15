import { expect, test } from "@playwright/test";

test("bug report: action log, error badge, text and JSON export", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("init")) {
      localStorage.clear();
      sessionStorage.setItem("init", "1");
    }
    localStorage.setItem("cad.lang", "fr");
  });
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });

  // A few actions: menu, shortcut, uncaught error.
  await page.getByRole("button", { name: "Affichage", exact: true }).click();
  await page.getByRole("button", { name: "Zoom ajusté" }).click();
  await page.locator("canvas").first().click();
  await page.keyboard.press("f");
  await page.evaluate(() => setTimeout(() => { throw new Error("bug provoqué"); }));

  const bug = page.getByRole("button", { name: "Signaler un bug" });
  await expect(bug.locator(".badge")).toHaveText("1");
  await bug.click();

  const dialog = page.getByRole("dialog", { name: "Signaler un bug" });
  const timeline = dialog.locator(".bug-timeline");
  await expect(timeline).toContainText("Zoom ajusté [view.fit]");
  await expect(timeline).toContainText("F → Zoom ajusté [view.fit]");
  await expect(timeline).toContainText("vue 3D");
  await expect(timeline.locator(".k-error")).toContainText("bug provoqué");

  await dialog.getByRole("textbox").fill("La vue saute après le zoom");
  await dialog.getByRole("button", { name: "Copier le texte" }).click();
  await expect(dialog.getByRole("button", { name: "Copié ✓" })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("La vue saute après le zoom");
  expect(text).toContain("## Chronologie");
  expect(text).toMatch(/ERR\s+.*bug provoqué/);
  await expect(bug.locator(".badge")).toHaveCount(0); // reported: badge cleared

  // Save: JSON report with the attachment.
  await page.evaluate(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Enregistrer le rapport…" }).click();
  const file = await download;
  const report = JSON.parse(await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
  expect(report.format).toBe("cad.bugreport");
  expect(report.description).toBe("La vue saute après le zoom");
  expect(report.document.format).toBe("cad.part");
  expect(report.events.some((e: { kind: string }) => e.kind === "error")).toBe(true);
  await expect(dialog).toBeHidden();

  // After a reload, the previous session is offered.
  await page.reload();
  await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });
  await page.getByRole("button", { name: "Signaler un bug" }).click();
  await expect(page.getByText("Joindre la session précédente")).toBeVisible();
});
