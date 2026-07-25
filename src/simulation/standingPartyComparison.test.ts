import { describe, expect, it } from "vitest";
import { buildStandingPartyRunSummary, summarizeStandingPartyRuns } from "./standingPartyComparison";
import type { Agent, LogEntry, SimulationState } from "./types";

/**
 * Issue #190: standingPartyの比較指標集計(`standingPartyComparison.ts`)の単体テスト。
 * `pairFormation.test.ts`と同じ方針で、構造化イベント/agentフィールドから正しく集計できることを
 * 固定fixtureで検証する(実際のシミュレーション実行によるpaired比較は`standingPartyPresetComparison.test.ts`)。
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
    state: "undecided",
    stress: 0,
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
    ...overrides,
  };
}

function entry(overrides: Partial<LogEntry> & Pick<LogEntry, "eventType">): LogEntry {
  return {
    tick: 0,
    message: "",
    tags: [],
    ...overrides,
  };
}

describe("buildStandingPartyRunSummary: 自発離脱・強制release・再参加・異なるcluster参加数", () => {
  it("voluntaryDepartureCountとforcedReleaseCountを別々に数える(強制releaseを自発離脱として集計しない)", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a", label: "A", state: "undecided" })],
      log: [
        entry({ eventType: "nucleusCreated", metadata: { agentId: "a", groupId: "c1" } }),
        entry({ eventType: "clusterDepartureCompleted", metadata: { agentId: "a", groupId: "c1", ticksInCluster: 20, departureReason: "lowConversationSatisfaction" } }),
        entry({ eventType: "clusterRejoined", metadata: { agentId: "a", groupId: "c2", previousClusterId: "c1" } }),
        entry({ eventType: "clusterMemberReleased", metadata: { agentId: "a", groupId: "c2", ticksInCluster: 5 } }),
      ],
    });

    const summary = buildStandingPartyRunSummary(state);
    const metric = summary.agentMetrics.find((m) => m.agentId === "a")!;
    expect(metric.voluntaryDepartureCount).toBe(1);
    expect(metric.forcedReleaseCount).toBe(1);
    expect(metric.rejoinCount).toBe(1);
    expect(metric.distinctClusterCount).toBe(2);
    expect(summary.totalVoluntaryDepartureCount).toBe(1);
    expect(summary.totalForcedReleaseCount).toBe(1);
  });

  it("完了episodeの滞在tickをvoluntary/forced両方から集め、平均・中央値を算出する", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a" })],
      log: [
        entry({ eventType: "clusterDepartureCompleted", metadata: { agentId: "a", groupId: "c1", ticksInCluster: 10, departureReason: "socialCirculation" } }),
        entry({ eventType: "clusterMemberReleased", metadata: { agentId: "a", groupId: "c2", ticksInCluster: 20 } }),
        entry({ eventType: "clusterDepartureCompleted", metadata: { agentId: "a", groupId: "c3", ticksInCluster: 30, departureReason: "mixedConversationAndSocialCirculation" } }),
      ],
    });

    const summary = buildStandingPartyRunSummary(state);
    expect(summary.episodeDwellSamples).toHaveLength(3);
    expect(summary.meanCompletedEpisodeDwellTicks).toBeCloseTo(20, 10);
    expect(summary.medianCompletedEpisodeDwellTicks).toBeCloseTo(20, 10);
  });

  it("エピソード終了イベントが1件もなければ滞在tick指標はundefined", () => {
    const state = makeState({ agents: [makeAgent({ id: "a" })], log: [] });
    const summary = buildStandingPartyRunSummary(state);
    expect(summary.episodeDwellSamples).toHaveLength(0);
    expect(summary.meanCompletedEpisodeDwellTicks).toBeUndefined();
    expect(summary.medianCompletedEpisodeDwellTicks).toBeUndefined();
  });

  it("主要因別の離脱件数(departureReasonCounts)は自発離脱(clusterDepartureCompleted)のみを対象にする", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a" }), makeAgent({ id: "b" })],
      log: [
        entry({ eventType: "clusterDepartureCompleted", metadata: { agentId: "a", groupId: "c1", ticksInCluster: 10, departureReason: "lowConversationSatisfaction" } }),
        entry({ eventType: "clusterDepartureCompleted", metadata: { agentId: "b", groupId: "c2", ticksInCluster: 10, departureReason: "socialCirculation" } }),
        // 強制releaseの departureReason は "clusterBelowMinimumSize" であり、3つの主要因のいずれにも該当しない
        entry({ eventType: "clusterMemberReleased", metadata: { agentId: "a", groupId: "c3", ticksInCluster: 10, departureReason: "clusterBelowMinimumSize" } }),
      ],
    });

    const summary = buildStandingPartyRunSummary(state);
    expect(summary.departureReasonCounts).toEqual({
      lowConversationSatisfaction: 1,
      socialCirculation: 1,
      mixedConversationAndSocialCirculation: 0,
    });
  });

  it("clusterDissolutionCountは解散(activeClusterDissolved)した重複を除くcluster数を数える", () => {
    const state = makeState({
      agents: [],
      log: [
        entry({ eventType: "activeClusterDissolved", metadata: { groupId: "c1" } }),
        entry({ eventType: "activeClusterDissolved", metadata: { groupId: "c1" } }),
        entry({ eventType: "activeClusterDissolved", metadata: { groupId: "c2" } }),
      ],
    });
    expect(buildStandingPartyRunSummary(state).clusterDissolutionCount).toBe(2);
  });

  it("venueExitCountはrun終了時点で state === \"left\" のagent数", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a", state: "left" }), makeAgent({ id: "b", state: "joined" }), makeAgent({ id: "c", state: "left" })],
      log: [],
    });
    expect(buildStandingPartyRunSummary(state).venueExitCount).toBe(2);
  });

  it("afterParty/classroomPart相当(standingParty系イベントなし)のrunでは全指標が0/空になる", () => {
    const state = makeState({
      agents: [makeAgent({ id: "a", state: "joined" })],
      log: [entry({ eventType: "groupConfirmed", metadata: { groupId: "g1", memberCount: 2 } })],
    });
    const summary = buildStandingPartyRunSummary(state);
    expect(summary.totalVoluntaryDepartureCount).toBe(0);
    expect(summary.totalForcedReleaseCount).toBe(0);
    expect(summary.totalRejoinCount).toBe(0);
    expect(summary.clusterDissolutionCount).toBe(0);
    expect(summary.episodeDwellSamples).toHaveLength(0);
    expect(summary.departureReasonCounts).toEqual({
      lowConversationSatisfaction: 0,
      socialCirculation: 0,
      mixedConversationAndSocialCirculation: 0,
    });
  });
});

describe("summarizeStandingPartyRuns: 複数run分の平均集計", () => {
  it("run毎のagentMetrics/滞在tick/解散回数/会場退出人数を平均する", () => {
    const runA = buildStandingPartyRunSummary(
      makeState({
        agents: [makeAgent({ id: "a", state: "left" })],
        log: [
          entry({ eventType: "clusterDepartureCompleted", metadata: { agentId: "a", groupId: "c1", ticksInCluster: 10, departureReason: "lowConversationSatisfaction" } }),
          entry({ eventType: "activeClusterDissolved", metadata: { groupId: "c1" } }),
        ],
      }),
    );
    const runB = buildStandingPartyRunSummary(
      makeState({
        agents: [makeAgent({ id: "a", state: "joined" })],
        log: [
          entry({ eventType: "clusterDepartureCompleted", metadata: { agentId: "a", groupId: "c1", ticksInCluster: 30, departureReason: "socialCirculation" } }),
        ],
      }),
    );

    const summary = summarizeStandingPartyRuns([runA, runB]);
    expect(summary.runs).toBe(2);
    expect(summary.averageVoluntaryDepartureCountPerAgent).toBeCloseTo(1, 10);
    expect(summary.averageClusterDissolutionCount).toBeCloseTo(0.5, 10);
    expect(summary.averageVenueExitCount).toBeCloseTo(0.5, 10);
    expect(summary.averageMeanCompletedEpisodeDwellTicks).toBeCloseTo(20, 10);
    expect(summary.departureReasonRateAverages.lowConversationSatisfaction).toBeCloseTo(0.5, 10);
    expect(summary.departureReasonRateAverages.socialCirculation).toBeCloseTo(0.5, 10);
  });

  it("滞在tickサンプルが1件もないrunだけならaverageMeanCompletedEpisodeDwellTicksはundefined", () => {
    const run = buildStandingPartyRunSummary(makeState({ agents: [], log: [] }));
    const summary = summarizeStandingPartyRuns([run]);
    expect(summary.averageMeanCompletedEpisodeDwellTicks).toBeUndefined();
    expect(summary.averageMedianCompletedEpisodeDwellTicks).toBeUndefined();
  });

  it("runsが空配列なら全指標が0/undefinedになる(NaNを生じない)", () => {
    const summary = summarizeStandingPartyRuns([]);
    expect(summary.runs).toBe(0);
    expect(summary.averageVoluntaryDepartureCountPerAgent).toBe(0);
    expect(summary.averageMeanCompletedEpisodeDwellTicks).toBeUndefined();
  });
});
