import { describe, expect, it } from "vitest";
import {
  advanceInterventionEffects,
  createInitialInterventionRuntimeState,
  createInterventionRandom,
  createRunId,
  resolveSchoolIntervention,
  runSchoolInterventionHook,
  stableSortById,
  sumInterventionEffectValue,
} from "./schoolInterventionRuntime";
import type {
  InterventionEffect,
  SchoolIntervention,
  SchoolInterventionContext,
  SchoolInterventionHookOutput,
} from "./schoolInterventionRuntime";
import { SCHOOL_INTERVENTION_HOOK_ORDER } from "./interventions";
import type { SchoolInterventionHook } from "./interventions";
import { afterPartyPolicy } from "./formationPolicy";
import { DEFAULT_PARAMS } from "./presets";
import type { Agent, GroupCandidate } from "./types";

const AGENT: Agent = {
  id: "a1",
  label: "A",
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  willingness: 0.5,
  initiative: 0.5,
  ambiguityTolerance: 0.5,
  influenceAvoidance: 0.5,
  conformity: 0.5,
  leaveThreshold: 0.5,
  isObserverJoiner: false,
  state: "undecided",
  stress: 0,
};

function makeContext(hook: SchoolInterventionHook, overrides: Partial<SchoolInterventionContext> = {}): SchoolInterventionContext {
  return {
    hook,
    tick: 1,
    agents: [AGENT],
    groupCandidates: [] as GroupCandidate[],
    formationPolicy: afterPartyPolicy,
    params: DEFAULT_PARAMS,
    deadlineTick: undefined,
    recentEvents: [],
    runSeed: 42,
    runId: "test-run",
    runtimeState: createInitialInterventionRuntimeState(),
    ...overrides,
  };
}

describe("runSchoolInterventionHook", () => {
  it("returns an empty no-op result when no intervention is given", () => {
    const result = runSchoolInterventionHook(undefined, makeContext("beforeTick"));
    expect(result.effects).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.runtimeState).toEqual(createInitialInterventionRuntimeState());
  });

  it("returns an empty no-op result when the intervention doesn't implement that hook", () => {
    const intervention: SchoolIntervention = { id: "none" };
    const result = runSchoolInterventionHook(intervention, makeContext("atDeadline"));
    expect(result.effects).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("returns an empty no-op result when the handler returns void", () => {
    const intervention: SchoolIntervention = { id: "none", onBeforeTick: () => undefined };
    const result = runSchoolInterventionHook(intervention, makeContext("beforeTick"));
    expect(result.effects).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("fills in missing keys of a partial handler output with empty defaults", () => {
    const ctx = makeContext("beforeTick");
    const output: SchoolInterventionHookOutput = { events: [{ message: "hi", eventType: "schoolInterventionTriggered" }] };
    const intervention: SchoolIntervention = { id: "none", onBeforeTick: () => output };
    const result = runSchoolInterventionHook(intervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.effects).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.runtimeState).toBe(ctx.runtimeState);
  });

  it("calls the correct handler for each hook, in the fixed SCHOOL_INTERVENTION_HOOK_ORDER order", () => {
    const calls: SchoolInterventionHook[] = [];
    const record = (hook: SchoolInterventionHook) => () => {
      calls.push(hook);
      return undefined;
    };
    const intervention: SchoolIntervention = {
      id: "none",
      onInitialState: record("initialState"),
      onBeforeTick: record("beforeTick"),
      onBeforeApproachDecision: record("beforeApproachDecision"),
      onAfterStateTransition: record("afterStateTransition"),
      onBeforeDeadline: record("beforeDeadline"),
      onAtDeadline: record("atDeadline"),
    };

    for (const hook of SCHOOL_INTERVENTION_HOOK_ORDER) {
      runSchoolInterventionHook(intervention, makeContext(hook));
    }

    expect(calls).toEqual(SCHOOL_INTERVENTION_HOOK_ORDER);
  });

  it("threads runtimeState updates from one hook call into the next", () => {
    const intervention: SchoolIntervention = {
      id: "none",
      onBeforeTick: (ctx) => ({
        runtimeState: { ...ctx.runtimeState, forcedAssignmentApplied: true },
      }),
    };
    const first = runSchoolInterventionHook(intervention, makeContext("beforeTick"));
    expect(first.runtimeState.forcedAssignmentApplied).toBe(true);

    const second = runSchoolInterventionHook(
      intervention,
      makeContext("beforeTick", { runtimeState: first.runtimeState }),
    );
    expect(second.runtimeState.forcedAssignmentApplied).toBe(true);
  });
});

describe("resolveSchoolIntervention", () => {
  it("returns undefined for every InterventionScenarioId (no school interventions implemented yet)", () => {
    expect(resolveSchoolIntervention("none")).toBeUndefined();
    expect(resolveSchoolIntervention("light-observer-invitation")).toBeUndefined();
  });
});

describe("createInterventionRandom", () => {
  it("is deterministic for the same (runSeed, interventionId, tick, salt)", () => {
    const a = createInterventionRandom(7, "none", 12, "candidate-1");
    const b = createInterventionRandom(7, "none", 12, "candidate-1");
    expect(a.next()).toBe(b.next());
  });

  it("produces a different sequence when the salt differs", () => {
    const a = createInterventionRandom(7, "none", 12, "candidate-1");
    const b = createInterventionRandom(7, "none", 12, "candidate-2");
    expect(a.next()).not.toBe(b.next());
  });

  it("produces a different sequence when the tick differs", () => {
    const a = createInterventionRandom(7, "none", 12);
    const b = createInterventionRandom(7, "none", 13);
    expect(a.next()).not.toBe(b.next());
  });

  it("produces a different sequence when the interventionId differs", () => {
    const a = createInterventionRandom(7, "none", 12);
    const b = createInterventionRandom(7, "light-observer-invitation", 12);
    expect(a.next()).not.toBe(b.next());
  });
});

describe("stableSortById", () => {
  it("sorts by id ascending without mutating the input", () => {
    const items = [{ id: "b" }, { id: "a" }, { id: "c" }];
    const sorted = stableSortById(items);
    expect(sorted.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(items.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });
});

describe("createRunId", () => {
  it("is deterministic and distinguishes formationScenarioId/interventionId/runSeed", () => {
    expect(createRunId("classroomPair", "none", 1)).toBe(createRunId("classroomPair", "none", 1));
    expect(createRunId("classroomPair", "none", 1)).not.toBe(createRunId("afterParty", "none", 1));
    expect(createRunId("classroomPair", "none", 1)).not.toBe(createRunId("classroomPair", "none", 2));
  });
});

describe("createInitialInterventionRuntimeState", () => {
  it("returns a fresh, fully-empty state", () => {
    const state = createInitialInterventionRuntimeState();
    expect(state).toEqual({
      intervenedAgentIds: [],
      intervenedGroupIds: [],
      lastTriggeredAtTick: {},
      temporaryEffectExpiryByAgentId: {},
      recommendedGroupIdByAgentId: {},
      anonymouslyNotifiedAgentIds: [],
      forcedAssignmentApplied: false,
    });
  });

  it("returns a distinct object on each call (no shared mutable state across runs)", () => {
    const a = createInitialInterventionRuntimeState();
    const b = createInitialInterventionRuntimeState();
    a.intervenedAgentIds.push("x");
    expect(b.intervenedAgentIds).toEqual([]);
  });
});

describe("sumInterventionEffectValue / advanceInterventionEffects", () => {
  const effect: InterventionEffect = {
    dimension: "approachProbability",
    agentId: "a1",
    value: 0.2,
    startedAtTick: 5,
    expiresAtTick: 10,
  };

  it("sums only matching agentId + dimension within the active tick window", () => {
    expect(sumInterventionEffectValue([effect], "a1", "approachProbability", 5)).toBeCloseTo(0.2);
    expect(sumInterventionEffectValue([effect], "a1", "approachProbability", 9)).toBeCloseTo(0.2);
    expect(sumInterventionEffectValue([effect], "a1", "approachProbability", 10)).toBe(0);
    expect(sumInterventionEffectValue([effect], "a1", "approachProbability", 4)).toBe(0);
    expect(sumInterventionEffectValue([effect], "a2", "approachProbability", 5)).toBe(0);
    expect(sumInterventionEffectValue([effect], "a1", "stressRate", 5)).toBe(0);
  });

  it("only counts an attractiveness effect toward its own targetGroupId when specified", () => {
    const targeted: InterventionEffect = { ...effect, dimension: "attractiveness", targetGroupId: "group-1" };
    expect(sumInterventionEffectValue([targeted], "a1", "attractiveness", 5, "group-1")).toBeCloseTo(0.2);
    expect(sumInterventionEffectValue([targeted], "a1", "attractiveness", 5, "group-2")).toBe(0);
    // no targetGroupId asked for -> still counted (caller didn't filter by group)
    expect(sumInterventionEffectValue([targeted], "a1", "attractiveness", 5)).toBeCloseTo(0.2);
  });

  it("drops expired effects", () => {
    expect(advanceInterventionEffects([effect], 9)).toEqual([effect]);
    expect(advanceInterventionEffects([effect], 10)).toEqual([]);
  });
});
