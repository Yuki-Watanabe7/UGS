import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getScenarioById } from "../scenarios";
import { ScenarioIntroduction } from "./ScenarioIntroduction";
import { getRenderableScenarioIntroSections, type ScenarioIntroSection } from "./scenarioIntroductionContent";

function render(summary: string, details?: readonly ScenarioIntroSection[]): string {
  return renderToStaticMarkup(createElement(ScenarioIntroduction, { summary, details }));
}

describe("ScenarioIntroduction", () => {
  it("renders every scenario with the same summary and native details structure", () => {
    for (const scenarioId of ["after-party", "classroom", "standing-party"] as const) {
      const scenario = getScenarioById(scenarioId);
      const html = render(scenario.introSummary, scenario.introDetails);

      expect(html).toContain(scenario.introSummary);
      expect(html).toContain('<details class="scenario-introduction-details">');
      expect(html).toContain("仕組みと見方");
      // `open`属性を付けないことで、初期状態は閉じている。
      expect(html).not.toContain('<details class="scenario-introduction-details" open="">');
    }
  });

  it("keeps the standing-party model, ObserverJoiner, non-judgment, and pause guidance in details", () => {
    const scenario = getScenarioById("standing-party");
    const html = render(scenario.introSummary, scenario.introDetails);

    for (const text of [
      "離脱・移動の要因",
      "ObserverJoinerについて",
      "値の解釈上の注意",
      "性格の良し悪しや人格診断を意味しません",
      "区切りたいタイミングで一時停止してください",
      "Phase 5で話題や情報伝播のモデルを追加する場合",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("works without details for a future concise scenario", () => {
    const html = render("常時表示する短い概要です。");

    expect(html).toContain("常時表示する短い概要です。");
    expect(html).not.toContain("<details");
  });

  it("omits empty sections while retaining a long valid explanation", () => {
    const longBody = "長い説明。".repeat(80);
    const html = render("概要", [
      { id: "long", title: "長い説明", body: longBody },
      { id: "", title: "idなし", body: "表示しない" },
      { id: "empty-title", title: "  ", body: "表示しない" },
      { id: "empty-body", title: "本文なし", body: "\n" },
    ]);

    expect(html).toContain(longBody);
    expect(html).not.toContain("idなし");
    expect(html).not.toContain("本文なし");
    expect(getRenderableScenarioIntroSections([
      { id: "valid", title: "有効", body: "本文" },
      { id: "", title: "無効", body: "本文" },
    ])).toHaveLength(1);
  });
});
