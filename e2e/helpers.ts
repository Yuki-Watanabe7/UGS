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

/**
 * Issue #267: 立食パーティーで飲食台を有効にし、移動→受け取り→need低下→回遊復帰を
 * イベントログとInspectorの数値で確認する。Canvas座標の一致は見ない。
 */
export async function observeVenueRefreshment(page: Page): Promise<void> {
  await page.getByLabel("シナリオプリセット").selectOption("standing-party");
  await page.getByLabel("Seed").fill("267");
  await page.getByRole("button", { name: "Reset", exact: true }).click();

  const summary = page.getByText("飲食台(Phase 7", { exact: false });
  await summary.scrollIntoViewIfNeeded();
  const details = summary.locator("xpath=ancestor::details[1]");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await summary.click();
  }
  await page.getByTestId("standing-party-field-venueAnchorsEnabled").check();
  await page.getByRole("button", { name: "Reset", exact: true }).click();

  await expect(page.getByTestId("venue-anchor-anchor:food-main")).toBeVisible();
  await expect(page.getByTestId("venue-anchor-anchor:drink-main")).toBeVisible();
  await expect(page.getByTestId("observer-inspector-venue-visit")).toBeVisible();

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
      { timeout: 90_000, intervals: [250] },
    )
    .toBe(true);
  if (!started) throw new Error("移動開始ログが見つからない");
  const visit = started;

  const agentSelect = page.getByLabel("表示するagent");
  const optionValue = await agentSelect.locator("option").evaluateAll((opts, label) => {
    const match = opts.find((option) => {
      const text = option.textContent ?? "";
      return text === label || text === `${label}(observerJoiner)`;
    });
    return match ? (match as HTMLOptionElement).value : "";
  }, visit.label);
  expect(optionValue).not.toBe("");
  await agentSelect.selectOption(optionValue);
  const needTestId = visit.kind === "ドリンク" ? "observer-inspector-venue-thirst" : "observer-inspector-venue-hunger";
  const duringTravel = Number(await page.getByTestId(needTestId).innerText());
  expect(duringTravel).toBeGreaterThanOrEqual(0.65);

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
  await agentSelect.selectOption(optionValue);
  const afterObtain = Number(await page.getByTestId(needTestId).innerText());
  expect(afterObtain).toBeLessThan(duringTravel);
  expect(afterObtain).toBeLessThan(0.45);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  const station = visit.kind === "ドリンク" ? "ドリンク台" : "料理台";
  await expect
    .poll(
      async () => {
        await revealVenueLog(page);
        const texts = await page.locator(".event-log-entry").allTextContents();
        return texts.some((row) => row.includes(`${visit.label}さんが${station}を離れ、会場の回遊に戻った`));
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await agentSelect.selectOption(optionValue);
  const texts = await page.locator(".event-log-entry").allTextContents();
  expect(texts.some((row) => row.includes(`${visit.label}さんが${station}を離れ、会場の回遊に戻った`))).toBe(true);
  // 完了の次tickでもう一方の台へ出ることがある。その場合も回遊ログのあとに次の訪問が始まっている。
  const phase = await page.getByTestId("observer-inspector-venue-phase").innerText();
  expect(["訪問していない", "台へ移動中", "受け取り中", "摂取中"]).toContain(phase);
}
