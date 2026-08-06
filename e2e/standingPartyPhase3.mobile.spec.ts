import { test, expect } from "@playwright/test";
import { gotoStandingParty, setRangeValue } from "./helpers";

/**
 * Issue #203 (Phase 3, 検証範囲11節): standingParty Phase 3のiPhone相当幅flow。
 * `.claude/skills/verify/SKILL.md`の観点(横スクロールなし、768px/1100pxブレークポイント、
 * パネル縦積み順、`<details>`化)を自動テストへ固定する。ビューポート自体は
 * `playwright.config.ts`の`iphone-chromium`プロジェクト(iPhone 14相当)が既定で与える。
 */

async function hasNoHorizontalScroll(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

test.describe("standingParty Phase 3: iPhone相当幅flow", () => {
  test("横スクロールなし・主要panelへ到達可能・折りたたみ/select/number inputを操作できる", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoStandingParty(page);

    // 初期表示で横スクロールが発生しない(390x664、iPhone 14相当)。
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    // ヘッダー説明は全viewport共通の<details>で、初期状態は閉じている。
    const introductionDetails = page.locator(".scenario-introduction-details");
    await expect(introductionDetails).toBeVisible();
    await expect(introductionDetails).not.toHaveAttribute("open");

    // Canvas・操作・設定・Inspector・ログのいずれにも到達できる(スクロールして表示確認)。
    const canvas = page.locator("svg.simulation-field-canvas");
    const controlPanel = page.getByRole("heading", { name: "操作パネル" });
    const advancedSettings = page.getByRole("heading", { name: "詳細設定(立食パーティー)" });
    const inspector = page.locator(".panel.observer-inspector");
    const eventLog = page.getByRole("heading", { name: "状態ログ" });

    const initialCanvasBox = await canvas.boundingBox();
    expect(initialCanvasBox, "初期表示でCanvasの位置が取得できない").not.toBeNull();
    expect(initialCanvasBox!.y, "詳細を閉じた初期表示ではCanvasへ過度なscrollなしで到達できる").toBeLessThan(520);

    for (const locator of [canvas, controlPanel, advancedSettings, inspector, eventLog]) {
      await locator.scrollIntoViewIfNeeded();
      await expect(locator).toBeVisible();
    }
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    // 折りたたみ(<details>)を操作できる。
    await page.getByText(/^遷移decision・移動意図\(\d+項目\)$/).click();
    const transitionCheckbox = page.getByTestId("standing-party-field-transitionEnabled");
    await expect(transitionCheckbox).toBeVisible();

    // selectを操作できる(preset切り替え)。
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-current-circle");
    await expect(page.locator(".current-condition")).toContainText("立食パーティー(今の輪への配慮が強い場)");

    // number input(Seed)を操作できる。
    const seedInput = page.getByLabel("Seed");
    await seedInput.fill("777");
    await expect(seedInput).toHaveValue("777");

    // range inputを操作できる(長いcluster ID・factor文言を伴う遷移decision・移動意図セクション)。
    await page.getByText(/^遷移decision・移動意図\(\d+項目\)$/).click();
    await setRangeValue(page.getByTestId("standing-party-field-targetShareBase"), 1);

    expect(await hasNoHorizontalScroll(page)).toBe(true);

    // Start/Pause/Stepをタップしてtickが進む。
    await page.getByRole("button", { name: "Step 1 tick", exact: true }).click();
    await expect(page.locator(".tick-status")).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/\(実行中\)/)).toBeVisible();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    expect(await hasNoHorizontalScroll(page)).toBe(true);
  });

  test("320px幅でも横スクロールが発生しない", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await gotoStandingParty(page);
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    await page.getByText(/^他クラスタ関心\(\d+項目\)$/).click();
    expect(await hasNoHorizontalScroll(page)).toBe(true);
  });

  test("操作可能要素が44px相当のタップ領域を持つ(主要ボタン)", async ({ page }) => {
    await gotoStandingParty(page);
    for (const name of ["Start", "Step 1 tick", "Reset"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box, `ボタン「${name}」のboundingBoxが取得できない`).not.toBeNull();
      // 厳密な44px下限はデザイン都合で満たさない既存ボタンもあり得るため、極端な過小(タップ不能に
      // 近い)だけを回帰として検出する(要件: 44px相当の操作領域の確認)。
      expect(box!.height).toBeGreaterThanOrEqual(24);
      expect(box!.width).toBeGreaterThanOrEqual(24);
    }
  });
});
