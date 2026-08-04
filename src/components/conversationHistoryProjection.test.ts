/**
 * Issue #215: 会話履歴タイムライン投影の純関数テスト。
 */
import { describe, expect, it } from "vitest";
import type {
  Agent,
  ClusterLifetimeRecord,
  ClusterTransitionRecord,
  ConversationEpisodeRecord,
  SimulationState,
  StandingPartyConversationHistory,
} from "../simulation/types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "../simulation/types";
import {
  currentTickMarkerPercent,
  intervalToTrackStyle,
  projectConversationHistory,
} from "./conversationHistoryProjection";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "a",
    label: "A",
    x: 0,
    y: 0,
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

function makeEpisode(overrides: Partial<ConversationEpisodeRecord> = {}): ConversationEpisodeRecord {
  return {
    episodeId: "a:g1:2",
    agentId: "a",
    clusterId: "g1",
    startedAtTick: 2,
    endedAtTick: 10,
    dwellTicks: 8,
    status: "completed",
    endReason: "voluntaryDeparture",
    joinedGroupStatus: "confirmed",
    startMemberIds: ["a"],
    endMemberIds: ["a"],
    ...overrides,
  };
}

function makeLifetime(overrides: Partial<ClusterLifetimeRecord> = {}): ClusterLifetimeRecord {
  return {
    clusterId: "g1",
    founderAgentId: "a",
    createdAtTick: 1,
    confirmedAtTick: 2,
    endedAtTick: 20,
    status: "completed",
    endReason: "activeClusterDissolved",
    peakMemberCount: 2,
    joinCount: 2,
    voluntaryLeaveCount: 1,
    forcedReleaseCount: 0,
    ...overrides,
  };
}

function makeTransition(overrides: Partial<ClusterTransitionRecord> = {}): ClusterTransitionRecord {
  return {
    transitionId: "a:g1:10",
    agentId: "a",
    sourceClusterId: "g1",
    targetClusterId: "g2",
    startedAtTick: 10,
    endedAtTick: 15,
    result: "completed",
    ...overrides,
  };
}

function makeHistory(
  overrides: Partial<StandingPartyConversationHistory> = {},
): StandingPartyConversationHistory {
  return {
    schemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
    asOfTick: 30,
    episodes: [],
    membershipIntervals: [],
    clusterLifetimes: [],
    transitions: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeState(agents: Agent[]): SimulationState {
  return {
    tick: 30,
    seed: 1,
    agents,
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
  };
}

describe("conversationHistoryProjection (Issue #215)", () => {
  it("same-cluster rejoinを別episodeとして残す", () => {
    const history = makeHistory({
      episodes: [
        makeEpisode({ episodeId: "a:g1:2", startedAtTick: 2, endedAtTick: 8 }),
        makeEpisode({
          episodeId: "a:g1:12",
          startedAtTick: 12,
          endedAtTick: 18,
          dwellTicks: 6,
        }),
      ],
      clusterLifetimes: [makeLifetime()],
    });
    const projection = projectConversationHistory(makeState([makeAgent({ id: "a" })]), history, {
      mode: "agent",
      agentId: "a",
    });
    expect(projection.episodes).toHaveLength(2);
    expect(projection.agentLanes[0].episodes.map((e) => e.episodeId)).toEqual([
      "a:g1:2",
      "a:g1:12",
    ]);
  });

  it("active / completed / censored を intervalStatus で区別する", () => {
    const history = makeHistory({
      episodes: [
        makeEpisode({ episodeId: "a:g1:1", status: "completed", endReason: "voluntaryDeparture" }),
        makeEpisode({
          episodeId: "a:g1:20",
          startedAtTick: 20,
          endedAtTick: undefined,
          dwellTicks: 10,
          status: "active",
          endReason: undefined,
        }),
        makeEpisode({
          episodeId: "b:g1:5",
          agentId: "b",
          startedAtTick: 5,
          endedAtTick: undefined,
          dwellTicks: 25,
          status: "censored",
          endReason: undefined,
        }),
      ],
    });
    const agents = [makeAgent({ id: "a" }), makeAgent({ id: "b", label: "B" })];
    const active = projectConversationHistory(makeState(agents), history, {
      mode: "agent",
      intervalStatus: "active",
    });
    expect(active.episodes.map((e) => e.episodeId)).toEqual(["a:g1:20"]);

    const completed = projectConversationHistory(makeState(agents), history, {
      mode: "agent",
      intervalStatus: "completed",
    });
    expect(completed.episodes.map((e) => e.episodeId)).toEqual(["a:g1:1"]);
  });

  it("voluntary / forced / targeted を endReason の構造化値で絞る", () => {
    const history = makeHistory({
      episodes: [
        makeEpisode({ episodeId: "v:g1:1", agentId: "v", endReason: "voluntaryDeparture" }),
        makeEpisode({ episodeId: "f:g1:1", agentId: "f", endReason: "memberReleased" }),
        makeEpisode({ episodeId: "t:g1:1", agentId: "t", endReason: "targetedTransition" }),
      ],
    });
    const agents = [
      makeAgent({ id: "v", label: "V" }),
      makeAgent({ id: "f", label: "F" }),
      makeAgent({ id: "t", label: "T" }),
    ];
    expect(
      projectConversationHistory(makeState(agents), history, {
        mode: "agent",
        departureKind: "voluntary",
      }).episodes.map((e) => e.agentId),
    ).toEqual(["v"]);
    expect(
      projectConversationHistory(makeState(agents), history, {
        mode: "agent",
        departureKind: "forced",
      }).episodes.map((e) => e.agentId),
    ).toEqual(["f"]);
    expect(
      projectConversationHistory(makeState(agents), history, {
        mode: "agent",
        departureKind: "targeted",
      }).episodes.map((e) => e.agentId),
    ).toEqual(["t"]);
  });

  it("tick範囲の半開交差で絞り込む", () => {
    const history = makeHistory({
      episodes: [
        makeEpisode({ episodeId: "a:g1:0", startedAtTick: 0, endedAtTick: 5 }),
        makeEpisode({ episodeId: "a:g1:10", startedAtTick: 10, endedAtTick: 20 }),
      ],
    });
    const projection = projectConversationHistory(makeState([makeAgent({ id: "a" })]), history, {
      mode: "agent",
      fromTick: 5,
      toTick: 10,
    });
    expect(projection.episodes).toHaveLength(0);

    const overlapping = projectConversationHistory(makeState([makeAgent({ id: "a" })]), history, {
      mode: "agent",
      fromTick: 4,
      toTick: 12,
    });
    expect(overlapping.episodes.map((e) => e.episodeId)).toEqual(["a:g1:0", "a:g1:10"]);
  });

  it("ObserverJoinerのみ・検索・transition結果で絞り込む", () => {
    const history = makeHistory({
      episodes: [
        makeEpisode({ episodeId: "oj:g1:1", agentId: "oj" }),
        makeEpisode({ episodeId: "x:g1:1", agentId: "x" }),
      ],
      transitions: [
        makeTransition({ transitionId: "oj:g1:10", agentId: "oj", result: "completed" }),
        makeTransition({
          transitionId: "x:g1:10",
          agentId: "x",
          result: "invalidated",
          invalidationReason: "targetFull",
        }),
      ],
      clusterLifetimes: [makeLifetime()],
    });
    const agents = [
      makeAgent({ id: "oj", label: "OJ", isObserverJoiner: true }),
      makeAgent({ id: "x", label: "X" }),
    ];
    const ojOnly = projectConversationHistory(makeState(agents), history, {
      mode: "agent",
      observerJoinerOnly: true,
    });
    expect(ojOnly.episodes.map((e) => e.agentId)).toEqual(["oj"]);

    const search = projectConversationHistory(makeState(agents), history, {
      mode: "agent",
      searchQuery: "OJ",
    });
    expect(search.episodes).toHaveLength(1);

    const failed = projectConversationHistory(makeState(agents), history, {
      mode: "agent",
      transitionResults: ["invalidated"],
    });
    expect(failed.transitions.map((t) => t.result)).toEqual(["invalidated"]);
  });

  it("短い区間も最小幅を確保し、現在tick markerを計算できる", () => {
    const style = intervalToTrackStyle(5, 6, 100, 0, 100, 0.012);
    expect(style.widthPercent).toBeGreaterThanOrEqual(1.2);
    expect(currentTickMarkerPercent(50, 0, 100)).toBe(50);
    expect(currentTickMarkerPercent(200, 0, 100)).toBeUndefined();
  });

  it("入力historyをmutationしない", () => {
    const history = makeHistory({
      episodes: [makeEpisode()],
      clusterLifetimes: [makeLifetime()],
    });
    const before = JSON.stringify(history);
    projectConversationHistory(makeState([makeAgent({ id: "a" })]), history, {
      mode: "cluster",
      clusterId: "g1",
      departureKind: "voluntary",
    });
    expect(JSON.stringify(history)).toBe(before);
  });
});
