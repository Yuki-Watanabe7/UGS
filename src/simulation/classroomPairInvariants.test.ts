import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { Agent, SimParams, SimulationState } from "./types";

/**
 * Issue #137: classroomPairシナリオの不変条件を、複数seed・複数人数にわたって網羅的に検証する。
 * classroomPair.test.ts/groupCapacity.test.ts/approachFailure.test.tsの個別受入条件テストとは別に、
 * 「毎tick成り立つべき不変条件」を一箇所にまとめ、将来のチューニング変更による回帰を検知する。
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

/**
 * 毎tick呼び出す不変条件チェック。dissolving/dissolved/expired候補はフェードアウト表現のため
 * memberIdsを保持したまま数tick残る(候補固有の所属者はすでにundecidedへ解放済み)ので、
 * 「所属グループは最大1つ」の判定は現に所属を表すforming/confirmedの候補だけを対象にする。
 */
function assertInvariants(state: SimulationState): void {
  expect(state.agents.some((agent) => agent.state === "leaving" || agent.state === "left")).toBe(false);

  const membershipCounts = new Map<string, number>();
  for (const candidate of state.groupCandidates) {
    expect(new Set(candidate.memberIds).size).toBe(candidate.memberIds.length);

    const maxGroupSize = candidate.maxGroupSize ?? 2;
    expect(candidate.memberIds.length).toBeLessThanOrEqual(maxGroupSize);

    if (candidate.status === "confirmed") {
      expect(candidate.memberIds).toHaveLength(2);
    }

    if (candidate.status === "forming" || candidate.status === "confirmed") {
      for (const memberId of candidate.memberIds) {
        membershipCounts.set(memberId, (membershipCounts.get(memberId) ?? 0) + 1);
      }
    }
  }
  for (const count of membershipCounts.values()) {
    expect(count).toBeLessThanOrEqual(1);
  }
}

function runClassroomWithInvariantChecks(
  seed: number,
  params: SimParams,
  formationDeadlineTick: number,
  maxTicks = 400,
): SimulationState {
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick };
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, undefined, undefined, undefined, undefined, undefined, formation);
  assertInvariants(state);
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, formation);
    assertInvariants(state);
  }
  return state;
}

describe("classroomPair: 不変条件の網羅テスト (Issue #137)", () => {
  const populationSizes = [6, 7, 14, 19, 20];
  const seeds = [1, 2, 3, 17, 42];

  it.each(populationSizes.flatMap((populationSize) => seeds.map((seed) => ({ populationSize, seed }))))(
    "populationSize=$populationSize / seed=$seed: 毎tickの不変条件と終了理由の網羅性",
    ({ populationSize, seed }) => {
      const params: SimParams = { ...DEFAULT_PARAMS, populationSize, numLeaders: 0, overallWillingness: 0.7 };
      const deadline = 120;
      const state = runClassroomWithInvariantChecks(seed, params, deadline, 400);

      expect(state.finished).toBe(true);
      expect(state.tick).toBeLessThanOrEqual(deadline);
      const finishReason = state.log.find((entry) => entry.eventType === "simulationFinished")?.metadata
        ?.finishReason;
      expect(["allAssigned", "deadlineReached"]).toContain(finishReason);
    },
  );

  it("大人数(populationSize=120)でも容量・重複所属の不変条件が保たれる", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 120, numLeaders: 0, overallWillingness: 0.75 };
    const deadline = 200;
    const state = runClassroomWithInvariantChecks(9001, params, deadline, 400);

    expect(state.agents).toHaveLength(120);
    expect(state.finished).toBe(true);
    expect(state.tick).toBeLessThanOrEqual(deadline);
    const finishReason = state.log.find((entry) => entry.eventType === "simulationFinished")?.metadata
      ?.finishReason;
    expect(["allAssigned", "deadlineReached"]).toContain(finishReason);

    // 120人(偶数)なので、割当人数は常に偶数(ペアは必ず2人単位)
    expect(state.agents.filter((agent) => agent.state === "joined").length % 2).toBe(0);
  });
});

describe("classroomPair: 人数の境界ケース (Issue #137)", () => {
  // `createInitialAgents`はpopulationSizeを最低3人に切り上げるため、0/1/2人のケースは
  // (既存テストと同様に)SimulationStateを直接組み立てて検証する。
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 50 };

  it("populationSize相当0人: 空配列でも即座にallAssignedとして終了する(vacuous truth)", () => {
    const state: SimulationState = {
      tick: 0,
      agents: [],
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "classroomPair",
      formationDeadlineTick: 50,
    };
    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1), undefined, undefined, undefined, undefined, undefined, formation);

    expect(next.finished).toBe(true);
    expect(next.log.find((entry) => entry.eventType === "simulationFinished")?.metadata).toMatchObject({
      assignedCount: 0,
      unassignedCount: 0,
      finishReason: "allAssigned",
    });
  });

  it("populationSize相当1人: ペア相手がいないため必ずdeadlineでunassignedになる", () => {
    const agents: Agent[] = [makeAgent({ id: "solo", state: "undecided", initiative: 0.9, willingness: 0.9 })];
    let state: SimulationState = {
      tick: 0,
      agents,
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "classroomPair",
      formationDeadlineTick: 20,
    };
    const rng = new SeededRandom(1);
    while (!state.finished && state.tick < 200) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng);
      assertInvariants(state);
    }

    expect(state.finished).toBe(true);
    expect(state.tick).toBe(20);
    expect(state.agents[0].state).toBe("unassigned");
    expect(state.log.find((entry) => entry.eventType === "simulationFinished")?.metadata).toMatchObject({
      assignedCount: 0,
      unassignedCount: 1,
      finishReason: "deadlineReached",
    });
  });

  it("populationSize相当2人: 唯一のペアが成立しallAssignedで終了する", () => {
    const agents: Agent[] = [
      makeAgent({ id: "a", state: "undecided", x: 400, y: 260, initiative: 0.9, willingness: 0.9 }),
      makeAgent({ id: "b", state: "undecided", x: 410, y: 260, initiative: 0.9, willingness: 0.9 }),
    ];
    let state: SimulationState = {
      tick: 0,
      agents,
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "classroomPair",
      formationDeadlineTick: 100,
    };
    const rng = new SeededRandom(4);
    while (!state.finished && state.tick < 200) {
      state = stepSimulation(state, DEFAULT_PARAMS, rng);
      assertInvariants(state);
    }

    expect(state.finished).toBe(true);
    expect(state.agents.every((agent) => agent.state === "joined")).toBe(true);
    expect(state.agents[0].joinedGroupId).toBe(state.agents[1].joinedGroupId);
    expect(state.log.find((entry) => entry.eventType === "simulationFinished")?.metadata).toMatchObject({
      assignedCount: 2,
      unassignedCount: 0,
      finishReason: "allAssigned",
    });
  });
});
