import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SpeechEffectsComparisonPanel } from "./SpeechEffectsComparisonPanel";
import { DEFAULT_PARAMS } from "../simulation/presets";

describe("SpeechEffectsComparisonPanel", () => {
  it("renders the empty state prompt before any comparison has been executed", () => {
    const html = renderToStaticMarkup(
      createElement(SpeechEffectsComparisonPanel, {
        presetId: "natural",
        params: DEFAULT_PARAMS,
        seed: 12345,
        interventionId: "none",
        singleSimRunning: false,
        onBeforeRun: () => {},
      }),
    );

    expect(html).toContain("発言効果OFF/ONを比較して実行");
    expect(html).toContain("同一条件");
    expect(html).not.toContain("monte-carlo-stale");
  });

  it("works regardless of the selected intervention (unlike InterventionComparisonPanel, 'none' is not disabled)", () => {
    const html = renderToStaticMarkup(
      createElement(SpeechEffectsComparisonPanel, {
        presetId: "natural",
        params: DEFAULT_PARAMS,
        seed: 12345,
        interventionId: "none",
        singleSimRunning: false,
        onBeforeRun: () => {},
      }),
    );

    expect(html).not.toContain("が選択されているため比較できません");
  });

  it("shows a note that the single simulation will pause when it is currently running", () => {
    const html = renderToStaticMarkup(
      createElement(SpeechEffectsComparisonPanel, {
        presetId: "natural",
        params: DEFAULT_PARAMS,
        seed: 12345,
        interventionId: "late-join-ok",
        singleSimRunning: true,
        onBeforeRun: () => {},
      }),
    );

    expect(html).toContain("単発シミュレーションは一時停止します");
  });
});
