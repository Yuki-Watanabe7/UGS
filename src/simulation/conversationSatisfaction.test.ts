import { describe, expect, it } from "vitest";
import {
  computeCliqueMateRatio,
  DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
  initializeConversationSatisfaction,
  updateConversationSatisfaction,
  validateConversationSatisfactionConfig,
  type ConversationSatisfactionConfig,
} from "./conversationSatisfaction";
import { buildAgentInspection } from "./inspection";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, GroupCandidate, SimulationState } from "./types";

const CONFIG = DEFAULT_CONVERSATION_SATISFACTION_CONFIG;

function withConfig(overrides: Partial<ConversationSatisfactionConfig>): ConversationSatisfactionConfig {
  return { ...CONFIG, ...overrides };
}

describe("初期化 (initializeConversationSatisfaction)", () => {
  it("常に[0,1]へ収まる(極端な人数でも発散しない)", () => {
    for (const memberCountAtJoin of [1, 2, 4, 50, 100000]) {
      const value = initializeConversationSatisfaction({
        config: CONFIG,
        memberCountAtJoin,
        cliqueRatio: 1,
        existingTieStrength: 1,
      });
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("同一入力からは同一出力になる(純粋関数)", () => {
    const ctx = { config: CONFIG, memberCountAtJoin: 5, cliqueRatio: 0.5, existingTieStrength: 0.4 };
    expect(initializeConversationSatisfaction(ctx)).toBe(initializeConversationSatisfaction(ctx));
  });

  it("existingTieStrength=0ではclique補正が0になる(cliqueRatioに関わらず基礎値+人数補正のみ)", () => {
    const withTieZero = initializeConversationSatisfaction({
      config: CONFIG,
      memberCountAtJoin: CONFIG.preferredConversationSize,
      cliqueRatio: 1,
      existingTieStrength: 0,
    });
    // preferredConversationSizeちょうどなので人数補正も0 -> 基礎初期値そのものになるはず
    expect(withTieZero).toBe(CONFIG.initialConversationSatisfaction);
  });

  it("cliqueRatioが高いほど(existingTieStrength>0のとき)初期値が高くなる", () => {
    const low = initializeConversationSatisfaction({
      config: CONFIG,
      memberCountAtJoin: CONFIG.preferredConversationSize,
      cliqueRatio: 0,
      existingTieStrength: 0.5,
    });
    const high = initializeConversationSatisfaction({
      config: CONFIG,
      memberCountAtJoin: CONFIG.preferredConversationSize,
      cliqueRatio: 1,
      existingTieStrength: 0.5,
    });
    expect(high).toBeGreaterThan(low);
  });
});

describe("更新 (updateConversationSatisfaction)", () => {
  const NEUTRAL = {
    config: CONFIG,
    previousSatisfaction: 0.5,
    lastObservedMemberCount: CONFIG.preferredConversationSize,
    observedMemberCount: CONFIG.preferredConversationSize,
    cliqueRatio: 0,
    existingTieStrength: 0,
  };

  it("常に[0,1]へ収まる(大人数でもNaN/Infinityにならない)", () => {
    for (const memberCount of [1, 2, 4, 100, 100000]) {
      const result = updateConversationSatisfaction({
        ...NEUTRAL,
        lastObservedMemberCount: memberCount,
        observedMemberCount: memberCount,
      });
      expect(Number.isFinite(result.nextSatisfaction)).toBe(true);
      expect(result.nextSatisfaction).toBeGreaterThanOrEqual(0);
      expect(result.nextSatisfaction).toBeLessThanOrEqual(1);
    }
  });

  it("同一入力からは同一出力になる(純粋関数)", () => {
    expect(updateConversationSatisfaction(NEUTRAL)).toEqual(updateConversationSatisfaction(NEUTRAL));
  });

  it("時間経過だけ(人数・clique構成が変化しない)なら満足度は不意に増加しない", () => {
    let satisfaction = 0.5;
    for (let i = 0; i < 10; i++) {
      const result = updateConversationSatisfaction({ ...NEUTRAL, previousSatisfaction: satisfaction });
      expect(result.nextSatisfaction).toBeLessThanOrEqual(satisfaction);
      satisfaction = result.nextSatisfaction;
    }
  });

  it("decayを大きくすると、同じ状態で満足度低下が速くなる", () => {
    const slow = updateConversationSatisfaction({ ...NEUTRAL, config: withConfig({ satisfactionDecayPerTick: 0.01 }) });
    const fast = updateConversationSatisfaction({ ...NEUTRAL, config: withConfig({ satisfactionDecayPerTick: 0.05 }) });
    expect(fast.nextSatisfaction).toBeLessThan(slow.nextSatisfaction);
  });

  it("新規member boostが0なら参加者増加による回復がない", () => {
    const config = withConfig({ newMemberFreshnessBoost: 0, satisfactionDecayPerTick: 0 });
    const result = updateConversationSatisfaction({
      ...NEUTRAL,
      config,
      lastObservedMemberCount: 2,
      observedMemberCount: 5,
    });
    expect(result.newMemberContribution).toBe(0);
  });

  it("boostが正なら、参加者増加が上限内で満足度を回復させる", () => {
    const config = withConfig({ newMemberFreshnessBoost: 0.05, maxNewMemberBoostPerTick: 1, satisfactionDecayPerTick: 0 });
    const result = updateConversationSatisfaction({
      ...NEUTRAL,
      config,
      lastObservedMemberCount: 2,
      observedMemberCount: 3,
    });
    expect(result.newMemberContribution).toBeCloseTo(0.05, 10);
    expect(result.nextSatisfaction).toBeGreaterThan(NEUTRAL.previousSatisfaction);
  });

  it("同一tickの複数joinでも newMemberContribution が上限(maxNewMemberBoostPerTick)を超えない", () => {
    const config = withConfig({ newMemberFreshnessBoost: 0.2, maxNewMemberBoostPerTick: 0.15, satisfactionDecayPerTick: 0 });
    const result = updateConversationSatisfaction({
      ...NEUTRAL,
      config,
      lastObservedMemberCount: 2,
      observedMemberCount: 10, // 8人が同時に加わった想定
    });
    expect(result.newMemberContribution).toBe(0.15);
  });

  it("満足度は1を超えてクランプされる(合算がどれだけ大きくても)", () => {
    const config = withConfig({ newMemberFreshnessBoost: 5, maxNewMemberBoostPerTick: 5, satisfactionDecayPerTick: 0 });
    const result = updateConversationSatisfaction({
      ...NEUTRAL,
      config,
      previousSatisfaction: 0.95,
      lastObservedMemberCount: 1,
      observedMemberCount: 10,
    });
    expect(result.nextSatisfaction).toBe(1);
  });

  it("existingTieStrength=0ではclique寄与が常に0になる", () => {
    const result = updateConversationSatisfaction({ ...NEUTRAL, cliqueRatio: 1, existingTieStrength: 0 });
    expect(result.cliqueContribution).toBe(0);
  });

  it("member離脱による人数減少は、次回のsizeContribution(departure/size項)に反映される", () => {
    // preferredより多い人数から、preferredちょうどまで減った場合、sizeContributionのペナルティが縮む
    const configNoDecay = withConfig({ satisfactionDecayPerTick: 0 });
    const before = updateConversationSatisfaction({
      ...NEUTRAL,
      config: configNoDecay,
      lastObservedMemberCount: CONFIG.preferredConversationSize + 4,
      observedMemberCount: CONFIG.preferredConversationSize + 4,
    });
    const after = updateConversationSatisfaction({
      ...NEUTRAL,
      config: configNoDecay,
      lastObservedMemberCount: CONFIG.preferredConversationSize,
      observedMemberCount: CONFIG.preferredConversationSize,
    });
    expect(after.sizeContribution).toBeGreaterThan(before.sizeContribution);
  });

  it("Issue #233 (Phase 5): topicContribution未指定なら常に0で、既存式と同一結果になる(受入条件)", () => {
    const withoutTopic = updateConversationSatisfaction(NEUTRAL);
    const withUndefinedTopic = updateConversationSatisfaction({ ...NEUTRAL, topicContribution: undefined });
    expect(withoutTopic.topicContribution).toBe(0);
    expect(withUndefinedTopic).toEqual(withoutTopic);
  });

  it("Issue #233 (Phase 5): topicContributionが指定されればnextSatisfactionへ加算される(同一状態でtopic一致のみ差替え)", () => {
    const positive = updateConversationSatisfaction({ ...NEUTRAL, topicContribution: 0.08 });
    const negative = updateConversationSatisfaction({ ...NEUTRAL, topicContribution: -0.08 });
    const neutral = updateConversationSatisfaction(NEUTRAL);
    expect(positive.nextSatisfaction).toBeGreaterThan(neutral.nextSatisfaction);
    expect(negative.nextSatisfaction).toBeLessThan(neutral.nextSatisfaction);
    expect(positive.topicContribution).toBe(0.08);
  });

  it("Issue #233 (Phase 5): topicContributionが極端でも満足度は[0,1]に収まる", () => {
    const result = updateConversationSatisfaction({ ...NEUTRAL, previousSatisfaction: 0.05, topicContribution: -10 });
    expect(result.nextSatisfaction).toBe(0);
    const resultHigh = updateConversationSatisfaction({ ...NEUTRAL, previousSatisfaction: 0.95, topicContribution: 10 });
    expect(resultHigh.nextSatisfaction).toBe(1);
  });
});

describe("validateConversationSatisfactionConfig", () => {
  it("既定設定は検証を通る", () => {
    expect(() => validateConversationSatisfactionConfig(CONFIG)).not.toThrow();
  });

  it.each([
    ["initialConversationSatisfaction", NaN],
    ["initialConversationSatisfaction", Infinity],
    ["initialConversationSatisfaction", -0.1],
    ["initialConversationSatisfaction", 1.1],
    ["satisfactionDecayPerTick", -0.01],
    ["satisfactionDecayPerTick", NaN],
    ["newMemberFreshnessBoost", -1],
    ["maxNewMemberBoostPerTick", -1],
    ["preferredConversationSize", 0],
    ["preferredConversationSize", -1],
    ["preferredConversationSize", Infinity],
    ["sizeMismatchPenaltyCap", -0.1],
    ["cliqueCorrectionCap", -0.1],
  ] as const)("%s = %p を拒否する", (key, value) => {
    expect(() => validateConversationSatisfactionConfig(withConfig({ [key]: value }))).toThrow();
  });
});

describe("computeCliqueMateRatio", () => {
  const agents: Agent[] = [
    { id: "a", cliqueId: 1 } as Agent,
    { id: "b", cliqueId: 1 } as Agent,
    { id: "c", cliqueId: 2 } as Agent,
    { id: "d" } as Agent,
  ];

  it("cliqueId未設定のagentは常に0", () => {
    expect(computeCliqueMateRatio("d", undefined, ["a", "b", "d"], agents)).toBe(0);
  });

  it("自分自身を分母・分子から除外する", () => {
    // memberIds = 自分(a) + b(同clique) + c(別clique) -> 自分を除いた2人のうち1人が同clique
    expect(computeCliqueMateRatio("a", 1, ["a", "b", "c"], agents)).toBeCloseTo(0.5, 10);
  });

  it("自分以外にmemberがいなければ0", () => {
    expect(computeCliqueMateRatio("a", 1, ["a"], agents)).toBe(0);
  });
});

// --- engine結線(Issue #187): standingPartyでのみ満足度が計算され、二次会・学校には波及しない ---

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
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
  return {
    id: "group-1",
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

describe("engine結線: standingPartyのみに作用する", () => {
  it("afterParty/classroomPairではconversationSatisfactionが計算されない(既存挙動維持)", () => {
    for (const scenarioId of ["afterParty", "classroomPair"] as const) {
      const candidate = makeCandidate({ id: "group-1", memberIds: ["existing-member"] });
      const agent = makeAgent({ id: "member-0", state: "approaching", joinedGroupId: "group-1" });
      const state = makeState({ tick: 5, agents: [agent], groupCandidates: [candidate], formationScenarioId: scenarioId });
      const rng = new SeededRandom(1);
      const next = stepSimulation(
        state,
        DEFAULT_PARAMS,
        rng,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { scenarioId },
      );
      const joined = next.agents.find((a) => a.id === "member-0");
      if (joined?.state === "joined") {
        expect(joined.currentEpisode?.conversationSatisfaction).toBeUndefined();
      }
    }
  });

  it("新規member参加による回復は、参加したその場のtickではなく次tickの更新から反映される", () => {
    const candidate = makeCandidate({ id: "group-1", memberIds: ["member-0"] });
    const member0 = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-1",
      clusterJoinedAtTick: 0,
      currentEpisode: {
        episodeId: "member-0:group-1:0",
        clusterId: "group-1",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 1,
        lastObservedMemberCount: 1,
        conversationSatisfaction: initializeConversationSatisfaction({
          config: CONFIG,
          memberCountAtJoin: 1,
          cliqueRatio: 0,
          existingTieStrength: DEFAULT_PARAMS.existingTieStrength,
        }),
      },
    });
    let state = makeState({ tick: 0, agents: [member0], groupCandidates: [candidate], formationScenarioId: "standingParty" });
    const rng = new SeededRandom(5);
    const formation = { scenarioId: "standingParty" as const };

    // member-0の滞在時間を進め、経過による自然減衰を先に発生させておく。
    for (let i = 0; i < 3; i++) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
    }
    const beforeArrival = state.agents.find((a) => a.id === "member-0")!.currentEpisode!.conversationSatisfaction!;

    // 新規memberを候補へ直接到着させて合流させる。
    state = {
      ...state,
      agents: [
        ...state.agents.map((a) => (a.id === "member-0" ? a : a)),
        makeAgent({ id: "member-1", state: "approaching", joinedGroupId: "group-1", x: candidate.x, y: candidate.y }),
      ],
    };
    const arrivalTick = state.tick;
    state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
    expect(state.agents.find((a) => a.id === "member-1")!.state).toBe("joined");

    // 合流したそのtickでは、member-0の満足度はまだ新規member参加を織り込まない(次tickまで反映しない)。
    const sameTickValue = state.agents.find((a) => a.id === "member-0")!.currentEpisode!.conversationSatisfaction!;
    expect(sameTickValue).toBeLessThanOrEqual(beforeArrival);

    // 次tickの更新でようやく新鮮さ回復が反映される。
    state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
    const nextTickValue = state.agents.find((a) => a.id === "member-0")!.currentEpisode!.conversationSatisfaction!;
    expect(nextTickValue).toBeGreaterThan(sameTickValue);
    expect(arrivalTick).toBeLessThan(state.tick);
  });

  it("同一seed・同一設定なら満足度系列が再現される(決定的)", () => {
    function run(): number[] {
      const candidate = makeCandidate({ id: "group-1", memberIds: ["member-0", "member-1"] });
      const agents = [
        makeAgent({ id: "member-0", state: "joined", joinedGroupId: "group-1", clusterJoinedAtTick: 0, cliqueId: 1 }),
        makeAgent({ id: "member-1", state: "joined", joinedGroupId: "group-1", clusterJoinedAtTick: 0, cliqueId: 1 }),
      ];
      let state = makeState({ tick: 0, agents, groupCandidates: [candidate], formationScenarioId: "standingParty" });
      const rng = new SeededRandom(42);
      const values: number[] = [];
      for (let i = 0; i < 8; i++) {
        state = stepSimulation(
          state,
          DEFAULT_PARAMS,
          rng,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { scenarioId: "standingParty" },
        );
        const found = state.agents.find((a) => a.id === "member-0");
        if (found?.currentEpisode?.conversationSatisfaction !== undefined) {
          values.push(found.currentEpisode.conversationSatisfaction);
        }
      }
      return values;
    }

    expect(run()).toEqual(run());
  });

  it("Inspector(buildAgentInspection)を毎tick呼んでも、その後の満足度系列は変わらない", () => {
    function run(withInspection: boolean): number[] {
      const candidate = makeCandidate({ id: "group-1", memberIds: ["member-0", "member-1"] });
      const agents = [
        makeAgent({ id: "member-0", state: "joined", joinedGroupId: "group-1", clusterJoinedAtTick: 0 }),
        makeAgent({ id: "member-1", state: "joined", joinedGroupId: "group-1", clusterJoinedAtTick: 0 }),
      ];
      let state = makeState({ tick: 0, agents, groupCandidates: [candidate], formationScenarioId: "standingParty" });
      const rng = new SeededRandom(9);
      const values: number[] = [];
      for (let i = 0; i < 6; i++) {
        if (withInspection) buildAgentInspection(state, DEFAULT_PARAMS);
        state = stepSimulation(
          state,
          DEFAULT_PARAMS,
          rng,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { scenarioId: "standingParty" },
        );
        if (withInspection) buildAgentInspection(state, DEFAULT_PARAMS);
        const found = state.agents.find((a) => a.id === "member-0");
        values.push(found?.currentEpisode?.conversationSatisfaction ?? -1);
      }
      return values;
    }

    expect(run(true)).toEqual(run(false));
  });
});

describe("createInitialState連携", () => {
  it("standingPartyの初期agentは未所属なのでconversationSatisfactionを持たない", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
    });
    for (const agent of state.agents) {
      expect(agent.currentEpisode).toBeUndefined();
    }
  });
});
