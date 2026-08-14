import { describe, expect, it } from "vitest";
import {
  applyScheduledForgetting,
  deriveInformationTransmission,
  type InformationTransmissionContext,
} from "./informationTransmission";
import {
  DEFAULT_INFORMATION_PROPAGATION_LIMITS,
  DEFAULT_INFORMATION_TRANSMISSION_CONFIG,
} from "./informationState";
import type { AgentClaimState, InformationRuntimeState, InformationTransmissionConfig, SourceTrace } from "./informationState";
import type { ClaimCatalog, InformationClaim } from "./informationModel";
import { createRootVariant } from "./informationModel";
import type { ContentUtteranceEvent } from "./contentUtterance";
import type { Agent, GroupCandidate } from "./types";
import { createSpeechEvent } from "./speech";
import type { SpeechEvent } from "./speech";
import type { SpeechTrustResolver } from "./speechEffects";

/**
 * Issue #231 (Phase 5): `informationTransmission.ts`(reception -> comprehension -> adoption ->
 * memory/provenance)を、`engine.ts`を経由せず直接検証する。engine全体との結線は
 * `contentUtteranceWiring.test.ts`側が担う。
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
  return { id: "group-1", x: 100, y: 100, memberIds: [], status: "confirmed", age: 10, ...overrides };
}

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
const CLAIM_CATALOG: ClaimCatalog = { id: "test-claims", claims: [CLAIM_A], variants: [createRootVariant(CLAIM_A)] };

function makeUtteranceAndSpeech(overrides: {
  tick: number;
  speakerId: string;
  clusterId: string;
  variantId?: string;
  originX?: number;
  originY?: number;
  turnSuffix?: string;
}): { utterance: ContentUtteranceEvent; speech: SpeechEvent } {
  const speech = createSpeechEvent({
    tick: overrides.tick,
    speakerId: overrides.speakerId,
    intent: "shareInformation",
    reason: "contentTurn",
    audience: "nearby",
    idSuffix: `${overrides.clusterId}-${overrides.turnSuffix ?? "0"}`,
    originX: overrides.originX ?? 100,
    originY: overrides.originY ?? 100,
    range: 90,
    strength: 1,
  });
  const utterance: ContentUtteranceEvent = {
    id: `content-${speech.id}`,
    tick: overrides.tick,
    speechEventId: speech.id,
    speakerId: overrides.speakerId,
    clusterId: overrides.clusterId,
    topicId: CLAIM_A.topicId,
    claimId: CLAIM_A.id,
    variantId: overrides.variantId ?? CLAIM_A.rootVariantId,
    audience: "cluster",
    reason: "knownClaimShare",
    sourceTraceIds: [],
  };
  return { utterance, speech };
}

function makeRuntime(receiverId: string, extra: Partial<InformationRuntimeState[string]> = {}): InformationRuntimeState {
  return {
    [receiverId]: {
      agentId: receiverId,
      profile: { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: { [CLAIM_A.topicId]: 0.7 } },
      topics: { [CLAIM_A.topicId]: { topicId: CLAIM_A.topicId, interest: 0.7, fatigue: 0, lastDiscussedTick: undefined } },
      claims: {},
      ...extra,
    },
  };
}

const NEUTRAL_TRUST: SpeechTrustResolver = () => 0.5;
const NEUTRAL_TIE: SpeechTrustResolver = () => 0;

function baseCtx(overrides: Partial<InformationTransmissionContext>): InformationTransmissionContext {
  return {
    tick: 10,
    agents: [],
    groupCandidates: [makeCluster({})],
    contentUtterances: [],
    contentSpeechEvents: [],
    informationRuntime: {},
    claimCatalog: CLAIM_CATALOG,
    limits: DEFAULT_INFORMATION_PROPAGATION_LIMITS,
    config: DEFAULT_INFORMATION_TRANSMISSION_CONFIG,
    runSeed: 42,
    resolveTrust: NEUTRAL_TRUST,
    resolveTieCorrection: NEUTRAL_TIE,
    ...overrides,
  };
}

describe("deriveInformationTransmission: heard/not-heard boundary", () => {
  it("does not create any information state when the receiver is out of range (heard: false)", () => {
    const { utterance, speech } = makeUtteranceAndSpeech({ tick: 10, speakerId: "agent-1", clusterId: "group-1", originX: 0, originY: 0 });
    const agents = [
      makeAgent({ id: "agent-1", x: 0, y: 0, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", x: 10000, y: 10000, joinedGroupId: "group-1" }),
    ];
    const result = deriveInformationTransmission(
      baseCtx({
        agents,
        contentUtterances: [utterance],
        contentSpeechEvents: [speech],
        informationRuntime: makeRuntime("agent-2"),
      }),
    );

    expect(result.informationReceptions).toHaveLength(1);
    expect(result.informationReceptions[0]).toMatchObject({ heard: false, comprehension: "notHeard" });
    expect(result.adoptions).toHaveLength(0);
    expect(result.memoryUpdates).toHaveLength(0);
    expect(result.informationRuntime["agent-2"].claims[CLAIM_A.id]).toBeUndefined();
  });
});

describe("deriveInformationTransmission: adoption factors", () => {
  function heardScenario(config: InformationTransmissionConfig, resolveTrust: SpeechTrustResolver) {
    const { utterance, speech } = makeUtteranceAndSpeech({ tick: 10, speakerId: "agent-1", clusterId: "group-1" });
    const agents = [
      makeAgent({ id: "agent-1", x: 100, y: 100, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", x: 105, y: 100, joinedGroupId: "group-1" }),
    ];
    return deriveInformationTransmission(
      baseCtx({
        agents,
        contentUtterances: [utterance],
        contentSpeechEvents: [speech],
        informationRuntime: makeRuntime("agent-2"),
        config,
        resolveTrust,
      }),
    );
  }

  it("uses a higher adoption probability when speaker trust is higher (structured, comparable factor)", () => {
    const highTrust = heardScenario(DEFAULT_INFORMATION_TRANSMISSION_CONFIG, () => 0.95);
    const lowTrust = heardScenario(DEFAULT_INFORMATION_TRANSMISSION_CONFIG, () => 0.05);

    const highFactor = highTrust.adoptions[0].factors.find((f) => f.key === "speakerTrust")!;
    const lowFactor = lowTrust.adoptions[0].factors.find((f) => f.key === "speakerTrust")!;
    expect(highFactor.rawValue).toBeGreaterThan(lowFactor.rawValue);
    expect(highTrust.adoptions[0].probability!).toBeGreaterThan(lowTrust.adoptions[0].probability!);
  });

  it("still records awareness/memory updates when the adoption result is rejected", () => {
    const alwaysRejectConfig: InformationTransmissionConfig = {
      ...DEFAULT_INFORMATION_TRANSMISSION_CONFIG,
      adoptionBaseRate: 0,
      trustWeight: 0,
      tieWeight: 0,
      topicInterestWeight: 0,
      priorConfidenceWeight: 0,
      sourceRepetitionWeight: 0,
      sourceDiversityWeight: 0,
      variantCompatibilityWeight: 0,
      claimVerifiabilityWeight: 0,
      utteranceStrengthWeight: 0,
      uncertainBandShare: 0,
    };
    const result = heardScenario(alwaysRejectConfig, () => 0);

    expect(result.adoptions[0].result).toBe("rejected");
    expect(result.memoryUpdates).toHaveLength(1);
    const claimState = result.informationRuntime["agent-2"].claims[CLAIM_A.id];
    expect(claimState.awareness).toBe("understood");
    expect(claimState.acceptance).toBe("rejected");
    expect(claimState.heardCount).toBe(1);
  });

  it("diminishes the contribution of repeated hearing from the same immediate source", () => {
    const traceFactory = (encounterCount: number): SourceTrace => ({
      id: "source-existing",
      kind: "heardUtterance",
      originalSourceId: CLAIM_A.originalSource.id,
      immediateSpeakerId: "agent-1",
      utteranceId: "content-existing",
      receptionId: "info-reception-existing",
      variantId: CLAIM_A.rootVariantId,
      firstEncounteredTick: 0,
      lastEncounteredTick: 5,
      encounterCount,
    });
    const existingClaimState = (encounterCount: number): AgentClaimState => ({
      claimId: CLAIM_A.id,
      awareness: "understood",
      acceptance: "uncertain",
      confidence: 0.3,
      memoryStrength: 0.3,
      firstEncounteredTick: 0,
      lastEncounteredTick: 5,
      firstHeardTick: 0,
      lastHeardTick: 5,
      heardCount: encounterCount,
      understoodCount: encounterCount,
      adoptionCount: 0,
      activeVariantId: undefined,
      encounteredVariantIds: [CLAIM_A.rootVariantId],
      sourceTraces: [traceFactory(encounterCount)],
      retellingCount: 0,
      lastRetoldTick: undefined,
      retellableFromTick: 5,
      lastMemoryEvaluationTick: 5,
      forgetAtTick: undefined,
    });

    const { utterance, speech } = makeUtteranceAndSpeech({ tick: 10, speakerId: "agent-1", clusterId: "group-1" });
    const agents = [
      makeAgent({ id: "agent-1", x: 100, y: 100, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", x: 105, y: 100, joinedGroupId: "group-1" }),
    ];

    const runFor = (encounterCount: number) =>
      deriveInformationTransmission(
        baseCtx({
          agents,
          contentUtterances: [utterance],
          contentSpeechEvents: [speech],
          informationRuntime: makeRuntime("agent-2", { claims: { [CLAIM_A.id]: existingClaimState(encounterCount) } }),
        }),
      );

    const freshResult = runFor(0);
    const repeatedResult = runFor(20);

    const freshFactor = freshResult.adoptions[0].factors.find((f) => f.key === "sourceRepetition")!;
    const repeatedFactor = repeatedResult.adoptions[0].factors.find((f) => f.key === "sourceRepetition")!;
    expect(freshFactor.rawValue).toBeGreaterThan(repeatedFactor.rawValue);
  });

  it("gives independent sources a higher source-diversity contribution than a single repeated source", () => {
    const traceOf = (speakerId: string): SourceTrace => ({
      id: `source-${speakerId}`,
      kind: "heardUtterance",
      originalSourceId: CLAIM_A.originalSource.id,
      immediateSpeakerId: speakerId,
      utteranceId: `content-${speakerId}`,
      receptionId: `info-reception-${speakerId}`,
      variantId: CLAIM_A.rootVariantId,
      firstEncounteredTick: 0,
      lastEncounteredTick: 5,
      encounterCount: 1,
    });
    const existingClaimState = (traces: SourceTrace[]): AgentClaimState => ({
      claimId: CLAIM_A.id,
      awareness: "understood",
      acceptance: "uncertain",
      confidence: 0.3,
      memoryStrength: 0.3,
      firstEncounteredTick: 0,
      lastEncounteredTick: 5,
      firstHeardTick: 0,
      lastHeardTick: 5,
      heardCount: traces.length,
      understoodCount: traces.length,
      adoptionCount: 0,
      activeVariantId: undefined,
      encounteredVariantIds: [CLAIM_A.rootVariantId],
      sourceTraces: traces,
      retellingCount: 0,
      lastRetoldTick: undefined,
      retellableFromTick: 5,
      lastMemoryEvaluationTick: 5,
      forgetAtTick: undefined,
    });

    // クラスタメンバーはspeaker(agent-3)とreceiver(agent-4)の2人だけにする。既存traceが参照する
    // agent-1/agent-2はこのtickの発話には登場しない過去の話者(このtickのaudienceを汚染しない)。
    const { utterance, speech } = makeUtteranceAndSpeech({ tick: 10, speakerId: "agent-3", clusterId: "group-1" });
    const agents = [
      makeAgent({ id: "agent-3", x: 100, y: 100, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-4", x: 105, y: 100, joinedGroupId: "group-1" }),
    ];

    const singleSourceResult = deriveInformationTransmission(
      baseCtx({
        agents,
        contentUtterances: [utterance],
        contentSpeechEvents: [speech],
        informationRuntime: makeRuntime("agent-4", { claims: { [CLAIM_A.id]: existingClaimState([traceOf("agent-3")]) } }),
      }),
    );
    const diverseSourceResult = deriveInformationTransmission(
      baseCtx({
        agents,
        contentUtterances: [utterance],
        contentSpeechEvents: [speech],
        informationRuntime: makeRuntime("agent-4", {
          claims: { [CLAIM_A.id]: existingClaimState([traceOf("agent-1"), traceOf("agent-2")]) },
        }),
      }),
    );

    const singleDiversity = singleSourceResult.adoptions[0].factors.find((f) => f.key === "sourceDiversity")!;
    const diverseDiversity = diverseSourceResult.adoptions[0].factors.find((f) => f.key === "sourceDiversity")!;
    expect(diverseDiversity.rawValue).toBeGreaterThan(singleDiversity.rawValue);
  });

  it("penalizes a variant that conflicts with the already-adopted active variant", () => {
    const adoptedState: AgentClaimState = {
      claimId: CLAIM_A.id,
      awareness: "understood",
      acceptance: "adopted",
      confidence: 0.7,
      memoryStrength: 0.7,
      firstEncounteredTick: 0,
      lastEncounteredTick: 5,
      firstHeardTick: 0,
      lastHeardTick: 5,
      heardCount: 1,
      understoodCount: 1,
      adoptionCount: 1,
      activeVariantId: CLAIM_A.rootVariantId,
      encounteredVariantIds: [CLAIM_A.rootVariantId],
      sourceTraces: [],
      retellingCount: 0,
      lastRetoldTick: undefined,
      retellableFromTick: 5,
      lastMemoryEvaluationTick: 5,
      forgetAtTick: undefined,
    };
    const agents = [
      makeAgent({ id: "agent-1", x: 100, y: 100, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", x: 105, y: 100, joinedGroupId: "group-1" }),
    ];

    const { utterance: sameVariantUtterance, speech: sameVariantSpeech } = makeUtteranceAndSpeech({
      tick: 10,
      speakerId: "agent-1",
      clusterId: "group-1",
      variantId: CLAIM_A.rootVariantId,
    });
    const { utterance: conflictingUtterance, speech: conflictingSpeech } = makeUtteranceAndSpeech({
      tick: 10,
      speakerId: "agent-1",
      clusterId: "group-1",
      variantId: "claim:a:conflicting-variant",
    });

    const sameVariantResult = deriveInformationTransmission(
      baseCtx({
        agents,
        contentUtterances: [sameVariantUtterance],
        contentSpeechEvents: [sameVariantSpeech],
        informationRuntime: makeRuntime("agent-2", { claims: { [CLAIM_A.id]: adoptedState } }),
      }),
    );
    const conflictingResult = deriveInformationTransmission(
      baseCtx({
        agents,
        contentUtterances: [conflictingUtterance],
        contentSpeechEvents: [conflictingSpeech],
        informationRuntime: makeRuntime("agent-2", { claims: { [CLAIM_A.id]: adoptedState } }),
      }),
    );

    // 同一variantの再確認はalreadyKnown(RNGを使わない決定的短絡経路)になる
    expect(sameVariantResult.adoptions[0].result).toBe("alreadyKnown");
    const conflictFactor = conflictingResult.adoptions[0].factors.find((f) => f.key === "variantCompatibility")!;
    expect(conflictFactor.rawValue).toBeLessThan(1);
  });
});

describe("deriveInformationTransmission: same-tick aggregation", () => {
  it("collapses multiple utterances of the same claim in one tick into a single adoption/memory update, order-independently", () => {
    // agent-2(receiver)は両方のspeakerから届く距離、agent-1とagent-3同士は互いのaudibility圏外に置き、
    // 「agent-2が2件受信する」以外の余計な受信(speaker同士が互いを聞く等)が発生しないようにする。
    const { utterance: fromAgent1, speech: speechFromAgent1 } = makeUtteranceAndSpeech({
      tick: 10,
      speakerId: "agent-1",
      clusterId: "group-1",
      turnSuffix: "0",
      originX: 80,
      originY: 0,
    });
    const { utterance: fromAgent3, speech: speechFromAgent3 } = makeUtteranceAndSpeech({
      tick: 10,
      speakerId: "agent-3",
      clusterId: "group-1",
      turnSuffix: "1",
      originX: -80,
      originY: 0,
    });
    const agents = [
      makeAgent({ id: "agent-1", x: 80, y: 0, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", x: 0, y: 0, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-3", x: -80, y: 0, joinedGroupId: "group-1" }),
    ];

    const runWith = (utterances: ContentUtteranceEvent[], speeches: SpeechEvent[]) =>
      deriveInformationTransmission(
        baseCtx({
          agents,
          contentUtterances: utterances,
          contentSpeechEvents: speeches,
          informationRuntime: makeRuntime("agent-2"),
        }),
      );

    const forward = runWith([fromAgent1, fromAgent3], [speechFromAgent1, speechFromAgent3]);
    const reversed = runWith([fromAgent3, fromAgent1], [speechFromAgent3, speechFromAgent1]);

    const forwardForReceiver2 = forward.adoptions.filter((a) => a.receiverId === "agent-2");
    const reversedForReceiver2 = reversed.adoptions.filter((a) => a.receiverId === "agent-2");
    expect(forwardForReceiver2).toHaveLength(1);
    expect(forward.informationRuntime["agent-2"].claims[CLAIM_A.id].heardCount).toBe(2);
    expect(forward.informationRuntime).toEqual(reversed.informationRuntime);
    expect(forwardForReceiver2).toEqual(reversedForReceiver2);
  });
});

describe("applyScheduledForgetting / relearn", () => {
  const decayConfig: InformationTransmissionConfig = {
    ...DEFAULT_INFORMATION_TRANSMISSION_CONFIG,
    memoryDecayPerTick: 0.05,
    forgetThreshold: 0.2,
    relearnFloor: 0.4,
  };

  function dueClaimState(): AgentClaimState {
    return {
      claimId: CLAIM_A.id,
      awareness: "understood",
      acceptance: "adopted",
      confidence: 0.6,
      memoryStrength: 0.22,
      firstEncounteredTick: 0,
      lastEncounteredTick: 5,
      firstHeardTick: 5,
      lastHeardTick: 5,
      heardCount: 1,
      understoodCount: 1,
      adoptionCount: 1,
      activeVariantId: CLAIM_A.rootVariantId,
      encounteredVariantIds: [CLAIM_A.rootVariantId],
      sourceTraces: [
        {
          id: "source-existing",
          kind: "heardUtterance",
          originalSourceId: CLAIM_A.originalSource.id,
          immediateSpeakerId: "agent-1",
          utteranceId: "content-existing",
          receptionId: "info-reception-existing",
          variantId: CLAIM_A.rootVariantId,
          firstEncounteredTick: 5,
          lastEncounteredTick: 5,
          encounterCount: 1,
        },
      ],
      retellingCount: 0,
      lastRetoldTick: undefined,
      retellableFromTick: 5,
      lastMemoryEvaluationTick: 5,
      forgetAtTick: 10,
    };
  }

  it("forgets a claim once its scheduled forgetAtTick is due, while keeping source traces and firstHeardTick", () => {
    const runtime = makeRuntime("agent-2", { claims: { [CLAIM_A.id]: dueClaimState() } });
    const result = applyScheduledForgetting(runtime, 10, decayConfig);

    expect(result.memoryUpdates).toHaveLength(1);
    expect(result.memoryUpdates[0]).toMatchObject({ receiverId: "agent-2", claimId: CLAIM_A.id, reason: "forgotten" });
    const claimState = result.runtime["agent-2"].claims[CLAIM_A.id];
    expect(claimState.awareness).toBe("forgotten");
    expect(claimState.forgetAtTick).toBeUndefined();
    expect(claimState.sourceTraces).toHaveLength(1);
    expect(claimState.firstHeardTick).toBe(5);
  });

  it("does not forget a claim before its scheduled tick", () => {
    const runtime = makeRuntime("agent-2", { claims: { [CLAIM_A.id]: dueClaimState() } });
    const result = applyScheduledForgetting(runtime, 5, decayConfig);
    expect(result.memoryUpdates).toHaveLength(0);
    expect(result.runtime["agent-2"].claims[CLAIM_A.id].awareness).toBe("understood");
  });

  it("relearns a forgotten claim without overwriting firstHeardTick, and restores memory above relearnFloor", () => {
    const forgotten = applyScheduledForgetting(makeRuntime("agent-2", { claims: { [CLAIM_A.id]: dueClaimState() } }), 10, decayConfig)
      .runtime;

    const { utterance, speech } = makeUtteranceAndSpeech({ tick: 20, speakerId: "agent-1", clusterId: "group-1" });
    const agents = [
      makeAgent({ id: "agent-1", x: 100, y: 100, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", x: 105, y: 100, joinedGroupId: "group-1" }),
    ];

    const result = deriveInformationTransmission(
      baseCtx({
        tick: 20,
        agents,
        contentUtterances: [utterance],
        contentSpeechEvents: [speech],
        informationRuntime: forgotten,
        config: decayConfig,
      }),
    );

    expect(result.memoryUpdates[0].reason).toBe("relearned");
    const claimState = result.informationRuntime["agent-2"].claims[CLAIM_A.id];
    expect(claimState.awareness).not.toBe("forgotten");
    expect(claimState.firstHeardTick).toBe(5);
    expect(claimState.lastHeardTick).toBe(20);
    expect(claimState.memoryStrength).toBeGreaterThanOrEqual(decayConfig.relearnFloor);
  });
});

describe("deriveInformationTransmission: determinism", () => {
  it("returns identical results for identical inputs/seed (reproducibility)", () => {
    const { utterance, speech } = makeUtteranceAndSpeech({ tick: 10, speakerId: "agent-1", clusterId: "group-1" });
    const agents = [
      makeAgent({ id: "agent-1", x: 100, y: 100, joinedGroupId: "group-1" }),
      makeAgent({ id: "agent-2", x: 105, y: 100, joinedGroupId: "group-1" }),
    ];
    const ctx = baseCtx({
      agents,
      contentUtterances: [utterance],
      contentSpeechEvents: [speech],
      informationRuntime: makeRuntime("agent-2"),
    });

    const first = deriveInformationTransmission(ctx);
    const second = deriveInformationTransmission(ctx);
    expect(first).toEqual(second);
  });
});
