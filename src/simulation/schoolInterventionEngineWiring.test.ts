import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";
import type { SimParams, SimulationState } from "./types";

/**
 * Issue #156: `schoolInterventionRuntime.ts`のフックがengine.tsへ結線されたことの統合テスト。
 * ここでは介入を一切指定しない(=`interventionId: "none"`、`resolveSchoolIntervention`が常に
 * undefinedを返す)経路について、「配線があってもno-opであること」と「配線が状態へ正しく反映される
 * こと」の2点を確認する。Issue #157で実装された個別介入(`nearby-peer-prompt`/`open-group-signal`)
 * が実際にhookを発火させる経路のテストは`schoolInterventions.test.ts`にある。
 */

function runClassroomTicks(seed: number, params: SimParams, ticks: number): SimulationState[] {
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
  const rng = new SeededRandom(seed);
  const states: SimulationState[] = [];
  let state = createInitialState(seed, params, undefined, undefined, undefined, undefined, undefined, formation);
  states.push(state);
  for (let i = 0; i < ticks && !state.finished; i++) {
    state = stepSimulation(state, params, rng, undefined, undefined, undefined, undefined, undefined, formation);
    states.push(state);
  }
  return states;
}

describe("school intervention hook wiring: no-op invariance (Issue #156)", () => {
  it("createInitialState populates an empty interventionRuntimeState/activeInterventionEffects when no school intervention is registered", () => {
    const state = createInitialState(1, DEFAULT_PARAMS, undefined, undefined, undefined, undefined, undefined, {
      scenarioId: "classroomPair",
      formationDeadlineTick: 150,
    });
    expect(state.interventionRuntimeState).toEqual({
      intervenedAgentIds: [],
      intervenedGroupIds: [],
      lastTriggeredAtTick: {},
      temporaryEffectExpiryByAgentId: {},
      recommendedGroupIdByAgentId: {},
      anonymouslyNotifiedAgentIds: [],
      forcedAssignmentApplied: false,
    });
    expect(state.activeInterventionEffects).toEqual([]);
    expect(state.seed).toBe(1);
  });

  it("carries the runtime state/effects/seed forward across ticks, remaining empty throughout a full classroomPair run", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 0, overallWillingness: 0.8 };
    const states = runClassroomTicks(7, params, 150);

    expect(states.length).toBeGreaterThan(1);
    for (const state of states) {
      expect(state.activeInterventionEffects).toEqual([]);
      expect(state.interventionRuntimeState?.forcedAssignmentApplied).toBe(false);
      expect(state.seed).toBe(7);
    }
  });

  it("produces byte-identical agent/candidate/log state whether or not the caller re-passes `formation` every tick (fall-back path is unaffected by the hook wiring)", () => {
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 10, numLeaders: 1, overallWillingness: 0.7 };
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 80 };

    const rngA = new SeededRandom(3);
    let stateA = createInitialState(3, params, undefined, undefined, undefined, undefined, undefined, formation);
    while (!stateA.finished && stateA.tick < 80) {
      stateA = stepSimulation(stateA, params, rngA, undefined, undefined, undefined, undefined, undefined, formation);
    }

    const rngB = new SeededRandom(3);
    let stateB = createInitialState(3, params, undefined, undefined, undefined, undefined, undefined, formation);
    while (!stateB.finished && stateB.tick < 80) {
      // Issue #156 hooks are invoked every tick regardless; omitting `formation` here exercises the
      // existing fall-back path (state.formationScenarioId) that the hook wiring must not disturb.
      stateB = stepSimulation(stateB, params, rngB);
    }

    expect(stateB.agents.map((a) => ({ x: a.x, y: a.y, state: a.state }))).toEqual(
      stateA.agents.map((a) => ({ x: a.x, y: a.y, state: a.state })),
    );
    expect(stateB.groupCandidates).toEqual(stateA.groupCandidates);
    expect(stateB.tick).toBe(stateA.tick);
    expect(stateB.finished).toBe(stateA.finished);
  });
});
