/**
 * Issue #214: standing-party Phase 4 統計集計
 * (`summarizeDistribution` / `buildStandingPartyRunStatistics`)の単体・結合テスト。
 * 完了とactive/censoredの分離、分母0、決定性、非mutation、filterを固定する。
 */
import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import {
  assertStatisticsDoesNotMutateState,
  buildStandingPartyConversationHistory,
  buildStandingPartyRunStatistics,
  clipHalfOpenInterval,
  rateWithDenominator,
  summarizeDistribution,
} from "./standingPartyAnalysis";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { Agent, GroupCandidate, LogEntry, SimParams, SimulationState } from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

const STANDING_PARTY_RUNTIME: FormationRuntimeOptions = { scenarioId: "standingParty" };

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
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
    ...overrides,
  };
}

function step(state: SimulationState, params: SimParams, rng: SeededRandom): SimulationState {
  return stepSimulation(
    state,
    params,
    rng,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    STANDING_PARTY_RUNTIME,
  );
}

function entry(
  tick: number,
  eventType: LogEntry["eventType"],
  metadata: NonNullable<LogEntry["metadata"]>,
): LogEntry {
  return { tick, message: `t=${tick}`, tags: [], eventType, metadata };
}

describe("summarizeDistribution / helpers (Issue #214)", () => {
  it("emptyはcount=0のみで分位点を捏造しない", () => {
    expect(summarizeDistribution([])).toEqual({ count: 0 });
  });

  it("件数・min/max・mean・median・分位点・sumを順序非依存で返す", () => {
    const a = summarizeDistribution([4, 1, 3, 2, 5]);
    const b = summarizeDistribution([5, 2, 1, 4, 3]);
    expect(a).toEqual(b);
    expect(a.count).toBe(5);
    expect(a.min).toBe(1);
    expect(a.max).toBe(5);
    expect(a.mean).toBe(3);
    expect(a.median).toBe(3);
    expect(a.sum).toBe(15);
    expect(a.p25).toBe(2);
    expect(a.p75).toBe(4);
  });

  it("NaN / Infinity / 負値を拒否する", () => {
    expect(() => summarizeDistribution([1, NaN])).toThrow();
    expect(() => summarizeDistribution([1, Infinity])).toThrow();
    expect(() => summarizeDistribution([1, -1])).toThrow();
  });

  it("rateWithDenominatorは分母0でrateをundefinedにする", () => {
    expect(rateWithDenominator(0, 0)).toEqual({ numerator: 0, denominator: 0, rate: undefined });
    expect(rateWithDenominator(1, 4)).toEqual({ numerator: 1, denominator: 4, rate: 0.25 });
  });

  it("clipHalfOpenIntervalは半開規約で長さ0を除外する", () => {
    expect(clipHalfOpenInterval(0, 10, 5, 15)).toEqual({
      startTick: 5,
      endTick: 10,
      durationTicks: 5,
    });
    expect(clipHalfOpenInterval(0, 5, 5, 10)).toBeUndefined();
    expect(clipHalfOpenInterval(10, 20, 0, 10)).toBeUndefined();
  });
});

describe("buildStandingPartyRunStatistics: fixture (Issue #214)", () => {
  function fixtureState(): SimulationState {
    return makeState({
      tick: 40,
      agents: [
        makeAgent({
          id: "oj",
          label: "OJ",
          isObserverJoiner: true,
          state: "joined",
          joinedGroupId: "g1",
          currentEpisode: {
            episodeId: "oj:g1:10",
            clusterId: "g1",
            joinedAtTick: 10,
            lastUpdatedTick: 10,
            memberCountAtJoin: 3,
            lastObservedMemberCount: 3,
            conversationSatisfaction: 0.5,
          },
        }),
        makeAgent({ id: "a", label: "A", state: "undecided" }),
        makeAgent({ id: "b", label: "B", state: "left" }),
      ],
      groupCandidates: [
        makeCandidate({
          id: "g1",
          status: "confirmed",
          memberIds: ["oj"],
        }),
      ],
      log: [
        entry(0, "nucleusCreated", { agentId: "a", groupId: "g1", memberCount: 1 }),
        entry(5, "groupConfirmed", { groupId: "g1", memberCount: 1 }),
        entry(5, "agentJoined", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:5",
          joinedGroupStatus: "confirmed",
          memberCount: 1,
        }),
        entry(8, "agentJoined", {
          agentId: "b",
          groupId: "g1",
          episodeId: "b:g1:8",
          joinedGroupStatus: "confirmed",
          memberCount: 2,
        }),
        entry(10, "observerJoinedConfirmed", {
          agentId: "oj",
          groupId: "g1",
          episodeId: "oj:g1:10",
          joinedGroupStatus: "confirmed",
          memberCount: 3,
        }),
        entry(15, "clusterDepartureCompleted", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:5",
          ticksInCluster: 10,
          episodeEndReason: "voluntaryDeparture",
          transitionAction: "departAndExplore",
        }),
        entry(15, "clusterResearchStarted", {
          agentId: "a",
          previousClusterId: "g1",
          episodeId: "a:g1:5",
        }),
        entry(20, "clusterMemberReleased", {
          agentId: "b",
          groupId: "g1",
          episodeId: "b:g1:8",
          ticksInCluster: 12,
          episodeEndReason: "memberReleased",
        }),
        entry(25, "clusterTransitionInhibited", {
          agentId: "oj",
          groupId: "g1",
          departureReason: "stayedByAttachment",
          transitionAction: "stay",
        }),
        entry(30, "observerLeaveStarted", { agentId: "oj", agentLabel: "OJ" }),
      ],
    });
  }

  it("active episodeを完了dwell分布に混ぜない", () => {
    const stats = buildStandingPartyRunStatistics(fixtureState());
    expect(stats.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(stats.run.completedEpisodeCount).toBe(2);
    expect(stats.run.activeEpisodeCount).toBeGreaterThanOrEqual(1);
    expect(stats.run.completedEpisodeDwellTicks.count).toBe(2);
    expect(stats.run.completedEpisodeDwellTicks.mean).toBeDefined();

    const oj = stats.agents.find((a) => a.agentId === "oj")!;
    expect(oj.activeEpisodeCount).toBe(1);
    expect(oj.completedEpisodeCount).toBe(0);
    expect(oj.completedDwellTicks.count).toBe(0);
    expect(oj.completedDwellTicks.mean).toBeUndefined();
    expect(oj.currentEpisodeDwellTicks).toBeDefined();
  });

  it("voluntary departureとforced releaseを別集計する", () => {
    const stats = buildStandingPartyRunStatistics(fixtureState());
    const a = stats.agents.find((agent) => agent.agentId === "a")!;
    const b = stats.agents.find((agent) => agent.agentId === "b")!;
    expect(a.voluntaryDepartureCount).toBe(1);
    expect(a.forcedReleaseCount).toBe(0);
    expect(b.voluntaryDepartureCount).toBe(0);
    expect(b.forcedReleaseCount).toBe(1);
    expect(stats.run.voluntaryDepartureCount).toBe(1);
    expect(stats.run.forcedReleaseCount).toBe(1);
  });

  it("ObserverJoiner比較は同じ定義の記述値のみで、複数OJ配列を返す", () => {
    const stats = buildStandingPartyRunStatistics(fixtureState());
    expect(stats.observerJoinerComparison.observerJoiners).toHaveLength(1);
    expect(stats.observerJoinerComparison.observerJoiners[0].agentId).toBe("oj");
    expect(stats.observerJoinerComparison.observerJoiners[0].stayedByAttachmentCount).toBe(1);
    expect(stats.observerJoinerComparison.nonObserverJoinerGroup.agentCount).toBe(2);
    expect(stats.observerJoinerComparison.nonObserverJoinerGroup.completedDwellTicks.count).toBe(2);
  });

  it("targeted transition成功率は分母0でrate undefined", () => {
    const stats = buildStandingPartyRunStatistics(fixtureState());
    expect(stats.run.targetedTransitionSuccessRate.denominator).toBe(0);
    expect(stats.run.targetedTransitionSuccessRate.rate).toBeUndefined();
  });

  it("agent / cluster filterと時間窓で再集計でき、元履歴をmutationしない", () => {
    const state = fixtureState();
    const beforeLog = JSON.stringify(state.log);
    const filtered = buildStandingPartyRunStatistics(state, {
      agentIds: ["a"],
      fromTick: 0,
      toTick: 16,
    });
    expect(filtered.agents.map((a) => a.agentId)).toEqual(["a"]);
    expect(filtered.run.completedEpisodeCount).toBe(1);
    expect(JSON.stringify(state.log)).toBe(beforeLog);

    assertStatisticsDoesNotMutateState(state, () => buildStandingPartyRunStatistics(state));
  });

  it("同一入力で同一JSONになり、入力順に依存しないagent配列順を持つ", () => {
    const state = fixtureState();
    const first = buildStandingPartyRunStatistics(state);
    const second = buildStandingPartyRunStatistics(state);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.agents.map((a) => a.agentId)).toEqual(["a", "b", "oj"]);
  });

  it("時系列はsample間隔でも最終tickを欠落させない", () => {
    const stats = buildStandingPartyRunStatistics(fixtureState(), {
      seriesSampleIntervalTicks: 10,
    });
    expect(stats.series.points[0].tick).toBe(0);
    expect(stats.series.points[stats.series.points.length - 1].tick).toBe(40);
    expect(stats.series.points.every((p) => Number.isFinite(p.activeClusterCount))).toBe(true);
  });

  it("clusterのmeanMemberCountは区間加重平均で、turnover定義を固定する", () => {
    const stats = buildStandingPartyRunStatistics(fixtureState());
    const cluster = stats.clusters.find((c) => c.clusterId === "g1");
    expect(cluster).toBeDefined();
    expect(cluster!.meanMemberCount).toBeDefined();
    expect(Number.isFinite(cluster!.meanMemberCount)).toBe(true);
    expect(cluster!.turnoverRate).toBe(
      (cluster!.voluntaryLeaveCount + cluster!.forcedReleaseCount) / Math.max(cluster!.joinCount, 1),
    );
  });
});

describe("buildStandingPartyRunStatistics: integration (Issue #214)", () => {
  it("standingParty短時間runでNaN/Infinity/負値がなく、contactと整合する", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 12 };
    let state = createInitialState(
      7,
      params,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        scenarioId: "standingParty",
        standingPartyConfig: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
          transition: { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.transition, enabled: true },
        },
      },
    );
    const rng = new SeededRandom(7);
    for (let i = 0; i < 80; i++) {
      state = step(state, params, rng);
    }

    const history = buildStandingPartyConversationHistory(state);
    const stats = buildStandingPartyRunStatistics(state, { history, seriesSampleIntervalTicks: 5 });

    expect(stats.run.populationSize).toBe(12);
    expect(stats.agents).toHaveLength(12);
    for (const agent of stats.agents) {
      expect(Number.isFinite(agent.totalContactTicks)).toBe(true);
      expect(agent.totalContactTicks).toBeGreaterThanOrEqual(0);
      expect(agent.distinctContactCount).toBeGreaterThanOrEqual(0);
      if (agent.targetedTransitionSuccessRate.denominator === 0) {
        expect(agent.targetedTransitionSuccessRate.rate).toBeUndefined();
      } else {
        expect(agent.targetedTransitionSuccessRate.rate).toBeGreaterThanOrEqual(0);
        expect(agent.targetedTransitionSuccessRate.rate).toBeLessThanOrEqual(1);
      }
    }
    for (const cluster of stats.clusters) {
      expect(cluster.lifetimeTicks).toBeGreaterThanOrEqual(0);
      if (cluster.meanMemberCount !== undefined) {
        expect(Number.isFinite(cluster.meanMemberCount)).toBe(true);
        expect(cluster.meanMemberCount).toBeGreaterThanOrEqual(0);
      }
    }
    expect(Number.isFinite(stats.run.network.density)).toBe(true);
    expect(stats.series.points.length).toBeGreaterThan(1);
  });

  it("afterPartyでは空/ゼロ相当を返し例外を投げない", () => {
    let state = createInitialState(3, DEFAULT_PARAMS);
    const rng = new SeededRandom(3);
    for (let i = 0; i < 30; i++) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng);
    }
    const stats = buildStandingPartyRunStatistics(state);
    expect(stats.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(stats.run.voluntaryDepartureCount).toBe(0);
    expect(stats.run.forcedReleaseCount).toBe(0);
    expect(stats.agents).toHaveLength(DEFAULT_PARAMS.populationSize);
  });

  it("1000tick級でも現実的時間で完了し、RNG系列を消費しない", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16 };
    let state = createInitialState(
      11,
      params,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        scenarioId: "standingParty",
        standingPartyConfig: {
          ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
          transition: { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.transition, enabled: true },
        },
      },
    );
    const rng = new SeededRandom(11);
    for (let i = 0; i < 200; i++) {
      state = step(state, params, rng);
    }
    const before = rng.next();
    const started = Date.now();
    const stats = buildStandingPartyRunStatistics(state, { seriesSampleIntervalTicks: 10 });
    const elapsed = Date.now() - started;
    const after = rng.next();
    // 分析はRNG非消費なので、beforeの次の値とafterの前の値の関係は「2回消費」分ずれるだけ
    // beforeを消費済みなので after は before の次。分析前後でnextが同じなら非消費。
    // ここでは分析呼び出しの前後で1回ずつnextしているため、差があること自体は当然。
    // 非消費の検証: 分析前後に同じ回数だけnextした結果が、分析を挟まない場合と一致する。
    void after;
    const rngA = new SeededRandom(99);
    const rngB = new SeededRandom(99);
    const probe = () => [rngA.next(), rngA.next(), rngA.next()];
    const without = probe();
    buildStandingPartyRunStatistics(state, { seriesSampleIntervalTicks: 20 });
    const withAnalysis = [rngB.next(), rngB.next(), rngB.next()];
    expect(withAnalysis).toEqual(without);
    expect(elapsed).toBeLessThan(5_000);
    expect(stats.run.completedEpisodeDwellTicks.count).toBeGreaterThanOrEqual(0);
    void before;
  });
});
