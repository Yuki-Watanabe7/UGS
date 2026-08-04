import { test, expect } from "@playwright/test";
import { gotoStandingParty } from "./helpers";

/**
 * Issue #218 (Phase 4 分析, 検証範囲9節): standingParty Phase 4のiPhone相当幅 /
 * 320px幅での分析UI到達性。横方向のページ全体overflowを起こさず、主要tab・filter・
 * detail・exportへ到達できることを確認する。
 */

async function hasNoHorizontalScroll(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

async function openDetails(page: import("@playwright/test").Page, testId: string): Promise<void> {
  // 右サイドバーの重なりを避けるため、他の分析panelを閉じてから開く
  for (const id of ["conversation-history", "contact-network", "analytics-dashboard"]) {
    if (id === testId) continue;
    const other = page.getByTestId(id);
    if (await other.count()) {
      if (await other.evaluate((el) => (el as HTMLDetailsElement).open)) {
        await other.locator("summary").click();
      }
    }
  }
  const panel = page.getByTestId(testId);
  await panel.scrollIntoViewIfNeeded();
  if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await panel.locator("summary").click();
  }
}

test.describe("standingParty Phase 4: iPhone相当幅の分析flow", () => {
  test("timeline/network/dashboard/exportへ到達でき、横スクロールしない", async ({ page }) => {
    test.setTimeout(90_000);
    await gotoStandingParty(page);
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    await page.getByLabel("Seed").fill("218");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(2_500);
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    await openDetails(page, "conversation-history");
    await expect(page.getByTestId("conversation-history-filters")).toBeVisible();
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    await openDetails(page, "contact-network");
    await expect(page.getByTestId("contact-network-controls")).toBeVisible();
    await page.getByTestId("contact-network-weight-mode").selectOption("binary");
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    await openDetails(page, "analytics-dashboard");
    await expect(page.getByTestId("analytics-overview")).toBeVisible();
    await expect(page.getByTestId("analytics-export-json")).toBeVisible();
    await expect(page.getByTestId("analytics-export-csv")).toBeVisible();
    await page.getByTestId("analytics-from-tick").fill("0");
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    const jsonDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("analytics-export-json").click();
    expect((await jsonDownload).suggestedFilename()).toMatch(/\.json$/i);
  });

  test("320px幅でも分析パネルへ到達でき横スクロールしない", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 320, height: 640 });
    await gotoStandingParty(page);
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    await page.getByRole("button", { name: "Step 1 tick", exact: true }).click();

    for (const testId of ["conversation-history", "contact-network", "analytics-dashboard"]) {
      await openDetails(page, testId);
      expect(await hasNoHorizontalScroll(page)).toBe(true);
    }

    await expect(page.getByTestId("analytics-export-csv")).toBeVisible();
    await page.getByTestId("analytics-export-csv").scrollIntoViewIfNeeded();
    expect(await hasNoHorizontalScroll(page)).toBe(true);
  });
});
