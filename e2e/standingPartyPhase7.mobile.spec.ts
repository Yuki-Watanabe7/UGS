import { expect, test } from "@playwright/test";
import { gotoStandingParty, setRangeValue } from "./helpers";

async function hasNoHorizontalScroll(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

/**
 * Issue #266: 320pxとiPhone相当幅で、説明がCanvasを押し出さず、飲食の台と移動表示へ到達できる。
 */
test.describe("standingParty Phase 7: 狭い幅の飲食動線", () => {
  test("320pxで横overflowがなく、台と移動表示を確認できる", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 640 });
    await gotoStandingParty(page);
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    const canvas = page.locator("svg.simulation-field-canvas");
    await expect(canvas).toBeVisible();
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(canvasBox!.width).toBeGreaterThan(250);
    expect(canvasBox!.width).toBeLessThanOrEqual(320);
    await expect(page.getByTestId("venue-anchor-anchor:food-main")).toBeVisible();
    await expect(page.getByTestId("venue-anchor-anchor:drink-main")).toBeVisible();

    const introduction = page.locator(".scenario-introduction-details");
    await expect(introduction).not.toHaveAttribute("open");
    await introduction.locator("summary").click();
    await expect(introduction).toContainText("飲食目的の移動の見方");
    await expect(introduction).toContainText("仮説的な設定");
    expect(await hasNoHorizontalScroll(page)).toBe(true);
    const canvasAfter = await canvas.boundingBox();
    expect(canvasAfter).not.toBeNull();
    expect(canvasAfter!.width).toBeGreaterThan(250);

    await setRangeValue(page.getByTestId("standing-party-field-visitThreshold"), 0.05);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator("[data-venue-phase='traveling']").first()).toBeVisible({ timeout: 45_000 });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    const agentSelect = page.getByLabel("表示するagent");
    const agentOptionValues = await agentSelect.locator("option").evaluateAll((opts) =>
      opts.map((option) => (option as HTMLOptionElement).value),
    );
    await agentSelect.selectOption(agentOptionValues[0]);
    await expect(page.getByText("飲食の目的行動(会話への参加とは別)")).toBeVisible();
    expect(await hasNoHorizontalScroll(page)).toBe(true);
  });
});
