import { expect, type Locator, type Page } from "@playwright/test";

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

async function revealVenueLog(page: Page): Promise<void> {
  const showAll = page.getByRole("button", { name: "すべて表示" });
  if (await showAll.isVisible().catch(() => false)) {
    await showAll.click();
  }
}

function parseVisitStart(text: string): { label: string; kind: "ドリンク" | "料理"; item: "ドリンク" | "料理" } | undefined {
  const match = text.match(/(\S+)さんが(ドリンク|料理)を取りに移動を始めた/);
  if (!match) return undefined;
  const kind = match[2] as "ドリンク" | "料理";
  return { label: match[1], kind, item: kind };
}

async function selectAgentByLabel(page: Page, label: string): Promise<void> {
  const agentSelect = page.getByLabel("表示するagent");
  const optionValue = await agentSelect.locator("option").evaluateAll((opts, agentLabel) => {
    const match = opts.find((option) => {
      const text = option.textContent ?? "";
      return text === agentLabel || text === `${agentLabel}(observerJoiner)`;
    });
    return match ? (match as HTMLOptionElement).value : "";
  }, label);
  expect(optionValue).not.toBe("");
  await agentSelect.selectOption(optionValue);
  await page.getByText("飲食の目的行動(会話への参加とは別)").scrollIntoViewIfNeeded();
}

/** #266 のインスペクターは空腹と喉の渇きを `0.72 / 0.31` の1行で出す。 */
async function readRefreshmentNeeds(page: Page): Promise<{ hunger: number; thirst: number }> {
  const row = page.locator(".observer-inspector-row").filter({ hasText: "空腹 / 喉の渇き" });
  await expect(row).toBeVisible();
  const text = await row.innerText();
  const match = text.match(/(\d+\.\d+)\s*\/\s*(\d+\.\d+)/);
  if (!match) throw new Error(`空腹 / 喉の渇きの行を読めない: ${text}`);
  return { hunger: Number(match[1]), thirst: Number(match[2]) };
}

/**
 * Issue #267: 初期preset「飲食による会場回遊」の既定閾値(0.7)のまま、
 * 移動中の需要と受け取り後の需要を #266 のインスペクターから読む。
 * 閾値を 0.05 まで下げると補充後(0.15)の方が高くなり得るので、この確認では下げない。
 * Canvas座標の一致は見ない。
 */
export async function observeVenueNeedDrop(page: Page): Promise<void> {
  await page.getByLabel("シナリオプリセット").selectOption("standing-party-venue-refreshment");
  await page.getByLabel("Seed").fill("267");
  await page.getByRole("button", { name: "Reset", exact: true }).click();

  await expect(page.getByTestId("venue-anchor-anchor:food-main")).toBeVisible();
  await expect(page.getByTestId("venue-anchor-anchor:drink-main")).toBeVisible();

  await page.getByRole("button", { name: "Start", exact: true }).click();
  let started: { label: string; kind: "ドリンク" | "料理"; item: "ドリンク" | "料理" } | undefined;
  await expect
    .poll(
      async () => {
        await revealVenueLog(page);
        const texts = await page.locator(".event-log-entry").allTextContents();
        for (const text of texts) {
          const parsed = parseVisitStart(text);
          if (!parsed) continue;
          const obtained = texts.some((row) => row.includes(`${parsed.label}さんが${parsed.item}を受け取った`));
          if (obtained) continue;
          if (await page.getByRole("button", { name: "Pause", exact: true }).isVisible()) {
            await page.getByRole("button", { name: "Pause", exact: true }).click();
          }
          started = parsed;
          return true;
        }
        return false;
      },
      { timeout: 120_000, intervals: [250] },
    )
    .toBe(true);
  if (!started) throw new Error("移動開始ログが見つからない");
  const visit = started;

  await selectAgentByLabel(page, visit.label);
  const duringTravel = await readRefreshmentNeeds(page);
  const duringValue = visit.kind === "ドリンク" ? duringTravel.thirst : duringTravel.hunger;
  expect(duringValue).toBeGreaterThanOrEqual(0.65);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .poll(
      async () => {
        await revealVenueLog(page);
        const texts = await page.locator(".event-log-entry").allTextContents();
        return texts.some((row) => row.includes(`${visit.label}さんが${visit.item}を受け取った`));
      },
      { timeout: 60_000, intervals: [250] },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await selectAgentByLabel(page, visit.label);
  const afterObtain = await readRefreshmentNeeds(page);
  const afterValue = visit.kind === "ドリンク" ? afterObtain.thirst : afterObtain.hunger;
  expect(afterValue).toBeLessThan(duringValue);
  expect(afterValue).toBeLessThan(0.45);
}
