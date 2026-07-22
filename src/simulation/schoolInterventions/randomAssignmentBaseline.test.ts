import { describe, expect, it } from "vitest";
import { createInitialState } from "../engine";
import { DEFAULT_PARAMS } from "../presets";
import type { FormationRuntimeOptions, GroupSizeRule } from "../formationPolicy";
import type { SimParams } from "../types";

/**
 * Issue #159: `random-assignment-baseline`(seed付きランダム割当・自由形成を行わない比較基準)のテスト。
 * `onInitialState`(tick 0)で発火するため、`createInitialState`のみで完結する。
 */

function buildFormation(classroomGroupSize: GroupSizeRule, formationDeadlineTick = 100): FormationRuntimeOptions {
  return { scenarioId: "classroomPair", formationDeadlineTick, classroomGroupSize };
}

describe("random-assignment-baseline: initial assignment", () => {
  it("assigns everyone into fixed-size pairs when the population divides evenly", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 8 };
    const state = createInitialState(
      5,
      params,
      { interventionId: "random-assignment-baseline" },
      undefined,
      undefined,
      undefined,
      undefined,
      buildFormation({ minGroupSize: 2, maxGroupSize: 2 }),
    );

    expect(state.agents.every((a) => a.state === "joined")).toBe(true);
    const confirmedGroups = state.groupCandidates.filter((c) => c.status === "confirmed");
    expect(confirmedGroups.length).toBe(4);
    for (const g of confirmedGroups) expect(g.memberIds.length).toBe(2);

    expect(state.log.some((e) => e.eventType === "randomAssignmentStarted")).toBe(true);
    expect(state.log.filter((e) => e.eventType === "randomGroupCreated").length).toBe(4);
    const completed = state.log.find((e) => e.eventType === "randomAssignmentCompleted");
    expect(completed?.metadata?.assignedByStrategyCount).toBe(8);
    expect(completed?.metadata?.structuralUnassignedCount).toBe(0);
  });

  it("does not silently reshape a fixed group size to absorb an odd leftover", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 7 };
    const state = createInitialState(
      5,
      params,
      { interventionId: "random-assignment-baseline" },
      undefined,
      undefined,
      undefined,
      undefined,
      buildFormation({ minGroupSize: 2, maxGroupSize: 2 }),
    );

    const joined = state.agents.filter((a) => a.state === "joined");
    const unassigned = state.agents.filter((a) => a.state === "unassigned");
    expect(joined.length).toBe(6);
    expect(unassigned.length).toBe(1);
    for (const g of state.groupCandidates) expect(g.memberIds.length).toBe(2);

    const completed = state.log.find((e) => e.eventType === "randomAssignmentCompleted");
    expect(completed?.metadata?.structuralUnassignedCount).toBe(1);
  });

  it("fully assigns a population that fits into a 3-4 variable-capacity split", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 10 };
    const state = createInitialState(
      5,
      params,
      { interventionId: "random-assignment-baseline" },
      undefined,
      undefined,
      undefined,
      undefined,
      buildFormation({ minGroupSize: 3, maxGroupSize: 4 }),
    );

    expect(state.agents.every((a) => a.state === "joined")).toBe(true);
    for (const g of state.groupCandidates) {
      expect(g.memberIds.length).toBeGreaterThanOrEqual(3);
      expect(g.memberIds.length).toBeLessThanOrEqual(4);
    }
  });

  it("is deterministic for a fixed seed (same grouping across repeated calls)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 11 };
    const formation = buildFormation({ minGroupSize: 3, maxGroupSize: 4 });
    const build = () => createInitialState(123, params, { interventionId: "random-assignment-baseline" }, undefined, undefined, undefined, undefined, formation);

    const a = build();
    const b = build();

    expect(b.agents.map((x) => ({ id: x.id, state: x.state, joinedGroupId: x.joinedGroupId }))).toEqual(
      a.agents.map((x) => ({ id: x.id, state: x.state, joinedGroupId: x.joinedGroupId })),
    );
    expect(b.groupCandidates).toEqual(a.groupCandidates);
  });

  it("does not perturb agent generation relative to no intervention (does not consume the main PRNG stream)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 9 };
    const formation = buildFormation({ minGroupSize: 3, maxGroupSize: 4 });

    const none = createInitialState(77, params, { interventionId: "none" }, undefined, undefined, undefined, undefined, formation);
    const random = createInitialState(77, params, { interventionId: "random-assignment-baseline" }, undefined, undefined, undefined, undefined, formation);

    // 割当(x/y座標は割当先班へ揃えるため意図的に変更される)を除いた、PRNG由来の生成属性
    // (人格パラメータ・cliqueId等)はintervention選択の影響を受けない
    // (受入条件: random baselineが本体PRNGを消費しない)
    const identityFields = (agents: typeof none.agents) =>
      agents.map((a) => ({
        id: a.id,
        label: a.label,
        willingness: a.willingness,
        initiative: a.initiative,
        ambiguityTolerance: a.ambiguityTolerance,
        influenceAvoidance: a.influenceAvoidance,
        conformity: a.conformity,
        leaveThreshold: a.leaveThreshold,
        isObserverJoiner: a.isObserverJoiner,
        cliqueId: a.cliqueId,
      }));
    expect(identityFields(random.agents)).toEqual(identityFields(none.agents));
  });

  it("does not affect the afterParty scenario", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, { interventionId: "random-assignment-baseline" });
    expect(state.agents.every((a) => a.state === "undecided")).toBe(true);
    expect(state.log.some((e) => e.eventType?.startsWith("randomAssignment"))).toBe(false);
  });

  it("does not fire under classroomPair when a different intervention (or none) is selected", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 8 };
    const formation = buildFormation({ minGroupSize: 2, maxGroupSize: 2 });
    const state = createInitialState(1, params, { interventionId: "none" }, undefined, undefined, undefined, undefined, formation);

    expect(state.agents.every((a) => a.state === "undecided")).toBe(true);
    expect(state.log.some((e) => e.eventType?.startsWith("randomAssignment"))).toBe(false);
  });
});
