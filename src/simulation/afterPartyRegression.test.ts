import { describe, expect, it } from "vitest";
import { runMonteCarlo } from "./monteCarlo";
import { getPresetById, PRESETS } from "./presets";
import type { MonteCarloConfig } from "./types";

/**
 * Issue #137 (受入条件): classroomPair(教室ペア形成)シナリオの追加が、既存の二次会(afterParty)
 * 5プリセットの挙動に意図しない差分を生んでいないことをスナップショットで固定する。
 * classroomPairはFormationPolicy(formationPolicy.ts)を介してafterPartyとは独立に切り替わる
 * 設計だが(engine.tsはscenarioId分岐を持たない)、この分離が壊れて既存挙動へ影響しないことを
 * 実測値で継続的に保証する。プリセット・パラメータ・stepSimulationの計算式のいずれかが変わると
 * このスナップショットは失敗するため、意図した変更であれば`vitest run -u`で更新すること。
 */

const NAMED_AFTER_PARTY_PRESET_IDS = [
  "natural",
  "ambiguous-dissolve",
  "strong-leader",
  "late-join-culture",
  "leftover-free-grouping",
] as const;

describe("afterParty既存プリセットの回帰スナップショット (Issue #137)", () => {
  it.each(NAMED_AFTER_PARTY_PRESET_IDS)("プリセット「%s」のMonte Carlo集計指標に回帰がない", (presetId) => {
    const preset = getPresetById(presetId);
    expect(preset.id).toBe(presetId);
    // classroomPair追加前と同じく、formationScenarioIdを設定しない(=afterPartyへfall back)プリセットのまま
    expect(preset.formationScenarioId).toBeUndefined();

    const config: MonteCarloConfig = {
      baseSeed: 1000,
      runs: 8,
      params: preset.params,
    };
    const result = runMonteCarlo(config);

    expect(result.summary).toMatchSnapshot();
  });

  it.each(NAMED_AFTER_PARTY_PRESET_IDS)("プリセット「%s」の単発seed(1000)の終了サマリーに回帰がない", (presetId) => {
    const preset = getPresetById(presetId);
    const config: MonteCarloConfig = {
      baseSeed: 1000,
      runs: 1,
      params: preset.params,
    };
    const result = runMonteCarlo(config);

    expect(result.runs[0].summary.stateCounts).toMatchSnapshot();
    expect(result.runs[0].summary.finishReason).toMatchSnapshot();
    expect(result.runs[0].finishedTick).toMatchSnapshot();
  });

  it("5つの既存プリセットが引き続きPRESETSに存在し、IDが変わっていない", () => {
    const ids = PRESETS.map((preset) => preset.id);
    for (const presetId of NAMED_AFTER_PARTY_PRESET_IDS) {
      expect(ids).toContain(presetId);
    }
  });
});
