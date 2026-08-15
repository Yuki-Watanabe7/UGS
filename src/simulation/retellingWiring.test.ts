import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { STANDING_PARTY_CLAIM_CATALOG } from "./informationModel";
import type { Agent, GroupCandidate, SimulationState } from "./types";
import type { AgentClaimState, InformationRuntimeState } from "./informationState";

/**
 * Issue #232 (Phase 5): `engine.ts`側の結線(catalogへのvariant merge、retellingRuntime/retellingLogの
 * 蓄積、mutation disabled時の互換)を検証する。mutation規則自体は`claimVariant.test.ts`、retelling
 * decision/実行境界は`retelling.test.ts`、`contentUtterance.ts`との結線詳細は`contentUtterance.test.ts`
 * が扱う ―― ここでは`stepSimulation`を通した end-to-end の結線だけを見る。
 */

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 400,
    y: 260,
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

const claim = STANDING_PARTY_CLAIM_CATALOG.claims[0];
const claimId = claim.id;
const rootVariantId = claim.rootVariantId;
const topicId = claim.topicId;

function knownClaimState(overrides: Partial<AgentClaimState> = {}): AgentClaimState {
  return {
    claimId,
    awareness: "understood",
    acceptance: "adopted",
    confidence: 0.6,
    memoryStrength: 0.6,
    firstEncounteredTick: 0,
    lastEncounteredTick: 0,
    firstHeardTick: 0,
    lastHeardTick: 0,
    heardCount: 1,
    understoodCount: 1,
    adoptionCount: 1,
    activeVariantId: rootVariantId,
    encounteredVariantIds: [rootVariantId],
    sourceTraces: [
      {
        id: "source-heard-original",
        kind: "heardUtterance",
        originalSourceId: claim.originalSource.id,
        immediateSpeakerId: "agent-0",
        utteranceId: "content-0",
        receptionId: "info-reception-0",
        variantId: rootVariantId,
        firstEncounteredTick: 0,
        lastEncounteredTick: 0,
        encounterCount: 1,
      },
    ],
    retellingCount: 0,
    lastRetoldTick: undefined,
    retellableFromTick: 0,
    lastMemoryEvaluationTick: 0,
    forgetAtTick: undefined,
    ...overrides,
  };
}

function informationRuntimeWithOneRetellerAndTwoStrangers(): InformationRuntimeState {
  return {
    "agent-1": {
      agentId: "agent-1",
      profile: { retellingTendency: 0.7, memoryRetention: 0.5, baselineTopicInterest: { [topicId]: 0.8 } },
      topics: { [topicId]: { topicId, interest: 0.8, fatigue: 0, lastDiscussedTick: undefined } },
      claims: { [claimId]: knownClaimState() },
    },
    "agent-2": {
      agentId: "agent-2",
      profile: { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: { [topicId]: 0.6 } },
      topics: { [topicId]: { topicId, interest: 0.6, fatigue: 0, lastDiscussedTick: undefined } },
      claims: {},
    },
    "agent-3": {
      agentId: "agent-3",
      profile: { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: { [topicId]: 0.6 } },
      topics: { [topicId]: { topicId, interest: 0.6, fatigue: 0, lastDiscussedTick: undefined } },
      claims: {},
    },
  };
}

function baseState(overrides: Partial<SimulationState> = {}): SimulationState {
  const candidate: GroupCandidate = {
    id: "group-1",
    x: 400,
    y: 260,
    memberIds: ["agent-1", "agent-2", "agent-3"],
    status: "confirmed",
    age: 20,
  };
  const agents: Agent[] = [
    makeAgent({ id: "agent-1", x: 400, y: 260, joinedGroupId: "group-1" }),
    makeAgent({ id: "agent-2", x: 405, y: 262, joinedGroupId: "group-1" }),
    makeAgent({ id: "agent-3", x: 402, y: 258, joinedGroupId: "group-1" }),
  ];
  return {
    tick: 10,
    agents,
    groupCandidates: [candidate],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    seed: 7,
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

describe("Phase 5 retelling wiring (master disabled)", () => {
  it("leaves generatedClaimVariants/retellingRuntime/retellingLog undefined when informationPropagation.enabled is false", () => {
    const state = baseState({ standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG });
    const rng = new SeededRandom(7);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng);
    expect(next.generatedClaimVariants).toBeUndefined();
    expect(next.retellingRuntime).toBeUndefined();
    // ログ配列は他のPhase 5ログ(`contentUtteranceLog`等)と同じ既存方針で`[]`になる(undefinedではない)
    expect(next.retellingLog ?? []).toEqual([]);
  });
});

describe("Phase 5 retelling wiring (enabled, mutation disabled — default)", () => {
  it("records only faithful RetellingEvents and never generates a variant", () => {
    const state = baseState({
      standingPartyConfig: {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        informationPropagation: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation,
          enabled: true,
          contentUtterance: {
            ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation.contentUtterance,
            utteranceIntervalTicks: 1,
            utteranceProbability: 1,
          },
        },
      },
      informationRuntime: informationRuntimeWithOneRetellerAndTwoStrangers(),
    });
    const rng = new SeededRandom(7);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng);

    expect(next.generatedClaimVariants ?? []).toEqual([]);
    if ((next.retellingLog ?? []).length > 0) {
      expect(next.retellingLog!.every((e) => e.result === "faithful")).toBe(true);
    }
  });
});

describe("Phase 5 retelling wiring (mutation enabled, forced)", () => {
  function mutationForcedState(): SimulationState {
    return baseState({
      standingPartyConfig: {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        informationPropagation: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation,
          enabled: true,
          contentUtterance: {
            ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation.contentUtterance,
            utteranceIntervalTicks: 1,
            utteranceProbability: 1,
          },
          transmission: {
            ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation.transmission,
            adoptionBaseRate: 1,
          },
          retelling: {
            ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.informationPropagation.retelling,
            mutationEnabled: true,
            baseMutationProbability: 1,
            retellingCooldownTicks: 0,
          },
        },
      },
      informationRuntime: informationRuntimeWithOneRetellerAndTwoStrangers(),
    });
  }

  it("appends a generated ClaimVariant, logs a mutated RetellingEvent, and receivers adopt the exact spoken variant", () => {
    const state = mutationForcedState();
    const rng = new SeededRandom(7);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng);

    expect(next.contentUtteranceLog).toHaveLength(1);
    const utterance = next.contentUtteranceLog![0];
    expect(utterance.speakerId).toBe("agent-1");
    expect(utterance.variantId).not.toBe(rootVariantId);

    expect(next.generatedClaimVariants).toHaveLength(1);
    const generated = next.generatedClaimVariants![0];
    expect(generated.id).toBe(utterance.variantId);
    expect(generated.parentVariantId).toBe(rootVariantId);
    expect(generated.canonicalClaimId).toBe(claimId);
    expect(generated.mutationFactors.length).toBeGreaterThan(0);

    expect(next.retellingLog).toHaveLength(1);
    expect(next.retellingLog![0]).toMatchObject({
      result: "mutated",
      speakerId: "agent-1",
      claimId,
      inputVariantId: rootVariantId,
      outputVariantId: generated.id,
      contentUtteranceId: utterance.id,
    });

    expect(next.retellingRuntime?.["group-1"]?.[generated.id]).toBe(1);

    // Issue #231との統合: 受信processingは発話された(mutated)variant IDをそのまま受け取り、
    // adoptionBaseRate:1で確定的に採用されるため受け手のactiveVariantIdもそのvariantになる。
    for (const receiverId of ["agent-2", "agent-3"]) {
      const receptions = next.informationReceptionLog?.filter((r) => r.receiverId === receiverId && r.claimId === claimId) ?? [];
      expect(receptions).toHaveLength(1);
      expect(receptions[0].variantId).toBe(generated.id);

      const receiverState = next.informationRuntime?.[receiverId]?.claims[claimId];
      expect(receiverState?.activeVariantId).toBe(generated.id);
      expect(receiverState?.encounteredVariantIds).toContain(generated.id);
    }

    // 話者自身のretellingCount/lastRetoldTickはContentUtterance生成成功と同じcommitで更新される。
    expect(next.informationRuntime?.["agent-1"]?.claims[claimId].retellingCount).toBe(1);
    expect(next.informationRuntime?.["agent-1"]?.claims[claimId].lastRetoldTick).toBe(state.tick + 1);
  });

  it("is fully reproducible for the same seed (deterministic lineage/events)", () => {
    const rngA = new SeededRandom(7);
    const rngB = new SeededRandom(7);
    const nextA = stepSimulation(mutationForcedState(), DEFAULT_PARAMS, rngA);
    const nextB = stepSimulation(mutationForcedState(), DEFAULT_PARAMS, rngB);
    expect(nextA.generatedClaimVariants).toEqual(nextB.generatedClaimVariants);
    expect(nextA.retellingLog).toEqual(nextB.retellingLog);
  });
});
