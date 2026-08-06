import { expect, test } from "@playwright/test";

async function gotoScenario(page: import("@playwright/test").Page, scenarioId: string): Promise<void> {
  await page.goto(`simulate/${scenarioId}`);
  await page.getByRole("heading", { name: "操作パネル" }).waitFor();
}

test.describe("scenario introduction: desktop", () => {
  test("standing-party starts compact, exposes its full explanation, and does not change the simulation", async ({ page }) => {
    await gotoScenario(page, "standing-party");

    const header = page.locator(".app-header");
    const details = page.locator(".scenario-introduction-details");
    const summary = details.locator("summary");
    const introductionSummary = page.locator(".scenario-introduction-summary");
    const canvas = page.locator("svg.simulation-field-canvas");

    await expect(details).not.toHaveAttribute("open");
    await expect(introductionSummary).toContainText("複数の会話の輪");
    const headerBox = await header.boundingBox();
    const introductionSummaryBox = await introductionSummary.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(introductionSummaryBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(introductionSummaryBox!.height, "1440px幅では短い概要を不必要に折り返さない").toBeLessThan(30);
    expect(headerBox!.height, "初期headerは説明全文で操作領域を圧迫しない").toBeLessThan(260);
    expect(canvasBox!.y, "Canvasの主要領域は初期viewport内から始まる").toBeLessThan(300);
    expect(canvasBox!.y + Math.min(canvasBox!.height, 200)).toBeLessThanOrEqual(900);

    const tickBefore = await page.locator(".tick-status").textContent();
    await summary.focus();
    await page.keyboard.press("Space");
    await expect(details).toHaveAttribute("open", "");
    await expect(details).toContainText("ObserverJoinerについて");
    await expect(details).toContainText("性格の良し悪しや人格診断を意味しません");
    await expect(details).toContainText("一時停止してください");
    await expect(page.locator(".tick-status")).toHaveText(tickBefore ?? "");

    await page.keyboard.press("Space");
    await expect(details).not.toHaveAttribute("open");
  });

  test("all scenarios use compact headers and a route change resets the details state", async ({ page }) => {
    const headerHeights: number[] = [];
    for (const scenarioId of ["after-party", "classroom", "standing-party"]) {
      await gotoScenario(page, scenarioId);
      const details = page.locator(".scenario-introduction-details");
      await expect(details).not.toHaveAttribute("open");
      const headerBox = await page.locator(".app-header").boundingBox();
      expect(headerBox).not.toBeNull();
      headerHeights.push(headerBox!.height);
      await details.locator("summary").click();
      await expect(details).toHaveAttribute("open", "");
    }

    expect(Math.max(...headerHeights) - Math.min(...headerHeights)).toBeLessThan(90);

    await gotoScenario(page, "after-party");
    await expect(page.locator(".scenario-introduction-details")).not.toHaveAttribute("open");
  });
});
