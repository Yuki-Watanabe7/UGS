import type {
  AggregatedActiveEffect,
  ActiveEffectContribution,
  SpeechEffectDimension,
  SpeechEffectEvent,
  SpeechInterpretationEvent,
  SpeechInterpretationFactor,
  SpeechInterpretationValence,
  SpeechReceptionEvent,
} from "../simulation/speechEffects";
import type { ObserverActiveEffectStatus } from "../simulation/types";
import { formatTick } from "../simulation/time";
import { resolveLabel } from "./speechDisplay";
import type { FormationScenarioId } from "../simulation/formationPolicy";
import { getScenarioPresentation } from "../presentation/scenarioPresentation";

/**
 * Phase 3の因果イベント(認知/解釈/効果/現在の適用状況)を、状態ログ・observerJoiner Inspectorの
 * 両方で共通の日本語文言へ変換する表示専用ヘルパー(Issue #98)。`speechDisplay.ts`と同様、
 * 構造化イベントの属性から文言を生成するだけの純粋関数のみを持ち、シミュレーション状態や
 * 乱数を一切参照・変更しない。
 */

export function speechEffectDimensionLabel(
  dimension: SpeechEffectDimension,
  scenarioId?: FormationScenarioId,
): string {
  return getScenarioPresentation(scenarioId).speechEffects[dimension];
}

const VALENCE_LABEL: Record<SpeechInterpretationValence, string> = {
  positive: "好意的",
  neutral: "中立(効果なし)",
  negative: "否定的",
};

export function speechInterpretationValenceLabel(valence: SpeechInterpretationValence): string {
  return VALENCE_LABEL[valence];
}

const FACTOR_LABEL: Record<SpeechInterpretationFactor["key"], string> = {
  intentBase: "発言の基礎方向",
  conformity: "同調傾向",
  influenceAvoidance: "影響回避度",
  relationshipTrust: "関係性への信頼",
  receiverStress: "受け手のストレス",
  receiverState: "受け手の状態",
  receptionRelation: "宛先(対象/周囲)",
  strength: "発言の強さ",
};

export function speechInterpretationFactorLabel(key: SpeechInterpretationFactor["key"]): string {
  return FACTOR_LABEL[key];
}

function formatNumber(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function formatSigned(value: number, digits = 3): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/** 認知(`SpeechReceptionEvent`)を1行で読める文言にする。heard/非heardの両方を扱う */
export function formatReceptionLine(reception: SpeechReceptionEvent, labelById: Map<string, string>): string {
  const receiver = resolveLabel(reception.receiverId, labelById);
  const distanceText = `距離${formatNumber(reception.distance, 1)} / 可聴閾値${formatNumber(reception.threshold, 1)}`;
  return reception.heard
    ? `${formatTick(reception.tick)} ${receiver}さんに届いた(${distanceText})`
    : `${formatTick(reception.tick)} ${receiver}さんには届かなかった(圏外: ${distanceText})`;
}

/** 解釈(`SpeechInterpretationEvent`)を1行で読める文言にする */
export function formatInterpretationLine(interpretation: SpeechInterpretationEvent, labelById: Map<string, string>): string {
  const receiver = resolveLabel(interpretation.receiverId, labelById);
  const valence = speechInterpretationValenceLabel(interpretation.valence);
  const intensity = Math.round(interpretation.intensity * 100);
  return `${formatTick(interpretation.tick)} ${receiver}さんの解釈: ${valence}(強度${intensity}%)`;
}

/** 解釈のfactor内訳1件分を1行で読める文言にする */
export function formatInterpretationFactorLine(factor: SpeechInterpretationFactor): string {
  const label = speechInterpretationFactorLabel(factor.key);
  return `${label}: 入力値${formatNumber(factor.rawValue)} → 寄与係数${formatNumber(factor.contribution)}`;
}

/** 効果(`SpeechEffectEvent`)を1行で読める文言にする */
export function formatEffectLine(
  effect: SpeechEffectEvent,
  labelById: Map<string, string>,
  scenarioId?: FormationScenarioId,
): string {
  const receiver = resolveLabel(effect.receiverId, labelById);
  const dimension = speechEffectDimensionLabel(effect.dimension, scenarioId);
  return `${formatTick(effect.occurredTick)} ${receiver}さんの${dimension}へ${formatSigned(effect.outputValue)}の効果(持続${effect.durationTicks}tick)`;
}

/** 現在の適用状況(`ObserverActiveEffectStatus`)を1行で読める文言にする。既に失効/置換済みの場合も明示する */
export function formatActiveEffectStatusLine(status: ObserverActiveEffectStatus | undefined): string {
  if (!status) return "現在は作用していない(失効済み、または同一話者の再発言により更新済み)";
  return `現在値${formatSigned(status.currentStrength)}(初期値${formatSigned(status.initialStrength)}) / 残り${status.remainingTicks}tick`;
}

/** 集約結果(`AggregatedActiveEffect`)を1行で読める文言にする */
export function formatAggregatedEffectSummary(
  summary: AggregatedActiveEffect,
  scenarioId?: FormationScenarioId,
): string {
  const presentation = getScenarioPresentation(scenarioId);
  const target = summary.targetGroupId
    ? `(${presentation.id === "classroomPair" ? "対象ペア候補" : "対象輪"}: ${summary.targetGroupId})`
    : "";
  return `${speechEffectDimensionLabel(summary.dimension, scenarioId)}${target}: 集約値${formatSigned(summary.value)}`;
}

/** 集約結果1件分の個別寄与(`ActiveEffectContribution`)を1行で読める文言にする */
export function formatContributionLine(contribution: ActiveEffectContribution, labelById: Map<string, string>): string {
  const speaker = resolveLabel(contribution.speakerId, labelById);
  return `speechEventId=${contribution.speechEventId} / 話者=${speaker} / intent=${contribution.intent} / 値=${formatSigned(contribution.value)}`;
}
