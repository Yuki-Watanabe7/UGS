import { describe, expect, it } from "vitest";
import {
  selectBestInformationOpportunity,
  selectCurrentTopicCompatibilityScore,
  selectFinalActionReason,
  selectSatisfactionTopicContribution,
  selectTopicFactorContribution,
  selectTransitionInformationContribution,
  selectUnknownClaimCount,
} from "./topicTransitionInspection";
import type { TopicCompatibility } from "./topicCompatibility";
import type { AlternativeClusterInterest } from "./alternativeClusterInterest";
import type { ClusterTransitionDecision } from "./clusterTransitionDecision";
import type { ConversationSatisfactionUpdateResult } from "./conversationSatisfaction";

/**
 * Issue #233 (Phase 5, 要件8節): Inspector向けselectorが、構造化された値をそのまま返すこと
 * (表示文言の解析に依存しないこと)を検証する。
 */

const COMPATIBILITY: TopicCompatibility = {
  clusterId: "cluster-1",
  topicId: "topic:a",
  score: 0.7,
  factors: [
    { kind: "novelty", contribution: 0.1 },
    { kind: "fatigue", contribution: -0.05 },
  ],
  unknownClaimCount: 3,
  knownClaimCount: 1,
  observedAtTick: 42,
};

const INTEREST: AlternativeClusterInterest = {
  targetClusterId: "cluster-2",
  score: 0.6,
  factors: [{ kind: "informationOpportunity", contribution: 0.22 }],
  observedAtTick: 42,
};

describe("topicTransitionInspection selectors", () => {
  it("selectCurrentTopicCompatibilityScore: 値を返し、未設定なら中立値0.5", () => {
    expect(selectCurrentTopicCompatibilityScore(COMPATIBILITY)).toBe(0.7);
    expect(selectCurrentTopicCompatibilityScore(undefined)).toBe(0.5);
  });

  it("selectTopicFactorContribution: kindに一致するfactorの寄与を返し、無ければ0", () => {
    expect(selectTopicFactorContribution(COMPATIBILITY, "novelty")).toBe(0.1);
    expect(selectTopicFactorContribution(COMPATIBILITY, "fatigue")).toBe(-0.05);
    expect(selectTopicFactorContribution(COMPATIBILITY, "repetition")).toBe(0);
    expect(selectTopicFactorContribution(undefined, "novelty")).toBe(0);
  });

  it("selectUnknownClaimCount", () => {
    expect(selectUnknownClaimCount(COMPATIBILITY)).toBe(3);
    expect(selectUnknownClaimCount(undefined)).toBe(0);
  });

  it("selectBestInformationOpportunity: informationOpportunity factorの寄与、無ければ0", () => {
    expect(selectBestInformationOpportunity(INTEREST)).toBe(0.22);
    expect(selectBestInformationOpportunity(undefined)).toBe(0);
    expect(selectBestInformationOpportunity({ ...INTEREST, factors: [] })).toBe(0);
  });

  it("selectSatisfactionTopicContribution", () => {
    const result: ConversationSatisfactionUpdateResult = {
      previousSatisfaction: 0.5,
      nextSatisfaction: 0.53,
      decayContribution: -0.01,
      newMemberContribution: 0,
      sizeContribution: 0,
      cliqueContribution: 0,
      topicContribution: 0.03,
    };
    expect(selectSatisfactionTopicContribution(result)).toBe(0.03);
    expect(selectSatisfactionTopicContribution(undefined)).toBe(0);
  });

  it("selectTransitionInformationContribution / selectFinalActionReason", () => {
    const decision: ClusterTransitionDecision = {
      eligible: true,
      actionProbabilities: { stay: 0.2, departAndExplore: 0.3, switchToTargetCluster: 0.5 },
      departurePressure: 0.4,
      inhibition: { attachment: 0, concern: 0, total: 0, factors: [] },
      conflictIntensity: 0,
      alternativeInterest: INTEREST,
      primaryReason: "informationSeeking",
      decidedAtTick: 42,
    };
    expect(selectTransitionInformationContribution(decision)).toBe(0.22);
    expect(selectFinalActionReason(decision)).toBe("informationSeeking");
    expect(selectFinalActionReason(undefined)).toBeUndefined();
  });
});
