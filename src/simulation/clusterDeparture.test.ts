import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById, PRESETS } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "./types";

/**
 * Issue #176 (Phase 1): standingPartyの会話クラスタからの離脱・再探索・再参加を検証する。
 * ADR(docs/interaction-cluster-model.md)の責務9(`evaluateClusterDeparture`)が
 * `engine.ts`へどう結線されているか(状態遷移・membership整合性・クールダウン・構造化イベント)を
 * 単体テスト(formationPolicy.test.ts)とは別に、engine全体の挙動として確認する。
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

function runUntil(
  state: SimulationState,
  params: SimParams,
  rng: SeededRandom,
  guard: number,
  predicate: (state: SimulationState) => boolean,
): SimulationState {
  let current = state;
  for (let i = 0; i < guard; i++) {
    if (predicate(current)) return current;
    current = stepSimulation(current, params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
  }
  return current;
}

describe("standingParty: クラスタ離脱 (責務9, Issue #176)", () => {
  it("十分な滞在tickの後、joinedなagentがクラスタを離れてundecidedへ戻る", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["member-0"] });
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
    });
    const state: SimulationState = {
      tick: 20,
      agents: [agent],
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "standingParty",
    };

    const rng = new SeededRandom(1);
    const next = runUntil(state, DEFAULT_PARAMS, rng, 300, (s) =>
      s.log.some((e) => e.eventType === "clusterDepartureCompleted"),
    );

    const departed = next.agents.find((a) => a.id === "member-0")!;
    expect(departed.state).toBe("undecided");
    expect(departed.joinedGroupId).toBeUndefined();
    expect(departed.clusterJoinedAtTick).toBeUndefined();
    expect(departed.lastDepartedClusterId).toBe("group-1");
    expect(departed.clusterDepartureCount).toBe(1);

    const remainingCandidate = next.groupCandidates.find((c) => c.id === "group-1")!;
    expect(remainingCandidate.memberIds).not.toContain("member-0");

    // 2節: 同じ場所に重なったまま即時再参加しないよう、一定距離離れる
    const dx = departed.x - remainingCandidate.x;
    const dy = departed.y - remainingCandidate.y;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(0);

    // 3節: Canvas境界外へ出ない
    expect(departed.x).toBeGreaterThanOrEqual(0);
    expect(departed.x).toBeLessThanOrEqual(800);
    expect(departed.y).toBeGreaterThanOrEqual(0);
    expect(departed.y).toBeLessThanOrEqual(520);

    // 5節: 構造化イベント(開始・完了・再探索開始)がagentId/clusterId/tick付きで記録されている
    const started = next.log.find((e) => e.eventType === "clusterDepartureStarted");
    const completed = next.log.find((e) => e.eventType === "clusterDepartureCompleted");
    const researchStarted = next.log.find((e) => e.eventType === "clusterResearchStarted");
    expect(started?.metadata?.agentId).toBe("member-0");
    expect(started?.metadata?.groupId).toBe("group-1");
    expect(started?.metadata?.departureReason).toBe("provisionalStayDuration");
    expect(started?.tick).toBe(completed?.tick);
    expect(completed?.metadata?.agentId).toBe("member-0");
    expect(completed?.metadata?.groupId).toBe("group-1");
    expect(researchStarted?.metadata?.agentId).toBe("member-0");
    expect(researchStarted?.tick).toBe(completed?.tick);
  });

  it("最低滞在tick未満では離脱しない(暫定ルールの下限)", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["member-0"] });
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-1",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
    });
    const state: SimulationState = {
      tick: 0,
      agents: [agent],
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "standingParty",
    };

    const rng = new SeededRandom(1);
    let current = state;
    for (let i = 0; i < 14; i++) {
      current = stepSimulation(current, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
      expect(current.agents.find((a) => a.id === "member-0")!.state).toBe("joined");
      expect(current.log.some((e) => e.eventType?.startsWith("clusterDeparture"))).toBe(false);
    }
  });

  it("消滅済みclusterからの離脱処理でも例外にならない(所属先candidateが既に存在しない)", () => {
    const agent = makeAgent({
      id: "member-0",
      state: "joined",
      joinedGroupId: "group-missing",
      x: 400,
      y: 260,
      clusterJoinedAtTick: 0,
    });
    const state: SimulationState = {
      tick: 100,
      agents: [agent],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "standingParty",
    };

    const rng = new SeededRandom(1);
    expect(() =>
      stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION),
    ).not.toThrow();

    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
    expect(next.agents.find((a) => a.id === "member-0")!.state).toBe("undecided");
  });
});

describe("standingParty: 再参加とクールダウン (Issue #176)", () => {
  it("離脱直後は同じクラスタへ即座に再接近しない(クールダウン)が、クールダウン後は接近できる", () => {
    const candidate = makeCandidate({ id: "group-1", x: 400, y: 260, memberIds: ["other-member"] });
    const agent = makeAgent({
      id: "member-0",
      state: "undecided",
      x: 405,
      y: 260,
      lastDepartedClusterId: "group-1",
      lastDepartedClusterAtTick: 10,
    });
    // observerJoinerの様子見ログ等のノイズを避けるため、確実に接近するようwillingness/initiativeを高くする
    const eager: Agent = { ...agent, willingness: 0.95, conformity: 0.95, influenceAvoidance: 0 };

    const cooldownState: SimulationState = {
      tick: 11,
      agents: [eager],
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "standingParty",
    };
    const rngA = new SeededRandom(1);
    const duringCooldown = stepSimulation(
      cooldownState,
      DEFAULT_PARAMS,
      rngA,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      STANDING_PARTY_FORMATION,
    );
    expect(duringCooldown.agents.find((a) => a.id === "member-0")!.state).toBe("undecided");

    const afterCooldownState: SimulationState = {
      ...cooldownState,
      tick: 25, // lastDepartedClusterAtTick(10) から十分経過(CLUSTER_REJOIN_COOLDOWN_TICKS=10)
    };
    const rngB = new SeededRandom(1);
    let current = afterCooldownState;
    let approached = false;
    for (let i = 0; i < 30; i++) {
      current = stepSimulation(
        current,
        DEFAULT_PARAMS,
        rngB,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        STANDING_PARTY_FORMATION,
      );
      const member = current.agents.find((a) => a.id === "member-0")!;
      if (member.state === "approaching" || member.state === "joined") {
        approached = true;
        break;
      }
    }
    expect(approached).toBe(true);
  });

  it("再参加時にclusterRejoinedを記録する(別クラスタへの合流)", () => {
    const target = makeCandidate({ id: "group-2", x: 700, y: 260, memberIds: [] });
    const agent = makeAgent({
      id: "member-0",
      state: "approaching",
      joinedGroupId: "group-2",
      x: 700,
      y: 260,
      lastDepartedClusterId: "group-1",
      lastDepartedClusterAtTick: 5,
    });
    const state: SimulationState = {
      tick: 10,
      agents: [agent],
      groupCandidates: [target],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "standingParty",
    };

    const rng = new SeededRandom(1);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);

    const joined = next.agents.find((a) => a.id === "member-0")!;
    expect(joined.state).toBe("joined");
    expect(joined.joinedGroupId).toBe("group-2");
    expect(joined.clusterJoinedAtTick).toBe(11);

    const rejoinEvent = next.log.find((e) => e.eventType === "clusterRejoined");
    expect(rejoinEvent).toBeDefined();
    expect(rejoinEvent?.metadata?.agentId).toBe("member-0");
    expect(rejoinEvent?.metadata?.previousClusterId).toBe("group-1");
    expect(rejoinEvent?.metadata?.groupId).toBe("group-2");
    expect(rejoinEvent?.metadata?.ticksSinceDeparture).toBe(6);
  });

  it("clusterRejoinedはlastDepartedClusterIdを持たないagentには記録されない(通常の初回合流)", () => {
    const target = makeCandidate({ id: "group-2", x: 700, y: 260, memberIds: [] });
    const agent = makeAgent({
      id: "member-0",
      state: "approaching",
      joinedGroupId: "group-2",
      x: 700,
      y: 260,
    });
    const state: SimulationState = {
      tick: 10,
      agents: [agent],
      groupCandidates: [target],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "standingParty",
    };

    const rng = new SeededRandom(1);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
    expect(next.log.some((e) => e.eventType === "clusterRejoined")).toBe(false);
  });
});

describe("standingParty: membership不変条件を跨tickで維持する (Issue #176)", () => {
  it("1エージェントは同時に最大1クラスタへ所属し、memberIdsに重複がない", () => {
    const preset = getPresetById("standing-party");
    for (const seed of [1, 2, 3]) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);

      for (let i = 0; i < 250; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);

        // dissolving/dissolved/expiredはフェードアウト表現のためmemberIdsを保持したまま数tick残る
        // (所属者は既にundecidedへ解放済み)。「所属は最大1つ」の判定は現に所属を表す
        // forming/confirmedの候補だけを対象にする(classroomPairInvariants.test.tsと同じ方針)。
        const membership = new Map<string, number>();
        for (const candidate of state.groupCandidates) {
          expect(new Set(candidate.memberIds).size, `seed=${seed} tick=${state.tick} candidate=${candidate.id}`).toBe(
            candidate.memberIds.length,
          );
          if (candidate.status !== "forming" && candidate.status !== "confirmed") continue;
          for (const memberId of candidate.memberIds) {
            membership.set(memberId, (membership.get(memberId) ?? 0) + 1);
          }
        }
        for (const [agentId, count] of membership) {
          expect(count, `seed=${seed} tick=${state.tick} agent=${agentId} は複数クラスタに同時所属している`).toBe(1);
        }

        // joinedを名乗るagentは、必ず自分が所属するcandidateのmemberIdsに含まれている
        for (const agent of state.agents) {
          if (agent.state !== "joined") continue;
          const candidate = state.groupCandidates.find((c) => c.id === agent.joinedGroupId);
          expect(candidate, `seed=${seed} tick=${state.tick} agent=${agent.id} の所属先candidateが見当たらない`).toBeDefined();
          expect(candidate!.memberIds).toContain(agent.id);
        }
      }
    }
  });

  it("1agentが同一run中に少なくとも2つの異なるclusterへ順に所属できる", () => {
    const preset = getPresetById("standing-party");
    const seenGroupsByAgent = new Map<string, Set<string>>();
    let anyDeparture = false;

    // 複数seedを試し、少なくとも1つで「別クラスタへの再参加」が観測されることを確認する
    // (暫定ルールは固定確率のため、必ず特定tick数内に発生するとは限らない)
    outer: for (const seed of [1, 2, 3, 4, 5]) {
      const rng = new SeededRandom(seed);
      let state = createInitialState(seed, preset.params, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);

      for (let i = 0; i < 400; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
        for (const agent of state.agents) {
          if (agent.state !== "joined" || agent.joinedGroupId === undefined) continue;
          const set = seenGroupsByAgent.get(agent.id) ?? new Set<string>();
          set.add(agent.joinedGroupId);
          seenGroupsByAgent.set(agent.id, set);
        }
        if (state.log.some((e) => e.eventType === "clusterDepartureCompleted")) anyDeparture = true;
        if ([...seenGroupsByAgent.values()].some((set) => set.size >= 2)) break outer;
      }
    }

    expect(anyDeparture).toBe(true);
    expect([...seenGroupsByAgent.values()].some((set) => set.size >= 2)).toBe(true);
  });

  it("同一seed・同一設定でjoin/leave/rejoinイベント列が再現される", () => {
    const preset = getPresetById("standing-party");
    const run = () => {
      const rng = new SeededRandom(4);
      let state = createInitialState(4, preset.params, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
      for (let i = 0; i < 150; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
      }
      return state;
    };

    const a = run();
    const b = run();
    expect(a.agents).toEqual(b.agents);
    expect(a.groupCandidates).toEqual(b.groupCandidates);
    expect(a.log).toEqual(b.log);

    const clusterEvents = (s: SimulationState) =>
      s.log.filter((e) => e.eventType?.startsWith("cluster")).map((e) => ({ tick: e.tick, eventType: e.eventType, metadata: e.metadata }));
    expect(clusterEvents(a)).toEqual(clusterEvents(b));
  });
});

describe("既存シナリオへの回帰なし (Issue #176 受入条件)", () => {
  it("afterParty/classroomPairの既存プリセットではクラスタ離脱イベントが一度も発生しない", () => {
    const nonStandingPartyPresetIds = PRESETS.filter((p) => p.id !== "standing-party").map((p) => p.id);
    expect(nonStandingPartyPresetIds.length).toBeGreaterThan(0);

    for (const presetId of nonStandingPartyPresetIds) {
      const preset = getPresetById(presetId);
      const formation: FormationRuntimeOptions | undefined = preset.formationScenarioId
        ? {
            scenarioId: preset.formationScenarioId,
            formationDeadlineTick: preset.formationDeadlineTick,
            classroomGroupSize: preset.formationClassroomGroupSize,
          }
        : undefined;
      const rng = new SeededRandom(1);
      let state = createInitialState(1, preset.params, undefined, undefined, undefined, undefined, undefined, formation);
      let guard = 0;
      while (!state.finished && guard < 500) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, formation);
        guard += 1;
      }
      const clusterEventTypes = state.log.filter((e) => e.eventType?.startsWith("cluster")).map((e) => e.eventType);
      expect(clusterEventTypes, `preset=${presetId}`).toEqual([]);
    }
  });
});
