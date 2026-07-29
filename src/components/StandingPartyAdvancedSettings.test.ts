import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StandingPartyAdvancedSettings } from "./StandingPartyAdvancedSettings";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  OUTWARD_INTEREST_STANDING_PARTY_CONFIG,
  CURRENT_CIRCLE_ATTACHMENT_STANDING_PARTY_CONFIG,
  type StandingPartyScenarioConfig,
} from "../simulation/standingPartyScenarioConfig";

/**
 * Issue #202 8節: `StandingPartyAdvancedSettings`のコンポーネントテスト。Phase 2の直接コンポーネントテストは
 * PR #195/#196で対象外として残っていた(issue #202背景節)ため、Phase 2セクションも含めてここでカバーする。
 * `renderToStaticMarkup`による静的レンダリングのため、onChange操作そのものはテストせず(既存の
 * `ExpressionDisplaySettings.test.ts`と同じ方針)、折りたたみセクションの展開状態・現在値の表示・
 * Resetバナーの出現条件・scenario切替(このcomponent自体は常にstandingParty専用)を検証する。
 */

function render(config: StandingPartyScenarioConfig, hasPendingChanges = false) {
  return renderToStaticMarkup(
    createElement(StandingPartyAdvancedSettings, { config, onConfigChange: () => {}, hasPendingChanges }),
  );
}

describe("StandingPartyAdvancedSettings", () => {
  it("renders all four sections (Phase 2 + 3 Phase 3 groups) with non-personality-judging notes", () => {
    const html = render(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG);

    expect(html).toContain("Phase 2パラメータ");
    expect(html).toContain("他クラスタ関心");
    expect(html).toContain("現在クラスタ愛着・離脱配慮");
    expect(html).toContain("遷移decision・移動意図");
    expect(html).toContain("性格の良し悪しや");
    expect(html).toContain("ObserverJoinerも他のagentと同じ連続値のdecision");
  });

  it("does not show the reset-required banner when there are no pending changes", () => {
    const html = render(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, false);
    expect(html).not.toContain("一部の変更はReset後に反映されます");
  });

  it("shows the reset-required banner when there are pending changes", () => {
    const html = render(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG, true);
    expect(html).toContain("一部の変更はReset後に反映されます");
  });

  it("renders each field with a Reset-required apply-mode badge (all fields need Reset to take effect)", () => {
    const html = render(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG);
    const badgeCount = (html.match(/apply-mode-badge--resetRequired/g) ?? []).length;
    // Phase 2(10項目) + 他クラスタ関心(8項目) + 愛着(8項目) + 遷移(1 boolean + 4 number)の合計31項目
    expect(badgeCount).toBe(31);
  });

  it("reflects the current numeric values from the config (e.g. observation radius)", () => {
    const html = render(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG);
    expect(html).toContain(`${DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.alternativeInterest.observationRadius.toFixed(0)}px`);
  });

  function transitionEnabledCheckboxTag(html: string): string {
    // data-testidを持つ`transitionEnabled`のinputタグ自体を切り出す(属性順序に依存しない)。
    const testidIndex = html.indexOf('data-testid="standing-party-field-transitionEnabled"');
    const tagStart = html.lastIndexOf("<input", testidIndex);
    const tagEnd = html.indexOf("/>", testidIndex);
    return html.slice(tagStart, tagEnd);
  }

  it("reflects transition.enabled as an unchecked checkbox by default (Phase 3 disabled)", () => {
    const html = render(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG);
    expect(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.transition.enabled).toBe(false);
    expect(html).toContain("他クラスタ関心・愛着配慮をdecisionへ反映する");
    // 遷移decisionのcheckboxだけが対象。Phase 2/3の他フィールドがcheckedになっていないことは別テストで担保する。
    expect(transitionEnabledCheckboxTag(html)).not.toContain('checked=""');
  });

  it("reflects transition.enabled as a checked checkbox for the outward-interest preset (Phase 3 enabled)", () => {
    expect(OUTWARD_INTEREST_STANDING_PARTY_CONFIG.transition.enabled).toBe(true);
    const html = render(OUTWARD_INTEREST_STANDING_PARTY_CONFIG);
    expect(transitionEnabledCheckboxTag(html)).toContain('checked=""');
  });

  it("reflects the current-circle-attachment preset's higher attachment values", () => {
    const html = render(CURRENT_CIRCLE_ATTACHMENT_STANDING_PARTY_CONFIG);
    expect(html).toContain(
      `${CURRENT_CIRCLE_ATTACHMENT_STANDING_PARTY_CONFIG.attachment.maxAttachment.toFixed(2)}`,
    );
  });

  it("uses only native form controls (range/checkbox wrapped in label), operable via keyboard and touch", () => {
    const html = render(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG);
    expect(html).not.toContain("onClick");
    expect(html).not.toMatch(/role="button"/);
    expect((html.match(/type="range"/g) ?? []).length).toBeGreaterThan(0);
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(1);
  });
});
