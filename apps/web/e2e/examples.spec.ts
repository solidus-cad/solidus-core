import { expect, test } from "@playwright/test";

/** Example assemblies of the tips pane: one click opens the assembly only, its parts open on their own from its tree. */
for (const ex of [
  { card: "Cardan double", asm: "Cardan double", part: "Croisillon", tracks: 1 },
  { card: "Presse à excentrique", asm: "Presse à excentrique", part: "Coulisseau", tracks: 1 },
  { card: "Croix de Malte", asm: "Croix de Malte", part: "Roue de Malte", tracks: 2 },
]) {
  test(`example assembly: ${ex.card}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem("cad.lang", "fr");
    });
    await page.goto("/");
    await expect(page.locator(".statusbar")).toContainText("Prêt", { timeout: 30_000 });

    const card = page.locator(".tips-examples .example-card", { hasText: ex.card });
    // Thumbnail served (skipped while the thumbnails themselves are being shot).
    if (!process.env.EXAMPLE_SHOTS) {
      await expect(card.locator("img")).toHaveJSProperty("complete", true);
      expect(await card.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    }
    await card.click();

    // Only the assembly gets a tab (besides the starting part); its parts are loaded with it.
    const active = page.locator(".doc-tab.active");
    await expect(active).toContainText(ex.asm, { timeout: 60_000 });
    await expect(page.locator(".doc-tab")).toHaveCount(2);
    await expect(page.locator(".tree-row", { hasText: ex.part }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".statusbar")).not.toContainText("introuvable");
    // The assembly carries its Motion study (motor tracks: one, or two for the Geneva drive: driver + wheel law).
    const tracks = await page.evaluate(async () => ((await import("/src/workspace.ts")).ws.asm?.motion ?? []).map((s) => s.tracks.length));
    expect(tracks).toEqual([ex.tracks]);

    if (process.env.EXAMPLE_SHOTS) {
      await page.waitForTimeout(3000);
      await page.locator(".viewport").screenshot({ path: `${process.env.EXAMPLE_SHOTS}/${ex.card}.png` });
    }

    // A part opens on its own, in its own tab.
    await page.locator(".tree-row", { hasText: ex.part }).first().click({ button: "right" });
    await page.locator(".menu-popup.context").getByRole("button", { name: "Ouvrir seul", exact: true }).click();
    await expect(active).toContainText(ex.part);
    expect(errors).toEqual([]);
  });
}

/** Deep links: French or English name in ?exemple= / ?example=, removed from the address once opened. */
for (const link of [
  { query: "?exemple=pelleteuse", asm: "Excavator arm", part: "Bucket", lang: "fr" },
  { query: "?example=geneva", asm: "Croix de Malte", part: "Roue de Malte", lang: "en" },
]) {
  test(`example deep link: ${link.query}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((lang) => {
      localStorage.clear();
      localStorage.setItem("cad.lang", lang);
    }, link.lang);
    await page.goto(`/${link.query}`);
    await expect(page.locator(".doc-tab.active")).toContainText(link.asm, { timeout: 60_000 });
    await expect(page.locator(".tree-row", { hasText: link.part }).first()).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).search).toBe("");
    const tracks = await page.evaluate(async () => ((await import("/src/workspace.ts")).ws.asm?.motion ?? []).map((s) => s.tracks.length));
    expect(tracks[0]).toBeGreaterThan(0);
    // Not offered as a card: the excavator is reachable from its link only.
    await expect(page.locator(".tips-examples .example-card")).toHaveCount(3);
    expect(errors).toEqual([]);
  });
}
