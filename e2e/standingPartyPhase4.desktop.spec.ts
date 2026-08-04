import { test, expect } from "@playwright/test";
import { gotoStandingParty } from "./helpers";

/**
 * Issue #218 (Phase 4 分析, 検証範囲9節): standingParty Phase 4のdesktop主要分析flow。
 * timeline / network / dashboard / filter連携 / export / pause・resume / reset /
 * scenario切替を実ブラウザで確認する。数値の妥当性ではなくUI配線の到達性を固定する。
 *
 * 右サイドバーは`overflow: hidden` + event-logの`flex: 1`のため、分析panelを同時展開すると
 * クリックが隣接panelに遮られる。本E2Eでは操作対象以外の`<details>`を閉じてから進める。
 */

async function ensureDetailsOpen(
  page: import("@playwright/test").Page,
  testId: string,
): Promise<void> {
  const panel = page.getByTestId(testId);
  await panel.scrollIntoViewIfNeeded();
  if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await panel.locator("summary").click();
  }
}

async function ensureDetailsClosed(
  page: import("@playwright/test").Page,
  testId: string,
): Promise<void> {
  const panel = page.getByTestId(testId);
  if (await panel.evaluate((el) => (el as HTMLDetailsElement).open)) {
    await panel.locator("summary").click();
  }
}

test.describe("standingParty Phase 4: desktop主要分析flow", () => {
  test("履歴蓄積→timeline/network/dashboard→filter連携→export→pause/resume/reset→scenario切替", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await gotoStandingParty(page);
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-outward-interest");
    await expect(page.locator(".current-condition")).toContainText("立食パーティー(交流先へ移りやすい場)");

    await page.getByLabel("Seed").fill("218");
    await page.getByRole("button", { name: "Reset", exact: true }).click();

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/\(実行中\)/)).toBeVisible();
    await page.waitForTimeout(4_000);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText(/\(一時停止\)/)).toBeVisible();

    // 初期状態で3panelともopenなので、操作対象以外を閉じてから進める
    await ensureDetailsClosed(page, "analytics-dashboard");
    await ensureDetailsClosed(page, "contact-network");
    await ensureDetailsClosed(page, "conversation-history");

    // timeline
    await ensureDetailsOpen(page, "conversation-history");
    await expect(page.getByTestId("conversation-history-filters")).toBeVisible();
    const episodeBars = page.locator('[data-testid^="conversation-history-episode-"]');
    const hasEpisodes = (await episodeBars.count()) > 0;
    const hasEmpty = await page.getByTestId("conversation-history-empty").isVisible().catch(() => false);
    expect(hasEpisodes || hasEmpty).toBe(true);
    if (hasEpisodes) {
      await episodeBars.first().click({ force: true });
      await expect(page.getByTestId("conversation-history-detail")).toBeVisible();
    }
    await ensureDetailsClosed(page, "conversation-history");

    // network
    await ensureDetailsOpen(page, "contact-network");
    await expect(page.getByTestId("contact-network-controls")).toBeVisible();
    await page.getByTestId("contact-network-weight-mode").selectOption("contactIntervalCount");
    await expect(page.getByTestId("contact-network-metrics")).toBeVisible();
    const listNodes = page.locator('[data-testid^="contact-network-list-node-"]');
    if ((await listNodes.count()) > 0) {
      await listNodes.first().click({ force: true });
      await expect(page.getByTestId("contact-network-detail")).toBeVisible();
    }
    await ensureDetailsClosed(page, "contact-network");

    // dashboard
    await ensureDetailsOpen(page, "analytics-dashboard");
    await expect(page.getByTestId("analytics-overview")).toBeVisible();
    await expect(page.getByTestId("analytics-overview")).toContainText("episode");
    await expect(page.getByTestId("analytics-overview")).toContainText("接触network");

    await page.getByTestId("analytics-from-tick").fill("0");
    // chart↔table切替(force clickはReact onClickを発火する)
    await page.getByTestId("analytics-view-tables").evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId("analytics-tables")).toBeVisible();
    await page.getByTestId("analytics-view-charts").evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId("analytics-charts")).toBeVisible();

    const jsonDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("analytics-export-json").evaluate((el) => (el as HTMLButtonElement).click());
    expect((await jsonDownload).suggestedFilename()).toMatch(/\.json$/i);

    const csvDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("analytics-export-csv").evaluate((el) => (el as HTMLButtonElement).click());
    expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/i);

    // pause/resume後も分析パネルが残る
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("analytics-dashboard")).toBeVisible();
    await expect(page.getByTestId("conversation-history")).toBeVisible();

    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator(".tick-status")).toBeVisible();
    await expect(page.getByTestId("analytics-dashboard")).toBeVisible();

    // scenario切替でstandingParty専用分析UIが消える
    await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    await expect(page.getByRole("heading", { name: "人がグループを作る過程を、場面ごとに観察する" })).toBeVisible();
    const scenarioCards = page.locator(".scenario-card");
    const cardCount = await scenarioCards.count();
    let switchedAway = false;
    for (let i = 0; i < cardCount; i++) {
      await scenarioCards.nth(i).click();
      const isStandingParty = await page
        .getByRole("heading", { name: "詳細設定(立食パーティー)" })
        .isVisible()
        .catch(() => false);
      if (!isStandingParty) {
        switchedAway = true;
        break;
      }
      await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    }
    expect(switchedAway).toBe(true);
    await expect(page.getByTestId("analytics-dashboard")).toHaveCount(0);
    await expect(page.getByTestId("contact-network")).toHaveCount(0);
    await expect(page.getByTestId("conversation-history")).toHaveCount(0);
  });
});
