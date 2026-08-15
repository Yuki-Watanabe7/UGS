/**
 * Issue #233 (Phase 5, roadmap #172): issue要件8節「Inspector／structured reason」向けの、
 * topic/情報探索統合の観測用selector群。UI実装自体は後続Issueの対象だが、ここでは表示文言の
 * 文字列解析に依存しない構造化された値だけを返す純粋関数として先に提供する。
 *
 * すべて既存の構造化型(`TopicCompatibility`/`AlternativeClusterInterest`/
 * `ConversationSatisfactionUpdateResult`/`ClusterTransitionDecision`)から値を取り出すだけの
 * 薄いaccessorであり、新しい状態を持たない・rngを消費しない・引数をmutationしない。
 */
import type { AlternativeClusterInterest } from "./alternativeClusterInterest";
import type { ConversationSatisfactionUpdateResult } from "./conversationSatisfaction";
import type { ClusterTransitionDecision } from "./clusterTransitionDecision";
import type { ClusterTransitionPrimaryReason } from "./types";
import type { TopicCompatibility, TopicCompatibilityFactorKind } from "./topicCompatibility";

/** 現在clusterのtopic compatibility総合score [0,1](0.5 = 中立、topic未設定/Phase 5 disabledを含む) */
export function selectCurrentTopicCompatibilityScore(compatibility: TopicCompatibility | undefined): number {
  return compatibility?.score ?? 0.5;
}

/** 指定kindのfactor寄与を取り出す(存在しなければ0)。novelty/fatigue/repetition等いずれにも使える */
export function selectTopicFactorContribution(
  compatibility: TopicCompatibility | undefined,
  kind: TopicCompatibilityFactorKind,
): number {
  return compatibility?.factors.find((factor) => factor.kind === kind)?.contribution ?? 0;
}

/** 現在clusterのtopicのうち、agentがまだ認識していないclaim数(要件8節「未知だったclaim数」) */
export function selectUnknownClaimCount(compatibility: TopicCompatibility | undefined): number {
  return compatibility?.unknownClaimCount ?? 0;
}

/** best alternative clusterの情報探索機会(`informationOpportunity` factor)の寄与 [0,1] */
export function selectBestInformationOpportunity(interest: AlternativeClusterInterest | undefined): number {
  return interest?.factors.find((factor) => factor.kind === "informationOpportunity")?.contribution ?? 0;
}

/** 直近tickの会話満足度更新のうち、topic compatibility由来の寄与(符号付き) */
export function selectSatisfactionTopicContribution(result: ConversationSatisfactionUpdateResult | undefined): number {
  return result?.topicContribution ?? 0;
}

/** transition decisionにおける情報探索側の寄与(selected/bestのinformationOpportunity寄与) */
export function selectTransitionInformationContribution(decision: ClusterTransitionDecision | undefined): number {
  return selectBestInformationOpportunity(decision?.alternativeInterest);
}

/** transition decisionが最終的に採用したreason(topic由来のreasonへ精緻化済みの値を含む) */
export function selectFinalActionReason(decision: ClusterTransitionDecision | undefined): ClusterTransitionPrimaryReason | undefined {
  return decision?.primaryReason;
}
