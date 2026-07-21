import { describe, expect, it } from "vitest";
import { createInitialState, isCandidateFull, isJoinable, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import {
  computeStructuralUnassignedFloor,
  DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
  getFormationPolicyById,
  resolveNominalGroupCapacity,
} from "./formationPolicy";
import type { FormationRuntimeOptions, GroupSizeRule } from "./formationPolicy";
import { buildPairFormationRunSummary } from "./pairFormation";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "./types";

/**
 * Issue #154 (Phase 4): 固定2人/3人/4人班・3〜4人可変定員班を、共通の学校FormationPolicy境界
 * (`getFormationPolicyById("classroomPair", deadline, groupSize)`)で扱えることを検証する。
 * `classroomPair.test.ts`/`classroomPairInvariants.test.ts`/`formationPolicy.test.ts`の既存の
 * 2人固定回帰テストは変更しない(このファイルの追加テストのみで一般化のふるまいを担保する)。
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

function runClassroomGroupToEnd(
  seed: number,
  params: SimParams,
  formationDeadlineTick: number,
  classroomGroupSize: GroupSizeRule,
  maxTicks = 400,
): SimulationState {
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick, classroomGroupSize };
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, undefined, undefined, undefined, undefined, undefined, formation);
  while (!state.finished && state.tick < maxTicks) {
    state = stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, formation);
  }
  return state;
}

describe("classroomGroup capacity generalization: policy layer (Issue #154)", () => {
  describe.each([2, 3, 4])("fixed %d-person groups", (size) => {
    it(`confirm exactly at ${size} members and are full at ${size}`, () => {
      const policy = getFormationPolicyById("classroomPair", 100, { minGroupSize: size, maxGroupSize: size });
      expect(policy.shouldConfirmCandidate(size - 1, DEFAULT_PARAMS)).toBe(false);
      expect(policy.shouldConfirmCandidate(size, DEFAULT_PARAMS)).toBe(true);

      const capacity = resolveNominalGroupCapacity(policy, DEFAULT_PARAMS);
      expect(capacity).toEqual({ minGroupSize: size, maxGroupSize: size });

      const almostFull: GroupCandidate = {
        id: "g",
        x: 0,
        y: 0,
        memberIds: Array.from({ length: size - 1 }, (_, i) => `m${i}`),
        status: "forming",
        age: 0,
      };
      const full: GroupCandidate = { ...almostFull, memberIds: [...almostFull.memberIds, "last"] };
      expect(isCandidateFull(almostFull, capacity)).toBe(false);
      expect(isCandidateFull(full, capacity)).toBe(true);
    });
  });

  describe("variable 3-4 person groups", () => {
    const policy = getFormationPolicyById("classroomPair", 100, { minGroupSize: 3, maxGroupSize: 4 });
    const capacity = resolveNominalGroupCapacity(policy, DEFAULT_PARAMS);

    it("confirms once 3 have gathered but not at 2", () => {
      expect(policy.shouldConfirmCandidate(2, DEFAULT_PARAMS)).toBe(false);
      expect(policy.shouldConfirmCandidate(3, DEFAULT_PARAMS)).toBe(true);
    });

    it("resolves min=3/max=4 as the capacity", () => {
      expect(capacity).toEqual({ minGroupSize: 3, maxGroupSize: 4 });
    });

    it("stays joinable (not full) with 3 members, and becomes full only at 4", () => {
      const threeMembers: GroupCandidate = { id: "g", x: 0, y: 0, memberIds: ["a", "b", "c"], status: "confirmed", age: 0 };
      expect(isCandidateFull(threeMembers, capacity)).toBe(false);
      expect(isJoinable(threeMembers, capacity)).toBe(true);

      const fourMembers: GroupCandidate = { ...threeMembers, memberIds: ["a", "b", "c", "d"] };
      expect(isCandidateFull(fourMembers, capacity)).toBe(true);
      expect(isJoinable(fourMembers, capacity)).toBe(false);
    });
  });

  describe("config validation (受入条件: 不正値を黙って実行しない)", () => {
    it("rejects minGroupSize below 2", () => {
      expect(() => getFormationPolicyById("classroomPair", 100, { minGroupSize: 1, maxGroupSize: 2 })).toThrow();
    });

    it("rejects maxGroupSize below minGroupSize", () => {
      expect(() => getFormationPolicyById("classroomPair", 100, { minGroupSize: 4, maxGroupSize: 3 })).toThrow();
    });

    it("rejects a non-finite maxGroupSize (学校シナリオは実質無制限の定員を持たない)", () => {
      expect(() =>
        getFormationPolicyById("classroomPair", 100, { minGroupSize: 2, maxGroupSize: Number.POSITIVE_INFINITY }),
      ).toThrow();
    });

    it("rejects a non-positive formationDeadlineTick", () => {
      expect(() => getFormationPolicyById("classroomPair", 0, { minGroupSize: 2, maxGroupSize: 2 })).toThrow();
      expect(() => getFormationPolicyById("classroomPair", -1, { minGroupSize: 2, maxGroupSize: 2 })).toThrow();
    });

    it("normalizes to the fixed 2-person / default-deadline compat preset when classroomGroupSize is omitted", () => {
      const policy = getFormationPolicyById("classroomPair");
      expect(resolveNominalGroupCapacity(policy, DEFAULT_PARAMS)).toEqual({ minGroupSize: 2, maxGroupSize: 2 });
      expect(policy.finishReason([], DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK)).toBe("allAssigned");
    });
  });
});

describe("computeStructuralUnassignedFloor (Issue #154)", () => {
  it("returns 0 for an empty population", () => {
    expect(computeStructuralUnassignedFloor(0, { minGroupSize: 3, maxGroupSize: 4 })).toBe(0);
  });

  it("fixed 2-person groups matches populationSize % minGroupSize", () => {
    expect(computeStructuralUnassignedFloor(1, { minGroupSize: 2, maxGroupSize: 2 })).toBe(1);
    expect(computeStructuralUnassignedFloor(19, { minGroupSize: 2, maxGroupSize: 2 })).toBe(1);
    expect(computeStructuralUnassignedFloor(20, { minGroupSize: 2, maxGroupSize: 2 })).toBe(0);
  });

  it("a population under the minimum group size is entirely unassignable", () => {
    expect(computeStructuralUnassignedFloor(1, { minGroupSize: 3, maxGroupSize: 4 })).toBe(1);
    expect(computeStructuralUnassignedFloor(2, { minGroupSize: 3, maxGroupSize: 4 })).toBe(2);
  });

  it("a population exactly at a valid group size has a 0 floor", () => {
    expect(computeStructuralUnassignedFloor(3, { minGroupSize: 3, maxGroupSize: 4 })).toBe(0);
    expect(computeStructuralUnassignedFloor(4, { minGroupSize: 3, maxGroupSize: 4 })).toBe(0);
  });

  it("variable 3-4: a partitionable population (10 = 3+3+4) has a 0 floor", () => {
    expect(computeStructuralUnassignedFloor(10, { minGroupSize: 3, maxGroupSize: 4 })).toBe(0);
  });

  it("variable 3-4: an unpartitionable population (5) has at least a 1 floor", () => {
    expect(computeStructuralUnassignedFloor(5, { minGroupSize: 3, maxGroupSize: 4 })).toBe(1);
  });

  it("variable 3-4: multiple groups without a remainder (11 = 3+4+4)", () => {
    expect(computeStructuralUnassignedFloor(11, { minGroupSize: 3, maxGroupSize: 4 })).toBe(0);
  });

  it("fixed 3-person groups: remainder cases", () => {
    expect(computeStructuralUnassignedFloor(7, { minGroupSize: 3, maxGroupSize: 3 })).toBe(1);
    expect(computeStructuralUnassignedFloor(9, { minGroupSize: 3, maxGroupSize: 3 })).toBe(0);
  });
});

describe("classroomGroup capacity generalization: engine integration (Issue #154)", () => {
  it("confirmed-but-not-full 3〜4-person groups accept a 4th member on arrival (受入条件: confirmedかつ未満員の可変定員班へ参加できる)", () => {
    const candidate: GroupCandidate = { id: "group-1", x: 400, y: 260, memberIds: ["a", "b", "c"], status: "confirmed", age: 5 };
    const agents: Agent[] = [
      makeAgent({ id: "a", state: "joined", joinedGroupId: "group-1" }),
      makeAgent({ id: "b", state: "joined", joinedGroupId: "group-1", x: 405 }),
      makeAgent({ id: "c", state: "joined", joinedGroupId: "group-1", x: 410 }),
      makeAgent({ id: "d", state: "approaching", joinedGroupId: "group-1", x: 405, y: 260 }),
    ];
    const state: SimulationState = { tick: 5, agents, groupCandidates: [candidate], log: [], width: 800, height: 520, finished: false };
    const formation: FormationRuntimeOptions = {
      scenarioId: "classroomPair",
      formationDeadlineTick: 100,
      classroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
    };
    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1), undefined, undefined, undefined, undefined, undefined, formation);

    const nextCandidate = next.groupCandidates.find((c) => c.id === "group-1")!;
    expect(nextCandidate.memberIds).toEqual(["a", "b", "c", "d"]);
    expect(next.agents.find((a) => a.id === "d")!.state).toBe("joined");
  });

  it("rejects a 5th member once a 3〜4-person group is already full at 4 (受入条件: 4人で満員となる)", () => {
    const candidate: GroupCandidate = { id: "group-1", x: 400, y: 260, memberIds: ["a", "b", "c", "d"], status: "confirmed", age: 5 };
    const agents: Agent[] = [
      makeAgent({ id: "a", state: "joined", joinedGroupId: "group-1" }),
      makeAgent({ id: "b", state: "joined", joinedGroupId: "group-1", x: 405 }),
      makeAgent({ id: "c", state: "joined", joinedGroupId: "group-1", x: 410 }),
      makeAgent({ id: "d", state: "joined", joinedGroupId: "group-1", x: 415 }),
      makeAgent({ id: "e", state: "approaching", joinedGroupId: "group-1", x: 405, y: 260 }),
    ];
    const state: SimulationState = { tick: 5, agents, groupCandidates: [candidate], log: [], width: 800, height: 520, finished: false };
    const formation: FormationRuntimeOptions = {
      scenarioId: "classroomPair",
      formationDeadlineTick: 100,
      classroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
    };
    const next = stepSimulation(state, DEFAULT_PARAMS, new SeededRandom(1), undefined, undefined, undefined, undefined, undefined, formation);

    const nextCandidate = next.groupCandidates.find((c) => c.id === "group-1")!;
    expect(nextCandidate.memberIds).toEqual(["a", "b", "c", "d"]);
    expect(next.agents.find((a) => a.id === "e")!.state).not.toBe("joined");
  });

  it("groups a population into 3〜4-person groups end to end, never exceeding max, no duplicate membership", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 20, numLeaders: 0, overallWillingness: 0.8 };
    const state = runClassroomGroupToEnd(7, params, 150, { minGroupSize: 3, maxGroupSize: 4 });

    const confirmedGroups = state.groupCandidates.filter((c) => c.status === "confirmed");
    for (const group of confirmedGroups) {
      expect(group.memberIds.length).toBeGreaterThanOrEqual(3);
      expect(group.memberIds.length).toBeLessThanOrEqual(4);
    }
    const seen = new Set<string>();
    for (const group of confirmedGroups) {
      for (const memberId of group.memberIds) {
        expect(seen.has(memberId)).toBe(false);
        seen.add(memberId);
      }
    }
    expect(state.finished).toBe(true);
  });

  it("reproduces identical group composition, confirm ticks, and final agent states for the same seed (受入条件: 再現性)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 19, numLeaders: 0, overallWillingness: 0.7 };
    const groupSize: GroupSizeRule = { minGroupSize: 3, maxGroupSize: 4 };
    const run1 = runClassroomGroupToEnd(99, params, 150, groupSize);
    const run2 = runClassroomGroupToEnd(99, params, 150, groupSize);

    expect(run2.tick).toBe(run1.tick);
    expect(run2.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId }))).toEqual(
      run1.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId })),
    );
    const confirmTicksByGroup = (state: SimulationState) =>
      state.log
        .filter((entry) => entry.eventType === "groupConfirmed")
        .map((entry) => ({ tick: entry.tick, groupId: entry.metadata?.groupId, memberCount: entry.metadata?.memberCount }));
    expect(confirmTicksByGroup(run2)).toEqual(confirmTicksByGroup(run1));
  });

  it("carries classroomGroupSize across ticks when the caller omits it (fall back like formationDeadlineTick)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 10, numLeaders: 0 };
    const rng = new SeededRandom(5);
    let state = createInitialState(5, params, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "classroomPair",
      formationDeadlineTick: 42,
      classroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
    });
    expect(state.formationClassroomGroupSize).toEqual({ minGroupSize: 3, maxGroupSize: 4 });

    state = stepSimulation(state, params, rng);
    expect(state.formationScenarioId).toBe("classroomPair");
    expect(state.formationClassroomGroupSize).toEqual({ minGroupSize: 3, maxGroupSize: 4 });
  });
});

describe("pairFormation summary: variable-capacity structuralUnassignedFloor (Issue #154)", () => {
  it("returns the partition-based floor for a classroomPair run configured with a 3〜4 variable group size", () => {
    const agents: Agent[] = Array.from({ length: 5 }, (_, i) => makeAgent({ id: `a${i}`, state: "unassigned" }));
    const state: SimulationState = {
      tick: 50,
      agents,
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: true,
      formationScenarioId: "classroomPair",
      formationDeadlineTick: 50,
      formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
    };
    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);
    expect(summary.structuralUnassignedFloor).toBe(1);
    expect(summary.excessUnassignedCount).toBe(4);
  });

  it("returns a 0 floor for a partitionable population under a fixed 3-person group size", () => {
    const agents: Agent[] = Array.from({ length: 9 }, (_, i) => makeAgent({ id: `a${i}`, state: "joined" }));
    const state: SimulationState = {
      tick: 50,
      agents,
      groupCandidates: [],
      log: [],
      width: 800,
      height: 520,
      finished: true,
      formationScenarioId: "classroomPair",
      formationDeadlineTick: 50,
      formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 3 },
    };
    const summary = buildPairFormationRunSummary(state, DEFAULT_PARAMS);
    expect(summary.structuralUnassignedFloor).toBe(0);
  });
});
