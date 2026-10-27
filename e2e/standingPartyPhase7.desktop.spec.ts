import { expect, test } from "@playwright/test";
import { gotoStandingParty, observeVenueNeedDrop, setRangeValue } from "./helpers";

/**
 * Issue #266: 飲食presetで台への移動・受け取り・復帰がCanvasとログから追えること、
 * 表示の切り替えがtickを変えないこと、飲食なし比較へ切り替えると台が消えることを確認する。
 * Issue #267: 同じインスペクターで、既定閾値の受け取り後に需要が下がることを別手順で確認する。
 * 閾値0.05の手順では補充後の値の方が高くなり得るため、需要低下はその手順に混ぜない。
 */

test.describe("standingParty Phase 7: desktopの飲食動線", () => {
  test("初期presetで移動を観察し、表示切替と飲食なし比較ができる", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoStandingParty(page);

    const preset = page.getByLabel("シナリオプリセット");
    await expect(preset).toHaveValue("standing-party-venue-refreshment");
    await expect(page.locator(".current-condition")).toContainText("飲食による会場回遊");
    await expect(page.getByTestId("venue-anchor-anchor:food-main")).toBeVisible();
    await expect(page.getByTestId("venue-anchor-anchor:drink-main")).toBeVisible();

    const headerBox = await page.locator(".app-header").boundingBox();
    const canvasBox = await page.locator("svg.simulation-field-canvas").boundingBox();
    expect(headerBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(headerBox!.height).toBeLessThan(320);
    expect(canvasBox!.y).toBeLessThan(420);
    expect(canvasBox!.height).toBeGreaterThan(180);

    const agentSelect = page.getByLabel("表示するagent");
    const agentOptionValues = await agentSelect.locator("option").evaluateAll((opts) =>
      opts.map((option) => (option as HTMLOptionElement).value),
    );
    await agentSelect.selectOption(agentOptionValues[0]);
    await expect(page.getByText("飲食の目的行動(会話への参加とは別)")).toBeVisible();

    await setRangeValue(page.getByTestId("standing-party-field-visitThreshold"), 0.05);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();

    const traveling = page.locator("[data-venue-phase='traveling']");
    await expect(traveling.first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("取りに移動を始めた").first()).toBeVisible();

    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const tickBefore = await page.locator(".tick-status").textContent();
    const markers = page.getByTestId("venue-visit-markers-toggle");
    await expect(markers).toBeChecked();
    await markers.uncheck();
    await expect(page.locator("[data-venue-phase]")).toHaveCount(0);
    await expect(page.locator(".tick-status")).toHaveText(tickBefore ?? "");
    await expect(page.getByTestId("venue-anchor-anchor:food-main")).toBeVisible();
    await markers.check();
    await expect(page.locator("[data-venue-phase]").first()).toBeVisible();

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText("受け取った").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("会場の回遊に戻った").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    await page.getByLabel("シナリオプリセット").selectOption("standing-party-venue-off-baseline");
    await expect(page.locator(".tick-status")).toContainText("Tick: 0");
    await expect(page.getByTestId("venue-anchor-anchor:food-main")).toHaveCount(0);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(2_000);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText("取りに移動を始めた")).toHaveCount(0);
  });

  test("既定の閾値では受け取り後に満たした需要が下がる", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoStandingParty(page);
    await observeVenueNeedDrop(page);
  });
});
