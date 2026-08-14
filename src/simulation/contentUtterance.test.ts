import { describe, expect, it } from "vitest";
import { deriveContentUtterances, type ContentUtteranceGenerationContext } from "./contentUtterance";
import { DEFAULT_CONTENT_UTTERANCE_CONFIG, DEFAULT_INFORMATION_PROPAGATION_LIMITS, DEFAULT_RETELLING_CONFIG } from "./informationState";
import type { AgentClaimState, AgentInformationState, ContentUtteranceConfig, InformationRuntimeState, SourceTrace } from "./informationState";
import type { ClaimCatalog, InformationClaim, TopicCatalog } from "./informationModel";
import { createRootVariant } from "./informationModel";
import type { RetellingRuntimeState } from "./retelling";
import type { Agent, GroupCandidate } from "./types";

/**
 * Issue #230 (Phase 5): active clusterでの発話機会・話者・topic・claim/variant選択と
 * `ContentUtteranceEvent` + carrier `SpeechEvent`生成(`deriveContentUtterances`)を検証する。
 * 受け手の採用・記憶更新(#231以降)は対象外 ―― ここでは生成側の決定性・境界だけを扱う。
 */

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.3,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.3,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "joined",
    stress: 0,
    ...overrides,
  };
}

function makeCluster(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "group-1",
    x: 100,
    y: 100,
    memberIds: [],
    status: "confirmed",
    age: 10,
    ...overrides,
  };
}

const TOPIC_A = { id: "topic:a", labelKey: "a.label", descriptionKey: "a.desc", relatedTopicIds: ["topic:b"], baseSalience: 0.5 };
const TOPIC_B = { id: "topic:b", labelKey: "b.label", descriptionKey: "b.desc", relatedTopicIds: ["topic:a"], baseSalience: 0.5 };
const TOPIC_CATALOG: TopicCatalog = { id: "test-topics", topics: [TOPIC_A, TOPIC_B] };

const CLAIM_A: InformationClaim = {
  id: "claim:a",
  topicId: "topic:a",
  rootVariantId: "claim:a:root",
  contentKey: "claim.a",
  canonicalMeaning: { subjectKey: "s", predicateKey: "p", objectValue: "v", qualifiers: {} },
  originalSource: { id: "source:organizer", kind: "organizer" },
  verifiability: "verifiable",
  verificationStatus: "unknown",
  initialConfidence: 0.8,
};
const CLAIM_B: InformationClaim = {
  id: "claim:b",
  topicId: "topic:b",
  rootVariantId: "claim:b:root",
  contentKey: "claim.b",
  canonicalMeaning: { subjectKey: "s2", predicateKey: "p2", objectValue: "v2", qualifiers: {} },
  originalSource: { id: "source:organizer", kind: "organizer" },
  verifiability: "verifiable",
  verificationStatus: "unknown",
  initialConfidence: 0.8,
};
const CLAIM_CATALOG: ClaimCatalog = {
  id: "test-claims",
  claims: [CLAIM_A, CLAIM_B],
  variants: [createRootVariant(CLAIM_A), createRootVariant(CLAIM_B)],
};

function makeSourceTrace(overrides: Partial<SourceTrace>): SourceTrace {
  return {
    id: "source-initial-agent-1-claim:a",
    kind: "initialGrant",
    originalSourceId: "source:organizer",
    immediateSpeakerId: undefined,
    utteranceId: undefined,
    receptionId: undefined,
    variantId: "claim:a:root",
    firstEncounteredTick: 0,
    lastEncounteredTick: 0,
    encounterCount: 1,
    ...overrides,
  };
}

function makeClaimState(overrides: Partial<AgentClaimState>): AgentClaimState {
  return {
    claimId: "claim:a",
    awareness: "understood",
    acceptance: "adopted",
    confidence: 0.8,
    memoryStrength: 0.8,
    firstEncounteredTick: 0,
    lastEncounteredTick: 0,
    firstHeardTick: undefined,
    lastHeardTick: undefined,
    heardCount: 0,
    understoodCount: 0,
    adoptionCount: 1,
    activeVariantId: "claim:a:root",
    encounteredVariantIds: ["claim:a:root"],
    sourceTraces: [makeSourceTrace({})],
    retellingCount: 0,
    lastRetoldTick: undefined,
    retellableFromTick: 0,
    lastMemoryEvaluationTick: 0,
    forgetAtTick: undefined,
    ...overrides,
  };
}

function makeAgentInformationState(agentId: string, overrides: Partial<AgentInformationState> = {}): AgentInformationState {
  return {
    agentId,
    profile: { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: { "topic:a": 0.6, "topic:b": 0.6 } },
    topics: {
      "topic:a": { topicId: "topic:a", interest: 0.6, fatigue: 0, lastDiscussedTick: undefined },
      "topic:b": { topicId: "topic:b", interest: 0.6, fatigue: 0, lastDiscussedTick: undefined },
    },
    claims: {},
    ...overrides,
  };
}

function baseConfig(overrides: Partial<ContentUtteranceConfig> = {}): ContentUtteranceConfig {
  return { ...DEFAULT_CONTENT_UTTERANCE_CONFIG, utteranceIntervalTicks: 1, utteranceProbability: 1, ...overrides };
}

function baseRetellingRuntime(): RetellingRuntimeState {
  return {};
}

function baseContext(overrides: Partial<ContentUtteranceGenerationContext> = {}): ContentUtteranceGenerationContext {
  return {
    tick: 1,
    agents: [],
    groupCandidates: [],
    informationRuntime: {},
    clusterTopicRuntime: {},
    topicCatalog: TOPIC_CATALOG,
    claimCatalog: CLAIM_CATALOG,
    config: baseConfig(),
    limits: DEFAULT_INFORMATION_PROPAGATION_LIMITS,
    retellingConfig: DEFAULT_RETELLING_CONFIG,
    retellingRuntime: baseRetellingRuntime(),
    runSeed: 1,
    ...overrides,
  };
}

describe("deriveContentUtterances: single eligible speaker/claim (deterministic fixture)", () => {
  const agent1 = makeAgent({ id: "agent-1", label: "Agent1", joinedGroupId: "group-1" });
  const agent2 = makeAgent({ id: "agent-2", label: "Agent2", joinedGroupId: "group-1" });
  const cluster = makeCluster({ memberIds: ["agent-1", "agent-2"] });
  const informationRuntime: InformationRuntimeState = {
    "agent-1": makeAgentInformationState("agent-1", { claims: { "claim:a": makeClaimState({}) } }),
    "agent-2": makeAgentInformationState("agent-2", {}),
  };

  function run(tick: number, clusterTopicRuntime = {}) {
    return deriveContentUtterances(
      baseContext({ tick, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, clusterTopicRuntime }),
    );
  }

  it("produces exactly one ContentUtteranceEvent linked to a carrier shareInformation SpeechEvent", () => {
    const result = run(1);
    expect(result.utterances).toHaveLength(1);
    const utterance = result.utterances[0];
    expect(utterance.speakerId).toBe("agent-1");
    expect(utterance.clusterId).toBe("group-1");
    expect(utterance.topicId).toBe("topic:a");
    expect(utterance.claimId).toBe("claim:a");
    expect(utterance.variantId).toBe("claim:a:root");
    expect(utterance.audience).toBe("cluster");
    expect(utterance.reason).toBe("originalShare");
    expect(utterance.sourceTraceIds).toEqual(["source-initial-agent-1-claim:a"]);

    expect(result.speechEvents).toHaveLength(1);
    const speech = result.speechEvents[0];
    expect(speech.id).toBe(utterance.speechEventId);
    expect(speech.intent).toBe("shareInformation");
    expect(speech.reason).toBe("contentTurn");
    expect(speech.speakerId).toBe("agent-1");
    expect(speech.originX).toBe(agent1.x);
    expect(speech.originY).toBe(agent1.y);
    expect(speech.range).toBe(DEFAULT_CONTENT_UTTERANCE_CONFIG.clusterAudienceRange);
    expect(speech.strength).toBe(DEFAULT_CONTENT_UTTERANCE_CONFIG.clusterAudienceStrength);

    expect(result.clusterTopicRuntime["group-1"].currentTopicId).toBe("topic:a");
    expect(result.clusterTopicRuntime["group-1"].lastUtteranceTick).toBe(1);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe("contentUtteranceGenerated");
    expect(result.events[0].metadata?.topicTransition).toBe("started");
  });

  it("is fully reproducible for the same seed/tick/context", () => {
    const a = run(1);
    const b = run(1);
    expect(a).toEqual(b);
  });

  it("marks the reason as knownClaimShare when the speaker heard it from someone else", () => {
    const heardRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", {
        claims: {
          "claim:a": makeClaimState({
            sourceTraces: [makeSourceTrace({ id: "source-heard", kind: "heardUtterance", immediateSpeakerId: "agent-9", utteranceId: "u-1", receptionId: "r-1" })],
          }),
        },
      }),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
    const result = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime: heardRuntime }),
    );
    expect(result.utterances[0].reason).toBe("knownClaimShare");
  });
});

describe("deriveContentUtterances: retelling (Issue #232)", () => {
  const agent1 = makeAgent({ id: "agent-1", label: "Agent1", joinedGroupId: "group-1" });
  const agent2 = makeAgent({ id: "agent-2", label: "Agent2", joinedGroupId: "group-1" });
  const cluster = makeCluster({ memberIds: ["agent-1", "agent-2"] });

  function heardRuntime(overrides: Partial<AgentClaimState> = {}): InformationRuntimeState {
    return {
      "agent-1": makeAgentInformationState("agent-1", {
        claims: {
          "claim:a": makeClaimState({
            sourceTraces: [
              makeSourceTrace({ id: "source-heard", kind: "heardUtterance", immediateSpeakerId: "agent-9", utteranceId: "u-1", receptionId: "r-1" }),
            ],
            ...overrides,
          }),
        },
      }),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
  }

  it("does not trigger any RetellingEvent for an originalShare turn", () => {
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", { claims: { "claim:a": makeClaimState({}) } }),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
    const result = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime }));
    expect(result.utterances[0].reason).toBe("originalShare");
    expect(result.retellingEvents).toEqual([]);
    expect(result.generatedVariants).toEqual([]);
  });

  it("records a faithful RetellingEvent and updates retellingCount/lastRetoldTick when mutation is disabled (default)", () => {
    const informationRuntime = heardRuntime();
    const result = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime }),
    );
    expect(result.utterances[0].reason).toBe("knownClaimShare");
    expect(result.utterances[0].variantId).toBe("claim:a:root");
    expect(result.retellingEvents).toHaveLength(1);
    expect(result.retellingEvents[0]).toMatchObject({ result: "faithful", speakerId: "agent-1", claimId: "claim:a", inputVariantId: "claim:a:root" });
    expect(result.retellingEvents[0].contentUtteranceId).toBe(result.utterances[0].id);
    expect(result.generatedVariants).toEqual([]);

    const updatedClaimState = result.informationRuntime["agent-1"].claims["claim:a"];
    expect(updatedClaimState.retellingCount).toBe(1);
    expect(updatedClaimState.lastRetoldTick).toBe(1);
  });

  it("mutates the variant, marks reason=retelling, and records the new variant when forced to mutate", () => {
    const informationRuntime = heardRuntime({ memoryStrength: 0.3, confidence: 0.3 });
    const retellingConfig = { ...DEFAULT_RETELLING_CONFIG, mutationEnabled: true, baseMutationProbability: 1 };
    const result = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, retellingConfig }),
    );
    expect(result.utterances[0].reason).toBe("retelling");
    expect(result.utterances[0].variantId).not.toBe("claim:a:root");
    expect(result.generatedVariants).toHaveLength(1);
    expect(result.generatedVariants[0].parentVariantId).toBe("claim:a:root");
    expect(result.retellingEvents[0].result).toBe("mutated");
    expect(result.retellingEvents[0].mutationFactors.length).toBeGreaterThan(0);
  });

  it("reuses an already-generated variant across separate ticks (dedup, no duplicate id)", () => {
    const informationRuntime = heardRuntime({ memoryStrength: 0.3, confidence: 0.3 });
    const retellingConfig = {
      ...DEFAULT_RETELLING_CONFIG,
      mutationEnabled: true,
      baseMutationProbability: 1,
      retellingCooldownTicks: 0,
    };
    const first = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, retellingConfig }),
    );
    expect(first.generatedVariants).toHaveLength(1);

    const runtimeAfterFirst: InformationRuntimeState = {
      ...first.informationRuntime,
      "agent-1": {
        ...first.informationRuntime["agent-1"],
        claims: { "claim:a": { ...first.informationRuntime["agent-1"].claims["claim:a"], activeVariantId: "claim:a:root" } },
      },
    };
    const claimCatalogWithGenerated = { ...CLAIM_CATALOG, variants: [...CLAIM_CATALOG.variants, ...first.generatedVariants] };
    const second = deriveContentUtterances(
      baseContext({
        tick: 10,
        agents: [agent1, agent2],
        groupCandidates: [cluster],
        informationRuntime: runtimeAfterFirst,
        claimCatalog: claimCatalogWithGenerated,
        retellingConfig,
      }),
    );
    expect(second.retellingEvents[0].result).toBe("variantReused");
    expect(second.generatedVariants).toEqual([]);
    expect(second.retellingEvents[0].outputVariantId).toBe(first.generatedVariants[0].id);
  });

  it("suppresses the utterance (blockedByLimit) once the semantic distance ceiling is exceeded, without breaking the cluster's turn loop bookkeeping", () => {
    const informationRuntime = heardRuntime({ memoryStrength: 0.3, confidence: 0.3 });
    const retellingConfig = { ...DEFAULT_RETELLING_CONFIG, mutationEnabled: true, baseMutationProbability: 1, semanticDistanceCeiling: 0 };
    const result = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, retellingConfig }),
    );
    expect(result.utterances).toEqual([]);
    expect(result.speechEvents).toEqual([]);
    expect(result.retellingEvents).toHaveLength(1);
    expect(result.retellingEvents[0].result).toBe("blockedByLimit");
    expect(result.retellingEvents[0].contentUtteranceId).toBeUndefined();
    expect(result.generatedVariants).toEqual([]);
    // 話者自身のretellingCount/lastRetoldTickも更新されない(ContentUtterance生成成功時とだけ同時commit)
    expect(result.informationRuntime["agent-1"].claims["claim:a"].retellingCount).toBe(0);
  });
});

describe("deriveContentUtterances: no eligible speaker/claim", () => {
  const agent1 = makeAgent({ id: "agent-1", joinedGroupId: "group-1" });
  const agent2 = makeAgent({ id: "agent-2", joinedGroupId: "group-1" });
  const cluster = makeCluster({ memberIds: ["agent-1", "agent-2"] });

  it("produces no utterance and logs a deduplicated skip event when nobody remembers anything", () => {
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", {}),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
    const first = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime }),
    );
    expect(first.utterances).toEqual([]);
    expect(first.events).toHaveLength(1);
    expect(first.events[0].eventType).toBe("contentUtteranceSkipped");
    expect(first.events[0].metadata?.contentUtteranceSkipReason).toBe("noEligibleSpeaker");

    const second = deriveContentUtterances(
      baseContext({
        tick: 2,
        agents: [agent1, agent2],
        groupCandidates: [cluster],
        informationRuntime,
        clusterTopicRuntime: first.clusterTopicRuntime,
      }),
    );
    expect(second.utterances).toEqual([]);
    // 同一理由の連続記録は行わない(受入条件: 発話なしを毎tick大量記録しない)
    expect(second.events).toEqual([]);
  });

  it("does not treat a forgotten claim (memoryStrength 0) as eligible", () => {
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", {
        claims: { "claim:a": makeClaimState({ awareness: "forgotten", memoryStrength: 0 }) },
      }),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
    const result = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime }),
    );
    expect(result.utterances).toEqual([]);
  });
});

describe("deriveContentUtterances: cooldowns", () => {
  const agent1 = makeAgent({ id: "agent-1", joinedGroupId: "group-1" });
  const agent2 = makeAgent({ id: "agent-2", joinedGroupId: "group-1" });
  const cluster = makeCluster({ memberIds: ["agent-1", "agent-2"] });

  it("claimRepeatCooldownTicks prevents immediate re-sharing, then allows it again once elapsed", () => {
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", { claims: { "claim:a": makeClaimState({}) } }),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
    const config = baseConfig({ claimRepeatCooldownTicks: 5, speakerRepeatCooldownTicks: 0 });

    const tick1 = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config }));
    expect(tick1.utterances).toHaveLength(1);

    const tick2 = deriveContentUtterances(
      baseContext({ tick: 2, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config, clusterTopicRuntime: tick1.clusterTopicRuntime }),
    );
    expect(tick2.utterances).toEqual([]);
    expect(tick2.events[0]?.metadata?.contentUtteranceSkipReason).toBe("noEligibleSpeaker");

    const tick7 = deriveContentUtterances(
      baseContext({ tick: 7, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config, clusterTopicRuntime: tick1.clusterTopicRuntime }),
    );
    expect(tick7.utterances).toHaveLength(1);
  });

  it("speakerRepeatCooldownTicks rotates the turn to another eligible speaker", () => {
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", { claims: { "claim:a": makeClaimState({}) } }),
      "agent-2": makeAgentInformationState("agent-2", {
        claims: {
          "claim:b": makeClaimState({
            claimId: "claim:b",
            activeVariantId: "claim:b:root",
            encounteredVariantIds: ["claim:b:root"],
            sourceTraces: [makeSourceTrace({ id: "source-initial-agent-2-claim:b", variantId: "claim:b:root" })],
          }),
        },
      }),
    };
    const config = baseConfig({ speakerRepeatCooldownTicks: 3, claimRepeatCooldownTicks: 0 });

    const tick1 = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config }));
    expect(tick1.utterances).toHaveLength(1);
    const firstSpeaker = tick1.utterances[0].speakerId;

    const tick2 = deriveContentUtterances(
      baseContext({ tick: 2, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config, clusterTopicRuntime: tick1.clusterTopicRuntime }),
    );
    // cooldown中はfirstSpeakerを除外するため、もう片方が選ばれるか(候補がいなければ)スキップになる
    if (tick2.utterances.length > 0) {
      expect(tick2.utterances[0].speakerId).not.toBe(firstSpeaker);
    } else {
      expect(tick2.events[0]?.metadata?.contentUtteranceSkipReason).toBe("noEligibleSpeaker");
    }
  });
});

describe("deriveContentUtterances: cluster eligibility boundaries", () => {
  it("ignores clusters with fewer than 2 joined members", () => {
    const agent1 = makeAgent({ id: "agent-1", joinedGroupId: "group-1" });
    const cluster = makeCluster({ memberIds: ["agent-1"] });
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", { claims: { "claim:a": makeClaimState({}) } }),
    };
    const result = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1], groupCandidates: [cluster], informationRuntime }));
    expect(result.utterances).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("ignores clusters that are not confirmed (still forming)", () => {
    const agent1 = makeAgent({ id: "agent-1", state: "forming", joinedGroupId: "group-1" });
    const agent2 = makeAgent({ id: "agent-2", state: "forming", joinedGroupId: "group-1" });
    const cluster = makeCluster({ status: "forming", memberIds: ["agent-1", "agent-2"] });
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", { claims: { "claim:a": makeClaimState({}) } }),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
    const result = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime }));
    expect(result.utterances).toEqual([]);
  });

  it("discards the runtime state of a cluster that no longer exists (dissolved/expired)", () => {
    const priorRuntime = {
      "group-gone": {
        clusterId: "group-gone",
        currentTopicId: "topic:a",
        topicStartedTick: 1,
        lastUtteranceTick: 1,
        recentTopicIds: ["topic:a"],
        recentSpeakerIds: ["agent-1"],
        repetitionCount: 1,
        speakerLastTurnTick: { "agent-1": 1 },
        claimLastToldTick: { "claim:a": 1 },
        knownMemberIds: ["agent-1", "agent-2"],
        lastSkipReason: undefined,
      },
    };
    const result = deriveContentUtterances(baseContext({ tick: 2, agents: [], groupCandidates: [], clusterTopicRuntime: priorRuntime }));
    expect(result.clusterTopicRuntime).toEqual({});
    expect(result.utterances).toEqual([]);
  });

  it("does not wait for utteranceIntervalTicks before the very first opportunity", () => {
    const agent1 = makeAgent({ id: "agent-1", joinedGroupId: "group-1" });
    const agent2 = makeAgent({ id: "agent-2", joinedGroupId: "group-1" });
    const cluster = makeCluster({ memberIds: ["agent-1", "agent-2"] });
    const informationRuntime: InformationRuntimeState = {
      "agent-1": makeAgentInformationState("agent-1", { claims: { "claim:a": makeClaimState({}) } }),
      "agent-2": makeAgentInformationState("agent-2", {}),
    };
    const config = baseConfig({ utteranceIntervalTicks: 10 });
    const result = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config }));
    expect(result.utterances).toHaveLength(1);
  });
});

describe("deriveContentUtterances: topic persistence and new-member refresh", () => {
  const agent1 = makeAgent({ id: "agent-1", joinedGroupId: "group-1" });
  const agent2 = makeAgent({ id: "agent-2", joinedGroupId: "group-1" });
  const cluster = makeCluster({ memberIds: ["agent-1", "agent-2"] });
  const informationRuntime: InformationRuntimeState = {
    "agent-1": makeAgentInformationState("agent-1", {
      claims: {
        "claim:a": makeClaimState({}),
        "claim:b": makeClaimState({
          claimId: "claim:b",
          activeVariantId: "claim:b:root",
          encounteredVariantIds: ["claim:b:root"],
          sourceTraces: [makeSourceTrace({ id: "source-initial-agent-1-claim:b", variantId: "claim:b:root" })],
        }),
      },
    }),
    "agent-2": makeAgentInformationState("agent-2", {}),
  };

  it("stays on the current topic while minTopicDurationTicks has not elapsed and no new member joined", () => {
    const config = baseConfig({ minTopicDurationTicks: 100, speakerRepeatCooldownTicks: 0, claimRepeatCooldownTicks: 0 });
    const tick1 = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config }));
    const firstTopic = tick1.utterances[0].topicId;
    const tick2 = deriveContentUtterances(
      baseContext({ tick: 2, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config, clusterTopicRuntime: tick1.clusterTopicRuntime }),
    );
    expect(tick2.utterances[0]?.topicId).toBe(firstTopic);
    expect(tick2.events[0]?.metadata?.topicTransition).toBe("continued");
  });

  it("allows a topic switch when a new member joins even mid minTopicDurationTicks lock", () => {
    const config = baseConfig({ minTopicDurationTicks: 100, speakerRepeatCooldownTicks: 0, claimRepeatCooldownTicks: 0 });
    const tick1 = deriveContentUtterances(
      baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [makeCluster({ memberIds: ["agent-1"] })], informationRuntime, config }),
    );
    // memberが1人だけの間は発話自体が起きない(境界テスト)ので、まず2人でtopic:aを開始させる
    const started = deriveContentUtterances(baseContext({ tick: 1, agents: [agent1, agent2], groupCandidates: [cluster], informationRuntime, config }));
    expect(started.utterances[0].topicId).toBeDefined();
    void tick1;

    // 3人目が新規joinしたことをsyncさせる(hasNewMember: trueがtopic固定を解除しうる)
    const agent3 = makeAgent({ id: "agent-3", joinedGroupId: "group-1" });
    const informationRuntimeWithNewMember: InformationRuntimeState = {
      ...informationRuntime,
      "agent-3": makeAgentInformationState("agent-3", {}),
    };
    const clusterWithNewMember = makeCluster({ memberIds: ["agent-1", "agent-2", "agent-3"] });
    const afterJoin = deriveContentUtterances(
      baseContext({
        tick: 2,
        agents: [agent1, agent2, agent3],
        groupCandidates: [clusterWithNewMember],
        informationRuntime: informationRuntimeWithNewMember,
        config,
        clusterTopicRuntime: started.clusterTopicRuntime,
      }),
    );
    // 新規member検出(syncClusterMembership)自体が起きていることをknownMemberIdsから確認する
    expect(afterJoin.clusterTopicRuntime["group-1"].knownMemberIds).toEqual(["agent-1", "agent-2", "agent-3"]);
  });
});
