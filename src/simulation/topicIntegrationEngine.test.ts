import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import { getFormationPolicyById, type FormationRuntimeOptions } from "./formationPolicy";
import { assertStandingPartyInvariants } from "./standingPartyInvariants";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  type StandingPartyScenarioConfig,
} from "./standingPartyScenarioConfig";
import { DEFAULT_CLUSTER_TRANSITION_CONFIG } from "./clusterTransitionDecision";
import { DEFAULT_TOPIC_INTEGRATION_CONFIG } from "./topicCompatibility";
import { DEFAULT_INFORMATION_PROPAGATION_CONFIG, type InformationRuntimeState } from "./informationState";
import { createInitialClusterTopicState, type ClusterTopicRuntimeState } from "./conversationTopic";
import type { Agent, GroupCandidate, LogEntry, SimulationState } from "./types";

/**
 * Issue #233 (Phase 5): engine.tsのstep 5a/5b結線(`topicCompatibility.ts`由来の満足度寄与・
 * `alternativeClusterInterest.ts`のinformationOpportunity factor・`clusterTransitionDecision.ts`の
 * topicSignal)の統合テスト。純粋関数側の性質はそれぞれのモジュールのtestで検証済みのため、
 * ここでは「engineが実際にその結果をどう配線するか」(disabled時のbyte-identical後方互換、
 * enabled時に満足度・target選択・metadataへ反映されること)に絞る。`clusterTransitionEngine.test.ts`
 * と同じ、agentを`state: "approaching"`から出発させてengine自身の合流フローを通す方針を踏襲する。
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
    influenceAvoidance: 0,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "approaching",
    stress: 0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "group-a",
    x: 400,
    y: 260,
    memberIds: [],
    status: "confirmed",
    age: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 0,
    agents: [],
    groupCandidates: [],
    log: [],
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    finished: false,
    ...overrides,
  };
}

function runTicks(
  state: SimulationState,
  standingPartyConfig: StandingPartyScenarioConfig,
  rng: SeededRandom,
  count: number,
): { state: SimulationState; log: LogEntry[] } {
  let current = state;
  for (let i = 0; i < count; i++) {
    current = stepSimulation(current, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
      standingPartyConfig,
    });
  }
  return { state: current, log: current.log };
}

const TOPIC_ID = "topic:hobby";
const CLAIM_ID = "claim:hobby:favorite-recommendation";

function agentInformation(interest: number, knowsClaim = false): InformationRuntimeState {
  return {
    "agent-x": {
      agentId: "agent-x",
      profile: { retellingTendency: 0.5, memoryRetention: 0.5, baselineTopicInterest: {} },
      topics: { [TOPIC_ID]: { topicId: TOPIC_ID, interest, fatigue: 0 } },
      // knowsClaim: trueならnovelty(未知claim)factorを0にし、interestMatchだけを比較できるようにする。
      claims: knowsClaim
        ? {
            [CLAIM_ID]: {
              claimId: CLAIM_ID,
              awareness: "understood",
              acceptance: "adopted",
              confidence: 0.8,
              memoryStrength: 0.8,
              firstEncounteredTick: 0,
              lastEncounteredTick: 0,
              heardCount: 1,
              understoodCount: 1,
              adoptionCount: 1,
              activeVariantId: `${CLAIM_ID}:root`,
              encounteredVariantIds: [`${CLAIM_ID}:root`],
              sourceTraces: [],
              retellingCount: 0,
              lastMemoryEvaluationTick: 0,
            },
          }
        : {},
    },
  };
}

function clusterTopicRuntime(): ClusterTopicRuntimeState {
  return { "group-a": { ...createInitialClusterTopicState("group-a"), currentTopicId: TOPIC_ID, topicStartedTick: 0 } };
}

// utteranceProbability: 0にすることで、このtest期間中`clusterTopicRuntime`/`informationRuntime`を
// content utterance生成(#230)由来の変化から完全に隔離し、topic統合(#233)の寄与だけを観察できるようにする。
function informationPropagationConfig() {
  return {
    ...DEFAULT_INFORMATION_PROPAGATION_CONFIG,
    enabled: true,
    contentUtterance: { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG.contentUtterance, utteranceProbability: 0 },
  };
}

function joinedAgentState(interest: number | undefined, topicIntegrationEnabled: boolean, knowsClaim = false) {
  const candidate = makeCandidate({ id: "group-a", memberIds: ["ghost-1"] });
  const agent = makeAgent({ id: "agent-x", state: "approaching", joinedGroupId: "group-a", x: candidate.x, y: candidate.y });
  const state = makeState({
    tick: 0,
    agents: [agent],
    groupCandidates: [candidate],
    formationScenarioId: "standingParty",
    informationRuntime: interest !== undefined ? agentInformation(interest, knowsClaim) : undefined,
    clusterTopicRuntime: interest !== undefined ? clusterTopicRuntime() : undefined,
  });
  const standingPartyConfig: StandingPartyScenarioConfig = {
    ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
    informationPropagation: interest !== undefined ? informationPropagationConfig() : DEFAULT_INFORMATION_PROPAGATION_CONFIG,
    topicIntegration: { ...DEFAULT_TOPIC_INTEGRATION_CONFIG, enabled: topicIntegrationEnabled },
  };
  return { state, standingPartyConfig };
}

describe("engine結線: topicIntegration disabled(既定)は既存挙動と同一(受入条件)", () => {
  it("clusterTopicRuntime/informationRuntimeが存在していても、topicIntegration.enabled=falseなら満足度系列が変わらない", () => {
    const baseline = joinedAgentState(undefined, false); // 完全にPhase 5 runtime state無し
    const withPhase5DataButDisabled = joinedAgentState(0.9, false); // topic dataはあるがtopicIntegration無効

    for (const seed of [1, 2, 3]) {
      const a = runTicks(baseline.state, baseline.standingPartyConfig, new SeededRandom(seed), 15);
      const b = runTicks(withPhase5DataButDisabled.state, withPhase5DataButDisabled.standingPartyConfig, new SeededRandom(seed), 15);
      const satA = a.state.agents.find((x) => x.id === "agent-x")?.currentEpisode?.conversationSatisfaction;
      const satB = b.state.agents.find((x) => x.id === "agent-x")?.currentEpisode?.conversationSatisfaction;
      expect(satA).toBeDefined();
      expect(satB).toBe(satA);
    }
  });

  it("informationPropagation.enabled=falseなら、topicIntegration.enabled=trueでも満足度系列が変わらない(topic runtime state自体が無いため)", () => {
    const baseline = joinedAgentState(undefined, false);
    const topicOnPropagationOff = joinedAgentState(undefined, true);

    for (const seed of [1, 2, 3]) {
      const a = runTicks(baseline.state, baseline.standingPartyConfig, new SeededRandom(seed), 15);
      const b = runTicks(topicOnPropagationOff.state, topicOnPropagationOff.standingPartyConfig, new SeededRandom(seed), 15);
      const satA = a.state.agents.find((x) => x.id === "agent-x")?.currentEpisode?.conversationSatisfaction;
      const satB = b.state.agents.find((x) => x.id === "agent-x")?.currentEpisode?.conversationSatisfaction;
      expect(satB).toBe(satA);
    }
  });
});

describe("engine結線: topicIntegration enabled → 満足度がtopic compatibilityを反映する", () => {
  it("同じ状態でtopicへの関心(interest)だけが高い方が、低い方より満足度が高くなる", () => {
    // claimを既知にしてnovelty factorを揃え(両者とも0)、interestMatch factorの差だけを比較する。
    // ticksは少なめにし、cap(0.08/tick)による両者飽和(=1)で差が消える前に比較する。
    const low = joinedAgentState(0.05, true, true);
    const high = joinedAgentState(0.95, true, true);

    for (const seed of [1, 2, 3]) {
      const lowResult = runTicks(low.state, low.standingPartyConfig, new SeededRandom(seed), 4);
      const highResult = runTicks(high.state, high.standingPartyConfig, new SeededRandom(seed), 4);
      const satLow = lowResult.state.agents.find((x) => x.id === "agent-x")?.currentEpisode?.conversationSatisfaction;
      const satHigh = highResult.state.agents.find((x) => x.id === "agent-x")?.currentEpisode?.conversationSatisfaction;
      expect(satLow).toBeDefined();
      expect(satHigh).toBeDefined();
      expect(satHigh!).toBeGreaterThan(satLow!);
    }
  });
});

describe("engine結線: informationOpportunityがswitchToTargetClusterのmetadataに現れる", () => {
  it("未知claimが多いtargetの方が選ばれやすく、選ばれた場合alternativeInterestFactorsにinformationOpportunityが含まれる", () => {
    let sawInformationOpportunity = false;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const clusterA = makeCandidate({ id: "group-a", memberIds: ["ghost-a1"] });
      const clusterB = makeCandidate({ id: "group-b", x: clusterA.x, y: clusterA.y, memberIds: ["ghost-b1"] });
      const agent = makeAgent({
        id: "agent-x",
        state: "approaching",
        joinedGroupId: "group-a",
        x: clusterA.x,
        y: clusterA.y,
        socialCirculationTendency: 1,
      });
      const state = makeState({
        tick: 0,
        agents: [agent],
        groupCandidates: [clusterA, clusterB],
        formationScenarioId: "standingParty",
        informationRuntime: agentInformation(0), // topic:hobbyへの関心自体は低い(移動の主因が満足度でなくinformationにする)
        clusterTopicRuntime: {
          "group-a": { ...createInitialClusterTopicState("group-a") }, // topic未設定 -> 中立
          "group-b": { ...createInitialClusterTopicState("group-b"), currentTopicId: TOPIC_ID, topicStartedTick: 0 },
        },
      });
      const standingPartyConfig: StandingPartyScenarioConfig = {
        ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
        clusterDeparture: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.clusterDeparture,
          minStayTicks: 5,
          maxCirculationContribution: 0.9,
          circulationWarmupTicks: 0,
          circulationRampTicks: 1,
        },
        attachment: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.attachment,
          attachmentInhibitionWeight: 0,
          clusterWouldDissolveConcern: 0,
          recentMemberJoinedConcern: 0,
        },
        transition: {
          ...DEFAULT_CLUSTER_TRANSITION_CONFIG,
          enabled: true,
          interestToDepartureGain: 1,
          targetShareBase: 0.9,
          targetShareGain: 0.1,
        },
        informationPropagation: informationPropagationConfig(),
        topicIntegration: { ...DEFAULT_TOPIC_INTEGRATION_CONFIG, enabled: true, informationSeekingWeight: 0.4 },
      };
      const rng = new SeededRandom(seed);
      const { log } = runTicks(state, standingPartyConfig, rng, 60);

      const switched = log.find(
        (entry) => entry.eventType === "clusterDepartureStarted" && entry.metadata?.transitionAction === "switchToTargetCluster",
      );
      if (switched) {
        expect(switched.metadata?.targetClusterId).toBe("group-b");
        const factors = switched.metadata?.alternativeInterestFactors as { kind: string }[] | undefined;
        if (factors?.some((f) => f.kind === "informationOpportunity")) {
          sawInformationOpportunity = true;
        }
      }
    }
    expect(sawInformationOpportunity).toBe(true);
  });
});

describe("standingParty (Phase 5 presets): 1000tickの長時間実行でのグローバル不変条件(issue #233 要件9節)", () => {
  const PHASE5_PRESET_IDS = [
    "standing-party-info-rich",
    "standing-party-topic-segmented",
    "standing-party-rumor-mutation",
    "standing-party-info-seeking",
  ] as const;
  const SEEDS = [1, 2];
  const TICKS = 1000;

  function formationOptionsFor(presetId: string): FormationRuntimeOptions {
    const preset = getPresetById(presetId);
    return { scenarioId: "standingParty", standingPartyConfig: preset.formationStandingPartyConfig };
  }

  it.each(PHASE5_PRESET_IDS)(
    "プリセット「%s」で複数seedにわたりNaN/Infinity・孤児episode・重複membership・同一target即時往復の暴走がない",
    (presetId) => {
      const preset = getPresetById(presetId);
      const formation = formationOptionsFor(presetId);
      const formationPolicy = getFormationPolicyById("standingParty");
      const maxEmptyFormingAge = formationPolicy.defaultMaxAge;

      for (const seed of SEEDS) {
        const rng = new SeededRandom(seed);
        let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
        // Issue #233 要件6節: 同一targetへの即時往復が既存cooldown(recentlyDeparted factor)で
        // 抑えられているかを、`lastDepartedClusterId`への復帰が起きていないかで簡易に確認する。
        let immediateRoundTrips = 0;

        for (let i = 0; i < TICKS; i++) {
          const before = new Map(state.agents.map((a) => [a.id, a.joinedGroupId]));
          state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
          for (const agent of state.agents) {
            if (
              agent.state === "joined" &&
              agent.lastDepartedClusterId !== undefined &&
              before.get(agent.id) === undefined &&
              agent.joinedGroupId === agent.lastDepartedClusterId
            ) {
              immediateRoundTrips += 1;
            }
          }
          assertStandingPartyInvariants(state, { maxEmptyFormingAge, label: `preset=${presetId} seed=${seed} tick=${state.tick}` });
        }

        // 往復自体をゼロにする要件ではない(cooldownは確率的抑制)が、無制限に暴走していないことを
        // population規模に対して緩やかな上限で確認する(要件6節: 即時往復の無限反復がない)。
        expect(immediateRoundTrips).toBeLessThan(preset.params.populationSize * 5);
      }
    },
    60000,
  );
});
