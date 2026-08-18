import { expect, test } from "@playwright/test";
import { gotoStandingParty } from "./helpers";

async function hasNoHorizontalScroll(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

async function openInformationPanel(page: import("@playwright/test").Page): Promise<void> {
  for (const testId of ["conversation-history", "contact-network", "analytics-dashboard"]) {
    const other = page.getByTestId(testId);
    if (await other.evaluate((element) => (element as HTMLDetailsElement).open)) {
      await other.locator("summary").click();
    }
  }
  const panel = page.getByTestId("information-propagation");
  await panel.scrollIntoViewIfNeeded();
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await panel.locator("summary").click();
  }
}

test.describe("standingParty Phase 5: iPhone相当幅の観察flow", () => {
  test("320px幅でfilter・主要tab・detailへ到達でき、横overflowを起こさない", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 640 });
    await gotoStandingParty(page);
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-info-rich");
    await page.getByLabel("Seed").fill("235");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(4_000);
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    await openInformationPanel(page);
    const panel = page.getByTestId("information-propagation");
    await expect(panel.getByTestId("information-propagation-filters")).toBeVisible();
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    for (const [tab, content] of [
      ["状態・Inspector", "information-propagation-inspector"],
      ["伝播network", "information-propagation-network"],
      ["Claim lineage", "information-propagation-lineage"],
      ["timeline", "information-propagation-timeline"],
      ["記述統計", "information-propagation-statistics"],
    ] as const) {
      await panel.getByRole("tab", { name: tab }).click();
      await expect(panel.getByTestId(content)).toBeVisible();
      expect(await hasNoHorizontalScroll(page)).toBe(true);
    }

    const filters = panel.getByTestId("information-propagation-filters");
    await filters.locator("select").nth(0).selectOption({ index: 1 });
    await filters.locator("select").nth(1).selectOption({ index: 1 });
    expect(await hasNoHorizontalScroll(page)).toBe(true);
  });
});
