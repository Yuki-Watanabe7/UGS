import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "./types";

/**
 * Issue #132 (Phase 2): 教室で自由にペアを作るシナリオのengine.ts統合テスト。
 * `formationPolicy.test.ts`のclassroomPairPolicy単体テストとは別に、実際に
 * `createInitialState`/`stepSimulation`を通した挙動が受入条件を満たすことを確認する。
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

function runClassroomToEnd(
  seed: number,
  params: SimParams,
  formationDeadlineTick: number,
  maxTicks = 400,
): SimulationState {
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick };
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, undefined, undefined, undefined, undefined, undefined, formation);
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, formation);
  }
  return state;
}

describe("classroomPair scenario: engine integration (Issue #132)", () => {
  it("pairs up a 20-person population into at most 10 pairs, and no agent belongs to more than one pair", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 20, numLeaders: 0, overallWillingness: 0.8 };
    const state = runClassroomToEnd(7, params, 150);

    const confirmedGroups = state.groupCandidates.filter((c) => c.status === "confirmed");
    expect(confirmedGroups.length).toBeLessThanOrEqual(10);
    for (const group of confirmedGroups) {
      expect(group.memberIds.length).toBeLessThanOrEqual(2);
    }

    // 同一agentが複数ペアへ所属しない
    const seen = new Set<string>();
    for (const group of confirmedGroups) {
      for (const memberId of group.memberIds) {
        expect(seen.has(memberId)).toBe(false);
        seen.add(memberId);
      }
    }

    // 20人(偶数)なので、割当人数は常に偶数(ペアは必ず2人単位)。observerJoiner同士だけが
    // 最後に取り残されると、どちらも自らは核形成しないため合流できずに終わることがあり得るため、
    // 「必ず全員割当」までは要求しない(受入条件が求めるのは「最大10組」という上限のみ)
    const joinedCount = state.agents.filter((a) => a.state === "joined").length;
    expect(joinedCount % 2).toBe(0);
    expect(joinedCount).toBeGreaterThan(0);
    expect(state.finished).toBe(true);
  });

  it("never transitions any agent to leaving/left (受入条件: leave/leftへ遷移しない)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 14, numLeaders: 0, overallWillingness: 0.5 };
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 100 };
    const rng = new SeededRandom(3);
    let state = createInitialState(3, params, undefined, undefined, undefined, undefined, undefined, formation);
    while (!state.finished && state.tick < 100) {
      state = stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, formation);
      expect(state.agents.some((a) => a.state === "leaving" || a.state === "left")).toBe(false);
    }
  });

  it("a third agent cannot join an already-confirmed pair (受入条件: ペア確定後は3人目が参加できない)", () => {
    const candidate: GroupCandidate = {
      id: "pair-1",
      x: 400,
      y: 260,
      memberIds: ["member-0", "member-1"],
      status: "confirmed",
      age: 3,
    };
    const agents: Agent[] = [
      makeAgent({ id: "member-0", state: "joined", joinedGroupId: "pair-1" }),
      makeAgent({ id: "member-1", state: "joined", joinedGroupId: "pair-1", x: 405 }),
      makeAgent({ id: "newcomer", state: "approaching", joinedGroupId: "pair-1" }),
    ];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 100 };
    const rng = new SeededRandom(1);

    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);

    const nextCandidate = next.groupCandidates.find((c) => c.id === "pair-1")!;
    expect(nextCandidate.memberIds).toEqual(["member-0", "member-1"]);
    expect(next.agents.find((a) => a.id === "newcomer")!.state).not.toBe("joined");
  });

  it("finishes immediately once everyone is already paired, even far before the deadline (受入条件: 全員割当時はdeadline前でも終了する)", () => {
    const agents: Agent[] = [
      makeAgent({ id: "a", state: "joined", joinedGroupId: "pair-1" }),
      makeAgent({ id: "b", state: "joined", joinedGroupId: "pair-1" }),
    ];
    const candidate: GroupCandidate = {
      id: "pair-1",
      x: 400,
      y: 260,
      memberIds: ["a", "b"],
      status: "confirmed",
      age: 3,
    };
    const state: SimulationState = {
      tick: 2,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 200 };
    const rng = new SeededRandom(1);

    const next = stepSimulation(state, DEFAULT_PARAMS, rng, undefined, undefined, undefined, undefined, undefined, formation);

    expect(next.finished).toBe(true);
    expect(next.tick).toBeLessThan(200);
  });

  it("hits the deadline with an unassigned agent left over for an odd population (受入条件: deadline到達時に未割当者を残したまま終了できる)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 15, numLeaders: 0, overallWillingness: 0.6 };
    const deadline = 60;
    const state = runClassroomToEnd(11, params, deadline);

    expect(state.finished).toBe(true);
    expect(state.tick).toBe(deadline);
    const unassigned = state.agents.filter((a) => a.state !== "joined");
    // 奇数人口なので「全員割当」には決して到達できず、必ず奇数人が未割当のまま残る
    expect(unassigned.length % 2).toBe(1);
    expect(unassigned.length).toBeGreaterThanOrEqual(1);
  });

  it("reproduces the same pairings and finish tick for the same seed (受入条件: 再現性)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 0, overallWillingness: 0.7 };
    const run1 = runClassroomToEnd(99, params, 150);
    const run2 = runClassroomToEnd(99, params, 150);

    expect(run2.tick).toBe(run1.tick);
    expect(run2.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId }))).toEqual(
      run1.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId })),
    );
  });

  it("createInitialState defaults formationDeadlineTick fall back for classroomPair across ticks when the caller omits it", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 10, numLeaders: 0 };
    const rng = new SeededRandom(5);
    let state = createInitialState(5, params, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "classroomPair",
      formationDeadlineTick: 42,
    });
    expect(state.formationScenarioId).toBe("classroomPair");
    expect(state.formationDeadlineTick).toBe(42);

    // 呼び出し側がformationを渡し忘れても、直前の設定(deadline=42含む)を引き継ぐ
    state = stepSimulation(state, params, rng);
    expect(state.formationScenarioId).toBe("classroomPair");
    expect(state.formationDeadlineTick).toBe(42);
  });

  it("the 'classroom-pair' UI preset is wired to the classroomPair formation scenario and runs to completion", () => {
    const preset = getPresetById("classroom-pair");
    expect(preset.formationScenarioId).toBe("classroomPair");
    expect(preset.formationDeadlineTick).toBeGreaterThan(0);

    const state = runClassroomToEnd(123, preset.params, preset.formationDeadlineTick!);
    expect(state.finished).toBe(true);
    expect(state.agents).toHaveLength(preset.params.populationSize);
  });
});
