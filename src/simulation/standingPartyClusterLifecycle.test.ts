import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, SimulationState } from "./types";

/**
 * Issue #177 (Phase 1): standingPartyの会話クラスタが成立(confirmed/active)後もjoin/leaveで
 * 人数が増減し、成立最小人数を下回ったら安全に解散して残存member・接近中agentを再探索へ戻す
 * ライフサイクル(ADR: docs/interaction-cluster-model.md 責務10)を検証する。
 * clusterDeparture.test.ts(Issue #176, 責務9)とは別に、責務10固有のケースだけをここでまとめる。
 */

const STANDING_PARTY_FORMATION: FormationRuntimeOptions = { scenarioId: "standingParty" };
// このファイルのテストは「成立=2人以上」という原則(実装範囲2)を素直に検証するため、
// 実プリセット(groupConfirmSize: 3)ではなく最小値2を明示的に使う。
const MIN_SIZE_PARAMS = { ...DEFAULT_PARAMS, groupConfirmSize: 2 };

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

function makeState(agents: Agent[], candidates: GroupCandidate[], tick: number): SimulationState {
  return {
    tick,
    agents,
    groupCandidates: candidates,
    log: [],
    width: 800,
    height: 520,
    finished: false,
    formationScenarioId: "standingParty",
  };
}

function step(state: SimulationState, rng: SeededRandom, params = MIN_SIZE_PARAMS): SimulationState {
  return stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
}

describe("standingParty: 確定後クラスタのライフサイクル (責務10, Issue #177)", () => {
  it("1人 forming -> 2人 active (成立最小人数2人で成立し、memberIdsが成立最小人数へ達するとeverConfirmedが立つ)", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["founder"], status: "forming", age: 0 });
    const founder = makeAgent({ id: "founder", state: "forming", x: 400, y: 260 });
    // computeConfirmationCount(afterPartyヒューリスティック)は近接しているだけでも数えるため、
    // 実際にmemberIdsへ加わったforming状態のagentで確実に2人揃える
    const second = makeAgent({ id: "second", state: "forming", x: 405, y: 260 });
    candidate.memberIds.push("second");

    let state = makeState([founder, second], [candidate], 0);
    const rng = new SeededRandom(1);
    state = step(state, rng);

    const confirmed = state.groupCandidates.find((c) => c.id === "group-1")!;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.memberIds.sort()).toEqual(["founder", "second"]);
    expect(state.agents.every((a) => a.state === "joined")).toBe(true);

    const confirmedEvent = state.log.find((e) => e.eventType === "groupConfirmed");
    expect(confirmedEvent).toBeDefined();

    // memberIdsが既に成立最小人数(2)へ達しているので、次のtickでeverConfirmedが立つ
    state = step(state, rng);
    const afterNextTick = state.groupCandidates.find((c) => c.id === "group-1")!;
    expect(afterNextTick.everConfirmed).toBe(true);
    expect(afterNextTick.status).toBe("confirmed");
  });

  it("2人 active -> 3人 active(合流) -> 2人 active(離脱): クラスタIDを維持したまま増減する", () => {
    const candidate = makeCandidate({
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["a", "b"],
      everConfirmed: true,
    });
    const a = makeAgent({ id: "a", state: "joined", joinedGroupId: "group-1", x: 400, y: 260, clusterJoinedAtTick: 0 });
    const b = makeAgent({ id: "b", state: "joined", joinedGroupId: "group-1", x: 400, y: 260, clusterJoinedAtTick: 0 });
    // 3人目が接近して合流する
    const newcomer = makeAgent({
      id: "newcomer",
      state: "approaching",
      joinedGroupId: "group-1",
      x: 395,
      y: 260,
      willingness: 0.9,
      conformity: 0.9,
    });

    let state = makeState([a, b, newcomer], [candidate], 20);
    const rng = new SeededRandom(1);
    state = step(state, rng);

    const afterJoin = state.groupCandidates.find((c) => c.id === "group-1")!;
    expect(afterJoin.status).toBe("confirmed");
    expect(afterJoin.memberIds.sort()).toEqual(["a", "b", "newcomer"]);
    const joinedEvent = state.log.find((e) => e.eventType === "agentJoined" && e.metadata?.agentId === "newcomer");
    expect(joinedEvent).toBeDefined();
    expect(joinedEvent?.metadata?.joinedGroupStatus).toBe("confirmed");

    // 全員に十分な滞在tickを与え、責務9由来の離脱が発生するまで進める(3人 -> 2人になった時点で止める)
    let current = state;
    let sawShrunk = false;
    for (let i = 0; i < 200; i++) {
      current = step(current, rng);
      const c = current.groupCandidates.find((cand) => cand.id === "group-1")!;
      if (c.memberIds.length === 2 && c.status === "confirmed") {
        sawShrunk = true;
        break;
      }
      // 2人未満まで縮んでしまったら(このテストの意図する経路ではない)打ち切る
      if (c.status !== "confirmed") break;
    }

    expect(sawShrunk).toBe(true);
    const finalCandidate = current.groupCandidates.find((c) => c.id === "group-1")!;
    expect(finalCandidate.id).toBe("group-1"); // クラスタIDを維持したまま増減した
    expect(finalCandidate.status).toBe("confirmed");
    const shrunkEvent = current.log.find((e) => e.eventType === "activeClusterShrunk" && e.tick === current.tick);
    expect(shrunkEvent).toBeDefined();
    expect(shrunkEvent?.metadata?.memberCount).toBe(2);
  });

  it("2人 active -> 1人となり解散、残存1人も孤立させず再探索へ戻す", () => {
    const candidate = makeCandidate({
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["leaver", "stayer"],
      everConfirmed: true,
    });
    const leaver = makeAgent({
      id: "leaver",
      state: "joined",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
    });
    const stayer = makeAgent({
      id: "stayer",
      state: "joined",
      joinedGroupId: "group-1",
      x: 405,
      y: 260,
      clusterJoinedAtTick: 0,
    });

    let state = makeState([leaver, stayer], [candidate], 20);
    const rng = new SeededRandom(1);

    let dissolvingTick: number | undefined;
    for (let i = 0; i < 300; i++) {
      state = step(state, rng);
      const c = state.groupCandidates.find((cand) => cand.id === "group-1")!;
      if (c.status === "dissolving" || c.status === "dissolved") {
        dissolvingTick = state.tick;
        break;
      }
    }

    expect(dissolvingTick).toBeDefined();
    const dissolvedCandidate = state.groupCandidates.find((c) => c.id === "group-1")!;
    // 残存1人を特別扱いせず、下回ったら即座に解散する(3節不変条件4: 最後の1人を特別扱いしない)
    expect(dissolvedCandidate.memberIds).toEqual([]);

    // 離脱した本人(責務9経由)・残存していたstayer(責務10の強制release経由)の両方がjoinedから解放される
    const leaverAgent = state.agents.find((a) => a.id === "leaver")!;
    const stayerAgent = state.agents.find((a) => a.id === "stayer")!;
    expect(leaverAgent.state).toBe("undecided");
    expect(leaverAgent.joinedGroupId).toBeUndefined();
    expect(stayerAgent.state).toBe("undecided");
    expect(stayerAgent.joinedGroupId).toBeUndefined();

    const dissolvingEvent = state.log.find((e) => e.eventType === "activeClusterDissolving" && e.tick === dissolvingTick);
    expect(dissolvingEvent).toBeDefined();
    expect(dissolvingEvent?.metadata?.memberCountBefore).toBe(1);

    const releasedEvent = state.log.find((e) => e.eventType === "clusterMemberReleased" && e.metadata?.agentId === "stayer");
    expect(releasedEvent).toBeDefined();
    expect(releasedEvent?.metadata?.departureReason).toBe("clusterBelowMinimumSize");

    // 責務9由来の自発的離脱(leaver)と責務10由来の強制release(stayer)は別イベントとして区別される
    expect(state.log.some((e) => e.eventType === "clusterDepartureCompleted" && e.metadata?.agentId === "leaver")).toBe(true);
    expect(state.log.some((e) => e.eventType === "clusterDepartureCompleted" && e.metadata?.agentId === "stayer")).toBe(false);
  });

  it("同一tickで複数memberが離脱し0人になった場合も矛盾なくdissolvedへ移行する(残存member0人)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const candidate = makeCandidate({
        id: "group-1",
        x: 400,
        y: 260,
        memberIds: ["a", "b"],
        everConfirmed: true,
      });
      const a = makeAgent({ id: "a", state: "joined", joinedGroupId: "group-1", x: 400, y: 260, clusterJoinedAtTick: 0 });
      const b = makeAgent({ id: "b", state: "joined", joinedGroupId: "group-1", x: 400, y: 260, clusterJoinedAtTick: 0 });

      let state = makeState([a, b], [candidate], 20);
      const rng = new SeededRandom(seed);

      let found = false;
      for (let i = 0; i < 60; i++) {
        state = step(state, rng);
        const departedThisTick = state.log.filter(
          (e) => e.tick === state.tick && e.eventType === "clusterDepartureCompleted",
        ).length;
        if (departedThisTick >= 2) {
          found = true;
          break;
        }
        const c = state.groupCandidates.find((cand) => cand.id === "group-1")!;
        if (c.status !== "confirmed") break; // 1人ずつ順に離脱して既に解散した(このテストの対象外の経路)
      }

      if (!found) continue;

      const dissolvedEvent = state.log.find((e) => e.eventType === "activeClusterDissolved" && e.tick === state.tick);
      expect(dissolvedEvent).toBeDefined();
      expect(dissolvedEvent?.metadata?.memberCountBefore).toBe(0);
      const finalCandidate = state.groupCandidates.find((c) => c.id === "group-1")!;
      expect(finalCandidate.status).toBe("dissolved");
      expect(finalCandidate.memberIds).toEqual([]);
      expect(state.agents.every((agent) => agent.state === "undecided")).toBe(true);
      expect(state.agents.every((agent) => agent.joinedGroupId === undefined)).toBe(true);
      return;
    }
    throw new Error("40seed x 60tickの探索で同一tick2人同時離脱が観測できなかった(暫定確率0.05の分布次第で稀に起こり得る)");
  });

  it("dissolving中のclusterへ接近中のagentはtarget invalidatedとなり再探索へ戻る", () => {
    // everConfirmed済み・既に最小人数(2)を下回っているクラスタを直接構成し、
    // 責務10の解散が即座に(次のtickで)発生する状況を作る
    const candidate = makeCandidate({
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["solo"],
      everConfirmed: true,
    });
    const solo = makeAgent({ id: "solo", state: "joined", joinedGroupId: "group-1", x: 400, y: 260, clusterJoinedAtTick: 0 });
    // JOIN_DISTANCE(26)より十分離しておき、1tickでは到着しないようにする
    const approacher = makeAgent({ id: "approacher", state: "approaching", joinedGroupId: "group-1", x: 200, y: 260 });

    let state = makeState([solo, approacher], [candidate], 20);
    const rng = new SeededRandom(1);

    // tick 1: soloは最小人数割れのため即dissolvingへ。approacherはこのtick開始時点ではまだ
    // confirmedだったcandidateへ接近を続ける(このtickでは無効化されない)
    state = step(state, rng);
    const afterFirstTick = state.groupCandidates.find((c) => c.id === "group-1")!;
    expect(afterFirstTick.status).toBe("dissolving");
    expect(state.agents.find((a) => a.id === "approacher")?.state).toBe("approaching");

    // tick 2: dissolving状態のcandidateへの接近は無効化される
    state = step(state, rng);
    const invalidated = state.log.find(
      (e) => e.eventType === "approachTargetInvalidated" && e.metadata?.agentId === "approacher",
    );
    expect(invalidated).toBeDefined();
    expect(invalidated?.metadata?.reason).toBe("groupDissolved");
    expect(state.agents.find((a) => a.id === "approacher")?.state).toBe("undecided");
  });

  it("dissolved後、同じ場所に新しいclusterが形成される場合は別IDになる", () => {
    const dissolvedCandidate = makeCandidate({
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: [],
      status: "dissolved",
      age: 0,
      everConfirmed: true,
    });
    const leader = makeAgent({ id: "leader", state: "undecided", x: 400, y: 260, initiative: 0.9, willingness: 0.9 });

    let state = makeState([leader], [dissolvedCandidate], 20);
    const rng = new SeededRandom(7);

    let newCandidateId: string | undefined;
    for (let i = 0; i < 80; i++) {
      state = step(state, rng, { ...MIN_SIZE_PARAMS, numLeaders: 1 });
      newCandidateId = state.groupCandidates.find((c) => c.status === "forming")?.id;
      if (newCandidateId) break;
    }

    expect(newCandidateId).toBeDefined();
    expect(newCandidateId).not.toBe("group-1");
  });

  it("既存シナリオへの回帰なし: afterParty/classroomPairはconfirmedClusterIsMutableがfalseで、confirmed後にmemberIdsが減らない", () => {
    const preset = getPresetById("natural");
    const rng = new SeededRandom(1);
    let state = createInitialState(1, preset.params, undefined, undefined, undefined, undefined, undefined, undefined);
    let guard = 0;
    while (!state.finished && guard < 500) {
      state = stepSimulation(state, preset.params, rng);
      guard += 1;
    }
    const clusterEventTypes = state.log
      .filter((e) => e.eventType?.startsWith("activeCluster") || e.eventType === "clusterMemberReleased")
      .map((e) => e.eventType);
    expect(clusterEventTypes).toEqual([]);
  });

  it("責務10: 複数seed・長時間実行でも、成立最小人数へ一度達したconfirmedクラスタは常にminGroupSize以上を維持するか解散している", () => {
    const preset = getPresetById("standing-party");
    for (const seed of [1, 2, 3]) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(
        seed,
        preset.params,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        STANDING_PARTY_FORMATION,
      );

      for (let i = 0; i < 300; i++) {
        state = stepSimulation(
          state,
          preset.params,
          rng,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          STANDING_PARTY_FORMATION,
        );

        for (const candidate of state.groupCandidates) {
          if (candidate.status === "confirmed" && candidate.everConfirmed) {
            expect(
              candidate.memberIds.length,
              `seed=${seed} tick=${state.tick} candidate=${candidate.id}が成立最小人数を下回ったままconfirmedに留まっている`,
            ).toBeGreaterThanOrEqual(preset.params.groupConfirmSize);
          }
          if (candidate.status === "dissolving" || candidate.status === "dissolved") {
            for (const memberId of candidate.memberIds) {
              const agent = state.agents.find((a) => a.id === memberId);
              expect(
                agent?.state,
                `seed=${seed} tick=${state.tick} agent=${memberId}がdissolving/dissolved候補${candidate.id}にjoinedのまま残っている`,
              ).not.toBe("joined");
            }
          }
        }

        // 1エージェントは同時に最大1クラスタへ所属し、joinedGroupIdの指す先とmemberIdsが常に一致する
        for (const agent of state.agents) {
          if (agent.state !== "joined") continue;
          const owner = state.groupCandidates.find((c) => c.id === agent.joinedGroupId);
          expect(owner, `seed=${seed} tick=${state.tick} agent=${agent.id}の所属先candidateが見当たらない`).toBeDefined();
          expect(owner!.memberIds).toContain(agent.id);
        }
      }
    }
  });
});
