import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InterventionComparisonPanel } from "./InterventionComparisonPanel";
import { DEFAULT_PARAMS } from "../simulation/presets";

describe("InterventionComparisonPanel", () => {
  it("disables comparison and shows an explanatory message when 'none' is selected", () => {
    const html = renderToStaticMarkup(
      createElement(InterventionComparisonPanel, {
        presetId: "natural",
        params: DEFAULT_PARAMS,
        seed: 12345,
        interventionId: "none",
        singleSimRunning: false,
        onBeforeRun: () => {},
      }),
    );

    expect(html).toContain("「介入なし」が選択されているため比較できません");
    expect(html).not.toContain("介入なしと比較して実行");
  });

  it("renders the empty state prompt before any comparison has been executed", () => {
    const html = renderToStaticMarkup(
      createElement(InterventionComparisonPanel, {
        presetId: "natural",
        params: DEFAULT_PARAMS,
        seed: 12345,
        interventionId: "late-join-ok",
        singleSimRunning: false,
        onBeforeRun: () => {},
      }),
    );

    expect(html).toContain("介入なしと比較して実行");
    expect(html).toContain("を同一条件");
    expect(html).not.toContain("monte-carlo-stale");
  });

  it("shows a note that the single simulation will pause when it is currently running", () => {
    const html = renderToStaticMarkup(
      createElement(InterventionComparisonPanel, {
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
