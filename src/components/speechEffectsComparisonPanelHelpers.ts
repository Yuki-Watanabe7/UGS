import type { InterventionScenarioId } from "../simulation/interventions";
import type { SimParams } from "../simulation/types";
import type { SpeechEffectsConfig } from "../simulation/speechEffects";

/**
 * Issue #99: 発言効果ON/OFF paired比較パネル専用のstaleness判定用スナップショット。
 * 既存の`RunConditionSnapshot`(`monteCarloPanelHelpers.ts`、介入あり/なし比較用)とは型として分離し、
 * 意図せず混同されないようにする。`speechEffectsOff`/`speechEffectsOn`は現状常に`{enabled: false}`/
 * `{enabled: true}`固定だが、`SpeechEffectsConfig`に`enabled`以外のフィールドが増えた場合でも
 * staleness判定に含められるよう、値そのものをスナップショットとして保持する
 * (受入条件: 「条件変更後のstale result警告に、発言効果設定を含める」)。
 */
export type SpeechEffectsComparisonConditionSnapshot = {
  presetId: string;
  seed: number;
  params: SimParams;
  interventionId: InterventionScenarioId;
  speechEffectsOff: SpeechEffectsConfig;
  speechEffectsOn: SpeechEffectsConfig;
};

export function isSameSpeechEffectsComparisonCondition(
  a: SpeechEffectsComparisonConditionSnapshot,
  b: SpeechEffectsComparisonConditionSnapshot,
): boolean {
  return (
    a.presetId === b.presetId &&
    a.seed === b.seed &&
    a.interventionId === b.interventionId &&
    JSON.stringify(a.params) === JSON.stringify(b.params) &&
    JSON.stringify(a.speechEffectsOff) === JSON.stringify(b.speechEffectsOff) &&
    JSON.stringify(a.speechEffectsOn) === JSON.stringify(b.speechEffectsOn)
  );
}
