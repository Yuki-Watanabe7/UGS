import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import { STANDING_PARTY_CLAIM_CATALOG, createRootVariant } from "./informationModel";
import type { Agent, GroupCandidate, SimulationState } from "./types";
import type { InformationRuntimeState } from "./informationState";

/**
 * Issue #230 (Phase 5): `engine.ts`側の結線(既存Phase 1〜4処理後にだけ内容発話を生成し、
 * disabled時は一切影響しない)を検証する。選択ロジック自体の詳細は`contentUtterance.test.ts`が扱う。
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

const claimId = STANDING_PARTY_CLAIM_CATALOG.claims[0].id;
const rootVariantId = STANDING_PARTY_CLAIM_CATALOG.claims[0].rootVariantId;
const topicId = STANDING_PARTY_CLAIM_CATALOG.claims[0].topicId;

function informationRuntimeWithOneKnower(): InformationRuntimeState {
  return {
    "agent-1": {
      agentId: "agent-1",
      profile: { retellingTendency: 0.7, memoryRetention: 0.7, baselineTopicInterest: { [topicId]: 0.8 } },
      topics: { [topicId]: { topicId, interest: 0.8, fatigue: 0, lastDiscussedTick: undefined } },
      claims: {
        [claimId]: {
          claimId,
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
          activeVariantId: rootVariantId,
          encounteredVariantIds: [rootVariantId],
          sourceTraces: [
            {
              id: `source-initial-agent-1-${claimId}`,
              kind: "initialGrant",
              originalSourceId: STANDING_PARTY_CLAIM_CATALOG.claims[0].originalSource.id,
              immediateSpeakerId: undefined,
              utteranceId: undefined,
              receptionId: undefined,
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
        },
      },
    },
    "agent-2": {
      agentId: "agent-2",
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
    memberIds: ["agent-1", "agent-2"],
    status: "confirmed",
    age: 20,
  };
  const agents: Agent[] = [
    makeAgent({ id: "agent-1", x: 400, y: 260, joinedGroupId: "group-1" }),
    makeAgent({ id: "agent-2", x: 405, y: 262, joinedGroupId: "group-1" }),
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

describe("Phase 5 content utterance wiring (disabled, default)", () => {
  it("leaves clusterTopicRuntime/contentUtteranceLog untouched when informationPropagation.enabled is false", () => {
    const state = baseState({ standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG });
    const rng = new SeededRandom(7);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng);
    expect(next.clusterTopicRuntime).toBeUndefined();
    expect(next.contentUtteranceLog ?? []).toEqual([]);
    expect(next.speechLog?.some((s) => s.intent === "shareInformation")).toBe(false);
  });
});

describe("Phase 5 content utterance wiring (enabled)", () => {
  function enabledState(): SimulationState {
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
        },
      },
      informationRuntime: informationRuntimeWithOneKnower(),
    });
  }

  it("generates a ContentUtteranceEvent + shareInformation SpeechEvent once a confirmed cluster with an eligible speaker exists", () => {
    const state = enabledState();
    const rng = new SeededRandom(7);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng);

    expect(next.contentUtteranceLog).toHaveLength(1);
    const utterance = next.contentUtteranceLog![0];
    expect(utterance.speakerId).toBe("agent-1");
    expect(utterance.clusterId).toBe("group-1");
    expect(utterance.claimId).toBe(claimId);

    expect(next.speechLog?.some((s) => s.id === utterance.speechEventId && s.intent === "shareInformation")).toBe(true);
    expect(next.clusterTopicRuntime?.["group-1"]?.currentTopicId).toBe(topicId);

    // agentごとの情報状態(informationRuntime)自体はこのIssueでは書き換えない(#231以降の対象)
    expect(next.informationRuntime).toEqual(state.informationRuntime);
  });

  it("does not perturb agent transitions/log for non-Phase-5 concerns compared to disabled, aside from the new content utterance additions", () => {
    const disabledState = baseState({ standingPartyConfig: DEFAULT_STANDING_PARTY_SCENARIO_CONFIG });
    const enabled = enabledState();
    const rngA = new SeededRandom(7);
    const rngB = new SeededRandom(7);
    const nextDisabled = stepSimulation(disabledState, DEFAULT_PARAMS, rngA);
    const nextEnabled = stepSimulation(enabled, DEFAULT_PARAMS, rngB);

    expect(nextEnabled.agents).toEqual(nextDisabled.agents);
    expect(nextEnabled.groupCandidates).toEqual(nextDisabled.groupCandidates);
  });
});

describe("catalog fixtures used by the wiring test stay internally valid", () => {
  it("STANDING_PARTY catalogs still validate (guards fixture drift)", () => {
    expect(STANDING_PARTY_CLAIM_CATALOG.variants.map((v) => v.id)).toContain(rootVariantId);
    expect(createRootVariant(STANDING_PARTY_CLAIM_CATALOG.claims[0]).id).toBe(rootVariantId);
  });
});
