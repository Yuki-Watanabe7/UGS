import { describe, expect, it } from "vitest";
import {
  computeDepartureInhibition,
  DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
  evaluateClusterDissolutionImpact,
  initializeAttachment,
  isRecentMemberJoin,
  updateAttachment,
  validateCurrentClusterAttachmentConfig,
  type CurrentClusterAttachmentConfig,
  type CurrentClusterAttachmentState,
} from "./currentClusterAttachment";
import { buildAgentInspection } from "./inspection";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, GroupCandidate, SimulationState } from "./types";

const CONFIG = DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG;

function withConfig(overrides: Partial<CurrentClusterAttachmentConfig>): CurrentClusterAttachmentConfig {
  return { ...CONFIG, ...overrides };
}

describe("初期化 (initializeAttachment)", () => {
  it("valueをconfig.initialAttachmentへ、各tickフィールドをjoin tickへ初期化する", () => {
    const state = initializeAttachment({ config: CONFIG, tick: 7, memberIds: ["a", "b"] });
    expect(state.value).toBe(CONFIG.initialAttachment);
    expect(state.initializedAtTick).toBe(7);
    expect(state.lastUpdatedAtTick).toBe(7);
    expect(state.lastMemberArrivalAtTick).toBe(7);
    expect(state.lastObservedMemberCount).toBe(2);
    expect(state.foundingMemberIds).toEqual(["a", "b"]);
    expect(state.lastFoundingPresentCount).toBe(2);
  });

  it("foundingMemberIdsは渡した配列のコピーであり、呼び出し側の配列変更の影響を受けない", () => {
    const memberIds = ["a", "b"];
    const state = initializeAttachment({ config: CONFIG, tick: 0, memberIds });
    memberIds.push("c");
    expect(state.foundingMemberIds).toEqual(["a", "b"]);
  });

  it("同一clusterへの再参加でも、新しいepisodeとして毎回独立に初期化される(前回値を継承しない)", () => {
    const first = initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a"] });
    // 前回values(高い滞在等)を模してから再度初期化しても、常に同じ初期値へ戻る
    const advanced: CurrentClusterAttachmentState = { ...first, value: 0.9 };
    const rejoined = initializeAttachment({ config: CONFIG, tick: 50, memberIds: ["a", "x"] });
    expect(advanced.value).toBe(0.9); // 前回参照はここでは変更していないことの確認(参照独立性)
    expect(rejoined.value).toBe(CONFIG.initialAttachment);
  });
});

describe("更新 (updateAttachment)", () => {
  it("member構成が変化しない限り、滞在tickが増えるほど愛着は単調に増加する(受入条件)", () => {
    let state = initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a", "b"] });
    let tick = 0;
    const values: number[] = [state.value];
    for (let i = 0; i < 20; i++) {
      tick += 1;
      const result = updateAttachment({ config: CONFIG, previous: state, tick, observedMemberIds: ["a", "b"] });
      expect(result.turnoverContribution).toBe(0);
      expect(result.dilutionContribution).toBe(0);
      state = result.next;
      values.push(state.value);
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it("maxAttachmentで飽和し、無制限には増えない", () => {
    let state = initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a"] });
    let tick = 0;
    for (let i = 0; i < 500; i++) {
      tick += 1;
      state = updateAttachment({ config: CONFIG, previous: state, tick, observedMemberIds: ["a"] }).next;
    }
    expect(state.value).toBeCloseTo(CONFIG.maxAttachment, 10);
    expect(state.value).toBeLessThanOrEqual(CONFIG.maxAttachment);
  });

  it("founding memberが減ると、そのtickに限りturnover由来の損失が発生する(edge-triggered)", () => {
    let state = initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a", "b", "c"] });
    // 誰も欠けていないtickをいくつか進める
    for (let t = 1; t <= 3; t++) {
      state = updateAttachment({ config: CONFIG, previous: state, tick: t, observedMemberIds: ["a", "b", "c"] }).next;
    }
    const beforeDeparture = state.value;

    // bが欠ける(turnoverが発生するtick)
    const departureResult = updateAttachment({ config: CONFIG, previous: state, tick: 4, observedMemberIds: ["a", "c"] });
    expect(departureResult.turnoverContribution).toBeLessThan(0);
    state = departureResult.next;
    expect(state.value).toBeLessThan(beforeDeparture + CONFIG.attachmentGrowthPerTick);

    // 以後member構成が変化しなければ、同じ欠員が続いていてもturnover寄与は再発しない(同一条件下での不意の低下がない)
    const stableResult = updateAttachment({ config: CONFIG, previous: state, tick: 5, observedMemberIds: ["a", "c"] });
    expect(stableResult.turnoverContribution).toBe(0);
    expect(stableResult.nextValue).toBeGreaterThanOrEqual(state.value);
  });

  it("新規memberの参加は、そのtickに限り希釈由来の損失を生む(edge-triggered)", () => {
    let state = initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a"] });
    for (let t = 1; t <= 3; t++) {
      state = updateAttachment({ config: CONFIG, previous: state, tick: t, observedMemberIds: ["a"] }).next;
    }
    const before = state.value;

    const arrivalResult = updateAttachment({ config: CONFIG, previous: state, tick: 4, observedMemberIds: ["a", "b"] });
    expect(arrivalResult.dilutionContribution).toBeLessThan(0);
    state = arrivalResult.next;
    expect(state.value).toBeLessThan(before + CONFIG.attachmentGrowthPerTick);

    const stableResult = updateAttachment({ config: CONFIG, previous: state, tick: 5, observedMemberIds: ["a", "b"] });
    expect(stableResult.dilutionContribution).toBe(0);
  });

  it("同一tickで複数回呼んでも(呼び出し側の責務だが)、各回は独立して決定的な結果を返す", () => {
    const state = initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a"] });
    const first = updateAttachment({ config: CONFIG, previous: state, tick: 1, observedMemberIds: ["a"] });
    const second = updateAttachment({ config: CONFIG, previous: state, tick: 1, observedMemberIds: ["a"] });
    expect(first.nextValue).toBe(second.nextValue);
  });

  it("結果はconfig.maxAttachmentを超えず、0を下回らない", () => {
    const state = initializeAttachment({
      config: withConfig({ initialAttachment: 0 }),
      tick: 0,
      memberIds: ["a", "b", "c", "d"],
    });
    // 一度に全員入れ替わる極端なケースでも[0, maxAttachment]に収まる
    const result = updateAttachment({
      config: withConfig({ initialAttachment: 0, memberTurnoverAttachmentLoss: 1 }),
      previous: state,
      tick: 1,
      observedMemberIds: [],
    });
    expect(result.nextValue).toBeGreaterThanOrEqual(0);
    expect(result.nextValue).toBeLessThanOrEqual(CONFIG.maxAttachment);
  });
});

describe("isRecentMemberJoin", () => {
  it("windowTicks以内はtrue、超えるとfalse", () => {
    const state = initializeAttachment({ config: CONFIG, tick: 10, memberIds: ["a"] });
    expect(isRecentMemberJoin(state, 10, CONFIG)).toBe(true);
    expect(isRecentMemberJoin(state, 10 + CONFIG.recentMemberJoinedWindowTicks, CONFIG)).toBe(true);
    expect(isRecentMemberJoin(state, 10 + CONFIG.recentMemberJoinedWindowTicks + 1, CONFIG)).toBe(false);
  });
});

describe("cluster解散影響 (evaluateClusterDissolutionImpact)", () => {
  it("成立最小人数を割り込み、confirmed・mutable・everConfirmedが揃うとwouldDissolve", () => {
    const impact = evaluateClusterDissolutionImpact({
      memberIds: ["a", "b", "c"],
      minGroupSize: 3,
      confirmedClusterIsMutable: true,
      candidateStatus: "confirmed",
      everConfirmed: true,
    });
    expect(impact.memberCountAfterDeparture).toBe(2);
    expect(impact.wouldFallBelowMinimum).toBe(true);
    expect(impact.wouldDissolve).toBe(true);
    expect(impact.releasedMemberCount).toBe(2);
  });

  it("confirmedClusterIsMutable=falseの既存シナリオ(afterParty/classroomPair)では常にfalse", () => {
    const impact = evaluateClusterDissolutionImpact({
      memberIds: ["a", "b", "c"],
      minGroupSize: 3,
      confirmedClusterIsMutable: false,
      candidateStatus: "confirmed",
      everConfirmed: true,
    });
    expect(impact.wouldDissolve).toBe(false);
    expect(impact.releasedMemberCount).toBe(0);
  });

  it("forming/dissolving等confirmed以外のstatusでは常にfalse", () => {
    for (const candidateStatus of ["forming", "dissolving", "dissolved", "expired"] as const) {
      const impact = evaluateClusterDissolutionImpact({
        memberIds: ["a", "b"],
        minGroupSize: 3,
        confirmedClusterIsMutable: true,
        candidateStatus,
        everConfirmed: true,
      });
      expect(impact.wouldDissolve).toBe(false);
    }
  });

  it("近接ヒューリスティックによりまだeverConfirmedが立っていないconfirmed候補では常にfalse", () => {
    const impact = evaluateClusterDissolutionImpact({
      memberIds: ["a"],
      minGroupSize: 3,
      confirmedClusterIsMutable: true,
      candidateStatus: "confirmed",
      everConfirmed: false,
    });
    expect(impact.wouldFallBelowMinimum).toBe(true);
    expect(impact.wouldDissolve).toBe(false);
  });

  it("離脱後も成立最小人数を満たすならwouldDissolveはfalse", () => {
    const impact = evaluateClusterDissolutionImpact({
      memberIds: ["a", "b", "c", "d"],
      minGroupSize: 3,
      confirmedClusterIsMutable: true,
      candidateStatus: "confirmed",
      everConfirmed: true,
    });
    expect(impact.wouldDissolve).toBe(false);
    expect(impact.releasedMemberCount).toBe(0);
  });

  it("入力(memberIds)をmutationしない", () => {
    const memberIds = ["a", "b"];
    evaluateClusterDissolutionImpact({
      memberIds,
      minGroupSize: 3,
      confirmedClusterIsMutable: true,
      candidateStatus: "confirmed",
      everConfirmed: true,
    });
    expect(memberIds).toEqual(["a", "b"]);
  });
});

describe("離脱配慮の合成 (computeDepartureInhibition)", () => {
  const noImpact = evaluateClusterDissolutionImpact({
    memberIds: ["a", "b", "c", "d"],
    minGroupSize: 2,
    confirmedClusterIsMutable: true,
    candidateStatus: "confirmed",
    everConfirmed: true,
  });
  const dissolveImpact = evaluateClusterDissolutionImpact({
    memberIds: ["a", "b"],
    minGroupSize: 2,
    confirmedClusterIsMutable: true,
    candidateStatus: "confirmed",
    everConfirmed: true,
  });

  it("attachment未設定・構造的影響なし・influenceAvoidance未設定なら、全て0を返す", () => {
    const result = computeDepartureInhibition({
      config: CONFIG,
      attachment: undefined,
      tick: 10,
      dissolutionImpact: noImpact,
      influenceAvoidance: undefined,
    });
    expect(result.attachment).toBe(0);
    expect(result.concern).toBe(0);
    expect(result.total).toBe(0);
    expect(result.factors).toEqual([]);
  });

  it("愛着のみの寄与は attachmentInhibitionWeight を通じてtotalへ反映される", () => {
    const attachment = { ...initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a", "b"] }), value: 0.4 };
    const result = computeDepartureInhibition({
      config: CONFIG,
      attachment,
      tick: 100, // recentMemberJoinedWindowTicksを十分超え、recentJoin要因を排除する
      dissolutionImpact: noImpact,
      influenceAvoidance: 0,
    });
    expect(result.attachment).toBe(0.4);
    expect(result.concern).toBe(0);
    expect(result.total).toBeCloseTo(0.4 * CONFIG.attachmentInhibitionWeight, 10);
    expect(result.factors).toEqual([{ kind: "episodeAttachment", contribution: 0.4 * CONFIG.attachmentInhibitionWeight }]);
  });

  it("clusterWouldDissolveが立つとconcernへ寄与し、influenceAvoidanceがその寄与を増幅する(乗算)", () => {
    const withoutAvoidance = computeDepartureInhibition({
      config: CONFIG,
      attachment: undefined,
      tick: 0,
      dissolutionImpact: dissolveImpact,
      influenceAvoidance: 0,
    });
    const withAvoidance = computeDepartureInhibition({
      config: CONFIG,
      attachment: undefined,
      tick: 0,
      dissolutionImpact: dissolveImpact,
      influenceAvoidance: 1,
    });
    expect(withoutAvoidance.concern).toBeCloseTo(CONFIG.clusterWouldDissolveConcern, 10);
    expect(withAvoidance.concern).toBeGreaterThan(withoutAvoidance.concern);
    expect(withAvoidance.factors.some((f) => f.kind === "influenceAvoidance")).toBe(true);
    expect(withoutAvoidance.factors.some((f) => f.kind === "influenceAvoidance")).toBe(false);
  });

  it("influenceAvoidanceは構造的影響が存在しない場面(dissolveなし・recentJoinなし)では一切作用しない", () => {
    const attachment = { ...initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a"] }), value: 0.5 };
    const low = computeDepartureInhibition({
      config: CONFIG,
      attachment,
      tick: 100,
      dissolutionImpact: noImpact,
      influenceAvoidance: 0,
    });
    const high = computeDepartureInhibition({
      config: CONFIG,
      attachment,
      tick: 100,
      dissolutionImpact: noImpact,
      influenceAvoidance: 1,
    });
    expect(high.total).toBe(low.total);
    expect(high.factors.some((f) => f.kind === "influenceAvoidance")).toBe(false);
  });

  it("maxInhibitionにより、総抑制は上限で頭打ちになり1に張り付かない", () => {
    const config = withConfig({ attachmentInhibitionWeight: 1, clusterWouldDissolveConcern: 1, maxInhibition: 0.5 });
    const attachment = { ...initializeAttachment({ config, tick: 0, memberIds: ["a", "b"] }), value: 1 };
    const result = computeDepartureInhibition({
      config,
      attachment,
      tick: 0,
      dissolutionImpact: dissolveImpact,
      influenceAvoidance: 1,
    });
    expect(result.total).toBe(0.5);
    expect(result.total).toBeLessThan(1);
  });

  it("factorsはcontribution降順で並ぶ", () => {
    const attachment = { ...initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a"] }), value: 0.9 };
    const result = computeDepartureInhibition({
      config: CONFIG,
      attachment,
      tick: 0, // join直後なのでrecentJoinも立つ
      dissolutionImpact: dissolveImpact,
      influenceAvoidance: 0.8,
    });
    for (let i = 1; i < result.factors.length; i++) {
      expect(result.factors[i - 1].contribution).toBeGreaterThanOrEqual(result.factors[i].contribution);
    }
  });

  it("入力(dissolutionImpact/attachment)をmutationしない", () => {
    const attachment = initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["a"] });
    const before = { ...attachment };
    computeDepartureInhibition({
      config: CONFIG,
      attachment,
      tick: 0,
      dissolutionImpact: dissolveImpact,
      influenceAvoidance: 1,
    });
    expect(attachment).toEqual(before);
  });
});

describe("validateCurrentClusterAttachmentConfig", () => {
  it("既定設定は妥当", () => {
    expect(() => validateCurrentClusterAttachmentConfig(CONFIG)).not.toThrow();
  });

  it("initialAttachmentが[0,1]の範囲外なら拒否する", () => {
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ initialAttachment: -0.1 }))).toThrow();
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ initialAttachment: 1.1 }))).toThrow();
  });

  it("initialAttachment > maxAttachmentは拒否する", () => {
    expect(() =>
      validateCurrentClusterAttachmentConfig(withConfig({ initialAttachment: 0.9, maxAttachment: 0.5 })),
    ).toThrow();
  });

  it("maxInhibitionが1以上なら拒否する(完全ブロック禁止)", () => {
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ maxInhibition: 1 }))).toThrow();
  });

  it("負のattachmentGrowthPerTick/memberTurnoverAttachmentLoss/newMemberDilutionを拒否する", () => {
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ attachmentGrowthPerTick: -0.01 }))).toThrow();
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ memberTurnoverAttachmentLoss: -0.01 }))).toThrow();
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ newMemberDilution: -0.01 }))).toThrow();
  });

  it("非整数・負のrecentMemberJoinedWindowTicksを拒否する", () => {
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ recentMemberJoinedWindowTicks: 1.5 }))).toThrow();
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ recentMemberJoinedWindowTicks: -1 }))).toThrow();
  });

  it("NaN/Infinityを拒否する", () => {
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ attachmentGrowthPerTick: NaN }))).toThrow();
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ maxAttachment: Number.POSITIVE_INFINITY }))).toThrow();
  });

  it("influenceAvoidanceGainが[0,4]の範囲外なら拒否する", () => {
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ influenceAvoidanceGain: -0.1 }))).toThrow();
    expect(() => validateCurrentClusterAttachmentConfig(withConfig({ influenceAvoidanceGain: 4.1 }))).toThrow();
  });
});

// --- engine結線(Issue #199, ステップP3-B): standingPartyでのみ愛着が計算され、二次会・学校には波及しない ---

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
  it("afterParty/classroomPairではattachmentが計算されない(既存挙動維持)", () => {
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
        expect(joined.currentEpisode?.attachment).toBeUndefined();
      }
    }
  });

  it("standingPartyでは合流tickにconfig.initialAttachmentで初期化され、以後のtickで増加する", () => {
    const candidate = makeCandidate({ id: "group-1", memberIds: ["existing-member"] });
    const agent = makeAgent({ id: "member-0", state: "approaching", joinedGroupId: "group-1", x: candidate.x, y: candidate.y });
    let state = makeState({ tick: 0, agents: [agent], groupCandidates: [candidate], formationScenarioId: "standingParty" });
    const rng = new SeededRandom(3);
    const formation = { scenarioId: "standingParty" as const };

    state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
    const joined = state.agents.find((a) => a.id === "member-0")!;
    expect(joined.state).toBe("joined");
    expect(joined.currentEpisode?.attachment?.value).toBeCloseTo(DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG.initialAttachment, 10);

    const joinValue = joined.currentEpisode!.attachment!.value;
    for (let i = 0; i < 5; i++) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
    }
    const later = state.agents.find((a) => a.id === "member-0")!.currentEpisode?.attachment?.value;
    expect(later).toBeDefined();
    expect(later!).toBeGreaterThan(joinValue);
  });

  it("episode終了(離脱・所属先喪失)でattachment stateが残らない", () => {
    const candidate = makeCandidate({ id: "group-1", memberIds: ["member-0"], status: "dissolved" });
    const agent = makeAgent({
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
        attachment: initializeAttachment({ config: CONFIG, tick: 0, memberIds: ["member-0"] }),
      },
    });
    const state = makeState({ tick: 30, agents: [agent], groupCandidates: [candidate], formationScenarioId: "standingParty" });
    const rng = new SeededRandom(11);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
    });
    const after = next.agents.find((a) => a.id === "member-0")!;
    expect(after.state).toBe("undecided");
    expect(after.currentEpisode).toBeUndefined();
  });

  it("同一seed・同一設定なら愛着系列が再現される(決定的)", () => {
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
        if (found?.currentEpisode?.attachment?.value !== undefined) {
          values.push(found.currentEpisode.attachment.value);
        }
      }
      return values;
    }

    expect(run()).toEqual(run());
  });

  it("Inspector(buildAgentInspection)を毎tick呼んでも、その後の愛着系列は変わらない(非干渉)", () => {
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
        values.push(found?.currentEpisode?.attachment?.value ?? -1);
      }
      return values;
    }

    expect(run(true)).toEqual(run(false));
  });
});

describe("createInitialState連携", () => {
  it("standingPartyの初期agentは未所属なのでattachmentを持たない", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "standingParty",
    });
    for (const agent of state.agents) {
      expect(agent.currentEpisode?.attachment).toBeUndefined();
    }
  });
});
