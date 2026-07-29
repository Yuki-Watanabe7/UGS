import type { Locator, Page } from "@playwright/test";

/**
 * Issue #203 (Phase 3, 検証範囲11節): `<input type="range">`はPlaywrightの`fill()`が信頼できないため
 * (ブラウザによってはinputイベントが発火しない)、値を直接設定してinput/changeイベントを発火させる。
 */
export async function setRangeValue(locator: Locator, value: number): Promise<void> {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/**
 * standingPartyシナリオへ直接遷移する。`baseURL`(`playwright.config.ts`)は`/UGS/`を含むため、
 * 先頭に`/`を付けると(絶対パス扱いになり)baseURLのパス部分ごと上書きされてしまう
 * (`new URL('/x', 'http://host/UGS/')` は `http://host/x`)。相対パスのまま渡す。
 */
export async function gotoStandingParty(page: Page): Promise<void> {
  await page.goto("simulate/standing-party");
  await page.getByRole("heading", { name: "操作パネル" }).waitFor();
}
