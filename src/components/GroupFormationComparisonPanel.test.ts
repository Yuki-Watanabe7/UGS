import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupFormationComparisonPanel } from "./GroupFormationComparisonPanel";
import { DEFAULT_PARAMS } from "../simulation/presets";
import { CLASSROOM_PRESENTATION } from "../presentation/scenarioPresentation";

/**
 * Issue #170: 起源別内訳・低圧介入ファネル・分位点の表示を追加した`GroupFormationComparisonPanel`の
 * スモークテスト。`InterventionComparisonPanel.test.ts`と同じ手法(`renderToStaticMarkup`による
 * 初期状態の静的レンダリング確認のみ、jsdomでのクリック操作は行わない)。
 */

describe("GroupFormationComparisonPanel", () => {
  it("実行前の空状態を、教師介入が選択可能なプリセットでエラーなく描画する", () => {
    const html = renderToStaticMarkup(
      createElement(GroupFormationComparisonPanel, {
        presetId: "classroomPair",
        params: DEFAULT_PARAMS,
        seed: 12345,
        singleSimRunning: false,
        onBeforeRun: () => {},
        formation: { scenarioId: "classroomPair", formationDeadlineTick: 60, classroomGroupSize: { minGroupSize: 2, maxGroupSize: 2 } },
        presentation: CLASSROOM_PRESENTATION,
      }),
    );

    expect(html).toContain("介入なしと比較して実行");
    expect(html).not.toContain("所属起源別の人数");
  });
});
