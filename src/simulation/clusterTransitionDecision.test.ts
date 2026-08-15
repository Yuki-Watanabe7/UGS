import { describe, expect, it } from "vitest";
import {
  computeClusterTransitionDecision,
  DEFAULT_CLUSTER_TRANSITION_CONFIG,
  validateClusterTransitionConfig,
  type ClusterTransitionConfig,
  type ClusterTransitionDecisionInput,
} from "./clusterTransitionDecision";
import type { ClusterDepartureDecisionResult } from "./clusterDepartureDecision";
import type { AlternativeClusterInterest } from "./alternativeClusterInterest";
import type { DepartureInhibition } from "./currentClusterAttachment";
import { DEFAULT_TOPIC_INTEGRATION_CONFIG, type TopicCompatibility } from "./topicCompatibility";

/**
 * Issue #200 (Phase 3): `computeClusterTransitionDecision`(責務9のクラスタ遷移decision本体)の
 * 定性的性質を検証する。`docs/cluster-transition-phase3-model.md`(Issue #197 ADR)4節・
 * issue「action合成方式」節・受入条件に列挙された各性質に1:1対応させる。
 */

const CONFIG = DEFAULT_CLUSTER_TRANSITION_CONFIG;

function makeDeparture(overrides: Partial<ClusterDepartureDecisionResult> = {}): ClusterDepartureDecisionResult {
  return { eligible: true, probability: 0, ...overrides };
}

function makeInhibition(overrides: Partial<DepartureInhibition> = {}): DepartureInhibition {
  return { attachment: 0, concern: 0, total: 0, factors: [], ...overrides };
}

function makeInterest(overrides: Partial<AlternativeClusterInterest> = {}): AlternativeClusterInterest {
  return { targetClusterId: "target-1", score: 0.5, factors: [], observedAtTick: 0, ...overrides };
}

function decide(overrides: Partial<ClusterTransitionDecisionInput> = {}) {
  return computeClusterTransitionDecision({
    config: overrides.config ?? CONFIG,
    tick: overrides.tick ?? 10,
    departure: overrides.departure ?? makeDeparture(),
    bestAlternativeInterest: overrides.bestAlternativeInterest,
    minTargetInterestScore: overrides.minTargetInterestScore ?? 0.35,
    inhibition: overrides.inhibition ?? makeInhibition(),
    topicSignal: overrides.topicSignal,
  });
}

describe("validateClusterTransitionConfig", () => {
  it("accepts the default config", () => {
    expect(() => validateClusterTransitionConfig(CONFIG)).not.toThrow();
  });

  it("rejects targetShareBase + targetShareGain > 1", () => {
    expect(() => validateClusterTransitionConfig({ ...CONFIG, targetShareBase: 0.7, targetShareGain: 0.5 })).toThrow();
  });

  it("rejects out-of-range weights", () => {
    expect(() => validateClusterTransitionConfig({ ...CONFIG, interestToDepartureGain: 1.5 })).toThrow();
    expect(() => validateClusterTransitionConfig({ ...CONFIG, interestToDepartureGain: -0.1 })).toThrow();
    expect(() => validateClusterTransitionConfig({ ...CONFIG, mixedReasonMargin: -0.01 })).toThrow();
  });

  it("rejects a non-positive/non-integer pendingTransitionTtlTicks", () => {
    expect(() => validateClusterTransitionConfig({ ...CONFIG, pendingTransitionTtlTicks: 0 })).toThrow();
    expect(() => validateClusterTransitionConfig({ ...CONFIG, pendingTransitionTtlTicks: 1.5 })).toThrow();
  });

  it("rejects NaN/Infinity", () => {
    expect(() => validateClusterTransitionConfig({ ...CONFIG, interestToDepartureGain: Number.NaN })).toThrow();
    expect(() => validateClusterTransitionConfig({ ...CONFIG, targetShareGain: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe("computeClusterTransitionDecision: eligibility", () => {
  it("departure.eligible=falseならdrawを引かない前提のstay-onlyな結果を返す", () => {
    const result = decide({ departure: makeDeparture({ eligible: false, probability: 0.9 }) });
    expect(result.eligible).toBe(false);
    expect(result.actionProbabilities).toEqual({ stay: 1, departAndExplore: 0, switchToTargetCluster: 0 });
    expect(result.departurePressure).toBe(0);
    expect(result.conflictIntensity).toBe(0);
    expect(result.primaryReason).toBeUndefined();
  });
});

describe("computeClusterTransitionDecision: 外部候補がない場合の後方互換(4.3節)", () => {
  it("bestAlternativeInterestが無ければswitchToTargetClusterは常に0", () => {
    const result = decide({ departure: makeDeparture({ probability: 0.4 }) });
    expect(result.actionProbabilities.switchToTargetCluster).toBe(0);
    expect(result.selectedTargetClusterId).toBeUndefined();
  });

  it("interestDrive===0(=bestAlternativeInterestなし)のとき、pDepart <= p2(抑制が0の場合は等しい)", () => {
    const p2 = 0.4;
    const result = decide({ departure: makeDeparture({ probability: p2 }) });
    const pDepart = result.actionProbabilities.departAndExplore + result.actionProbabilities.switchToTargetCluster;
    expect(pDepart).toBeCloseTo(p2, 10);
  });

  it("抑制の全係数が0のとき、Phase 2と数値が完全に一致する(actionProbabilities.departAndExplore === p2)", () => {
    const p2 = 0.25;
    const result = decide({ departure: makeDeparture({ probability: p2, factors: [{ kind: "socialCirculation", contribution: p2 }], primaryReason: "socialCirculation" }) });
    expect(result.actionProbabilities.departAndExplore).toBeCloseTo(p2, 10);
    expect(result.actionProbabilities.switchToTargetCluster).toBe(0);
    expect(result.primaryReason).toBe("socialCirculation");
  });
});

describe("computeClusterTransitionDecision: switchToTargetClusterの条件(3節)", () => {
  it("bestAlternativeInterest.score < minTargetInterestScoreならswitchShareは0(departAndExploreへ吸収)", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.3 }),
      bestAlternativeInterest: makeInterest({ score: 0.1 }),
      minTargetInterestScore: 0.35,
    });
    expect(result.actionProbabilities.switchToTargetCluster).toBe(0);
    expect(result.selectedTargetClusterId).toBeUndefined();
    // interestDriveは閾値未満でも寄与する(departure側は増える)
    const pDepart = result.actionProbabilities.departAndExplore + result.actionProbabilities.switchToTargetCluster;
    expect(pDepart).toBeGreaterThan(0.3);
  });

  it("score >= minTargetInterestScoreならswitchToTargetClusterが正になり、targetClusterId/focusAgentIdを設定する", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.3 }),
      bestAlternativeInterest: makeInterest({ score: 0.6, targetClusterId: "cluster-9", focusAgentId: "agent-7" }),
      minTargetInterestScore: 0.35,
    });
    expect(result.actionProbabilities.switchToTargetCluster).toBeGreaterThan(0);
    expect(result.selectedTargetClusterId).toBe("cluster-9");
    expect(result.focusAgentId).toBe("agent-7");
  });

  it("targetがない(eligibleでも0.35未満)場合、focusAgentIdもtargetClusterIdもundefined", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.5 }),
      bestAlternativeInterest: makeInterest({ score: 0.2, focusAgentId: "agent-1" }),
      minTargetInterestScore: 0.35,
    });
    expect(result.selectedTargetClusterId).toBeUndefined();
    expect(result.focusAgentId).toBeUndefined();
  });
});

describe("computeClusterTransitionDecision: 単調性(issue受入条件・ADR 4.1節)", () => {
  it("Phase 2離脱圧力(p2)を上げると、stay確率は不意に上がらない(非増加)", () => {
    const low = decide({ departure: makeDeparture({ probability: 0.1 }) });
    const high = decide({ departure: makeDeparture({ probability: 0.6 }) });
    expect(high.actionProbabilities.stay).toBeLessThanOrEqual(low.actionProbabilities.stay);
  });

  it("target interestのscoreを上げると、switch確率は不意に下がらない(非減少)", () => {
    const low = decide({
      departure: makeDeparture({ probability: 0.3 }),
      bestAlternativeInterest: makeInterest({ score: 0.4 }),
    });
    const high = decide({
      departure: makeDeparture({ probability: 0.3 }),
      bestAlternativeInterest: makeInterest({ score: 0.9 }),
    });
    expect(high.actionProbabilities.switchToTargetCluster).toBeGreaterThanOrEqual(low.actionProbabilities.switchToTargetCluster);
  });

  it("attachment/concern(inhibition.total)を上げると、stay確率は不意に下がらない(非減少)", () => {
    const low = decide({
      departure: makeDeparture({ probability: 0.6 }),
      inhibition: makeInhibition({ total: 0 }),
    });
    const high = decide({
      departure: makeDeparture({ probability: 0.6 }),
      inhibition: makeInhibition({ total: 0.5 }),
    });
    expect(high.actionProbabilities.stay).toBeGreaterThanOrEqual(low.actionProbabilities.stay);
  });

  it("maxInhibition相当の上限抑制でも、pDepartは0に張り付かない(完全ブロック禁止)", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.9 }),
      bestAlternativeInterest: makeInterest({ score: 1 }),
      inhibition: makeInhibition({ total: 0.599 }), // maxInhibition(0.6)未満の上限相当値
    });
    const pDepart = result.actionProbabilities.departAndExplore + result.actionProbabilities.switchToTargetCluster;
    expect(pDepart).toBeGreaterThan(0);
  });
});

describe("computeClusterTransitionDecision: factorが0のとき他factorだけでdecisionが成立する", () => {
  it("p2=0でも関心のみでdepartが生じる", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0 }),
      bestAlternativeInterest: makeInterest({ score: 0.8 }),
      minTargetInterestScore: 0.35,
    });
    const pDepart = result.actionProbabilities.departAndExplore + result.actionProbabilities.switchToTargetCluster;
    expect(pDepart).toBeGreaterThan(0);
  });

  it("関心が0でもp2のみでdepartが生じる(既存Phase 2相当)", () => {
    const result = decide({ departure: makeDeparture({ probability: 0.3 }) });
    expect(result.actionProbabilities.departAndExplore).toBeGreaterThan(0);
  });

  it("inhibitionが0でも抑制なしでdecisionが成立する(既に他ケースでカバー、非throwのみ確認)", () => {
    expect(() => decide({ departure: makeDeparture({ probability: 0.3 }), inhibition: makeInhibition({ total: 0 }) })).not.toThrow();
  });
});

describe("computeClusterTransitionDecision: 常に有限・正規化(6.3節)", () => {
  const cases: Array<{ p2: number; score?: number; inhibitionTotal: number }> = [
    { p2: 0, inhibitionTotal: 0 },
    { p2: 1, inhibitionTotal: 0 },
    { p2: 1, score: 1, inhibitionTotal: 0 },
    { p2: 1, score: 1, inhibitionTotal: 0.5 },
    { p2: 0.5, score: 0.35, inhibitionTotal: 0.3 },
    { p2: 0, score: 0, inhibitionTotal: 0 },
  ];

  for (const { p2, score, inhibitionTotal } of cases) {
    it(`p2=${p2}, score=${score}, inhibitionTotal=${inhibitionTotal} で有限・合計1`, () => {
      const result = decide({
        departure: makeDeparture({ probability: p2 }),
        bestAlternativeInterest: score !== undefined ? makeInterest({ score }) : undefined,
        inhibition: makeInhibition({ total: inhibitionTotal }),
      });
      const { stay, departAndExplore, switchToTargetCluster } = result.actionProbabilities;
      for (const value of [stay, departAndExplore, switchToTargetCluster]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(stay + departAndExplore + switchToTargetCluster).toBeCloseTo(1, 10);
    });
  }
});

describe("computeClusterTransitionDecision: primaryReason(4.3節の状況表)", () => {
  it("離脱側支配・Phase2寄与のみ主因ならPhase2のprimaryReasonをそのまま使う", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.8, primaryReason: "lowConversationSatisfaction" }),
    });
    expect(result.primaryReason).toBe("lowConversationSatisfaction");
  });

  it("離脱側支配・関心寄与のみ主因ならalternativeClusterInterest", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0 }),
      bestAlternativeInterest: makeInterest({ score: 1 }),
    });
    expect(result.primaryReason).toBe("alternativeClusterInterest");
  });

  it("離脱側支配・Phase2と関心の寄与差がmixedReasonMargin以内ならmixed", () => {
    const config: ClusterTransitionConfig = { ...CONFIG, interestToDepartureGain: 1, mixedReasonMargin: 0.05 };
    const result = decide({
      config,
      departure: makeDeparture({ probability: 0.5, primaryReason: "socialCirculation" }),
      bestAlternativeInterest: makeInterest({ score: 0.5 }),
    });
    expect(result.primaryReason).toBe("mixedDepartureAndAlternativeInterest");
  });

  it("stay側支配・愛着のみ主因ならstayedByAttachment", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.05 }),
      inhibition: makeInhibition({ total: 0.5, concern: 0, factors: [{ kind: "episodeAttachment", contribution: 0.5 }] }),
    });
    expect(result.primaryReason).toBe("stayedByAttachment");
  });

  it("stay側支配・構造的配慮のみ主因ならstayedByDepartureConcern", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.05 }),
      inhibition: makeInhibition({ total: 0.5, concern: 0.5, factors: [{ kind: "clusterWouldDissolve", contribution: 0.5 }] }),
    });
    expect(result.primaryReason).toBe("stayedByDepartureConcern");
  });

  it("stay側支配・両寄与の差が僅差ならstayedByMixedInhibition", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.05 }),
      inhibition: makeInhibition({
        total: 0.5,
        concern: 0.24,
        factors: [
          { kind: "episodeAttachment", contribution: 0.26 },
          { kind: "clusterWouldDissolve", contribution: 0.24 },
        ],
      }),
    });
    expect(result.primaryReason).toBe("stayedByMixedInhibition");
  });

  it("寄与がすべて0ならundefined", () => {
    const result = decide({ departure: makeDeparture({ probability: 0 }) });
    expect(result.primaryReason).toBeUndefined();
  });
});

describe("computeClusterTransitionDecision: conflictIntensity(観察専用、1.4.1節)", () => {
  it("interestDriveとinhibitionのmin(片方0なら0)", () => {
    const zeroInterest = decide({ departure: makeDeparture({ probability: 0.3 }), inhibition: makeInhibition({ total: 0.4 }) });
    expect(zeroInterest.conflictIntensity).toBe(0);

    const zeroInhibition = decide({
      departure: makeDeparture({ probability: 0.3 }),
      bestAlternativeInterest: makeInterest({ score: 0.9 }),
      inhibition: makeInhibition({ total: 0 }),
    });
    expect(zeroInhibition.conflictIntensity).toBe(0);

    const both = decide({
      departure: makeDeparture({ probability: 0.3 }),
      bestAlternativeInterest: makeInterest({ score: 0.9 }),
      inhibition: makeInhibition({ total: 0.3 }),
    });
    expect(both.conflictIntensity).toBeGreaterThan(0);
    expect(both.conflictIntensity).toBeLessThanOrEqual(0.3);
  });
});

describe("computeClusterTransitionDecision: 決定性・非干渉", () => {
  it("同一入力なら常に同一結果を返す", () => {
    const input: ClusterTransitionDecisionInput = {
      config: CONFIG,
      tick: 42,
      departure: makeDeparture({ probability: 0.4, primaryReason: "socialCirculation" }),
      bestAlternativeInterest: makeInterest({ score: 0.5 }),
      minTargetInterestScore: 0.35,
      inhibition: makeInhibition({ total: 0.2, concern: 0.2 }),
    };
    expect(computeClusterTransitionDecision(input)).toEqual(computeClusterTransitionDecision(input));
  });

  it("入力(departure/inhibition/bestAlternativeInterest)をmutationしない", () => {
    const departure = makeDeparture({ probability: 0.4, factors: [{ kind: "socialCirculation", contribution: 0.4 }] });
    const inhibition = makeInhibition({ total: 0.2, factors: [{ kind: "episodeAttachment", contribution: 0.2 }] });
    const bestAlternativeInterest = makeInterest({ score: 0.5, factors: [{ kind: "distance", contribution: 0.3 }] });
    const departureCopy = structuredClone(departure);
    const inhibitionCopy = structuredClone(inhibition);
    const interestCopy = structuredClone(bestAlternativeInterest);

    computeClusterTransitionDecision({
      config: CONFIG,
      tick: 1,
      departure,
      bestAlternativeInterest,
      minTargetInterestScore: 0.35,
      inhibition,
    });

    expect(departure).toEqual(departureCopy);
    expect(inhibition).toEqual(inhibitionCopy);
    expect(bestAlternativeInterest).toEqual(interestCopy);
  });
});

describe("computeClusterTransitionDecision: topicSignal (Issue #233, Phase 5)", () => {
  function makeCompatibility(overrides: Partial<TopicCompatibility> = {}): TopicCompatibility {
    return { clusterId: "current", topicId: "topic:a", score: 0.5, factors: [], unknownClaimCount: 0, knownClaimCount: 0, observedAtTick: 0, ...overrides };
  }

  it("topicSignal未設定なら既存挙動と同一(受入条件: byte-identical)", () => {
    const withoutSignal = decide({ departure: makeDeparture({ probability: 0.8, primaryReason: "lowConversationSatisfaction" }) });
    expect(withoutSignal.primaryReason).toBe("lowConversationSatisfaction");
  });

  it("離脱側支配・fatigue/repetitionが負のtopic factorの主因ならtopicFatigue", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.8, primaryReason: "lowConversationSatisfaction" }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        currentCompatibility: makeCompatibility({ factors: [{ kind: "fatigue", contribution: -0.1 }] }),
      },
    });
    expect(result.primaryReason).toBe("topicFatigue");
  });

  it("離脱側支配・fatigue/repetition以外が負のtopic factorの主因ならtopicMismatch", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.8, primaryReason: "lowConversationSatisfaction" }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        currentCompatibility: makeCompatibility({ factors: [{ kind: "topicChange", contribution: -0.1 }] }),
      },
    });
    expect(result.primaryReason).toBe("topicMismatch");
  });

  it("負のtopic factor合計がtopicMismatchThreshold未満なら差し替えない", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.8, primaryReason: "lowConversationSatisfaction" }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        currentCompatibility: makeCompatibility({ factors: [{ kind: "fatigue", contribution: -0.01 }] }),
      },
    });
    expect(result.primaryReason).toBe("lowConversationSatisfaction");
  });

  it("離脱側支配・関心寄与のみ主因で情報機会が強い(閾値未満)ならinformationSeeking", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0 }),
      bestAlternativeInterest: makeInterest({ score: 1 }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        alternativeInformationOpportunityContribution: 0.1,
      },
    });
    expect(result.primaryReason).toBe("informationSeeking");
  });

  it("情報機会がnovelInformationOpportunityThreshold以上ならnovelInformationOpportunity", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0 }),
      bestAlternativeInterest: makeInterest({ score: 1 }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        alternativeInformationOpportunityContribution: 0.2,
      },
    });
    expect(result.primaryReason).toBe("novelInformationOpportunity");
  });

  it("情報機会がminInformationOpportunityScore未満ならalternativeClusterInterestのまま", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0 }),
      bestAlternativeInterest: makeInterest({ score: 1 }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        alternativeInformationOpportunityContribution: 0.01,
      },
    });
    expect(result.primaryReason).toBe("alternativeClusterInterest");
  });

  it("mixedDepartureAndAlternativeInterestかつtopic/情報要因が両方強ければmixedConversationAndInformation", () => {
    const config: ClusterTransitionConfig = { ...CONFIG, interestToDepartureGain: 1, mixedReasonMargin: 0.05 };
    const result = decide({
      config,
      departure: makeDeparture({ probability: 0.5, primaryReason: "socialCirculation" }),
      bestAlternativeInterest: makeInterest({ score: 0.5 }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        currentCompatibility: makeCompatibility({ factors: [{ kind: "fatigue", contribution: -0.1 }] }),
        alternativeInformationOpportunityContribution: 0.1,
      },
    });
    expect(result.primaryReason).toBe("mixedConversationAndInformation");
  });

  it("stay側支配・情報機会が強ければstayedDespiteInformationInterest(愛着/配慮が情報探索移動を抑制した扱い)", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.05 }),
      inhibition: makeInhibition({ total: 0.5, concern: 0, factors: [{ kind: "episodeAttachment", contribution: 0.5 }] }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        alternativeInformationOpportunityContribution: 0.1,
      },
    });
    expect(result.primaryReason).toBe("stayedDespiteInformationInterest");
  });

  it("stay側支配・情報機会が弱ければ元のstayedBy*のまま", () => {
    const result = decide({
      departure: makeDeparture({ probability: 0.05 }),
      inhibition: makeInhibition({ total: 0.5, concern: 0, factors: [{ kind: "episodeAttachment", contribution: 0.5 }] }),
      topicSignal: {
        config: DEFAULT_TOPIC_INTEGRATION_CONFIG,
        alternativeInformationOpportunityContribution: 0,
      },
    });
    expect(result.primaryReason).toBe("stayedByAttachment");
  });
});
