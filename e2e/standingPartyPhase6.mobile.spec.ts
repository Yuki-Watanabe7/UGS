import { expect, test } from "@playwright/test";
import { gotoStandingParty } from "./helpers";

/**
 * Issue #252 (standingParty Phase 6 統合検証): iPhone相当幅でも空間ダイナミクスの主要観察flow
 * (preset選択→Inspector diagnostics→overlay toggle→dashboard)へ到達でき、横overflowを起こさない
 * ことを確認する。desktop版(`standingPartyPhase6.desktop.spec.ts`)のexport/scenario切替は割愛し、
 * 320px幅でのレイアウト崩れの検出に絞る。
 */

async function hasNoHorizontalScroll(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

async function ensureDetailsOpen(page: import("@playwright/test").Page, testId: string): Promise<void> {
  const panel = page.getByTestId(testId);
  await panel.scrollIntoViewIfNeeded();
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await panel.locator("summary").click();
  }
}

test.describe("standingParty Phase 6: iPhone相当幅の観察flow", () => {
  test("320px幅で空間diagnostics/overlay/dashboardへ到達でき、横overflowを起こさない", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 640 });
    await gotoStandingParty(page);
    await page.getByLabel("シナリオプリセット").selectOption("standing-party-spatial-roaming");
    await page.getByLabel("Seed").fill("252");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(4_000);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    const agentSelect = page.getByLabel("表示するagent");
    await expect(agentSelect).toBeVisible();
    const agentOptionValues = await agentSelect.locator("option").evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );
    await agentSelect.selectOption(agentOptionValues[0]);
    await expect(page.getByText("空間diagnostics(Phase 6)")).toBeVisible();
    expect(await hasNoHorizontalScroll(page)).toBe(true);

    const overlayToggle = page.getByTestId("spatial-diagnostics-toggle");
    await overlayToggle.scrollIntoViewIfNeeded();
    await overlayToggle.check();
    await expect(page.locator(".spatial-diagnostic-grid")).toHaveCount(1);
    expect(await hasNoHorizontalScroll(page)).toBe(true);
    await overlayToggle.uncheck();

    await ensureDetailsOpen(page, "analytics-dashboard");
    await expect(page.getByTestId("analytics-spatial-overview")).toBeVisible();
    expect(await hasNoHorizontalScroll(page)).toBe(true);
  });
});
