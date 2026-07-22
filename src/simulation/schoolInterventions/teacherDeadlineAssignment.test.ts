import { describe, expect, it } from "vitest";
import { stepSimulation } from "../engine";
import { SeededRandom } from "../random";
import { DEFAULT_PARAMS } from "../presets";
import type { FormationRuntimeOptions, GroupSizeRule } from "../formationPolicy";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "../types";

/**
 * Issue #159: `teacher-deadline-assignment`(締切時の教師強制割当)の統合テスト。
 * 手組みの`SimulationState`(deadlineの1tick前)から`stepSimulation`を1回呼び、
 * atDeadlineフックが発火した結果を検証する(`schoolInterventionEngineWiring.test.ts`と同じ手法)。
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

function runToDeadline(
  agents: Agent[],
  groupCandidates: GroupCandidate[],
  classroomGroupSize: GroupSizeRule,
  params: SimParams = DEFAULT_PARAMS,
  deadlineTick = 100,
  seed = 42,
): SimulationState {
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: deadlineTick, classroomGroupSize };
  const state: SimulationState = {
    tick: deadlineTick - 1,
    agents,
    groupCandidates,
    log: [],
    width: 800,
    height: 520,
    finished: false,
    seed,
  };
  const rng = new SeededRandom(seed);
  return stepSimulation(state, params, rng, { interventionId: "teacher-deadline-assignment" }, undefined, undefined, undefined, undefined, formation);
}

function assertNoDuplicateMembership(state: SimulationState): void {
  const seen = new Set<string>();
  for (const candidate of state.groupCandidates) {
    for (const id of candidate.memberIds) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  }
  for (const agent of state.agents) {
    if (agent.state !== "joined") continue;
    const candidate = state.groupCandidates.find((c) => c.id === agent.joinedGroupId);
    expect(candidate).toBeDefined();
    expect(candidate!.memberIds).toContain(agent.id);
  }
}

describe("teacher-deadline-assignment: pre-deadline non-interference", () => {
  it("does not fire before the deadline tick", () => {
    const agents = [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })];
    const formation: FormationRuntimeOptions = {
      scenarioId: "classroomPair",
      formationDeadlineTick: 100,
      classroomGroupSize: { minGroupSize: 2, maxGroupSize: 2 },
    };
    const state: SimulationState = { tick: 5, agents, groupCandidates: [], log: [], width: 800, height: 520, finished: false, seed: 1 };
    const rng = new SeededRandom(1);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, { interventionId: "teacher-deadline-assignment" }, undefined, undefined, undefined, undefined, formation);

    expect(next.log.some((e) => e.eventType?.startsWith("teacherAssignment"))).toBe(false);
    expect(next.interventionRuntimeState?.forcedAssignmentApplied ?? false).toBe(false);
  });

  it("is a no-op under the afterParty scenario", () => {
    const agents = [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })];
    const state: SimulationState = { tick: 0, agents, groupCandidates: [], log: [], width: 800, height: 520, finished: false, seed: 1 };
    const rng = new SeededRandom(1);
    const next = stepSimulation(state, DEFAULT_PARAMS, rng, { interventionId: "teacher-deadline-assignment" });

    expect(next.log.some((e) => e.eventType?.startsWith("teacherAssignment"))).toBe(false);
  });
});

describe("teacher-deadline-assignment: assignment at deadline", () => {
  const groupSize: GroupSizeRule = { minGroupSize: 3, maxGroupSize: 4 };

  it("fills a vacancy in an existing confirmed group and forms a new group from the remainder", () => {
    const confirmed: GroupCandidate = {
      id: "g-confirmed",
      x: 100,
      y: 100,
      memberIds: ["a1", "a2", "a3"],
      status: "confirmed",
      age: 10,
    };
    const agents = [
      makeAgent({ id: "a1", state: "joined", joinedGroupId: "g-confirmed", x: 100, y: 100 }),
      makeAgent({ id: "a2", state: "joined", joinedGroupId: "g-confirmed", x: 100, y: 100 }),
      makeAgent({ id: "a3", state: "joined", joinedGroupId: "g-confirmed", x: 100, y: 100 }),
      // a4: closest to g-confirmed's vacancy, but far enough away that a single pre-deadline tick of
      // normal approach movement (APPROACH_SPEED=14/tick) cannot complete the join on its own —
      // this keeps a4 in the intervention's pool instead of being absorbed by ordinary dynamics
      // before the deadline hook even runs (see the CLAUDE.md note on placing candidates out of
      // one-tick reach to isolate "decided to approach" from "arrived and joined").
      makeAgent({ id: "a4", state: "undecided", x: 300, y: 105 }),
      // a5-a7: far away, form a brand new group of exactly 3 (meets min)
      makeAgent({ id: "a5", state: "undecided", x: 500, y: 500 }),
      makeAgent({ id: "a6", state: "undecided", x: 505, y: 500 }),
      makeAgent({ id: "a7", state: "undecided", x: 495, y: 505 }),
    ];

    const next = runToDeadline(agents, [confirmed], groupSize);

    expect(next.finished).toBe(true);
    assertNoDuplicateMembership(next);

    const a4 = next.agents.find((a) => a.id === "a4")!;
    expect(a4.state).toBe("joined");
    expect(a4.joinedGroupId).toBe("g-confirmed");
    const finalConfirmed = next.groupCandidates.find((c) => c.id === "g-confirmed")!;
    expect(finalConfirmed.memberIds).toEqual(expect.arrayContaining(["a1", "a2", "a3", "a4"]));
    expect(finalConfirmed.memberIds.length).toBe(4);

    for (const id of ["a5", "a6", "a7"]) {
      const agent = next.agents.find((a) => a.id === id)!;
      expect(agent.state).toBe("joined");
      const group = next.groupCandidates.find((c) => c.id === agent.joinedGroupId)!;
      expect(group.memberIds.length).toBeGreaterThanOrEqual(3);
      expect(group.memberIds.length).toBeLessThanOrEqual(4);
      expect(group.status).toBe("confirmed");
    }

    expect(next.agents.every((a) => a.state === "joined")).toBe(true);
    expect(next.log.some((e) => e.eventType === "teacherAssignmentUnable")).toBe(false);

    expect(next.log.some((e) => e.eventType === "teacherAssignmentStarted")).toBe(true);
    const completed = next.log.find((e) => e.eventType === "teacherAssignmentCompleted");
    expect(completed).toBeDefined();
    expect(completed!.metadata?.assignedByStrategyCount).toBe(4); // a4 + a5 + a6 + a7
    expect(completed!.metadata?.structuralUnassignedCount).toBe(0);

    // 全てのconfirmed候補がmin/maxを満たす(受入条件: min未満・max超過のconfirmed班を作らない)
    for (const candidate of next.groupCandidates) {
      if (candidate.status !== "confirmed") continue;
      expect(candidate.memberIds.length).toBeGreaterThanOrEqual(groupSize.minGroupSize);
      expect(candidate.memberIds.length).toBeLessThanOrEqual(groupSize.maxGroupSize);
    }
  });

  it("rebalances an existing group's slack member to complete a below-minimum remainder", () => {
    const confirmed: GroupCandidate = {
      id: "g-full",
      x: 200,
      y: 200,
      memberIds: ["a1", "a2", "a3", "a4"],
      status: "confirmed",
      age: 20,
    };
    const agents = [
      makeAgent({ id: "a1", state: "joined", joinedGroupId: "g-full", x: 200, y: 200 }),
      makeAgent({ id: "a2", state: "joined", joinedGroupId: "g-full", x: 200, y: 200 }),
      makeAgent({ id: "a3", state: "joined", joinedGroupId: "g-full", x: 200, y: 200 }),
      makeAgent({ id: "a4", state: "joined", joinedGroupId: "g-full", x: 200, y: 200 }),
      makeAgent({ id: "b1", state: "undecided", x: 700, y: 700 }),
      makeAgent({ id: "b2", state: "undecided", x: 705, y: 700 }),
    ];

    const next = runToDeadline(agents, [confirmed], groupSize);

    expect(next.finished).toBe(true);
    assertNoDuplicateMembership(next);

    // 全員が割り当てられている(構造的未割当0、受入条件: 既存班の再配分で救済できる場合は割当不能にしない)
    expect(next.agents.every((a) => a.state === "joined")).toBe(true);

    const remainingOriginal = next.groupCandidates.find((c) => c.id === "g-full")!;
    expect(remainingOriginal.memberIds.length).toBe(3); // 1人が再配分で抜けた
    expect(remainingOriginal.memberIds.length).toBeGreaterThanOrEqual(groupSize.minGroupSize);

    const b1 = next.agents.find((a) => a.id === "b1")!;
    const mergedGroup = next.groupCandidates.find((c) => c.id === b1.joinedGroupId)!;
    expect(mergedGroup.memberIds.length).toBe(3);
    expect(mergedGroup.memberIds).toEqual(expect.arrayContaining(["b1", "b2"]));

    expect(next.log.some((e) => e.eventType === "teacherRebalancedGroup")).toBe(true);
    const completed = next.log.find((e) => e.eventType === "teacherAssignmentCompleted");
    expect(completed?.metadata?.rebalancedGroupCount).toBe(1);
    expect(completed?.metadata?.rebalancedStudentCount).toBe(1);
    expect(completed?.metadata?.structuralUnassignedCount).toBe(0);
  });

  it("marks a fixed-capacity leftover as unable when no donor slack exists (fixed groups never have slack)", () => {
    const fixedSize: GroupSizeRule = { minGroupSize: 4, maxGroupSize: 4 };
    const agents = Array.from({ length: 9 }, (_, i) => makeAgent({ id: `a${i}`, state: "undecided", x: 100 + i, y: 100 }));

    const next = runToDeadline(agents, [], fixedSize, DEFAULT_PARAMS, 100, 7);

    assertNoDuplicateMembership(next);
    const unassigned = next.agents.filter((a) => a.state === "unassigned");
    expect(unassigned.length).toBe(1); // 9人を4人固定班へ -> 4+4、残り1人は割当不能
    expect(next.log.some((e) => e.eventType === "teacherAssignmentUnable")).toBe(true);

    for (const candidate of next.groupCandidates) {
      if (candidate.status !== "confirmed") continue;
      expect(candidate.memberIds.length).toBe(4); // 3・3・4等へ暗黙に変更しない
    }
  });

  it("does not re-fire or reassign on a second tick past the deadline (fires exactly once per run)", () => {
    const agents = Array.from({ length: 9 }, (_, i) => makeAgent({ id: `a${i}`, state: "undecided", x: 100 + i, y: 100 }));
    const deadlineTick = 100;
    const afterDeadline = runToDeadline(agents, [], groupSize, DEFAULT_PARAMS, deadlineTick, 7);

    expect(afterDeadline.log.filter((e) => e.eventType === "teacherAssignmentCompleted").length).toBe(1);
    expect(afterDeadline.interventionRuntimeState?.forcedAssignmentApplied).toBe(true);

    const formation: FormationRuntimeOptions = {
      scenarioId: "classroomPair",
      formationDeadlineTick: deadlineTick,
      classroomGroupSize: groupSize,
    };
    const rng = new SeededRandom(7);
    const second = stepSimulation(
      afterDeadline,
      DEFAULT_PARAMS,
      rng,
      { interventionId: "teacher-deadline-assignment" },
      undefined,
      undefined,
      undefined,
      undefined,
      formation,
    );

    // 2回目のstepでも新規のteacherAssignmentCompleted/teacherAssignedAgentは発火しない(受入条件: 締切時1回のみ)
    expect(second.log.filter((e) => e.eventType === "teacherAssignmentCompleted").length).toBe(1);
    expect(second.log.some((e) => e.eventType === "teacherAssignedAgent")).toBe(
      afterDeadline.log.some((e) => e.eventType === "teacherAssignedAgent"),
    );
    expect(second.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId }))).toEqual(
      afterDeadline.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId })),
    );
  });

  it("ignores dissolved/expired candidates (does not target them for vacancy-filling or rebalancing)", () => {
    const dissolved: GroupCandidate = {
      id: "g-dissolved",
      x: 50,
      y: 50,
      memberIds: ["d1", "d2"],
      status: "dissolved",
      age: 1,
    };
    const expired: GroupCandidate = {
      id: "g-expired",
      x: 60,
      y: 60,
      memberIds: ["e1"],
      status: "expired",
      age: 1,
    };
    const agents = [
      // dissolved/expiredの元メンバーは既にengine側でundecidedへ戻されている想定(実際のtick経過を模す)
      makeAgent({ id: "d1", state: "undecided", x: 50, y: 50 }),
      makeAgent({ id: "d2", state: "undecided", x: 52, y: 50 }),
      makeAgent({ id: "e1", state: "undecided", x: 60, y: 60 }),
      makeAgent({ id: "f1", state: "undecided", x: 400, y: 400 }),
    ];

    const next = runToDeadline(agents, [dissolved, expired], groupSize);

    // dissolved/expiredは「フェードアウト表示用に残る過去のmemberIds」であり、現在の所属を表さない
    // (現在の所属は`agent.joinedGroupId`が真実の情報源のため、ここでは対象から除いて重複を検証する)
    const activeCandidates = next.groupCandidates.filter((c) => c.status !== "dissolved" && c.status !== "expired");
    const seen = new Set<string>();
    for (const candidate of activeCandidates) {
      for (const id of candidate.memberIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    for (const agent of next.agents) {
      if (agent.state !== "joined") continue;
      const candidate = next.groupCandidates.find((c) => c.id === agent.joinedGroupId);
      expect(candidate).toBeDefined();
      expect(candidate!.memberIds).toContain(agent.id);
    }

    // dissolved/expired候補自体はteacher-deadline-assignmentのactions/eventsから一切変更されない
    const finalDissolved = next.groupCandidates.find((c) => c.id === "g-dissolved");
    const finalExpired = next.groupCandidates.find((c) => c.id === "g-expired");
    expect(finalDissolved?.memberIds).toEqual(["d1", "d2"]);
    expect(finalExpired?.memberIds).toEqual(["e1"]);

    // 元メンバーは新規班として教師割当の対象になる(構造的に4人揃うのでconfirmedの新規班へ)
    for (const id of ["d1", "d2", "e1", "f1"]) {
      const agent = next.agents.find((a) => a.id === id)!;
      expect(agent.state).toBe("joined");
      expect(agent.joinedGroupId).not.toBe("g-dissolved");
      expect(agent.joinedGroupId).not.toBe("g-expired");
    }
  });

  it("is deterministic for a fixed seed/state (same result across repeated runs)", () => {
    const agents = Array.from({ length: 10 }, (_, i) => makeAgent({ id: `a${i}`, state: "undecided", x: 100 + i * 3, y: 100 + i }));

    const runOnce = () => runToDeadline(agents.map((a) => ({ ...a })), [], groupSize, DEFAULT_PARAMS, 100, 99);
    const first = runOnce();
    const second = runOnce();

    expect(second.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId }))).toEqual(
      first.agents.map((a) => ({ id: a.id, state: a.state, joinedGroupId: a.joinedGroupId })),
    );
    expect(second.groupCandidates).toEqual(first.groupCandidates);
  });
});
