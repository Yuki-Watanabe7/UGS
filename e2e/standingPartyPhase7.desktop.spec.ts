import { expect, test } from "@playwright/test";
import { gotoStandingParty, observeVenueRefreshment } from "./helpers";

/**
 * Issue #267 (standingParty Phase 7): 料理台・ドリンク台の表示、preset上での実行、
 * 受け取りに伴うInspectorのneed低下、会場回遊への復帰をdesktopで確認する。
 * 座標の完全一致は見ない。
 */

test.describe("standingParty Phase 7: desktopの飲食観察", () => {
  test("飲食台を有効にして移動・受け取り・need低下・回遊復帰を確認する", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoStandingParty(page);
    await observeVenueRefreshment(page);

    await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    const scenarioCards = page.locator(".scenario-card");
    const cardCount = await scenarioCards.count();
    let switchedAway = false;
    for (let i = 0; i < cardCount; i++) {
      await scenarioCards.nth(i).click();
      const stillStanding = await page
        .getByRole("heading", { name: "詳細設定(立食パーティー)" })
        .isVisible()
        .catch(() => false);
      if (!stillStanding) {
        switchedAway = true;
        break;
      }
      await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    }
    expect(switchedAway).toBe(true);
    await expect(page.getByTestId("venue-anchor-anchor:food-main")).toHaveCount(0);
    await expect(page.getByTestId("observer-inspector-venue-visit")).toHaveCount(0);
  });
});
