import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOPIC_COMPATIBILITY_CONFIG,
  DEFAULT_TOPIC_INTEGRATION_CONFIG,
  computeTopicCompatibility,
  deriveSatisfactionContribution,
  noveltyRatioOf,
  validateTopicCompatibilityConfig,
  validateTopicIntegrationConfig,
  type TopicCompatibilityContext,
} from "./topicCompatibility";
import { createInitialClusterTopicState, recordUtterance, type ClusterTopicState } from "./conversationTopic";
import type { AgentInformationState } from "./informationState";
import type { ClaimCatalog, TopicCatalog } from "./informationModel";

/**
 * Issue #233 (Phase 5): `computeTopicCompatibility`の定性的性質を検証する。issue要件1節・2節・
 * 5節・9節に列挙された性質に対応させる ―― topic未設定/Phase 5 disabled時の中立性、各factorの
 * 単調性、observation境界(agent自身の情報だけを使う)を中心に見る。
 */

const CONFIG = DEFAULT_TOPIC_COMPATIBILITY_CONFIG;

const TOPIC_CATALOG: TopicCatalog = {
  id: "test-topics",
  topics: [
    { id: "topic:a", labelKey: "a", descriptionKey: "a", relatedTopicIds: ["topic:b"], baseSalience: 0.5 },
    { id: "topic:b", labelKey: "b", descriptionKey: "b", relatedTopicIds: ["topic:a"], baseSalience: 0.5 },
  ],
};

const CLAIM_CATALOG: ClaimCatalog = {
  id: "test-claims",
  claims: [
    {
      id: "claim:a1",
      topicId: "topic:a",
      rootVariantId: "claim:a1:root",
      contentKey: "a1",
      canonicalMeaning: { subjectKey: "x", predicateKey: "y", qualifiers: {} },
      originalSource: { id: "source:organizer", kind: "organizer" },
      verifiability: "verifiable",
      verificationStatus: "unknown",
      initialConfidence: 0.8,
    },
    {
      id: "claim:a2",
      topicId: "topic:a",
      rootVariantId: "claim:a2:root",
      contentKey: "a2",
      canonicalMeaning: { subjectKey: "x2", predicateKey: "y2", qualifiers: {} },
      originalSource: { id: "source:organizer", kind: "organizer" },
      verifiability: "verifiable",
      verificationStatus: "unknown",
      initialConfidence: 0.8,
    },
  ],
  variants: [
    {
      id: "claim:a1:root",
      canonicalClaimId: "claim:a1",
      topicId: "topic:a",
      parentVariantId: undefined,
      meaning: { subjectKey: "x", predicateKey: "y", qualifiers: {} },
      semanticFingerprint: "fp1",
      mutationFactors: [],
      hopDistance: 0,
      canonicalDistance: 0,
      lineageDepth: 0,
      generatedAtTick: 0,
    },
    {
      id: "claim:a2:root",
      canonicalClaimId: "claim:a2",
      topicId: "topic:a",
      parentVariantId: undefined,
      meaning: { subjectKey: "x2", predicateKey: "y2", qualifiers: {} },
      semanticFingerprint: "fp2",
      mutationFactors: [],
      hopDistance: 0,
      canonicalDistance: 0,
      lineageDepth: 0,
      generatedAtTick: 0,
    },
  ],
};

function makeAgentInformation(overrides: Partial<AgentInformationState> = {}): AgentInformationState {
  return {
    agentId: "agent-1",
    profile: { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: {} },
    topics: {},
    claims: {},
    ...overrides,
  };
}

function makeClusterTopic(overrides: Partial<ClusterTopicState> = {}): ClusterTopicState {
  return { ...createInitialClusterTopicState("cluster-1"), currentTopicId: "topic:a", topicStartedTick: 0, ...overrides };
}

function makeContext(overrides: Partial<TopicCompatibilityContext> = {}): TopicCompatibilityContext {
  return {
    config: CONFIG,
    tick: 10,
    clusterId: "cluster-1",
    clusterTopic: makeClusterTopic(),
    topicCatalog: TOPIC_CATALOG,
    claimCatalog: CLAIM_CATALOG,
    agentInformation: makeAgentInformation(),
    fatigueGain: 0.2,
    fatigueDecay: 0.05,
    ...overrides,
  };
}

describe("validateTopicCompatibilityConfig / validateTopicIntegrationConfig", () => {
  it("accepts the default configs", () => {
    expect(() => validateTopicCompatibilityConfig(CONFIG)).not.toThrow();
    expect(() => validateTopicIntegrationConfig(DEFAULT_TOPIC_INTEGRATION_CONFIG)).not.toThrow();
  });

  it("rejects out-of-range weights and NaN/Infinity", () => {
    expect(() => validateTopicCompatibilityConfig({ ...CONFIG, interestMatchWeight: 1.5 })).toThrow();
    expect(() => validateTopicCompatibilityConfig({ ...CONFIG, noveltyWeight: Number.NaN })).toThrow();
    expect(() => validateTopicCompatibilityConfig({ ...CONFIG, stagnationPenaltyCap: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("rejects non-positive-integer tick fields", () => {
    expect(() => validateTopicCompatibilityConfig({ ...CONFIG, recentTopicChangeWindowTicks: 0 })).toThrow();
    expect(() => validateTopicCompatibilityConfig({ ...CONFIG, stagnationTicks: 1.5 })).toThrow();
  });

  it("rejects stagnationTicks < recentTopicChangeWindowTicks", () => {
    expect(() =>
      validateTopicCompatibilityConfig({ ...CONFIG, stagnationTicks: 2, recentTopicChangeWindowTicks: 5 }),
    ).toThrow();
  });
});

describe("computeTopicCompatibility: 中立性(issue要件2節)", () => {
  it("clusterTopicが未設定ならscore 0.5・factors空", () => {
    const result = computeTopicCompatibility(makeContext({ clusterTopic: undefined }));
    expect(result.score).toBe(0.5);
    expect(result.factors).toEqual([]);
    expect(result.topicId).toBeUndefined();
  });

  it("currentTopicIdが未設定ならscore 0.5・factors空", () => {
    const result = computeTopicCompatibility(makeContext({ clusterTopic: makeClusterTopic({ currentTopicId: undefined }) }));
    expect(result.score).toBe(0.5);
    expect(result.factors).toEqual([]);
  });

  it("agentInformationが未設定ならscore 0.5・factors空", () => {
    const result = computeTopicCompatibility(makeContext({ agentInformation: undefined }));
    expect(result.score).toBe(0.5);
    expect(result.factors).toEqual([]);
  });

  it("それによりderiveSatisfactionContributionは常に0を返す(受入条件: topic未設定/disabledで既存式と同一)", () => {
    const neutral = computeTopicCompatibility(makeContext({ clusterTopic: undefined }));
    expect(deriveSatisfactionContribution(neutral, DEFAULT_TOPIC_INTEGRATION_CONFIG)).toBe(0);
  });

  it("同一入力からは同一出力になる(純粋関数)", () => {
    const ctx = makeContext();
    expect(computeTopicCompatibility(ctx)).toEqual(computeTopicCompatibility(ctx));
  });
});

describe("computeTopicCompatibility: interestMatch / relatedTopicMatch", () => {
  it("興味が高いほどscoreが上がる(topic matchは満足度を支えるだけ、要件2節)", () => {
    const low = computeTopicCompatibility(
      makeContext({ agentInformation: makeAgentInformation({ topics: { "topic:a": { topicId: "topic:a", interest: 0.1, fatigue: 0 } } }) }),
    );
    const high = computeTopicCompatibility(
      makeContext({ agentInformation: makeAgentInformation({ topics: { "topic:a": { topicId: "topic:a", interest: 0.9, fatigue: 0 } } }) }),
    );
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.factors.find((f) => f.kind === "interestMatch")?.contribution).toBeGreaterThan(0);
  });

  it("related topicへの高い関心は、current topicへの関心が低くてもscoreを押し上げる", () => {
    const baseline = computeTopicCompatibility(makeContext());
    const withRelated = computeTopicCompatibility(
      makeContext({
        agentInformation: makeAgentInformation({ topics: { "topic:b": { topicId: "topic:b", interest: 1, fatigue: 0 } } }),
      }),
    );
    expect(withRelated.score).toBeGreaterThan(baseline.score);
    expect(withRelated.factors.find((f) => f.kind === "relatedTopicMatch")).toBeDefined();
  });
});

describe("computeTopicCompatibility: novelty / repetition(issue要件1節)", () => {
  it("未知claimが多いほどnoveltyの寄与が大きい(一時的な回復、要件2節)", () => {
    const noneKnown = computeTopicCompatibility(makeContext());
    const oneKnown = computeTopicCompatibility(
      makeContext({
        agentInformation: makeAgentInformation({
          claims: {
            "claim:a1": {
              claimId: "claim:a1",
              awareness: "understood",
              acceptance: "adopted",
              confidence: 0.8,
              memoryStrength: 0.8,
              firstEncounteredTick: 0,
              lastEncounteredTick: 0,
              heardCount: 1,
              understoodCount: 1,
              adoptionCount: 1,
              activeVariantId: "claim:a1:root",
              encounteredVariantIds: ["claim:a1:root"],
              sourceTraces: [],
              retellingCount: 0,
              lastMemoryEvaluationTick: 0,
            },
          },
        }),
      }),
    );
    expect(noneKnown.unknownClaimCount).toBe(2);
    expect(oneKnown.unknownClaimCount).toBe(1);
    const noveltyNone = noneKnown.factors.find((f) => f.kind === "novelty")?.contribution ?? 0;
    const noveltyOne = oneKnown.factors.find((f) => f.kind === "novelty")?.contribution ?? 0;
    expect(noveltyNone).toBeGreaterThan(noveltyOne);
  });

  it("noveltyRatioOfはunknown/(unknown+known)を返す", () => {
    const result = computeTopicCompatibility(makeContext());
    expect(noveltyRatioOf(result)).toBe(1); // 何も知らないので2/2
  });

  it("既知claimがこのclusterで最近繰り返し話されるほどrepetitionの減点が大きい", () => {
    const knownAgent = makeAgentInformation({
      claims: {
        "claim:a1": {
          claimId: "claim:a1",
          awareness: "understood",
          acceptance: "adopted",
          confidence: 0.8,
          memoryStrength: 0.8,
          firstEncounteredTick: 0,
          lastEncounteredTick: 0,
          heardCount: 1,
          understoodCount: 1,
          adoptionCount: 1,
          activeVariantId: "claim:a1:root",
          encounteredVariantIds: ["claim:a1:root"],
          sourceTraces: [],
          retellingCount: 0,
          lastMemoryEvaluationTick: 0,
        },
      },
    });
    let clusterTopic = makeClusterTopic();
    // claim:a1を10回連続で話されたことにする(repetitionCountが上がる)
    for (let i = 0; i < 10; i++) {
      clusterTopic = recordUtterance(clusterTopic, { topicId: "topic:a", speakerId: "s", claimId: "claim:a1", tick: i });
    }
    const repeated = computeTopicCompatibility(makeContext({ clusterTopic, agentInformation: knownAgent, tick: 10 }));
    const freshTopic = computeTopicCompatibility(
      makeContext({ clusterTopic: makeClusterTopic(), agentInformation: knownAgent, tick: 10 }),
    );
    const repeatedPenalty = repeated.factors.find((f) => f.kind === "repetition")?.contribution ?? 0;
    const freshPenalty = freshTopic.factors.find((f) => f.kind === "repetition")?.contribution ?? 0;
    expect(repeatedPenalty).toBeLessThan(freshPenalty); // より負(強い減点)
  });
});

describe("computeTopicCompatibility: fatigue / topicChange(issue要件1節)", () => {
  it("clusterのtopic反復が多いほどfatigueの減点が大きい", () => {
    let clusterTopic = makeClusterTopic();
    for (let i = 0; i < 10; i++) {
      clusterTopic = recordUtterance(clusterTopic, { topicId: "topic:a", speakerId: "s", claimId: "claim:a1", tick: i });
    }
    const fatigued = computeTopicCompatibility(makeContext({ clusterTopic, tick: 10 }));
    const fresh = computeTopicCompatibility(makeContext({ clusterTopic: makeClusterTopic(), tick: 10 }));
    const fatiguePenalty = fatigued.factors.find((f) => f.kind === "fatigue")?.contribution ?? 0;
    expect(fatiguePenalty).toBeLessThan(0);
    expect(fatigued.score).toBeLessThan(fresh.score);
  });

  it("直近でtopicが切り替わったばかりなら、関心があるほど新鮮さの正寄与が生まれる", () => {
    const interestedAgent = makeAgentInformation({ topics: { "topic:a": { topicId: "topic:a", interest: 1, fatigue: 0 } } });
    const result = computeTopicCompatibility(
      makeContext({ clusterTopic: makeClusterTopic({ topicStartedTick: 9 }), agentInformation: interestedAgent, tick: 10 }),
    );
    expect(result.factors.find((f) => f.kind === "topicChange")?.contribution).toBeGreaterThan(0);
  });

  it("同一topicが長く続く(停滞)ほど負の寄与になる", () => {
    const result = computeTopicCompatibility(
      makeContext({ clusterTopic: makeClusterTopic({ topicStartedTick: 0 }), tick: 200 }),
    );
    expect(result.factors.find((f) => f.kind === "topicChange")?.contribution).toBeLessThan(0);
  });
});

describe("computeTopicCompatibility: scoreの定義域(issue要件2節)", () => {
  it("極端な入力でも常に[0,1]・有限に収まる", () => {
    let clusterTopic = makeClusterTopic();
    for (let i = 0; i < 500; i++) {
      clusterTopic = recordUtterance(clusterTopic, { topicId: "topic:a", speakerId: "s", claimId: "claim:a1", tick: i });
    }
    const result = computeTopicCompatibility(
      makeContext({
        clusterTopic,
        tick: 100000,
        agentInformation: makeAgentInformation({ topics: { "topic:a": { topicId: "topic:a", interest: 1, fatigue: 0 } } }),
      }),
    );
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("deriveSatisfactionContribution", () => {
  it("上限(satisfactionContributionCap)で頭打ちになる", () => {
    const maximallyCompatible = { clusterId: "c", topicId: "topic:a", score: 1, factors: [], unknownClaimCount: 0, knownClaimCount: 2, observedAtTick: 0 };
    const contribution = deriveSatisfactionContribution(maximallyCompatible, DEFAULT_TOPIC_INTEGRATION_CONFIG);
    expect(contribution).toBe(DEFAULT_TOPIC_INTEGRATION_CONFIG.satisfactionContributionCap);
  });

  it("scoreが中立未満なら負の寄与になる", () => {
    const mismatched = { clusterId: "c", topicId: "topic:a", score: 0, factors: [], unknownClaimCount: 0, knownClaimCount: 2, observedAtTick: 0 };
    expect(deriveSatisfactionContribution(mismatched, DEFAULT_TOPIC_INTEGRATION_CONFIG)).toBeLessThan(0);
  });
});
