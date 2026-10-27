import { expect, test } from "@playwright/test";
import { gotoStandingParty, observeVenueRefreshment } from "./helpers";

/**
 * Issue #267 (standingParty Phase 7): iPhone相当幅でも飲食台の表示と
 * 受け取り→need低下→回遊復帰へ到達でき、横overflowを起こさない。
 */

async function hasNoHorizontalScroll(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

test.describe("standingParty Phase 7: iPhone相当幅の飲食観察", () => {
  test("320px幅で飲食台・Inspector・回遊復帰を確認し、横overflowを起こさない", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 320, height: 640 });
    await gotoStandingParty(page);
    expect(await hasNoHorizontalScroll(page)).toBe(true);
    await observeVenueRefreshment(page);
    expect(await hasNoHorizontalScroll(page)).toBe(true);
    await expect(page.getByTestId("observer-inspector-venue-phase")).toBeVisible();
  });
});
