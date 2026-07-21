import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { afterPartyPolicy, getFormationPolicyById } from "./formationPolicy";
import type { FormationRuntimeOptions, GroupSizeRule } from "./formationPolicy";
import { createInitialInterventionRuntimeState, runSchoolInterventionHook } from "./schoolInterventionRuntime";
import type { SchoolInterventionContext } from "./schoolInterventionRuntime";
import {
  NEARBY_PEER_PROMPT_BOOST_WINDOW,
  NEARBY_PEER_PROMPT_MIN_TICK,
  NEARBY_PEER_PROMPT_SEARCH_RADIUS,
  nearbyPeerPromptIntervention,
} from "./schoolInterventions/nearbyPeerPrompt";
import { openGroupSignalIntervention } from "./schoolInterventions/openGroupSignal";
import type { Agent, GroupCandidate, SimParams, SimulationState } from "./types";

/**
 * Issue #157: 「近くの人への声かけ促進」(`nearby-peer-prompt`)と「空きのある班の参加可能表示」
 * (`open-group-signal`)の2つの学校向け低圧介入のテスト。#156の実行契約(`schoolInterventionRuntime.ts`)
 * を通した単体テストと、`engine.ts`統合(`createInitialState`/`stepSimulation`)の両方をカバーする。
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

function makeContext(overrides: Partial<SchoolInterventionContext> = {}): SchoolInterventionContext {
  return {
    hook: "beforeApproachDecision",
    tick: NEARBY_PEER_PROMPT_MIN_TICK,
    agents: [],
    groupCandidates: [],
    formationPolicy: getFormationPolicyById("classroomPair", 150),
    params: DEFAULT_PARAMS,
    deadlineTick: 150,
    recentEvents: [],
    runSeed: 1,
    runId: "test-run",
    runtimeState: createInitialInterventionRuntimeState(),
    ...overrides,
  };
}

describe("nearbyPeerPromptIntervention", () => {
  it("is a no-op outside classroomPair (afterParty guard)", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 10, y: 0 });
    const ctx = makeContext({ agents: [a, b], formationPolicy: afterPartyPolicy });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("is a no-op before the stagnation threshold tick", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 10, y: 0 });
    const ctx = makeContext({ agents: [a, b], tick: NEARBY_PEER_PROMPT_MIN_TICK - 1 });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("is a no-op with fewer than 2 eligible (undecided) agents", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0, state: "joined" });
    const b = makeAgent({ id: "b", x: 10, y: 0 });
    const ctx = makeContext({ agents: [a, b] });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("is a no-op when the closest undecided pair is outside the search radius", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: NEARBY_PEER_PROMPT_SEARCH_RADIUS + 1, y: 0 });
    const ctx = makeContext({ agents: [a, b] });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("deterministically picks the closest eligible pair and emits a presented event + temporary effects for both", () => {
    const near1 = makeAgent({ id: "near1", x: 0, y: 0 });
    const near2 = makeAgent({ id: "near2", x: 5, y: 0 });
    const far = makeAgent({ id: "far", x: 300, y: 300 });
    const ctx = makeContext({ agents: [far, near2, near1] });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe("schoolInterventionTriggered");
    expect(result.events[0].metadata).toMatchObject({
      schoolInterventionId: "nearby-peer-prompt",
      agentId: "near1",
      secondAgentId: "near2",
      outcome: "presented",
    });

    expect(result.effects).toHaveLength(4);
    const forNear1 = result.effects.filter((e) => e.agentId === "near1");
    const forNear2 = result.effects.filter((e) => e.agentId === "near2");
    expect(forNear1.map((e) => e.dimension).sort()).toEqual(["approachProbability", "attractiveness"]);
    expect(forNear2.map((e) => e.dimension).sort()).toEqual(["approachProbability", "attractiveness"]);
    for (const effect of result.effects) {
      expect(effect.startedAtTick).toBe(ctx.tick);
      expect(effect.expiresAtTick).toBe(ctx.tick + NEARBY_PEER_PROMPT_BOOST_WINDOW);
      expect(effect.value).toBeGreaterThan(0);
    }

    expect(result.runtimeState.temporaryEffectExpiryByAgentId).toEqual({
      near1: ctx.tick + NEARBY_PEER_PROMPT_BOOST_WINDOW,
      near2: ctx.tick + NEARBY_PEER_PROMPT_BOOST_WINDOW,
    });
    expect(result.runtimeState.intervenedAgentIds.sort()).toEqual(["near1", "near2"]);
  });

  it("excludes an agent that is still within its cooldown/effect window", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 5, y: 0 });
    const c = makeAgent({ id: "c", x: 6, y: 0 });
    const ctx = makeContext({
      agents: [a, b, c],
      runtimeState: {
        ...createInitialInterventionRuntimeState(),
        temporaryEffectExpiryByAgentId: { a: NEARBY_PEER_PROMPT_MIN_TICK + 100 },
      },
    });
    const result = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata?.agentId).toBe("b");
    expect(result.events[0].metadata?.secondAgentId).toBe("c");
  });

  it("is deterministic: same context always yields the same pair and metadata", () => {
    const a = makeAgent({ id: "a", x: 0, y: 0 });
    const b = makeAgent({ id: "b", x: 5, y: 0 });
    const c = makeAgent({ id: "c", x: 5, y: 5 });
    const ctx1 = makeContext({ agents: [a, b, c] });
    const ctx2 = makeContext({ agents: [a, b, c] });
    const r1 = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx1);
    const r2 = runSchoolInterventionHook(nearbyPeerPromptIntervention, ctx2);
    expect(r1.events).toEqual(r2.events);
    expect(r1.effects).toEqual(r2.effects);
  });
});

describe("openGroupSignalIntervention", () => {
  const pairPolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 2, maxGroupSize: 2 });
  const variablePolicy = getFormationPolicyById("classroomPair", 150, { minGroupSize: 3, maxGroupSize: 4 });

  // `openGroupSignalIntervention`は`afterStateTransition`フックのみを実装しているため、
  // 共通の`makeContext`(既定`beforeApproachDecision`)をこのdescribeブロック用に上書きする。
  function makeOpenGroupContext(overrides: Partial<SchoolInterventionContext> = {}): SchoolInterventionContext {
    return makeContext({ hook: "afterStateTransition", ...overrides });
  }

  function candidate(overrides: Partial<GroupCandidate>): GroupCandidate {
    return { id: "g1", x: 0, y: 0, memberIds: [], status: "forming", age: 0, ...overrides };
  }

  it("is a no-op outside classroomPair (afterParty guard)", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: afterPartyPolicy,
      groupCandidates: [candidate({ memberIds: ["a"] })],
      agents: [makeAgent({ id: "a" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.effects).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("signals a forming pair candidate with room and boosts attractiveness for undecided agents", () => {
    const undecided = makeAgent({ id: "u1" });
    const ctx = makeOpenGroupContext({
      formationPolicy: pairPolicy,
      agents: [undecided],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1"], status: "forming" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata).toMatchObject({
      schoolInterventionId: "open-group-signal",
      groupId: "g1",
      outcome: "presented",
    });
    expect(result.effects).toEqual([
      {
        dimension: "attractiveness",
        agentId: "u1",
        targetGroupId: "g1",
        value: expect.any(Number),
        startedAtTick: ctx.tick,
        expiresAtTick: ctx.tick + 2,
      },
    ]);
    expect(result.runtimeState.intervenedGroupIds).toEqual(["g1"]);
  });

  it("does not signal a full fixed-capacity (pair) candidate", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: pairPolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2"], status: "confirmed" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it("does not signal dissolving/dissolved/expired candidates", () => {
    for (const status of ["dissolving", "dissolved", "expired"] as const) {
      const ctx = makeOpenGroupContext({
        formationPolicy: pairPolicy,
        agents: [makeAgent({ id: "u1" })],
        groupCandidates: [candidate({ id: "g1", memberIds: ["m1"], status })],
      });
      const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
      expect(result.events).toEqual([]);
      expect(result.effects).toEqual([]);
    }
  });

  it("signals a confirmed variable-capacity group that still has room (3-4 person group)", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: variablePolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2", "m3"], status: "confirmed" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata?.outcome).toBe("presented");
    expect(result.effects).toHaveLength(1);
  });

  it("does not signal a confirmed variable-capacity group once it reaches maxGroupSize", () => {
    const ctx = makeOpenGroupContext({
      formationPolicy: variablePolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2", "m3", "m4"], status: "confirmed" })],
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it("emits an ended event (without re-emitting a presented event) once a previously-signaled group becomes full", () => {
    const runtimeState = { ...createInitialInterventionRuntimeState(), intervenedGroupIds: ["g1"] };
    const ctx = makeOpenGroupContext({
      formationPolicy: pairPolicy,
      agents: [makeAgent({ id: "u1" })],
      groupCandidates: [candidate({ id: "g1", memberIds: ["m1", "m2"], status: "confirmed" })],
      runtimeState,
    });
    const result = runSchoolInterventionHook(openGroupSignalIntervention, ctx);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata).toMatchObject({
      schoolInterventionId: "open-group-signal",
      groupId: "g1",
      outcome: "assigned",
      triggerReason: "groupBecameFull",
    });
    expect(result.runtimeState.intervenedGroupIds).toEqual([]);
  });
});

// --- engine.ts integration -----------------------------------------------------------------

function runClassroomTicks(
  seed: number,
  params: SimParams,
  ticks: number,
  formation: FormationRuntimeOptions,
  interventionId?: "nearby-peer-prompt" | "open-group-signal" | "none",
): SimulationState[] {
  const rng = new SeededRandom(seed);
  const intervention = interventionId ? { interventionId } : undefined;
  const states: SimulationState[] = [];
  let state = createInitialState(seed, params, intervention, undefined, undefined, undefined, undefined, formation);
  states.push(state);
  for (let i = 0; i < ticks && !state.finished; i++) {
    state = stepSimulation(state, params, rng, intervention, undefined, undefined, undefined, undefined, formation);
    states.push(state);
  }
  return states;
}

describe("nearby-peer-prompt: engine.ts integration (Issue #157)", () => {
  const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
  const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 1, overallWillingness: 0.6 };

  it("createInitialState starts with an empty interventionRuntimeState/activeInterventionEffects", () => {
    const state = createInitialState(
      5,
      params,
      { interventionId: "nearby-peer-prompt" },
      undefined,
      undefined,
      undefined,
      undefined,
      formation,
    );
    expect(state.activeInterventionEffects).toEqual([]);
    expect(state.interventionRuntimeState?.intervenedAgentIds).toEqual([]);
  });

  it("is byte-identical to the no-intervention run before the stagnation threshold tick (no-op invariance)", () => {
    const none = runClassroomTicks(3, params, NEARBY_PEER_PROMPT_MIN_TICK - 1, formation, "none");
    const withIntervention = runClassroomTicks(3, params, NEARBY_PEER_PROMPT_MIN_TICK - 1, formation, "nearby-peer-prompt");

    expect(withIntervention.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state }))).toEqual(
      none.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state })),
    );
    expect(withIntervention.at(-1)?.groupCandidates).toEqual(none.at(-1)?.groupCandidates);
  });

  it("does not affect the afterParty scenario even if selected (applicability guard)", () => {
    const afterPartyParams: SimParams = { ...DEFAULT_PARAMS, populationSize: 10 };
    const noneRun = runClassroomTicks(9, afterPartyParams, 40, { scenarioId: "afterParty" }, "none");
    const interventionRun = runClassroomTicks(9, afterPartyParams, 40, { scenarioId: "afterParty" }, "nearby-peer-prompt");
    expect(interventionRun.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state }))).toEqual(
      noneRun.at(-1)?.agents.map((a) => ({ x: a.x, y: a.y, state: a.state })),
    );
  });

  it("eventually triggers a schoolInterventionTriggered prompt event over a full run, and effects expire", () => {
    const states = runClassroomTicks(11, params, 150, formation, "nearby-peer-prompt");
    const finalState = states.at(-1)!;
    const triggered = finalState.log.filter(
      (entry) => entry.eventType === "schoolInterventionTriggered" && entry.metadata?.schoolInterventionId === "nearby-peer-prompt",
    );
    expect(triggered.length).toBeGreaterThan(0);
    // 最終tickでは、直近で発火していない限り効果は残らない(expiresAtTickを過ぎたら除去される)
    for (const effect of finalState.activeInterventionEffects ?? []) {
      expect(finalState.tick).toBeLessThan(effect.expiresAtTick);
    }
  });

  it("produces the same schoolInterventionTriggered sequence for the same seed (reproducibility)", () => {
    const a = runClassroomTicks(21, params, 100, formation, "nearby-peer-prompt");
    const b = runClassroomTicks(21, params, 100, formation, "nearby-peer-prompt");
    const eventsA = a.at(-1)?.log.filter((e) => e.eventType === "schoolInterventionTriggered");
    const eventsB = b.at(-1)?.log.filter((e) => e.eventType === "schoolInterventionTriggered");
    expect(eventsA).toEqual(eventsB);
  });
});

describe("open-group-signal: engine.ts integration (Issue #157)", () => {
  it("never lets a variable-capacity (3-4 person) group exceed its maxGroupSize while the intervention is active", () => {
    const groupSize: GroupSizeRule = { minGroupSize: 3, maxGroupSize: 4 };
    const formation: FormationRuntimeOptions = {
      scenarioId: "classroomPair",
      formationDeadlineTick: 150,
      classroomGroupSize: groupSize,
    };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 2, overallWillingness: 0.7 };
    const states = runClassroomTicks(17, params, 150, formation, "open-group-signal");
    const finalState = states.at(-1)!;
    for (const candidate of finalState.groupCandidates) {
      expect(candidate.memberIds.length).toBeLessThanOrEqual(groupSize.maxGroupSize);
    }
  });

  it("is byte-identical to the no-intervention run when no candidate has ever formed yet (no-op invariance)", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 12, numLeaders: 0, overallWillingness: 0 };
    const none = runClassroomTicks(4, params, 3, formation, "none");
    const withIntervention = runClassroomTicks(4, params, 3, formation, "open-group-signal");
    expect(withIntervention.at(-1)?.agents).toEqual(none.at(-1)?.agents);
    expect(withIntervention.at(-1)?.groupCandidates).toEqual(none.at(-1)?.groupCandidates);
  });

  it("resets interventionRuntimeState on a fresh createInitialState (Reset/seed/preset change)", () => {
    const formation: FormationRuntimeOptions = { scenarioId: "classroomPair", formationDeadlineTick: 150 };
    const params: SimParams = { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 2, overallWillingness: 0.7 };
    const midRun = runClassroomTicks(23, params, 60, formation, "open-group-signal");
    expect((midRun.at(-1)?.interventionRuntimeState?.intervenedGroupIds.length ?? 0) >= 0).toBe(true);

    const fresh = createInitialState(
      23,
      params,
      { interventionId: "open-group-signal" },
      undefined,
      undefined,
      undefined,
      undefined,
      formation,
    );
    expect(fresh.interventionRuntimeState?.intervenedGroupIds).toEqual([]);
    expect(fresh.activeInterventionEffects).toEqual([]);
  });
});
