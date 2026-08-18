import { describe, expect, it } from "vitest";
import {
  assertInformationAnalysisDoesNotMutateState,
  buildInformationPropagationAnalysis,
} from "./informationAnalysis";
import { DEFAULT_INFORMATION_PROPAGATION_CONFIG } from "./informationState";
import type { Agent, GroupCandidate, SimulationState } from "./types";

const CLAIM_ID = "claim:event-program:closing-time";
const TOPIC_ID = "topic:event-program";
const VARIANT_ID = "claim:event-program:closing-time:root";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "a",
    label: "A",
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.5,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.5,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "joined",
    joinedGroupId: "g1",
    stress: 0,
    ...overrides,
  };
}

function candidate(): GroupCandidate {
  return { id: "g1", x: 180, y: 160, memberIds: ["a", "b", "c"], status: "confirmed", age: 0 };
}

function claimState(overrides: Record<string, unknown> = {}) {
  return {
    claimId: CLAIM_ID,
    awareness: "understood" as const,
    acceptance: "adopted" as const,
    confidence: 0.8,
    memoryStrength: 0.9,
    firstEncounteredTick: 0,
    lastEncounteredTick: 5,
    firstHeardTick: 5,
    lastHeardTick: 5,
    heardCount: 1,
    understoodCount: 1,
    adoptionCount: 1,
    activeVariantId: VARIANT_ID,
    encounteredVariantIds: [VARIANT_ID],
    sourceTraces: [{ id: "source-info-r1", kind: "heardUtterance" as const, originalSourceId: "source:organizer", immediateSpeakerId: "a", utteranceId: "content-s1", receptionId: "info-r1", variantId: VARIANT_ID, firstEncounteredTick: 5, lastEncounteredTick: 5, encounterCount: 1 }],
    retellingCount: 0,
    lastMemoryEvaluationTick: 5,
    ...overrides,
  };
}

function state(): SimulationState {
  return {
    tick: 9,
    seed: 42,
    agents: [agent({ id: "a", label: "A" }), agent({ id: "b", label: "B", isObserverJoiner: true }), agent({ id: "c", label: "C" })],
    groupCandidates: [candidate()],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
    informationRuntime: {
      a: { agentId: "a", profile: { retellingTendency: 0.4, memoryRetention: 0.7, baselineTopicInterest: { [TOPIC_ID]: 0.8 } }, topics: { [TOPIC_ID]: { topicId: TOPIC_ID, interest: 0.8, fatigue: 0.1 } }, claims: { [CLAIM_ID]: claimState({ firstHeardTick: undefined, lastHeardTick: undefined, heardCount: 0, understoodCount: 0, adoptionCount: 0, sourceTraces: [] }) } },
      b: { agentId: "b", profile: { retellingTendency: 0.5, memoryRetention: 0.7, baselineTopicInterest: { [TOPIC_ID]: 0.7 } }, topics: { [TOPIC_ID]: { topicId: TOPIC_ID, interest: 0.7, fatigue: 0.2 } }, claims: { [CLAIM_ID]: claimState() } },
      c: { agentId: "c", profile: { retellingTendency: 0.2, memoryRetention: 0.6, baselineTopicInterest: { [TOPIC_ID]: 0.2 } }, topics: {}, claims: {} },
    },
    clusterTopicRuntime: {
      g1: { clusterId: "g1", currentTopicId: TOPIC_ID, topicStartedTick: 9, lastUtteranceTick: 5, recentTopicIds: [TOPIC_ID], recentSpeakerIds: ["a"], repetitionCount: 1, speakerLastTurnTick: { a: 5 }, claimLastToldTick: { [CLAIM_ID]: 5 }, knownMemberIds: ["a", "b", "c"] },
    },
    contentUtteranceLog: [{ id: "content-s1", tick: 5, speechEventId: "speech-s1", speakerId: "a", clusterId: "g1", topicId: TOPIC_ID, claimId: CLAIM_ID, variantId: VARIANT_ID, reason: "originalShare", sourceTraceIds: [] }],
    informationReceptionLog: [
      { id: "info-r1", tick: 5, contentUtteranceId: "content-s1", speechReceptionEventId: "speech-reception-s1-b", receiverId: "b", speakerId: "a", clusterId: "g1", claimId: CLAIM_ID, variantId: VARIANT_ID, heard: true, comprehension: "understood", comprehensionFactors: [] },
      { id: "info-r2", tick: 5, contentUtteranceId: "content-s1", speechReceptionEventId: "speech-reception-s1-c", receiverId: "c", speakerId: "a", clusterId: "g1", claimId: CLAIM_ID, variantId: VARIANT_ID, heard: false, comprehension: "notHeard", comprehensionFactors: [] },
    ],
    informationAdoptionLog: [{ id: "info-adoption-5-b", tick: 5, receiverId: "b", claimId: CLAIM_ID, consideredVariantIds: [VARIANT_ID], receptionEventIds: ["info-r1"], result: "adopted", previousConfidence: 0, nextConfidence: 0.8, confidenceDelta: 0.8, factors: [], probability: 0.8, draw: 0.2 }],
    informationMemoryUpdateLog: [{ id: "info-memory-5-b", tick: 5, receiverId: "b", claimId: CLAIM_ID, adoptionEventId: "info-adoption-5-b", receptionEventIds: ["info-r1"], reason: "firstExposure", previousAwareness: undefined, nextAwareness: "understood", previousMemoryStrength: 0, nextMemoryStrength: 0.9, sourceTraceIdsAdded: ["source-info-r1"] }],
    retellingLog: [{ id: "retelling-7-g1-b-claim", tick: 7, clusterId: "g1", speakerId: "b", claimId: CLAIM_ID, inputVariantId: VARIANT_ID, outputVariantId: VARIANT_ID, sourceReceptionIds: ["info-r1"], sourceTraceIds: ["source-info-r1"], result: "faithful", factors: [], mutationFactors: [], probability: 0, draw: 0 }],
  };
}

const config = { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG, enabled: true };

describe("informationAnalysis (Issue #234)", () => {
  it("発話→受信→採用→記憶更新のID連鎖をread modelへ束ね、notHeardを伝播edgeにしない", () => {
    const analysis = buildInformationPropagationAnalysis(state(), { config });
    expect(analysis.transmissions).toHaveLength(2);
    expect(analysis.transmissions[0]).toMatchObject({ id: "info-r1", adoptionEventId: "info-adoption-5-b", memoryUpdateEventId: "info-memory-5-b", result: "adopted" });
    expect(analysis.transmissions[1]).toMatchObject({ id: "info-r2", result: "notHeard" });
    expect(analysis.propagationEdges).toHaveLength(1);
    expect(analysis.propagationEdges[0]?.edgeId).toBe("propagation:info-r1");
  });

  it("共通filterは伝播・timeline・agent inspectorへ同じclaim/result条件を適用する", () => {
    const analysis = buildInformationPropagationAnalysis(state(), { config, filter: { claimIds: [CLAIM_ID], results: ["adopted"], agentIds: ["b"] } });
    expect(analysis.transmissions.map((record) => record.id)).toEqual(["info-r1"]);
    expect(analysis.timeline.every((entry) => entry.claimId === CLAIM_ID)).toBe(true);
    expect(analysis.agentSnapshots.map((snapshot) => snapshot.agentId)).toEqual(["b"]);
  });

  it("cluster topic、lineage、分母つき率を導出し、forgotten/未接触を値で捏造しない", () => {
    const analysis = buildInformationPropagationAnalysis(state(), { config });
    expect(analysis.clusterSnapshots[0]).toMatchObject({ clusterId: "g1", currentTopicId: TOPIC_ID, changedAtCurrentTick: true });
    expect(analysis.lineage.find((row) => row.variantId === VARIANT_ID)).toMatchObject({ parentVariantId: undefined, lineageDepth: 0 });
    expect(analysis.statistics.utteranceToHeard).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(analysis.statistics.heardToAdopt).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(analysis.agentSnapshots.find((snapshot) => snapshot.agentId === "c")?.claims).toEqual([]);
  });

  it("analysisはstateをmutationしない", () => {
    const input = state();
    assertInformationAnalysisDoesNotMutateState(input, () => buildInformationPropagationAnalysis(input, { config }));
  });
});
