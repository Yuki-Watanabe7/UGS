import { expect, test } from "@playwright/test";
import { gotoStandingParty } from "./helpers";

async function ensureDetailsOpen(page: import("@playwright/test").Page, testId: string): Promise<void> {
  const panel = page.getByTestId(testId);
  await panel.scrollIntoViewIfNeeded();
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await panel.locator("summary").click();
  }
}

async function ensureDetailsClosed(page: import("@playwright/test").Page, testId: string): Promise<void> {
  const panel = page.getByTestId(testId);
  if (await panel.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await panel.locator("summary").click();
  }
}

test.describe("standingParty Phase 5: desktop主要観察flow", () => {
  test("情報発話→Inspector/network/lineage/timeline/statistics→export→pause/reset→scenario切替", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoStandingParty(page);
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-rumor-mutation");
    await page.getByLabel("Seed").fill("235");
    await page.getByRole("button", { name: "Reset", exact: true }).click();

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    for (const testId of ["analytics-dashboard", "contact-network", "conversation-history"]) {
      await ensureDetailsClosed(page, testId);
    }
    await ensureDetailsOpen(page, "information-propagation");
    const panel = page.getByTestId("information-propagation");
    await expect(panel.getByTestId("information-propagation-filters")).toBeVisible();
    await expect(panel.getByTestId("information-propagation-inspector")).toContainText("情報状態");

    // 実際に生成された内容発話を表示層まで辿り、文字列ログ解析には依存しない。
    await panel.getByRole("tab", { name: "timeline" }).click();
    await expect(panel.getByTestId("information-propagation-timeline")).toContainText("contentUtterance");

    await panel.getByRole("tab", { name: "伝播network" }).click();
    await expect(panel.getByTestId("information-propagation-network")).toContainText("接触だけでは矢印を表示しません");
    await panel.getByLabel("接触edgeを背景に表示").uncheck();
    await panel.getByLabel("接触edgeを背景に表示").check();

    await panel.getByRole("tab", { name: "Claim lineage" }).click();
    await expect(panel.getByTestId("information-propagation-lineage")).toContainText("canonical root");

    await panel.getByRole("tab", { name: "記述統計" }).click();
    await expect(panel.getByTestId("information-propagation-statistics")).toContainText("utterance → heard");
    await panel.getByTestId("information-propagation-filters").locator("select").nth(1).selectOption({ index: 1 });
    await expect(panel.getByTestId("information-propagation-statistics")).toBeVisible();

    // exportはPhase 4/5共通bundleだが、Phase 5が有効なrunから同じ入口で出力できる。
    await ensureDetailsClosed(page, "information-propagation");
    await ensureDetailsOpen(page, "analytics-dashboard");
    const jsonDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("analytics-export-json").evaluate((element) => (element as HTMLButtonElement).click());
    expect((await jsonDownload).suggestedFilename()).toMatch(/\.json$/i);
    const csvDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("analytics-export-csv").evaluate((element) => (element as HTMLButtonElement).click());
    expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/i);

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("information-propagation")).toBeVisible();

    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await ensureDetailsOpen(page, "information-propagation");
    await panel.getByRole("tab", { name: "timeline" }).click();
    await expect(panel.getByTestId("information-propagation-timeline").locator("tbody tr")).toHaveCount(0);

    await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    const cards = page.locator(".scenario-card");
    const cardCount = await cards.count();
    let switchedAway = false;
    for (let i = 0; i < cardCount; i++) {
      await cards.nth(i).click();
      if (!(await page.getByRole("heading", { name: "詳細設定(立食パーティー)" }).isVisible().catch(() => false))) {
        switchedAway = true;
        break;
      }
      await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    }
    expect(switchedAway).toBe(true);
    await expect(page.getByTestId("information-propagation")).toHaveCount(0);
  });
});
