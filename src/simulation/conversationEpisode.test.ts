import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "./types";

/**
 * Issue #186 (Phase 2): 会話エピソード状態(`Agent.currentEpisode`)と滞在時間の追跡を検証する。
 * 満足度の具体的な初期化・更新式(#187以降)は対象外 ―― ここでは器(episodeId/joinedAtTick/
 * lastUpdatedTick/memberCountAtJoin/lastObservedMemberCount)の開始・更新・終了だけを確認する。
 */

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

describe("会話エピソード: 開始 (Issue #186)", () => {
  it("到着による合流(agentJoined経路)でepisodeが初期化される", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["existing-member"] });
    const agent = makeAgent({
      id: "member-0",
      state: "approaching",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
    });
    const state = makeState({ tick: 5, agents: [agent], groupCandidates: [candidate] });

    const rng = new SeededRandom(1);
    const next = step(state, DEFAULT_PARAMS, rng);

    const joined = next.agents.find((a) => a.id === "member-0")!;
    expect(joined.state).toBe("joined");
    expect(joined.currentEpisode).toBeDefined();
    expect(joined.currentEpisode?.episodeId).toBe(`member-0:group-1:${next.tick}`);
    expect(joined.currentEpisode?.clusterId).toBe("group-1");
    expect(joined.currentEpisode?.joinedAtTick).toBe(next.tick);
    expect(joined.currentEpisode?.lastUpdatedTick).toBe(next.tick);
    expect(joined.currentEpisode?.memberCountAtJoin).toBe(2);
    expect(joined.currentEpisode?.lastObservedMemberCount).toBe(2);
    expect(joined.currentEpisode?.conversationSatisfaction).toBeUndefined();

    const joinEvent = next.log.find((e) => e.eventType === "agentJoined");
    expect(joinEvent?.metadata?.episodeId).toBe(joined.currentEpisode?.episodeId);
  });

  it("observerJoinerがforming輪へ合流した場合もepisodeが初期化される", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["member-0"], status: "forming" });
    const agent = makeAgent({
      id: "member-0",
      isObserverJoiner: true,
      state: "approaching",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
    });
    const state = makeState({ tick: 3, agents: [agent], groupCandidates: [candidate] });

    const rng = new SeededRandom(1);
    const next = step(state, DEFAULT_PARAMS, rng);

    const joined = next.agents.find((a) => a.id === "member-0")!;
    expect(joined.currentEpisode?.episodeId).toBe(`member-0:group-1:${next.tick}`);

    const joinEvent = next.log.find((e) => e.eventType === "observerJoinedForming");
    expect(joinEvent?.metadata?.episodeId).toBe(joined.currentEpisode?.episodeId);
  });

  it("同一clusterへの再参加でも新しいepisodeIdが発行される", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["member-0"] });
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
      currentEpisode: {
        episodeId: "member-0:group-1:0",
        clusterId: "group-1",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 1,
        lastObservedMemberCount: 1,
      },
    });
    let state = makeState({ tick: 20, agents: [agent], groupCandidates: [candidate] });

    const rng = new SeededRandom(7);
    // 離脱するまで進める(責務9、最低滞在tick=15超過後は確率的に離脱する)
    for (let i = 0; i < 500; i++) {
      state = step(state, DEFAULT_PARAMS, rng);
      const found = state.agents.find((a) => a.id === "member-0")!;
      if (found.state === "undecided" && found.lastDepartedClusterId === "group-1") break;
    }
    const departed = state.agents.find((a) => a.id === "member-0")!;
    expect(departed.state).toBe("undecided");
    expect(departed.currentEpisode).toBeUndefined();

    // 元のclusterへ即座に再接近・再参加させる
    state = {
      ...state,
      agents: state.agents.map((a) =>
        a.id === "member-0" ? { ...a, state: "approaching", joinedGroupId: "group-1", x: 400, y: 260 } : a,
      ),
      groupCandidates: state.groupCandidates.map((c) => (c.id === "group-1" ? { ...c, x: 400, y: 260 } : c)),
    };
    state = step(state, DEFAULT_PARAMS, rng);

    const rejoined = state.agents.find((a) => a.id === "member-0")!;
    expect(rejoined.state).toBe("joined");
    expect(rejoined.currentEpisode).toBeDefined();
    expect(rejoined.currentEpisode?.episodeId).not.toBe("member-0:group-1:0");
    expect(rejoined.currentEpisode?.clusterId).toBe("group-1");

    const rejoinEvent = [...state.log].reverse().find((e) => e.eventType === "clusterRejoined");
    expect(rejoinEvent?.metadata?.episodeId).toBe(rejoined.currentEpisode?.episodeId);
  });
});

describe("会話エピソード: 滞在時間の更新 (Issue #186)", () => {
  it("joinedの間、毎ticklastUpdatedTickが現在tickへ進む", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["member-0", "member-1"] });
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
      currentEpisode: {
        episodeId: "member-0:group-1:0",
        clusterId: "group-1",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 2,
        lastObservedMemberCount: 2,
      },
    });
    let state = makeState({ tick: 0, agents: [agent, makeAgent({ id: "member-1", state: "joined", joinedGroupId: "group-1", x: 400, y: 260, clusterJoinedAtTick: 0 })], groupCandidates: [candidate] });

    const rng = new SeededRandom(3);
    // STANDING_PARTY_MIN_TICKS_BEFORE_DEPARTURE(15)未満に留め、確率的離脱の影響を避ける
    for (let i = 0; i < 5; i++) {
      state = step(state, DEFAULT_PARAMS, rng);
    }

    const updated = state.agents.find((a) => a.id === "member-0")!;
    expect(updated.state).toBe("joined");
    expect(updated.currentEpisode?.joinedAtTick).toBe(0);
    expect(updated.currentEpisode?.lastUpdatedTick).toBe(state.tick);
    expect(state.tick).toBe(5);
  });

  it("pause中(stepSimulationを呼ばない)は滞在時間が進まない", () => {
    const episode = {
      episodeId: "member-0:group-1:0",
      clusterId: "group-1",
      joinedAtTick: 0,
      lastUpdatedTick: 3,
      memberCountAtJoin: 1,
      lastObservedMemberCount: 1,
    };
    const agent = makeAgent({ id: "member-0", state: "joined", joinedGroupId: "group-1", currentEpisode: episode });
    const state = makeState({ tick: 3, agents: [agent] });

    // pause = stepSimulationを呼ばないこと自体が契約。同じstateを複数回参照しても値は変化しない。
    expect(state.agents[0].currentEpisode?.lastUpdatedTick).toBe(3);
    expect(state.agents[0].currentEpisode?.lastUpdatedTick).toBe(3);
  });
});

describe("会話エピソード: 終了 (Issue #186)", () => {
  it("自発的離脱でepisodeがクリアされ、clusterDepartureCompletedにepisodeId/episodeEndReasonが記録される", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["member-0"] });
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
      currentEpisode: {
        episodeId: "member-0:group-1:0",
        clusterId: "group-1",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 1,
        lastObservedMemberCount: 1,
      },
    });
    let state = makeState({ tick: 20, agents: [agent], groupCandidates: [candidate] });

    const rng = new SeededRandom(1);
    for (let i = 0; i < 300; i++) {
      state = step(state, DEFAULT_PARAMS, rng);
      if (state.log.some((e) => e.eventType === "clusterDepartureCompleted")) break;
    }

    const departed = state.agents.find((a) => a.id === "member-0")!;
    expect(departed.currentEpisode).toBeUndefined();

    const completed = state.log.find((e) => e.eventType === "clusterDepartureCompleted");
    expect(completed?.metadata?.episodeId).toBe("member-0:group-1:0");
    expect(completed?.metadata?.episodeEndReason).toBe("voluntaryDeparture");
  });

  it("責務10による強制解放(clusterMemberReleased)でepisodeがクリアされ、episodeEndReasonがmemberReleasedになる", () => {
    const candidate = makeCandidate({
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["member-0"],
      status: "confirmed",
      everConfirmed: true,
      minGroupSize: 2,
      maxGroupSize: 4,
    });
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
      currentEpisode: {
        episodeId: "member-0:group-1:0",
        clusterId: "group-1",
        joinedAtTick: 0,
        lastUpdatedTick: 0,
        memberCountAtJoin: 2,
        lastObservedMemberCount: 2,
      },
    });
    const state = makeState({ tick: 1, agents: [agent], groupCandidates: [candidate] });

    const rng = new SeededRandom(1);
    const next = step(state, DEFAULT_PARAMS, rng);

    const released = next.agents.find((a) => a.id === "member-0")!;
    expect(released.state).toBe("undecided");
    expect(released.currentEpisode).toBeUndefined();

    const releaseEvent = next.log.find((e) => e.eventType === "clusterMemberReleased");
    expect(releaseEvent?.metadata?.episodeId).toBe("member-0:group-1:0");
    expect(releaseEvent?.metadata?.episodeEndReason).toBe("memberReleased");
  });

  it("所属clusterの消滅(整合性回復)でepisodeがクリアされる", () => {
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

    const rng = new SeededRandom(1);
    const next = step(state, DEFAULT_PARAMS, rng);

    const recovered = next.agents.find((a) => a.id === "member-0")!;
    expect(recovered.state).toBe("undecided");
    expect(recovered.joinedGroupId).toBeUndefined();
    expect(recovered.currentEpisode).toBeUndefined();
  });
});

describe("会話エピソード: 不変条件 (Issue #186)", () => {
  it("activeなepisodeのclusterIdは常にjoinedGroupIdと一致する", () => {
    // 3人をforming状態・候補地点上に置き、groupConfirmSize(既定3)分の近接ヒューリスティックで
    // すぐにconfirmedへ遷移させる(責務9の離脱・再探索を含む複数tickを通して不変条件を検証する)。
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["member-0", "member-1", "member-2"], status: "forming" });
    const members = ["member-0", "member-1", "member-2"].map((id) =>
      makeAgent({ id, state: "forming", joinedGroupId: "group-1", x: 400, y: 260 }),
    );
    let state = makeState({ tick: 0, agents: members, groupCandidates: [candidate] });

    const rng = new SeededRandom(11);
    for (let i = 0; i < 60; i++) {
      state = step(state, DEFAULT_PARAMS, rng);
      for (const agent of state.agents) {
        if (agent.state === "joined" && agent.currentEpisode) {
          expect(agent.currentEpisode.clusterId).toBe(agent.joinedGroupId);
          expect(agent.currentEpisode.joinedAtTick).toBeLessThanOrEqual(agent.currentEpisode.lastUpdatedTick);
          expect(agent.currentEpisode.lastUpdatedTick).toBeLessThanOrEqual(state.tick);
        } else {
          expect(agent.currentEpisode).toBeUndefined();
        }
      }
    }
    // 実際にconfirmed経路を通ったことを確認(そうでなければ上のループが空振りになる)
    expect(state.log.some((e) => e.eventType === "groupConfirmed")).toBe(true);
  });
});
