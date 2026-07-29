import { test, expect } from "@playwright/test";
import { gotoStandingParty, setRangeValue } from "./helpers";

/**
 * Issue #203 (Phase 3, 検証範囲11節): standingParty Phase 3のdesktop主要flow。
 * `docs/cluster-transition-phase3-model.md`が言う「実データ較正前の仮説的な値」という前提に沿い、
 * 数値の妥当性ではなくUI配線(選択→設定→反映→観察→pause/resume/reset→scenario切替)が壊れていない
 * ことを検証する。RNG起点はUIのSeed入力(`ControlPanel.tsx`)のみで、URLクエリ等の隠しfixtureは
 * 存在しないため(`e2e/helpers.ts`参照)、target switchを高確率で起こす方向へ詳細設定を寄せたうえで
 * 実時間で複数tick進め、`switchToTargetCluster`の発生を待つ(決定的レプレイではなく、緩やかな
 * 統計的フィクスチャ)。
 */

test.describe("standingParty Phase 3: desktop主要flow", () => {
  test("preset選択→詳細設定→Reset→agent選択→target switch観察→pause/resume/reset→scenario切替", async ({ page }) => {
    test.setTimeout(120_000);

    // 1. standingPartyへ直接アクセス
    await gotoStandingParty(page);
    await expect(page.getByRole("heading", { name: "詳細設定(立食パーティー)" })).toBeVisible();

    // 2. Phase 3 presetを選択(交流先へ移りやすい場: transition.enabled=trueが既定)
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-outward-interest");
    await expect(page.locator(".current-condition")).toContainText("立食パーティー(交流先へ移りやすい場)");

    // 3. 詳細設定を開き、境界内の値へ変更する(switchToTargetClusterが高確率で選ばれる方向)
    await page.getByText(/^他クラスタ関心\(\d+項目\)$/).click();
    await setRangeValue(page.getByTestId("standing-party-field-minTargetInterestScore"), 0);

    await page.getByText(/^遷移decision・移動意図\(\d+項目\)$/).click();
    await expect(page.getByTestId("standing-party-field-transitionEnabled")).toBeChecked();
    await setRangeValue(page.getByTestId("standing-party-field-interestToDepartureGain"), 1);
    await setRangeValue(page.getByTestId("standing-party-field-targetShareBase"), 1);

    await expect(page.locator(".reset-required-banner").first()).toBeVisible();

    // 4. resetして設定反映
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator(".reset-required-banner")).toHaveCount(0);
    await expect(page.locator(".tick-status")).toBeVisible();

    // 5. agentを選択できる(表示するagentセレクタ)
    const agentSelect = page.getByLabel("表示するagent");
    await expect(agentSelect).toBeVisible();
    const agentOptionValues = await agentSelect.locator("option").evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );
    expect(agentOptionValues.length).toBeGreaterThan(0);

    // 6. interest/attachment/concern/decisionが表示される(会話に参加後、いずれかのagentで)
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/\(実行中\)/)).toBeVisible();

    // 7-8. target switch開始(Canvasのtransition-role marker)とjoin成功/fallbackのいずれかを観察する。
    // 実時間駆動のため緩やかなpollingで待つ(`TICK_INTERVAL_MS=250ms`、App.tsx)。
    let sawTransitionRole = false;
    let sawDecisionSection = false;
    for (let attempt = 0; attempt < 60 && !sawTransitionRole; attempt++) {
      for (let i = 0; i < agentOptionValues.length; i++) {
        await agentSelect.selectOption(agentOptionValues[i]);
        if (await page.getByTestId("observer-inspector-target-selection").isVisible().catch(() => false)) {
          sawDecisionSection = true;
        }
        if ((await page.locator('[data-transition-role]').count()) > 0) {
          sawTransitionRole = true;
          break;
        }
      }
      if (!sawTransitionRole) await page.waitForTimeout(500);
    }
    expect(sawDecisionSection, "他クラスタ関心・葛藤decisionの表示が一度も確認できなかった").toBe(true);
    expect(sawTransitionRole, "target switch開始のCanvas marker(data-transition-role)が観察できなかった").toBe(true);

    // 9. pause/resume/reset
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText(/\(一時停止\)/)).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/\(実行中\)/)).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator(".tick-status")).toBeVisible();

    // 10. scenario切替で専用UIとstateが消える
    await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    await expect(page.getByRole("heading", { name: "人がグループを作る過程を、場面ごとに観察する" })).toBeVisible();
    const scenarioCards = page.locator(".scenario-card");
    const cardCount = await scenarioCards.count();
    expect(cardCount).toBeGreaterThan(1);
    // standingParty以外のカードへ入り、standingParty専用パネルが存在しないことを確認する。
    let switchedAway = false;
    for (let i = 0; i < cardCount; i++) {
      await scenarioCards.nth(i).click();
      const isStandingParty = await page.getByRole("heading", { name: "詳細設定(立食パーティー)" }).isVisible().catch(() => false);
      if (!isStandingParty) {
        switchedAway = true;
        break;
      }
      await page.getByRole("link", { name: "← シナリオ選択へ" }).click();
    }
    expect(switchedAway, "standingParty以外のシナリオへ切り替えられなかった").toBe(true);
    await expect(page.getByRole("heading", { name: "詳細設定(立食パーティー)" })).toHaveCount(0);
    await expect(page.locator(".observer-inspector-agent-select")).toHaveCount(0);
  });
});
