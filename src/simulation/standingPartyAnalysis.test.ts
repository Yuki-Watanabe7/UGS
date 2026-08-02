/**
 * Issue #212: standing-party Phase 4 会話履歴 read model
 * (`buildStandingPartyConversationHistory`)の単体・結合テスト。
 * 正本は`state.log`(+ live補完)。RNG非消費・入力非mutation・同一入力同一出力を固定する。
 */
import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import {
  assertHistoryDoesNotMutateState,
  buildStandingPartyConversationHistory,
  createClusterTransitionId,
  parseConversationEpisodeId,
} from "./standingPartyAnalysis";
import { DEFAULT_STANDING_PARTY_SCENARIO_CONFIG } from "./standingPartyScenarioConfig";
import type { Agent, GroupCandidate, LogEntry, SimParams, SimulationState } from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

const STANDING_PARTY_FORMATION: FormationRuntimeOptions = { scenarioId: "standingParty" };

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
  return stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
}

function entry(
  tick: number,
  eventType: LogEntry["eventType"],
  metadata: NonNullable<LogEntry["metadata"]>,
): LogEntry {
  return { tick, message: `t=${tick}`, tags: [], eventType, metadata };
}

describe("standingPartyAnalysis helpers (Issue #212)", () => {
  it("episodeId / transitionIdを決定的にパース・生成できる", () => {
    expect(parseConversationEpisodeId("member-0:group-1:12")).toEqual({
      agentId: "member-0",
      clusterId: "group-1",
      joinedAtTick: 12,
    });
    expect(parseConversationEpisodeId("bad")).toBeUndefined();
    expect(createClusterTransitionId("a", "g", 5)).toBe("a:g:5");
  });
});

describe("buildStandingPartyConversationHistory: episode開始の畳み込み (Issue #212)", () => {
  it("同一episodeIdのjoin系イベントは1件に畳み、duplicate診断を残す", () => {
    const state = makeState({
      tick: 3,
      agents: [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })],
      log: [
        entry(1, "nucleusCreated", { agentId: "founder", groupId: "g1" }),
        entry(2, "agentJoined", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:2",
          joinedGroupStatus: "forming",
          memberCount: 2,
        }),
        entry(2, "clusterRejoined", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:2",
          previousClusterId: "g0",
        }),
      ],
    });

    const history = buildStandingPartyConversationHistory(state);
    expect(history.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    expect(history.episodes).toHaveLength(1);
    expect(history.episodes[0].episodeId).toBe("a:g1:2");
    expect(history.episodes[0].status).toBe("active");
    expect(history.membershipIntervals).toHaveLength(1);
    expect(history.membershipIntervals[0].intervalId).toBe("a:g1:2");
    expect(history.diagnostics.some((d) => d.code === "duplicateEpisodeStart")).toBe(true);
  });

  it("Gap B: groupConfirmedでfounder episodeがjoinイベント無しでも開始される", () => {
    const state = makeState({
      tick: 5,
      agents: [
        makeAgent({
          id: "founder",
          state: "joined",
          joinedGroupId: "g1",
          currentEpisode: {
            episodeId: "founder:g1:4",
            clusterId: "g1",
            joinedAtTick: 4,
            lastUpdatedTick: 5,
            memberCountAtJoin: 1,
            lastObservedMemberCount: 1,
          },
        }),
      ],
      groupCandidates: [makeCandidate({ id: "g1", memberIds: ["founder"], status: "confirmed" })],
      log: [
        entry(1, "nucleusCreated", { agentId: "founder", groupId: "g1" }),
        entry(4, "groupConfirmed", { groupId: "g1", memberCount: 1 }),
      ],
    });

    const history = buildStandingPartyConversationHistory(state);
    expect(history.episodes).toHaveLength(1);
    expect(history.episodes[0]).toMatchObject({
      episodeId: "founder:g1:4",
      agentId: "founder",
      clusterId: "g1",
      startedAtTick: 4,
      status: "active",
      joinedGroupStatus: "confirmed",
    });
    expect(history.clusterLifetimes[0].confirmedAtTick).toBe(4);
  });
});

describe("buildStandingPartyConversationHistory: episode終了理由の分離 (Issue #212)", () => {
  it("自発離脱・targetedTransition・強制release・membershipLostを別reasonで終了する", () => {
    const state = makeState({
      tick: 40,
      agents: [
        makeAgent({ id: "v" }),
        makeAgent({ id: "t" }),
        makeAgent({ id: "f" }),
        makeAgent({ id: "m" }),
      ],
      log: [
        entry(1, "nucleusCreated", { agentId: "v", groupId: "g1" }),
        entry(2, "agentJoined", {
          agentId: "v",
          groupId: "g1",
          episodeId: "v:g1:2",
          joinedGroupStatus: "confirmed",
        }),
        entry(10, "clusterDepartureCompleted", {
          agentId: "v",
          groupId: "g1",
          episodeId: "v:g1:2",
          episodeEndReason: "voluntaryDeparture",
          ticksInCluster: 8,
        }),
        entry(11, "agentJoined", {
          agentId: "t",
          groupId: "g1",
          episodeId: "t:g1:11",
          joinedGroupStatus: "confirmed",
        }),
        entry(12, "agentJoined", {
          agentId: "f",
          groupId: "g1",
          episodeId: "f:g1:12",
          joinedGroupStatus: "confirmed",
        }),
        entry(13, "agentJoined", {
          agentId: "m",
          groupId: "g1",
          episodeId: "m:g1:13",
          joinedGroupStatus: "forming",
        }),
        entry(20, "clusterDepartureCompleted", {
          agentId: "t",
          groupId: "g1",
          episodeId: "t:g1:11",
          episodeEndReason: "voluntaryDeparture",
          transitionAction: "switchToTargetCluster",
          targetClusterId: "g2",
          ticksInCluster: 9,
        }),
        entry(20, "clusterTransitionTargetSelected", {
          agentId: "t",
          groupId: "g1",
          targetClusterId: "g2",
        }),
        entry(25, "clusterMemberReleased", {
          agentId: "f",
          groupId: "g1",
          episodeId: "f:g1:12",
          episodeEndReason: "memberReleased",
          ticksInCluster: 13,
        }),
        entry(30, "clusterMembershipLost", {
          agentId: "m",
          groupId: "g1",
          episodeId: "m:g1:13",
          episodeEndReason: "membershipLost",
          ticksInCluster: 17,
        }),
      ],
    });

    const history = buildStandingPartyConversationHistory(state);
    const byAgent = Object.fromEntries(history.episodes.map((ep) => [ep.agentId, ep]));
    expect(byAgent.v.endReason).toBe("voluntaryDeparture");
    expect(byAgent.v.status).toBe("completed");
    expect(byAgent.v.dwellTicks).toBe(8);
    expect(byAgent.t.endReason).toBe("targetedTransition");
    expect(byAgent.f.endReason).toBe("memberReleased");
    expect(byAgent.m.endReason).toBe("membershipLost");
    expect(history.episodes.every((ep) => ep.status === "completed")).toBe(true);
  });

  it("未完了episodeはactive/censoredとして完了分布へ混ぜない", () => {
    const running = makeState({
      tick: 15,
      finished: false,
      agents: [
        makeAgent({
          id: "a",
          state: "joined",
          joinedGroupId: "g1",
          currentEpisode: {
            episodeId: "a:g1:10",
            clusterId: "g1",
            joinedAtTick: 10,
            lastUpdatedTick: 15,
            memberCountAtJoin: 1,
            lastObservedMemberCount: 1,
          },
        }),
      ],
      log: [
        entry(10, "agentJoined", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:10",
          joinedGroupStatus: "confirmed",
        }),
      ],
    });
    const activeHistory = buildStandingPartyConversationHistory(running);
    expect(activeHistory.episodes[0].status).toBe("active");
    expect(activeHistory.episodes[0].endedAtTick).toBeUndefined();
    expect(activeHistory.episodes[0].dwellTicks).toBe(5);

    const finished = {
      ...running,
      finished: true,
      log: [
        ...running.log,
        entry(15, "simulationFinished", { finishReason: "observationHorizonReached" }),
      ],
    };
    const censoredHistory = buildStandingPartyConversationHistory(finished);
    expect(censoredHistory.episodes[0].status).toBe("censored");
    expect(censoredHistory.episodes[0].endedAtTick).toBeUndefined();
  });
});

describe("buildStandingPartyConversationHistory: transition (Issue #212)", () => {
  it("targeted transitionを同一IDで開始・成功まで関連付ける", () => {
    const state = makeState({
      tick: 30,
      agents: [makeAgent({ id: "a" })],
      log: [
        entry(5, "agentJoined", {
          agentId: "a",
          groupId: "src",
          episodeId: "a:src:5",
          joinedGroupStatus: "confirmed",
        }),
        entry(10, "clusterDepartureCompleted", {
          agentId: "a",
          groupId: "src",
          episodeId: "a:src:5",
          episodeEndReason: "voluntaryDeparture",
          transitionAction: "switchToTargetCluster",
          targetClusterId: "dst",
        }),
        entry(10, "clusterTransitionTargetSelected", {
          agentId: "a",
          groupId: "src",
          targetClusterId: "dst",
          focusAgentId: "b",
        }),
        entry(20, "agentJoined", {
          agentId: "a",
          groupId: "dst",
          episodeId: "a:dst:20",
          joinedGroupStatus: "confirmed",
        }),
        entry(20, "clusterTransitionCompleted", {
          agentId: "a",
          groupId: "dst",
          targetClusterId: "dst",
          episodeId: "a:dst:20",
          focusAgentId: "b",
        }),
      ],
    });

    const history = buildStandingPartyConversationHistory(state);
    expect(history.transitions).toHaveLength(1);
    const tr = history.transitions[0];
    expect(tr.transitionId).toBe(createClusterTransitionId("a", "src", 10));
    expect(tr).toMatchObject({
      agentId: "a",
      sourceClusterId: "src",
      targetClusterId: "dst",
      focusAgentId: "b",
      result: "completed",
      sourceEpisodeId: "a:src:5",
      targetEpisodeId: "a:dst:20",
      startedAtTick: 10,
      endedAtTick: 20,
      elapsedTicks: 10,
    });
    expect(history.episodes.filter((ep) => ep.agentId === "a")).toHaveLength(2);
  });

  it("目的地なしexploreとtargeted失敗(abandoned)を区別する", () => {
    const state = makeState({
      tick: 40,
      agents: [makeAgent({ id: "e" }), makeAgent({ id: "f" })],
      log: [
        entry(1, "agentJoined", {
          agentId: "e",
          groupId: "g1",
          episodeId: "e:g1:1",
          joinedGroupStatus: "confirmed",
        }),
        entry(2, "agentJoined", {
          agentId: "f",
          groupId: "g1",
          episodeId: "f:g1:2",
          joinedGroupStatus: "confirmed",
        }),
        entry(5, "clusterDepartureCompleted", {
          agentId: "e",
          groupId: "g1",
          episodeId: "e:g1:1",
          episodeEndReason: "voluntaryDeparture",
          transitionAction: "departAndExplore",
        }),
        entry(8, "clusterDepartureCompleted", {
          agentId: "f",
          groupId: "g1",
          episodeId: "f:g1:2",
          episodeEndReason: "voluntaryDeparture",
          transitionAction: "switchToTargetCluster",
          targetClusterId: "g2",
        }),
        entry(8, "clusterTransitionTargetSelected", {
          agentId: "f",
          groupId: "g1",
          targetClusterId: "g2",
        }),
        entry(12, "clusterTransitionTargetInvalidated", {
          agentId: "f",
          groupId: "g1",
          targetClusterId: "g2",
          invalidationReason: "targetFull",
        }),
        entry(12, "clusterTransitionAbandoned", {
          agentId: "f",
          groupId: "g2",
          targetClusterId: "g2",
        }),
      ],
    });

    const history = buildStandingPartyConversationHistory(state);
    const explore = history.transitions.find((t) => t.agentId === "e");
    const failed = history.transitions.find((t) => t.agentId === "f");
    expect(explore?.result).toBe("explore");
    expect(explore?.targetClusterId).toBeUndefined();
    expect(failed?.result).toBe("abandoned");
    expect(failed?.invalidationReason).toBe("targetFull");
    expect(failed?.transitionId).toBe(createClusterTransitionId("f", "g1", 8));
  });
});

describe("buildStandingPartyConversationHistory: lifetime / cleanup (Issue #212)", () => {
  it("cluster cleanup後もlifetime履歴を参照できる", () => {
    const state = makeState({
      tick: 50,
      agents: [],
      groupCandidates: [],
      log: [
        entry(1, "nucleusCreated", { agentId: "a", groupId: "g-gone" }),
        entry(3, "groupConfirmed", { groupId: "g-gone", memberCount: 2 }),
        entry(4, "agentJoined", {
          agentId: "b",
          groupId: "g-gone",
          episodeId: "b:g-gone:4",
          joinedGroupStatus: "confirmed",
        }),
        entry(10, "clusterDepartureCompleted", {
          agentId: "b",
          groupId: "g-gone",
          episodeId: "b:g-gone:4",
          episodeEndReason: "voluntaryDeparture",
        }),
        entry(11, "activeClusterDissolved", { groupId: "g-gone", memberCountBefore: 0, memberCount: 0 }),
      ],
    });

    const history = buildStandingPartyConversationHistory(state);
    expect(history.clusterLifetimes).toHaveLength(1);
    expect(history.clusterLifetimes[0]).toMatchObject({
      clusterId: "g-gone",
      createdAtTick: 1,
      confirmedAtTick: 3,
      endedAtTick: 11,
      endReason: "activeClusterDissolved",
      status: "completed",
      // Gap Bのfounder開始 + agentJoined(b) の2 join
      joinCount: 2,
      voluntaryLeaveCount: 1,
    });
  });
});

describe("buildStandingPartyConversationHistory: 不変条件 (Issue #212)", () => {
  it("同一入力で同一履歴となり、stateをmutationしない", () => {
    const state = makeState({
      tick: 8,
      agents: [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })],
      log: [
        entry(2, "agentJoined", {
          agentId: "a",
          groupId: "g1",
          episodeId: "a:g1:2",
          joinedGroupStatus: "confirmed",
        }),
      ],
    });
    const history = assertHistoryDoesNotMutateState(state);
    expect(history.episodes).toHaveLength(1);
  });

  it("engine結合: membershipLostイベントが記録され、履歴のendReasonになる", () => {
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "missing-group",
      currentEpisode: {
        episodeId: "member-0:missing-group:0",
        clusterId: "missing-group",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 1,
        lastObservedMemberCount: 1,
      },
    });
    const state = makeState({ tick: 1, agents: [agent], groupCandidates: [] });
    const next = step(state, DEFAULT_PARAMS, new SeededRandom(1));

    const lost = next.log.find((e) => e.eventType === "clusterMembershipLost");
    expect(lost?.metadata?.episodeEndReason).toBe("membershipLost");
    expect(lost?.metadata?.episodeId).toBe("member-0:missing-group:0");

    const history = buildStandingPartyConversationHistory(next);
    expect(history.episodes).toHaveLength(1);
    expect(history.episodes[0].endReason).toBe("membershipLost");
    expect(history.episodes[0].status).toBe("completed");
  });

  it("reset後の新stateでは前run履歴を持たない", () => {
    let state = createInitialState(
      7,
      DEFAULT_PARAMS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      STANDING_PARTY_FORMATION,
    );
    const rng = new SeededRandom(7);
    for (let i = 0; i < 80; i++) {
      state = step(state, DEFAULT_PARAMS, rng);
    }
    const prior = buildStandingPartyConversationHistory(state);
    expect(prior.asOfTick).toBeGreaterThan(0);

    const reset = createInitialState(
      7,
      DEFAULT_PARAMS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      STANDING_PARTY_FORMATION,
    );
    const afterReset = buildStandingPartyConversationHistory(reset);
    expect(afterReset.episodes).toHaveLength(0);
    expect(afterReset.transitions).toHaveLength(0);
    expect(afterReset.clusterLifetimes).toHaveLength(0);
    expect(afterReset.asOfTick).toBe(0);
  });

  it("standingPartyの短ランで履歴が矛盾なく構築でき、pause相当の再導出で重複しない", () => {
    const config = {
      ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
      transition: { ...DEFAULT_STANDING_PARTY_SCENARIO_CONFIG.transition, enabled: true },
    };
    const formation: FormationRuntimeOptions = { scenarioId: "standingParty", standingPartyConfig: config };
    let state = createInitialState(21, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, formation);
    const rng = new SeededRandom(21);
    for (let i = 0; i < 120; i++) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);
    }

    const first = buildStandingPartyConversationHistory(state);
    const second = buildStandingPartyConversationHistory(state);
    expect(second).toEqual(first);

    for (const ep of first.episodes) {
      if (ep.endedAtTick !== undefined) {
        expect(ep.dwellTicks).toBe(ep.endedAtTick - ep.startedAtTick);
        expect(ep.status).toBe("completed");
      } else {
        expect(ep.dwellTicks).toBe(first.asOfTick - ep.startedAtTick);
        expect(["active", "censored"]).toContain(ep.status);
      }
    }

    const openByAgent = new Map<string, string>();
    for (const ep of first.episodes) {
      if (ep.endedAtTick !== undefined) continue;
      expect(openByAgent.has(ep.agentId)).toBe(false);
      openByAgent.set(ep.agentId, ep.episodeId);
    }

    // cleanup済みclusterのlifetimeも残る
    const dissolvedIds = new Set(
      state.log.filter((e) => e.eventType === "activeClusterDissolved").map((e) => e.metadata?.groupId),
    );
    for (const id of dissolvedIds) {
      if (!id) continue;
      const life = first.clusterLifetimes.find((l) => l.clusterId === id);
      expect(life?.endedAtTick).toBeDefined();
    }
  });

  it("afterParty runでは例外を投げず空に近い履歴を返す", () => {
    let state = createInitialState(3, DEFAULT_PARAMS);
    const rng = new SeededRandom(3);
    for (let i = 0; i < 40; i++) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng);
    }
    const history = buildStandingPartyConversationHistory(state);
    expect(history.schemaVersion).toBe(STANDING_PARTY_ANALYSIS_SCHEMA_VERSION);
    // afterPartyでもjoinはあるが、clusterDeparture系transitionは基本空
    expect(history.transitions.filter((t) => t.result === "explore" || t.result === "completed")).toEqual(
      history.transitions.filter((t) => t.result === "explore" || t.result === "completed"),
    );
  });
});

describe("clusterMembershipLost: engine観測イベント (Issue #212 Gap A)", () => {
  it("conversationEpisodeの既存ケースでもmembershipLostイベントが出る", () => {
    const agent = makeAgent({
      id: "member-0",
      label: "A",
      state: "joined",
      joinedGroupId: "missing-group",
      currentEpisode: {
        episodeId: "member-0:missing-group:0",
        clusterId: "missing-group",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 1,
        lastObservedMemberCount: 1,
      },
    });
    const state = makeState({ tick: 1, agents: [agent], groupCandidates: [] });
    const next = step(state, DEFAULT_PARAMS, new SeededRandom(1));
    expect(next.log.some((e) => e.eventType === "clusterMembershipLost")).toBe(true);
    expect(next.agents[0].currentEpisode).toBeUndefined();
  });
});
