import { expect, test } from "@playwright/test";
import { gotoStandingParty } from "./helpers";

/**
 * Issue #252 (standingParty Phase 6 統合検証, roadmap #172): #246〜#251が実装した空間ダイナミクス
 * (cluster間斥力・persistent roaming・crowding avoidance・候補選択の一般化・設定UI/診断/統計)の
 * desktop主要観察flowを実ブラウザで固定する。数値の妥当性(spatial coverageの改善幅等)は
 * `standingPartyPhase6Verification.test.ts`のpaired seed検証に委ね、ここではUI配線の到達性
 * (preset選択→観察→Inspector diagnostics→overlay toggle→dashboard→export→pause/resume/reset→
 * scenario切替)を確認する。
 */

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

test.describe("standingParty Phase 6: desktop主要観察flow", () => {
  test("空間回遊presetで実行→Inspector diagnostics→overlay toggle→dashboard→export→pause/resume/reset→scenario切替", async ({ page }) => {
    test.setTimeout(120_000);

    // 1. 比較preset「立食パーティー(空間回遊あり・分散型)」を選ぶ(#251が用意したpaired比較用preset)
    await gotoStandingParty(page);
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-spatial-roaming");
    await expect(page.locator(".current-condition")).toContainText("立食パーティー(空間回遊あり・分散型)");
    await page.getByLabel("Seed").fill("252");
    await page.getByRole("button", { name: "Reset", exact: true }).click();

    // 2. 実時間で進め、複数tick分の空間ダイナミクスを観察する
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/\(実行中\)/)).toBeVisible();
    await page.waitForTimeout(5_000);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText(/\(一時停止\)/)).toBeVisible();

    // 3. Inspectorで選択agentの「空間diagnostics(Phase 6)」sectionへ到達できる
    const agentSelect = page.getByLabel("表示するagent");
    await expect(agentSelect).toBeVisible();
    const agentOptionValues = await agentSelect.locator("option").evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );
    expect(agentOptionValues.length).toBeGreaterThan(0);
    await agentSelect.selectOption(agentOptionValues[0]);
    await expect(page.getByText("空間diagnostics(Phase 6)")).toBeVisible();

    // 4. Canvasの空間diagnostics overlay toggle(既定OFF)をONにすると、計測用gridが描画される
    const overlayToggle = page.getByTestId("spatial-diagnostics-toggle");
    await expect(overlayToggle).not.toBeChecked();
    await overlayToggle.check();
    await expect(page.locator(".spatial-diagnostic-grid")).toHaveCount(1);
    await overlayToggle.uncheck();
    await expect(page.locator(".spatial-diagnostic-grid")).toHaveCount(0);

    // 5. 統計ダッシュボードの「空間ダイナミクス(Phase 6)」sectionが有効時の分布・tableを表示する
    for (const testId of ["contact-network", "conversation-history"]) {
      await ensureDetailsClosed(page, testId);
    }
    await ensureDetailsOpen(page, "analytics-dashboard");
    const spatialOverview = page.getByTestId("analytics-spatial-overview");
    await expect(spatialOverview).toBeVisible();
    await expect(spatialOverview).toContainText("spatial coverage");
    await expect(spatialOverview).not.toContainText("Spatial Dynamicsは現在無効です");

    await page.getByTestId("analytics-view-tables").evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId("analytics-tables")).toBeVisible();
    await page.getByTestId("analytics-view-charts").evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId("analytics-spatial-cluster-distance-dist")).toBeVisible();
    await expect(page.getByTestId("analytics-spatial-density-dist")).toBeVisible();
    await expect(page.getByTestId("analytics-spatial-breakdown")).toBeVisible();

    // 6. export(spatialDynamics fieldを含むbundle)がJSON/CSVとしてdownloadできる
    const jsonDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("analytics-export-json").evaluate((el) => (el as HTMLButtonElement).click());
    expect((await jsonDownload).suggestedFilename()).toMatch(/\.json$/i);
    const csvDownload = page.waitForEvent("download", { timeout: 10_000 });
    await page.getByTestId("analytics-export-csv").evaluate((el) => (el as HTMLButtonElement).click());
    expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/i);

    // 7. pause/resume/resetでも空間ダイナミクスUIが残る(reset後は初期状態へ戻る)
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("analytics-spatial-overview")).toBeVisible();

    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator(".tick-status")).toBeVisible();
    await expect(page.getByTestId("analytics-spatial-overview")).toBeVisible();

    // 8. 比較基準preset「空間固定に近い比較基準」へ切り替えると、Spatial Dynamicsが無効表示になる
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-spatial-fixed-baseline");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.getByTestId("analytics-spatial-overview")).toContainText("Spatial Dynamicsは現在無効です");

    // 9. afterParty/classroomへ切替えると、standingParty専用のspatial UIが残らない
    await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
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
    await expect(page.getByTestId("spatial-diagnostics-toggle")).toHaveCount(0);
    await expect(page.getByTestId("analytics-spatial-overview")).toHaveCount(0);
  });
});
